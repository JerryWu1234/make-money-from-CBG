import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { beginServiceShutdown, resetServiceLifecycle } from "../service-lifecycle";
import { CrawlAccessError } from "./types";
import { LoginRequiredDialogError } from "./login-dialog";

const mocks = vi.hoisted(() => ({
  createStore: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  crawl: vi.fn(),
  current: vi.fn(),
  enqueue: vi.fn(),
  getBrowser: vi.fn(),
  headRefresh: vi.fn(),
  watchLogin: vi.fn(),
  disposeLogin: vi.fn(),
  listPage: { close: vi.fn() },
  detailPage: { close: vi.fn(), setDefaultTimeout: vi.fn() },
}));
vi.mock("./store", () => ({
  CrawlStore: class {
    constructor() {
      mocks.createStore();
    }
    count = () => 42;
    checkpoint = () => undefined;
    pageReviews = () => [];
    recent = () => [];
    latestComplete = () => ({ key: "1:latest", collectedAt: "2026-10-25T05:00:20.000Z" });
    acquire = mocks.acquire;
    release = mocks.release;
  },
}));
vi.mock("./runner", () => ({ crawl: mocks.crawl, validateCrawlOptions: vi.fn() }));
vi.mock("./head-refresh-settings", () => ({ headRefreshSettings: mocks.headRefresh }));
vi.mock("../cbg", () => ({ checkCbgStatus: mocks.current }));
vi.mock("../session", () => ({
  getCbgPage: () => mocks.listPage,
  getBrowser: mocks.getBrowser,
  createHiddenPage: async () => mocks.detailPage,
}));
vi.mock("./source", () => ({ createCrawlSource: () => ({}) }));
vi.mock("./access-guard", () => ({ watchCrawlAccess: mocks.watchLogin }));
vi.mock("../analysis/controller", () => ({ appendCapturedAnalysis: mocks.enqueue }));
vi.mock("../diagnostics", () => ({ diagnostics: { record: vi.fn() }, watchWorkPage: vi.fn() }));

const key = Symbol.for("cbg.crawl-runtime.v1");
let initial: typeof import("./controller") | undefined;
beforeEach(() => {
  resetServiceLifecycle();
  Reflect.deleteProperty(globalThis, key);
  vi.resetModules();
  vi.clearAllMocks();
  mocks.acquire.mockReturnValue(true);
  mocks.headRefresh.mockReturnValue({ intervalSeconds: 600, random: true, listingAgeMinutes: 3 });
  mocks.current.mockResolvedValue({ isLoggedIn: true, running: false, workflowStep: "completed" });
  mocks.getBrowser.mockResolvedValue({ isConnected: () => true });
  mocks.watchLogin.mockResolvedValue(mocks.disposeLogin);
  initial = undefined;
});

it.each(["manual", "scheduled"] as const)("%s 启动将已保存的刷新配置传给采集器", async (origin) => {
  mocks.crawl.mockResolvedValue(undefined);
  const controller = await import("./controller");
  initial = controller;
  const result = await controller.startCrawl(origin);
  await result.activity!.completion;
  expect(mocks.crawl.mock.calls[0][4]).toMatchObject({
    headRefresh: { intervalSeconds: 600, random: true, listingAgeMinutes: 3 },
  });
});

it("重新开始使用当前分钟范围，不沿用上一轮的计划或实际刷新时间", async () => {
  mocks.crawl.mockImplementationOnce(async (_source, _store, _signal, publish) => {
    publish({
      nextHeadCheckAt: "2026-11-10T05:23:10.000Z",
      lastHeadRefreshAt: "2026-11-10T05:20:10.000Z",
    });
  });
  const controller = await import("./controller");
  initial = controller;
  const first = await controller.startCrawl();
  await first.activity!.completion;
  mocks.headRefresh.mockReturnValue({ intervalSeconds: 180, random: false, listingAgeMinutes: 5 });
  mocks.crawl.mockResolvedValueOnce(undefined);
  const second = await controller.startCrawl();
  await second.activity!.completion;
  expect(controller.crawlStatus()).toMatchObject({
    headRefresh: { intervalSeconds: 180, random: false, listingAgeMinutes: 5 },
    nextHeadCheckAt: undefined,
    lastHeadRefreshAt: undefined,
  });
});

