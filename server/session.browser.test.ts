// 真实 Playwright 会话集成回归：只启动临时专用配置，全部业务页面请求使用模拟响应。
// 不连接日常 Chrome、不使用 data/browser-profile，也不验证藏宝阁登录有效期。
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  openDedicatedBrowser: vi.fn(),
  browserSettings: vi.fn(),
  saveBrowserSettings: vi.fn(),
  resolveCdpEndpoint: vi.fn(),
  verifyCdpEndpoint: vi.fn(),
  screenshotsEnabled: vi.fn(),
  evidenceDirectory: vi.fn(),
  record: vi.fn(),
  browserControl: { changing: false, pending: 0 },
}));
vi.mock("./browser-settings", async (original) => ({
  ...(await original<typeof import("./browser-settings")>()),
  browserSettings: mocks.browserSettings,
  saveBrowserSettings: mocks.saveBrowserSettings,
  browserControl: mocks.browserControl,
}));
vi.mock("./dedicated-browser", () => ({ openDedicatedBrowser: mocks.openDedicatedBrowser }));
vi.mock("./chrome", async (original) => ({
  ...(await original<typeof import("./chrome")>()),
  resolveCdpEndpoint: mocks.resolveCdpEndpoint,
  verifyCdpEndpoint: mocks.verifyCdpEndpoint,
}));
vi.mock("./runtime-settings", () => ({ screenshotsEnabled: mocks.screenshotsEnabled }));
vi.mock("./diagnostics", async (original) => ({
  ...(await original<typeof import("./diagnostics")>()),
  diagnostics: { record: mocks.record, evidenceDirectory: mocks.evidenceDirectory },
}));

const runtime = globalThis as typeof globalThis & Record<symbol, unknown>;
const sessionKey = Symbol.for("cbg.browser-session.v1");

beforeEach(() => {
  delete runtime[sessionKey];
  vi.resetModules();
  vi.resetAllMocks();
  mocks.browserSettings.mockReturnValue({ mode: "dedicated" });
  mocks.screenshotsEnabled.mockReturnValue(false);
  mocks.browserControl.changing = false;
  mocks.browserControl.pending = 0;
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
  delete runtime[sessionKey];
});

it("并发连接与建页共享专用会话，context 关闭失败后真实 Browser.close 兜底并可重开", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cbg-session-browser-regression-"));
  const profile = path.join(root, "dedicated-profile");
  const artifacts = path.resolve("artifacts/session-browser-regression");
  const contexts = new Set<BrowserContext>();
  const browsers = new Set<Browser>();
  const origin = "http://session-cbg.test";
  let failed = false;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    await mkdir(artifacts, { recursive: true });
    const evidence = await mkdtemp(path.join(artifacts, "run-"));
    mocks.evidenceDirectory.mockReturnValue(evidence);
    const real = await vi.importActual<typeof import("./dedicated-browser")>("./dedicated-browser");
    mocks.openDedicatedBrowser.mockImplementation(async () => {
      const context = await real.openDedicatedBrowser(profile);
      contexts.add(context);
      const browser = context.browser();
      if (browser) browsers.add(browser);
      await context.route("**/*", (route) => {
        if (new URL(route.request().url()).origin !== origin) return route.abort();
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<meta charset="utf-8"><style>body{font:24px sans-serif;padding:48px;background:#142538;color:#e9f4fa}</style><h1>专用会话集成回归</h1><p>列表页、详情页共享同一持久上下文</p><p>全拦截模拟页面，不访问真实网站</p>`,
        });
      });
      return context;
    });
    const session = await import("./session");
    const [browser, concurrent] = await Promise.all([
      session.getBrowser(true),
      session.getBrowser(true),
    ]);
    expect(concurrent).toBe(browser);
    expect(mocks.openDedicatedBrowser).toHaveBeenCalledOnce();
    expect(await session.getBrowser()).toBe(browser);
    const context = [...contexts][0];
    expect(browser.contexts()).toEqual([context]);
    const dailyTarget = vi.spyOn(browser, "newBrowserCDPSession");
    const list = await session.createBackgroundPage(browser);
    const detail = await session.createHiddenPage(browser);
    expect(list).not.toBe(detail);
    expect(list.context()).toBe(context);
    expect(detail.context()).toBe(context);
    expect(await session.createBackgroundPage(browser)).toBe(list);
    expect(session.getCbgPage()).toBe(list);
    await Promise.all([
      list.goto(`${origin}/list`, { waitUntil: "domcontentloaded" }),
      detail.goto(`${origin}/detail`, { waitUntil: "domcontentloaded" }),
    ]);
    await detail.screenshot({ path: path.join(evidence, "shared-persistent-context.png") });
    expect(dailyTarget).not.toHaveBeenCalled();
    expect(mocks.resolveCdpEndpoint).not.toHaveBeenCalled();
    expect(mocks.verifyCdpEndpoint).not.toHaveBeenCalled();
    expect(mocks.screenshotsEnabled).toHaveBeenCalled();

    const closeError = new Error("模拟 context.close 首次失败");
    const contextClose = vi.spyOn(context, "close").mockRejectedValueOnce(closeError);
    const browserClose = vi.spyOn(browser, "close");
    await expect(session.shutdownBrowserSession()).rejects.toMatchObject({
      name: "AggregateError",
      errors: [closeError],
    });
    expect(contextClose).toHaveBeenCalledOnce();
    expect(browserClose).toHaveBeenCalledOnce();
    expect(browser.isConnected()).toBe(false);
    expect(list.isClosed()).toBe(true);
    expect(detail.isClosed()).toBe(true);
    expect(session.getCbgPage()).toBeNull();
    expect(mocks.record).toHaveBeenCalledWith("browser.context_close_error", {
      error: closeError,
    });
    contextClose.mockRestore();
    browserClose.mockRestore();

    session.resetBrowserSessionLifecycle();
    const restarted = await session.getBrowser(true);
    expect(restarted).not.toBe(browser);
    expect(restarted.isConnected()).toBe(true);
    expect(mocks.openDedicatedBrowser).toHaveBeenCalledTimes(2);
    const reopened = await session.createBackgroundPage(restarted);
    await reopened.goto(`${origin}/reopened`, { waitUntil: "domcontentloaded" });
    expect(await reopened.locator("h1").innerText()).toBe("专用会话集成回归");
    await session.shutdownBrowserSession();
    expect(restarted.isConnected()).toBe(false);
    session.resetBrowserSessionLifecycle();
  } catch (error) {
    failed = true;
    primaryError = error;
  } finally {
    vi.restoreAllMocks();
    const closed = await Promise.allSettled([...contexts].map((context) => context.close()));
    cleanupErrors.push(
      ...closed.filter((result) => result.status === "rejected").map((result) => result.reason),
    );
    const disconnected = await Promise.allSettled(
      [...browsers].filter((browser) => browser.isConnected()).map((browser) => browser.close()),
    );
    cleanupErrors.push(
      ...disconnected
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason),
    );
    try {
      await rm(root, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  const cleanupError = cleanupErrors.length
    ? new AggregateError(cleanupErrors, "专用会话集成测试清理失败")
    : undefined;
  if (failed) {
    if (cleanupError) console.error(cleanupError);
    throw primaryError;
  }
  if (cleanupError) throw cleanupError;
}, 90_000);
