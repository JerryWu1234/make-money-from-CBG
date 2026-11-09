import type { Page, Response } from "playwright-core";
import { watchLoginRequiredDialog } from "./login-dialog";
import { assertAvailable } from "./page";
import { CrawlAccessError, crawlAccessFailure } from "./types";

export class CrawlHttpAccessError extends CrawlAccessError {
  readonly code = "CBG_HTTP_ACCESS_BLOCKED";
  constructor(readonly status: 403 | 429) {
    super(status === 429 ? "busy" : "verification");
    this.message = `官网业务请求返回 HTTP ${status}，整轮采集已暂停；请确认访问状态后手动继续，已保存资料和待采任务保留。`;
  }
}

/** Ignore blocked images/loggers and unrelated frames; only collection business requests count. */
export function responseAccessFailure(response: Response, page: Page) {
  const status = response.status();
  if (status !== 403 && status !== 429) return;
  try {
    const request = response.request();
    if (
      new URL(response.url()).origin !== "https://xyq.cbg.163.com" ||
      request.frame() !== page.mainFrame() ||
      !["document", "xhr", "fetch"].includes(request.resourceType())
    )
      return;
    return new CrawlHttpAccessError(status);
  } catch {
    // A detached frame or service worker is not evidence about the collection document.
  }
}

/** Watch access state throughout a run, including asynchronous changes between collector reads. */
export async function watchCrawlAccess(
  page: Page,
  signal: AbortSignal,
  onAccess: (error: CrawlAccessError) => void,
): Promise<() => Promise<void>> {
  signal.throwIfAborted();
  let disposed = false,
    reported = false,
    checking = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposeLogin: (() => Promise<void>) | undefined;
  const report = (error: CrawlAccessError) => {
    if (disposed || reported || signal.aborted) return;
    reported = true;
    onAccess(error);
  };
  const check = async () => {
    if (disposed || reported || checking || signal.aborted || page.isClosed()) return;
    checking = true;
    try {
      await assertAvailable(page);
    } catch (error) {
      const access = crawlAccessFailure(error);
      if (access) report(access);
      // Unknown navigation/context errors remain the collector's responsibility.
    } finally {
      checking = false;
    }
  };
  const response = (value: Response) => {
    const access = responseAccessFailure(value, page);
    if (access) report(access);
  };
  const navigated = () => void check();
  const dispose = async () => {
    disposed = true;
    clearInterval(timer);
    page.off("response", response);
    page.off("framenavigated", navigated);
    signal.removeEventListener("abort", stop);
    await disposeLogin?.();
  };
  const stop = () => {
    void dispose().catch(() => {});
  };
  page.on("response", response);
  page.on("framenavigated", navigated);
  signal.addEventListener("abort", stop, { once: true });
  try {
    disposeLogin = await watchLoginRequiredDialog(page, signal, report);
    signal.throwIfAborted();
    timer = setInterval(() => void check(), 200);
    await check();
    return dispose;
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
