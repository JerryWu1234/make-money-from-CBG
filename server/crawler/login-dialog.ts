import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { CrawlAccessError } from "./types";

export class LoginRequiredDialogError extends CrawlAccessError {
  readonly code = "CBG_LOGIN_REQUIRED_DIALOG";
  constructor() {
    super("login");
    this.message =
      "检测到“请登录后，再进行操作”弹窗，整轮采集已暂停；请重新登录后继续，已保存资料和待采任务已保留。";
  }
}

/** Self-contained: this function also runs inside the collection page. */
export function hasLoginRequiredDialog() {
  return Array.from(document.querySelectorAll(".popupDialog, .dialogWrap")).some(
    (element) =>
      element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) &&
      /请(?:先)?登录(?:后)?再进行操作/.test(
        (element.textContent || "").replace(/[\s，,。.!！：:]/g, ""),
      ),
  );
}

// A page has one permanent bridge; each collection owns a fresh token and disposable observer.
type Watch = { token: string; notify: () => void; reported: boolean };
const bridges = new WeakMap<Page, { ready: Promise<void>; watch?: Watch }>();
const signals = new WeakMap<Page, AbortSignal>();
export function collectionPageSignal(page: Page) {
  return signals.get(page);
}

function installObserver(read: () => boolean) {
  const globals = window as typeof window & {
    __cbgReportLoginDialog: (event: { type: string; token?: string }) => Promise<string | null>;
    __cbgLoginDialogObserver?: { stop: () => void };
  };
  // addInitScript runs in subframes too; only the owned page's main document is monitored.
  if (window !== window.top) return;
  globals.__cbgLoginDialogObserver?.stop();
  let stopped = false;
  let reported = false;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    stopped = true;
    observer?.disconnect();
    clearInterval(timer);
  };
  globals.__cbgLoginDialogObserver = { stop };
  void (async () => {
    const token = await globals.__cbgReportLoginDialog({ type: "ready" });
    if (!token || stopped) return;
    const check = () => {
      if (stopped || reported || !read()) return;
      reported = true;
      void globals.__cbgReportLoginDialog({ type: "dialog", token }).catch(() => {});
    };
    observer = new MutationObserver(check);
    observer.observe(document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    // CSS animation/visibility changes need not mutate the DOM.
    timer = setInterval(check, 200);
    check();
  })().catch(stop);
}

const observerScript = `(${installObserver.toString()})(${hasLoginRequiredDialog.toString()})`;

export async function watchLoginRequiredDialog(
  page: Page,
  signal: AbortSignal,
  onDialog: (error: LoginRequiredDialogError) => void,
): Promise<() => Promise<void>> {
  signal.throwIfAborted();
  let bridge = bridges.get(page);
  if (!bridge) {
    const state: { ready: Promise<void>; watch?: Watch } = { ready: Promise.resolve() };
    bridges.set(page, state);
    state.ready = (async () => {
      await page.exposeBinding(
        "__cbgReportLoginDialog",
        (source, event: { type?: string; token?: string } | null) => {
          if (source.frame !== page.mainFrame()) return null;
          const watch = state.watch;
          if (event?.type === "ready") return watch?.token || null;
          if (event?.type === "dialog" && watch && watch.token === event.token && !watch.reported) {
            watch.reported = true;
            watch.notify();
          }
          return null;
        },
      );
      await page.addInitScript(observerScript);
    })();
    bridge = state;
  }
  const state = bridge;
  const watch: Watch = {
    token: randomUUID(),
    reported: false,
    notify: () => {
      if (!signal.aborted) onDialog(new LoginRequiredDialogError());
    },
  };
  state.watch = watch;
  signals.set(page, signal);
  const dispose = async () => {
    if (state.watch !== watch) return;
    state.watch = undefined;
    try {
      if (!page.isClosed())
        await page.evaluate(() => {
          const stop = Reflect.get(window, "__cbgLoginDialogObserver") as
            | { stop(): void }
            | undefined;
          stop?.stop();
        });
    } finally {
      if (signals.get(page) === signal) signals.delete(page);
    }
  };
  try {
    await state.ready;
    signal.throwIfAborted();
    // Arm an existing document as well as future navigations/reloads.
    await page.evaluate(observerScript);
    return dispose;
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}
