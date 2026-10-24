import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { beginServiceShutdown, resetServiceLifecycle } from "../service-lifecycle";

const mocks = vi.hoisted(() => ({
  createStore: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  crawl: vi.fn(),
  current: vi.fn(),
  roleLimit: vi.fn(),
  roleCount: vi.fn(),
  setRoleLimit: vi.fn(),
  enqueue: vi.fn(),
  detailPage: { close: vi.fn(), setDefaultTimeout: vi.fn() },
}));
vi.mock("./store", () => ({
  CrawlStore: class {
    constructor() {
      mocks.createStore();
    }
    count = () => 42;
    roleLimit = mocks.roleLimit;
    countRoles = mocks.roleCount;
    setRoleLimit = mocks.setRoleLimit;
    checkpoint = () => undefined;
    recent = () => [];
    acquire = mocks.acquire;
    release = mocks.release;
  },
}));
vi.mock("./runner", () => ({ crawl: mocks.crawl, validateCrawlOptions: vi.fn() }));
vi.mock("../cbg", () => ({ checkCbgStatus: mocks.current }));
vi.mock("../session", () => ({
  getCbgPage: () => ({}),
  getBrowser: async () => ({}),
  createHiddenPage: async () => mocks.detailPage,
}));
vi.mock("./source", () => ({ createCrawlSource: () => ({}) }));
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
  mocks.roleLimit.mockReturnValue(undefined);
  mocks.roleCount.mockReturnValue(0);
  mocks.setRoleLimit.mockImplementation((limit) => mocks.roleLimit.mockReturnValue(limit));
  mocks.current.mockResolvedValue({ isLoggedIn: true, running: false, workflowStep: "completed" });
  initial = undefined;
});

it("达到完整角色目标后停止派发，最后一件仍入分析队列，不继续采第4件", async () => {
  const enqueuedRoleCounts: unknown[] = [];
  mocks.enqueue.mockImplementation(() => enqueuedRoleCounts.push(mocks.roleCount()));
  mocks.roleLimit.mockReturnValue(3);
  mocks.crawl.mockImplementation(async (_source, _store, signal: AbortSignal, publish) => {
    for (let saved = 1; saved <= 5; saved++) {
      signal.throwIfAborted();
      mocks.roleCount.mockReturnValue(saved);
      publish({ saved });
      await Promise.resolve();
    }
  });
  const controller = await import("./controller");
  initial = controller;
  const started = await controller.startCrawl();
  await expect(started.activity!.completion).resolves.toMatchObject({
    running: false,
    phase: "completed",
    saved: 3,
    roleLimit: 3,
    totalRoles: 3,
    message: expect.stringContaining("分析继续"),
  });
  await vi.waitFor(() => expect(enqueuedRoleCounts).toContain(3));
  expect(mocks.release).toHaveBeenCalledOnce();
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

it("已达到角色目标时不重新连接 Chrome 或启动采集", async () => {
  mocks.roleLimit.mockReturnValue(500);
  mocks.roleCount.mockReturnValue(500);
  const controller = await import("./controller");
  initial = controller;
  expect(await controller.startCrawl()).toMatchObject({
    started: false,
    status: { phase: "completed" },
  });
  expect(mocks.current).not.toHaveBeenCalled();
  expect(mocks.crawl).not.toHaveBeenCalled();
});
afterEach(async () => {
  const controller = initial ?? (await import("./controller"));
  const activity = controller.crawlActivity();
  controller.stopCrawl();
  await activity?.completion;
  Reflect.deleteProperty(globalThis, key);
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
});

it("模块重载后设置已达目标，原任务仍报告达标完成而非普通暂停", async () => {
  mocks.crawl.mockImplementation(async (_source, _store, signal: AbortSignal) => {
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
  mocks.roleCount.mockReturnValue(3);
  reloaded.setCaptureRoleLimit(3);
  await expect(started.activity!.completion).resolves.toMatchObject({
    running: false,
    phase: "completed",
    roleLimit: 3,
    totalRoles: 3,
    message: expect.stringContaining("分析继续"),
  });
  expect(mocks.release).toHaveBeenCalledOnce();
});