it("浏览器检查期间开始关停，不会在检查返回后启动采集", async () => {
  mocks.current.mockImplementation(async () => {
    beginServiceShutdown();
    return { isLoggedIn: true, running: false, workflowStep: "completed" };
  });
  const controller = await import("./controller");
  initial = controller;
  await expect(controller.startCrawl()).rejects.toThrow("正在关闭");
  expect(mocks.crawl).not.toHaveBeenCalled();
  expect(mocks.acquire).not.toHaveBeenCalled();
});

it.each(["login", "verification", "busy"] as const)(
  "访问状态 %s 明确暂停而非执行异常，保留进度",
  async (kind) => {
    mocks.crawl.mockImplementation(async (_source, _store, _signal, publish) => {
      publish({ page: 3, saved: 5 });
      throw new CrawlAccessError(kind);
    });
    const controller = await import("./controller");
    initial = controller;
    const started = await controller.startCrawl();
    await expect(started.activity!.completion).resolves.toMatchObject({
      phase: "paused",
      running: false,
      page: 3,
      saved: 5,
      accessIssue: kind,
      error: undefined,
    });
    expect(controller.crawlStatus().message).toContain("暂停");
    expect(mocks.release).toHaveBeenCalledOnce();
  },
);

it.each([
  ["list", "login"],
  ["detail", "login"],
  ["list", "verification"],
  ["detail", "verification"],
  ["list", "busy"],
  ["detail", "busy"],
] as const)("%s 页发现 %s 立即取消整轮并保留访问原因", async (kind, issue) => {
  let readingSignal: AbortSignal | undefined;
  mocks.crawl.mockImplementation(async (_source, _store, signal: AbortSignal, publish) => {
    readingSignal = signal;
    publish({ page: 3, saved: 5 });
    await new Promise<void>((_resolve, reject) => {
      // Closing a page may replace the browser error; controller must retain the login reason.
      signal.addEventListener("abort", () => reject(new Error("Target page closed")), {
        once: true,
      });
    });
  });
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "1");
  const controller = await import("./controller");
  initial = controller;
  const started = await controller.startCrawl();
  await vi.waitFor(() => expect(mocks.crawl).toHaveBeenCalledOnce());
  const target = kind === "list" ? mocks.listPage : mocks.detailPage;
  const call = mocks.watchLogin.mock.calls.find(([page]) => page === target)!;
  const reason = issue === "login" ? new LoginRequiredDialogError() : new CrawlAccessError(issue);
  call[2](reason);
  expect(readingSignal?.aborted).toBe(true);
  expect(mocks.listPage.close).toHaveBeenCalledOnce();
  expect(mocks.detailPage.close).toHaveBeenCalled();
  await expect(started.activity!.completion).resolves.toMatchObject({
    phase: "paused",
    running: false,
    accessIssue: issue,
    page: 3,
    saved: 5,
    message: reason.message,
    error: undefined,
  });
  expect(mocks.disposeLogin).toHaveBeenCalledTimes(2);
  expect(mocks.release).toHaveBeenCalledOnce();
});

it("连续三件失败立即取消，保留失败原因和计数，不等待在途浏览器超时", async () => {
  mocks.crawl.mockImplementation(async (_source, _store, signal: AbortSignal, publish) => {
    publish({ page: 4, saved: 2, failed: 1 });
    expect(signal.aborted).toBe(false);
    publish({ failed: 2 });
    expect(signal.aborted).toBe(false);
    publish({ failed: 3 });
    expect(signal.aborted).toBe(true);
    throw new Error("Target page closed");
  });
  const controller = await import("./controller");
  initial = controller;
  const started = await controller.startCrawl();
  await expect(started.activity!.completion).resolves.toMatchObject({
    phase: "paused",
    running: false,
    page: 4,
    saved: 2,
    failed: 3,
    message: expect.stringContaining("连续 3 件采集失败"),
    error: undefined,
  });
  expect(mocks.listPage.close).toHaveBeenCalledOnce();
  expect(mocks.detailPage.close).toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledOnce();
});

