import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { CONNECTION_HELP, resolveCdpEndpoint, verifyCdpEndpoint } from "./chrome";
import { CBG_HOME_URL, showBrowserWorkPages } from "./config";
import { ensureWorkViewport } from "./viewport";
import { openWorkTransport, type WorkTransport } from "./work-transport";
import { diagnostics } from "./diagnostics";
import { captureBrowserStep, registerBrowserEvidence } from "./browser-evidence";
import { openDedicatedBrowser } from "./dedicated-browser";
import {
  browserControl,
  browserSettings,
  isBrowserModes,
  saveBrowserSettings,
  browserBusyError,
  type BrowserMode,
} from "./browser-settings";

type BrowserSession = {
  cachedBrowser: Browser | null;
  connectionPromise: Promise<Browser> | null;
  selectedPage: Page | null;
  hiddenPageCreation: Promise<void>;
  mode?: BrowserMode;
  context?: BrowserContext | null;
  transport?: WorkTransport;
  closing?: boolean;
  closePromise?: Promise<void>;
  cleanup?: { browser: Browser | null; context?: BrowserContext | null; transport?: WorkTransport };
};
// Connections survive module reloads; browser identities and work pages stay separate.
type Session = ReturnType<typeof createSession>;
type SessionPool = {
  sessions: Partial<Record<BrowserMode, Session>>;
  closing: boolean;
  creation: Promise<void>;
};
const sessionKey = Symbol.for("cbg.browser-session.v1");
const runtime = globalThis as typeof globalThis & { [sessionKey]?: SessionPool };
const pool = (runtime[sessionKey] ??= {
  sessions: {},
  closing: false,
  creation: Promise.resolve(),
});
function createSession(mode: BrowserMode) {
  const cache: BrowserSession = {
    cachedBrowser: null,
    connectionPromise: null,
    selectedPage: null,
    hiddenPageCreation: Promise.resolve(),
  };
  async function getBrowser(allowConnect = false): Promise<Browser> {
    if (cache.closing || pool.closing) throw browserBusyError("本地服务正在关闭，请稍后重试");
    if (browserControl.changing) throw browserBusyError();
    // 配置回滚也可能写盘失败；新连接不能越过另一个模式遗留的真实会话。
    const others = Object.entries(pool.sessions)
      .filter(([otherMode, entry]) => otherMode !== mode && entry.hasSessionResources())
      .map(([, entry]) => entry);
    if (others.some((entry) => entry.browserSessionSettings().busy)) throw browserBusyError();
    if (others.length) {
      if (!allowConnect)
        throw new Error("浏览器未连接；其他浏览器会话尚未关闭，请重新开始以重试清理");
      await Promise.all(others.map((entry) => entry.closeBrowserSession()));
      if (
        cache.closing ||
        pool.closing ||
        browserControl.changing ||
        mode !== getActiveBrowserMode()
      )
        throw browserBusyError();
    }
    if (cache.cleanup) {
      if (!allowConnect) throw new Error("浏览器未连接；旧会话尚未关闭，请重新开始以重试清理");
      await closeBrowserSession();
      if (cache.closing || browserControl.changing) throw browserBusyError();
    }
    if (cache.cachedBrowser?.isConnected()) return cache.cachedBrowser;
    if (!allowConnect) throw new Error(`浏览器未连接。${CONNECTION_HELP}`);
    if (cache.connectionPromise) return cache.connectionPromise;
    cache.connectionPromise = (async () => {
      if (mode === "dedicated") {
        diagnostics.record("browser.launch_start", { mode });
        const context = await openDedicatedBrowser();
        const browser = context.browser();
        if (!browser || cache.closing) {
          cache.cleanup = { browser, context };
          await closeBrowserSession();
          throw new Error(cache.closing ? "本地服务正在关闭" : "项目专用浏览器连接未建立");
        }
        cache.context = context;
        cache.mode = mode;
        cache.cachedBrowser = browser;
        watchBrowserDisconnect(browser, mode);
        diagnostics.record("browser.launched", { mode });
        return browser;
      }
      const endpoint = await resolveCdpEndpoint();
      let transport: WorkTransport | undefined;
      let stage = "checking_port";
      try {
        diagnostics.record("browser.endpoint_resolved", { port: Number(new URL(endpoint).port) });
        await verifyCdpEndpoint(endpoint);
        stage = "handshake";
        transport = await openWorkTransport(endpoint);
        stage = "initializing";
        diagnostics.record("browser.websocket_connected");
        const browser = await chromium.connectOverCDP(transport, {
          timeout: 15000,
          noDefaults: true,
        });
        if (cache.closing) {
          await browser.close();
          throw new Error("本地服务正在关闭");
        }
        cache.cachedBrowser = browser;
        cache.mode = mode;
        cache.transport = transport;
        watchBrowserDisconnect(browser, mode);
        return browser;
      } catch (error) {
        transport?.close();
        diagnostics.record("browser.connection_error", { stage, error });
        if (stage === "checking_port") throw error;
        throw new Error(
          stage === "initializing"
            ? "已连接 Chrome 调试服务，但初始化工作连接失败。请重试，并查看运行日志中的 browser.connection_error。"
            : `Chrome 调试端口已启动，但连接未获授权或握手失败。请检查 Chrome 的连接提示并确认允许；如已允许，请关闭再重新开启远程调试后重试。`,
          { cause: error },
        );
      }
    })();
    try {
      return await cache.connectionPromise;
    } finally {
      cache.connectionPromise = null;
    }
  }

  function watchBrowserDisconnect(browser: Browser, mode: BrowserMode) {
    browser.on("disconnected", () => {
      diagnostics.record("browser.disconnected", { mode });
      if (cache.cachedBrowser === browser) {
        cache.cachedBrowser = null;
        cache.selectedPage = null;
        cache.context = null;
        cache.transport = undefined;
      }
    });
  }

  function browserSessionSettings() {
    return {
      mode,
      connected: cache.cachedBrowser?.isConnected() === true,
      busy: !!cache.connectionPromise || !!cache.closePromise || browserControl.changing,
    };
  }

  async function closeBrowserSession() {
    if (cache.closePromise) return cache.closePromise;
    const pending = cache.cleanup || {
      browser: cache.cachedBrowser,
      context: cache.context,
      transport: cache.transport,
    };
    const { browser, context, transport } = pending;
    if (browser || context || transport) cache.cleanup = pending;
    cache.cachedBrowser = null;
    cache.selectedPage = null;
    cache.context = null;
    cache.transport = undefined;
    cache.closePromise = (async () => {
      await cache.hiddenPageCreation;
      if (context) {
        try {
          // 仅清理本项目的私有 context。保留空白会话使 Chrome 原生保留 session cookie，
          // 同时阻止下次启动恢复旧列表/详情页；日常 Chrome 从不经过这条路径。
          if (browser?.isConnected()) {
            const blank = await context.newPage();
            await Promise.all(
              context
                .pages()
                .filter((page) => page !== blank)
                .map((page) => page.close()),
            );
          }
          await context.close();
        } catch (error) {
          diagnostics.record("browser.context_close_error", { error });
          if (browser?.isConnected()) {
            try {
              await browser.close();
            } catch (fallbackError) {
              diagnostics.record("browser.close_error", { error: fallbackError });
              throw error;
            }
          }
          if (browser && !browser.isConnected() && cache.cleanup === pending)
            cache.cleanup = undefined;
          throw error;
        }
        // Playwright may return immediately after an earlier context.close() failed.
        if (browser?.isConnected()) await browser.close();
        if (browser?.isConnected()) throw new Error("项目专用浏览器尚未退出，请重新开始以重试清理");
      }
      // CDP Browser.close disconnects this client; it does not close the user's Chrome.
      else if (browser) await browser.close();
      else transport?.close();
      if (cache.cleanup === pending) cache.cleanup = undefined;
    })();
    try {
      await cache.closePromise;
    } finally {
      cache.closePromise = undefined;
    }
  }

  async function shutdownBrowserSession() {
    cache.closing = true;
    await cache.connectionPromise?.catch(() => {});
    await closeBrowserSession();
  }

  function resetBrowserSessionLifecycle() {
    if (
      cache.closePromise ||
      cache.connectionPromise ||
      cache.cleanup ||
      cache.cachedBrowser?.isConnected()
    )
      throw new Error("旧浏览器会话尚未关闭，不能重新启动本地服务");
    cache.closing = false;
  }

  function getCbgPage(): Page | null {
    return cache.selectedPage && !cache.selectedPage.isClosed() ? cache.selectedPage : null;
  }

  async function createBackgroundPage(browser: Browser): Promise<Page> {
    const existing = getCbgPage();
    if (existing) {
      await ensureWorkViewport(existing);
      registerBrowserEvidence(existing);
      return existing;
    }
    cache.selectedPage = await createHiddenPage(browser);
    return cache.selectedPage;
  }

  function createHiddenPage(browser: Browser): Promise<Page> {
    // Only target creation shares the temporary Playwright compatibility switch.
    const creation = pool.creation.then(() => openHiddenPage(browser));
    cache.hiddenPageCreation = pool.creation = creation.then(
      () => {},
      () => {},
    );
    return creation;
  }

  async function openHiddenPage(browser: Browser): Promise<Page> {
    if (cache.closing || browserControl.changing) throw browserBusyError();
    if (cache.context && cache.cachedBrowser === browser) {
      const page = await cache.context.newPage();
      try {
        await ensureWorkViewport(page);
        registerBrowserEvidence(page);
        await captureBrowserStep(page, { flow: "browser", stage: "page.created" });
        return page;
      } catch (error) {
        await page.close();
        throw error;
      }
    }
    const before = new Set(browser.contexts().flatMap((context) => context.pages()));
    const session = await browser.newBrowserCDPSession();
    let retained = false;
    // Chrome 把隐藏页报告为 other，Playwright 需要此兼容开关才能暴露为 Page。
    // 只在创建期间启用，并且仍按返回的 targetId 绑定自己的工作页。
    const previousAttachOther = process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
    try {
      const visible = showBrowserWorkPages();
      const firstVisible = visible && !getCbgPage();
      // 调试时在独立窗口展示列表，后续详情加入标签栏，供用户直接观察。
      const { targetId } = await session.send("Target.createTarget", {
        url: "about:blank",
        hidden: !visible,
        forTab: false,
        background: !visible,
        focus: visible,
        ...(visible ? { newWindow: firstVisible } : {}),
      });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        for (const page of browser.contexts().flatMap((context) => context.pages())) {
          if (before.has(page) || page.isClosed()) continue;
          const targetSession = await page.context().newCDPSession(page);
          try {
            const { targetInfo } = await targetSession.send("Target.getTargetInfo");
            if (targetInfo.targetId === targetId) {
              await ensureWorkViewport(page);
              registerBrowserEvidence(page);
              await captureBrowserStep(page, { flow: "browser", stage: "page.created" });
              // 隐藏目标的生命周期绑定创建它的会话，不能在返回时 detach。
              retained = true;
              page.once("close", () => {
                if (cache.selectedPage === page) cache.selectedPage = null;
                void session.detach().catch(() => {});
              });
              return page;
            }
          } finally {
            await targetSession.detach();
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      await session.send("Target.closeTarget", { targetId });
      throw new Error("后台工作页创建超时，请重试。");
    } finally {
      if (previousAttachOther === undefined) delete process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
      else process.env.PW_CHROMIUM_ATTACH_TO_OTHER = previousAttachOther;
      if (!retained) await session.detach();
    }
  }

  return {
    getBrowser,
    getCbgPage,
    createBackgroundPage,
    createHiddenPage,
    browserSessionSettings,
    shutdownBrowserSession,
    resetBrowserSessionLifecycle,
    closeBrowserSession,
    hasSessionResources: () =>
      !!(
        cache.cleanup ||
        cache.cachedBrowser?.isConnected() ||
        cache.connectionPromise ||
        cache.closePromise
      ),
    owns: (browser: Browser) => cache.cachedBrowser === browser,
  };
}
function session(mode = getActiveBrowserMode()) {
  return (pool.sessions[mode] ??= createSession(mode));
}
export function getActiveBrowserMode(): BrowserMode {
  return browserSettings().mode;
}
export function getBrowser(allowConnect = false, mode?: BrowserMode) {
  if (mode && mode !== getActiveBrowserMode())
    throw new Error("请先切换浏览器运行方式，再开始查询");
  return session(mode).getBrowser(allowConnect);
}
export const getCbgPage = (mode?: BrowserMode) => session(mode).getCbgPage();
export const createBackgroundPage = (browser: Browser, mode?: BrowserMode) =>
  session(mode).createBackgroundPage(browser);
export function createHiddenPage(browser: Browser): Promise<Page> {
  const owner = Object.values(pool.sessions).find(
    (entry) => entry.browserSessionSettings().connected && entry.owns(browser),
  );
  return (owner || session()).createHiddenPage(browser);
}
export function browserSessionSettings() {
  const modes = [getActiveBrowserMode()];
  const browsers = modes.map((mode) => ({ ...session(mode).browserSessionSettings(), mode }));
  return {
    mode: getActiveBrowserMode(),
    modes,
    browsers,
    connected: browsers.some((entry) => entry.connected),
    busy: pool.closing || browsers.some((entry) => entry.busy),
  };
}
export async function changeBrowserModes(
  modes: BrowserMode[],
  busy: () => boolean,
  reset: () => void,
) {
  if (!isBrowserModes(modes)) throw new Error("请只选择一种浏览器方式");
  if (
    pool.closing ||
    browserControl.changing ||
    busy() ||
    Object.values(pool.sessions).some((entry) => entry.browserSessionSettings().busy)
  )
    throw browserBusyError("查询、采集或分析正在运行，请先暂停并等待任务结束后切换浏览器");
  const previous = browserSettings();
  browserControl.changing = true;
  let saved = false;
  try {
    saveBrowserSettings(modes);
    saved = true;
    reset();
    const results = await Promise.allSettled(
      Object.values(pool.sessions).map((entry) => entry.closeBrowserSession()),
    );
    const errors = results.filter((result) => result.status === "rejected");
    if (errors.length)
      throw new AggregateError(
        errors.map((result) => result.reason),
        String(errors[0].reason),
      );
    pool.sessions = {};
    diagnostics.record("browser.modes_changed", { modes });
  } catch (error) {
    if (saved) {
      try {
        saveBrowserSettings(previous.modes || [previous.mode]);
      } catch (rollbackError) {
        diagnostics.record("browser.mode_rollback_error", { error, rollbackError });
        throw new AggregateError(
          [error, rollbackError],
          `${String(error)}；浏览器运行方式回滚失败`,
        );
      }
    }
    throw error;
  } finally {
    browserControl.changing = false;
  }
}
export function changeBrowserMode(mode: BrowserMode, busy: () => boolean, reset: () => void) {
  return changeBrowserModes([mode], busy, reset);
}
export async function shutdownBrowserSession() {
  pool.closing = true;
  const results = await Promise.allSettled(
    Object.values(pool.sessions).map((entry) => entry.shutdownBrowserSession()),
  );
  const errors = results.filter((result) => result.status === "rejected");
  if (errors.length)
    throw new AggregateError(
      errors.map((result) => result.reason),
      "浏览器连接关闭失败",
    );
}
export function resetBrowserSessionLifecycle() {
  for (const entry of Object.values(pool.sessions)) entry.resetBrowserSessionLifecycle();
  pool.closing = false;
}
export function isCbgUrl(value: string): boolean {
  try {
    return new URL(value).origin === new URL(CBG_HOME_URL).origin;
  } catch {
    return false;
  }
}
