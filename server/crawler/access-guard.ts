import type { Page, Response, Request } from "playwright-core";
import { watchLoginRequiredDialog } from "./login-dialog";
import { assertAvailable } from "./page";
import { CrawlAccessError, crawlAccessFailure } from "./types";
import {
  classifyBusinessResponse,
  isBusinessResponse,
  type ResponseClassification,
} from "../access/response-classifier";

export class CrawlHttpAccessError extends CrawlAccessError {
  readonly code = "CBG_HTTP_ACCESS_BLOCKED";
  constructor(
    readonly status: 403 | 429,
    readonly retryAfter?: string,
  ) {
    super(status === 429 ? "busy" : "verification");
    this.message = `官网业务请求返回 HTTP ${status}，整轮采集已暂停；请确认访问状态后手动继续，已保存资料和待采任务保留。`;
  }
}

export class CrawlBusinessAccessError extends CrawlAccessError {
  readonly code = "CBG_BUSINESS_ACCESS_BLOCKED";
  constructor(
    readonly reason: "login" | "verification" | "frequency",
    readonly retryAfter?: string,
  ) {
    super(reason === "frequency" ? "busy" : reason);
  }
}

function observation(response: Response, page: Page) {
  const request = response.request();
  return {
    url: response.url(),
    status: response.status(),
    resourceType: request.resourceType(),
    mainFrame: request.frame() === page.mainFrame(),
    retryAfter:
      typeof response.headers === "function" ? response.headers()["retry-after"] : undefined,
  };
}

/** Ignore blocked images/loggers and unrelated frames; only collection business requests count. */
export function responseAccessFailure(response: Response, page: Page) {
  const status = response.status();
  if (status !== 403 && status !== 429) return;
  try {
    const input = observation(response, page);
    if (!isBusinessResponse(input)) return;
    return new CrawlHttpAccessError(status, input.retryAfter);
  } catch {
    // A detached frame or service worker is not evidence about the collection document.
  }
}

/** Watch access state throughout a run, including asynchronous changes between collector reads. */
export async function watchCrawlAccess(
  page: Page,
  signal: AbortSignal,
  onAccess: (error: CrawlAccessError, request?: Request) => void,
  onResponse?: (
    classification: ResponseClassification,
    summary: { url: string; status: number; resourceType: string },
    request?: Request,
  ) => void,
  onProtectionFailure?: (error: unknown) => void,
  shouldReport: (error: CrawlAccessError) => boolean = () => true,
): Promise<() => Promise<void>> {
  signal.throwIfAborted();
  let disposed = false,
    reported = false,
    checking = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposeLogin: (() => Promise<void>) | undefined;
  const report = (error: CrawlAccessError, request?: Request) => {
    if (disposed || reported || signal.aborted) return;
    if (!shouldReport(error)) return;
    reported = true;
    onAccess(error, request);
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
    void (async () => {
      let input: ReturnType<typeof observation>;
      try {
        input = observation(value, page);
        if (!isBusinessResponse(input)) return;
      } catch {
        return; // Detached frames are outside the guarded page's scope.
      }
      let body: string | undefined;
      try {
        const headers = typeof value.headers === "function" ? value.headers() : {};
        const length = Number(headers["content-length"]);
        // Playwright has no streaming response reader. Do not materialize unknown,
        // chunked or compressed bodies; these remain unknown rather than risking
        // an unbounded detached body allocation. No response is requested again.
        const bounded =
          Number.isSafeInteger(length) &&
          length > 0 &&
          length <= 262144 &&
          (!headers["content-encoding"] || headers["content-encoding"] === "identity") &&
          !headers["transfer-encoding"];
        if (input.status === 200 && input.resourceType !== "document" && bounded)
          body = await value.text();
      } catch {
        /* unavailable body remains unknown */
      }
      const classification = classifyBusinessResponse({ ...input, body });
      try {
        // Count the observed request before a refusal callback aborts its page.
        onResponse?.(
          classification,
          {
            url: input.url,
            status: input.status,
            resourceType: input.resourceType,
          },
          value.request(),
        );
      } catch (error) {
        if (onProtectionFailure) onProtectionFailure(error);
        else {
          const failure = new CrawlAccessError("verification");
          failure.message = "访问保护证据保存失败，官网操作已停止，请检查本地服务存储。";
          report(failure);
        }
        return;
      }
      if (disposed || signal.aborted) return;
      const access = responseAccessFailure(value, page);
      if (access) report(access, value.request());
      else if (
        classification.kind === "blocked" &&
        ["login", "verification", "frequency"].includes(classification.reason)
      )
        report(
          new CrawlBusinessAccessError(
            classification.reason as "login" | "verification" | "frequency",
            classification.retryAfter,
          ),
          value.request(),
        );
    })();
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