it.each(["disconnected", "input_unavailable"])(
  "浏览器%s作为整轮暂停，保留计数并明确原因",
  async (kind) => {
    mocks.crawl.mockImplementation(async (_source, _store, _signal, publish) => {
      publish({ page: 3, saved: 5 });
      throw Object.assign(new Error("Chrome 调试连接已断开，采集已暂停"), {
        name: "BrowserConnectionError",
        kind,
      });
    });
    const controller = await import("./controller");
    initial = controller;
    const started = await controller.startCrawl();
    await expect(started.activity!.completion).resolves.toMatchObject({
      phase: "paused",
      running: false,
      page: 3,
      saved: 5,
      error: undefined,
      browserIssue: kind,
    });
    expect(mocks.release).toHaveBeenCalledOnce();
  },
);

it("已登录列表核验后连接消失，创建详情页时暂停且不自动重连", async () => {
  mocks.getBrowser.mockRejectedValueOnce(new Error("浏览器未连接"));
  const controller = await import("./controller");
  initial = controller;
  const started = await controller.startCrawl();
  await expect(started.activity!.completion).resolves.toMatchObject({
    phase: "paused",
    running: false,
    browserIssue: "disconnected",
    failed: 0,
  });
  expect(mocks.getBrowser).toHaveBeenCalledExactlyOnceWith(false);
  expect(mocks.crawl).not.toHaveBeenCalled();
  expect(mocks.release).toHaveBeenCalledOnce();
});

afterEach(async () => {
  const controller = initial ?? (await import("./controller"));
  const activity = controller.crawlActivity();
  controller.stopCrawl();
  await activity?.completion;
  Reflect.deleteProperty(globalThis, key);
  vi.unstubAllEnvs();
});

it("开启原始工作页显示时，采集停止后保留详情页供人工核对", async () => {
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "1");
  mocks.crawl.mockResolvedValue(undefined);
  const controller = await import("./controller");
  initial = controller;
  const started = await controller.startCrawl();
  await started.activity!.completion;
  expect(mocks.detailPage.close).not.toHaveBeenCalled();
});

it("模块重载保留采集进度、同一个在途任务和暂停控制器，不会重复启动", async () => {
  mocks.crawl.mockImplementation(async (_source, _store, signal: AbortSignal, publish) => {
    publish({ page: 8, totalPages: 100, message: "正在采集第8页" });
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const original = await import("./controller");
  initial = original;
  const started = await original.startCrawl();
  await vi.waitFor(() => expect(mocks.crawl).toHaveBeenCalledOnce());
  vi.resetModules();
  const reloaded = await import("./controller");
  expect(reloaded.crawlStatus()).toMatchObject({ running: true, page: 8, totalSaved: 42 });
  expect(reloaded.crawlActivity()).toBe(started.activity);
  expect(await reloaded.startCrawl()).toMatchObject({ started: false, activity: started.activity });
  expect(mocks.acquire).toHaveBeenCalledOnce();
  expect(mocks.createStore).toHaveBeenCalledOnce();
  reloaded.stopCrawl();
  await expect(started.activity!.completion).resolves.toMatchObject({
    running: false,
    phase: "paused",
    page: 8,
  });
  expect(reloaded.isCrawling()).toBe(false);
  expect(reloaded.crawlActivity()).toBeNull();
  expect(mocks.release).toHaveBeenCalledOnce();
  expect(mocks.detailPage.close).toHaveBeenCalledOnce();
});

it("完成后的状态不会因模块重载回到初始页", async () => {
  mocks.crawl.mockImplementation(async (_source, _store, _signal, publish) => {
    publish({
      running: false,
      phase: "completed",
      page: 100,
      totalPages: 100,
      message: "本轮完成",
    });
  });
  const original = await import("./controller");
  initial = original;
  const started = await original.startCrawl();
  await started.activity!.completion;
  vi.resetModules();
  const reloaded = await import("./controller");
  expect(reloaded.crawlStatus()).toMatchObject({
    running: false,
    phase: "completed",
    page: 100,
    message: "本轮完成",
  });
  expect(reloaded.crawlActivity()).toBeNull();
  expect(mocks.createStore).toHaveBeenCalledOnce();
  expect(reloaded.crawlStatus().latestComplete).toEqual({
    key: "1:latest",
    collectedAt: "2026-10-25T05:00:20.000Z",
  });
});
