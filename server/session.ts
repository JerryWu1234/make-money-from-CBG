import { chromium, type Browser, type Page } from "playwright-core";
import { CONNECTION_HELP, resolveCdpEndpoint } from "./chrome";
import { CBG_HOME_URL } from "./config";
import { ensureWorkViewport } from "./viewport";
import { openWorkTransport, type WorkTransport } from "./work-transport";
import { diagnostics } from "./diagnostics";

type BrowserSession = {
  cachedBrowser: Browser | null;
  connectionPromise: Promise<Browser> | null;
  selectedPage: Page | null;
  hiddenPageCreation: Promise<void>;
};
// Vite reloads the API modules in the same process; keep only our own work session.
const sessionKey = Symbol.for("cbg.browser-session.v1");
const runtime = globalThis as typeof globalThis & { [sessionKey]?: BrowserSession };
const cache = (runtime[sessionKey] ??= {
  cachedBrowser: null,
  connectionPromise: null,
  selectedPage: null,
  hiddenPageCreation: Promise.resolve(),
});

export function isCbgUrl(value: string): boolean {
  try {
    return new URL(value).origin === new URL(CBG_HOME_URL).origin;
  } catch {
    return false;
  }
}

export async function getBrowser(allowConnect = false): Promise<Browser> {
  if (cache.cachedBrowser?.isConnected()) return cache.cachedBrowser;
  if (!allowConnect) throw new Error(`浏览器未连接。${CONNECTION_HELP}`);
  if (cache.connectionPromise) return cache.connectionPromise;
  cache.connectionPromise = (async () => {
    const endpoint = await resolveCdpEndpoint();
    let transport: WorkTransport | undefined;
    let stage = "handshake";
    try {
      diagnostics.record("browser.endpoint_resolved", { port: Number(new URL(endpoint).port) });
      transport = await openWorkTransport(endpoint);
      stage = "initializing";
      diagnostics.record("browser.websocket_connected");
      const browser = await chromium.connectOverCDP(transport, {
        timeout: 15000,
        noDefaults: true,
      });
      cache.cachedBrowser = browser;
      browser.on("disconnected", () => {
        if (cache.cachedBrowser === browser) {
          cache.cachedBrowser = null;
          cache.selectedPage = null;
        }
      });
      return browser;
    } catch (error) {
      transport?.close();
      diagnostics.record("browser.connection_error", { stage, error });
      throw new Error(
        stage === "initializing"
          ? "已连接 Chrome 调试服务，但初始化工作连接失败。请重试，并查看运行日志中的 browser.connection_error。"
          : `Chrome 调试连接尚未建立。${CONNECTION_HELP}`,
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

export function getCbgPage(): Page | null {
  return cache.selectedPage && !cache.selectedPage.isClosed() ? cache.selectedPage : null;
}

export async function createBackgroundPage(browser: Browser): Promise<Page> {
  const existing = getCbgPage();
  if (existing) {
    await ensureWorkViewport(existing);
    return existing;
  }
  cache.selectedPage = await createHiddenPage(browser);
  return cache.selectedPage;
}

export function createHiddenPage(browser: Browser): Promise<Page> {
  // Only target creation shares the temporary Playwright compatibility switch.
  const creation = cache.hiddenPageCreation.then(() => openHiddenPage(browser));
  cache.hiddenPageCreation = creation.then(
    () => {},
    () => {},
  );
  return creation;
}

async function openHiddenPage(browser: Browser): Promise<Page> {
  const before = new Set(browser.contexts().flatMap((context) => context.pages()));
  const session = await browser.newBrowserCDPSession();
  let retained = false;
  // Chrome 把隐藏页报告为 other，Playwright 需要此兼容开关才能暴露为 Page。
  // 只在创建期间启用，并且仍按返回的 targetId 绑定自己的工作页。
  const previousAttachOther = process.env.PW_CHROMIUM_ATTACH_TO_OTHER;
  process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
  try {
    // 同一日常配置内创建隐藏页面，不创建可见窗口或标签页。
    const { targetId } = await session.send("Target.createTarget", {
      url: "about:blank",
      hidden: true,
      forTab: false,
      background: true,
      focus: false,
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
