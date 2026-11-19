import { afterEach, expect, it, vi } from "vite-plus/test";
import { CrawlStore } from "./store";
import { officialGovernor } from "../official-access";
const f = vi.hoisted(() => ({
  idle: false,
  stopped: false,
  crawl: vi.fn(),
  enqueue: vi.fn(),
  adapter: undefined as any,
}));
vi.mock("../browser-settings", () => ({
  browserSettings: () => ({ accessAdapter: "extension-native" }),
}));
vi.mock("../native-access", () => ({
  nativeAccess: async () => f.adapter,
  nativeAccessOwner: () => ({ owner: "native", fence: 1, expiresAt: Date.now() + 100000 }),
}));
vi.mock("../adapters/native-query-health", () => ({
  bindNativeCrawlSource: () => ({ source: {}, context: () => undefined }),
}));
vi.mock("./runner", () => ({ crawl: f.crawl, validateCrawlOptions: () => {} }));
vi.mock("../analysis/controller", () => ({ appendCapturedAnalysis: f.enqueue }));
vi.mock("./head-refresh-settings", () => ({
  headRefreshSettings: () => ({ intervalSeconds: 60, random: false }),
}));
const stores: CrawlStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  Reflect.deleteProperty(globalThis, Symbol.for("cbg.crawl-runtime.v1"));
});

async function fixture() {
  vi.resetModules();
  vi.clearAllMocks();
  f.idle = false;
  f.stopped = false;
  const store = new CrawlStore(":memory:");
  stores.push(store);
  Reflect.set(globalThis, Symbol.for("cbg.crawl-runtime.v1"), {
    storage: store,
    status: { running: false, phase: "idle", saved: 0, skipped: 0 },
    abort: null,
    activeRun: null,
  });
  f.adapter = {
    snapshot: async () => ({
      listing: { page: 1, totalPages: 1, order: "selling_time DESC", items: [] },
      access: "normal",
      authenticated: true,
      loading: false,
    }),
    status: () => ({ stopped: f.stopped, idle: f.idle }),
    finishRun: vi.fn(async () => {
      f.stopped = true;
      f.idle = true;
    }),
    resumeForRun: vi.fn(async () => {
      f.stopped = false;
      f.idle = false;
    }),
  };
  return { store, controller: await import("./controller") };
}

it.each(["completed", "time_limit"])(
  "T14 原生%s结束后，后续正常计划任务重新核验并启动",
  async (kind) => {
    const { store, controller } = await fixture();
    f.crawl.mockImplementationOnce(async (_source, _db, signal: AbortSignal, publish) => {
      if (kind === "time_limit")
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      publish({ phase: "completed", running: false });
    });
    const first = await controller.startCrawl("scheduled");
    if (kind === "time_limit") {
      await vi.waitFor(() => expect(f.crawl).toHaveBeenCalledOnce());
      controller.stopCrawl("time_limit");
    }
    await first.activity!.completion;
    expect(officialGovernor(store.db).read().state).toBe("ready");
    expect(f.adapter.finishRun).toHaveBeenCalledOnce();
    expect(f.idle).toBe(true);
    f.crawl.mockResolvedValueOnce(undefined);
    const second = await controller.startCrawl("scheduled");
    expect(second.started).toBe(true);
    await second.activity!.completion;
    expect(f.adapter.resumeForRun).toHaveBeenCalledOnce();
    expect(f.adapter.finishRun).toHaveBeenCalledTimes(2);
  },
);

it("T14 原生结束通路失败仍释放业务租约并结束当前activity", async () => {
  const { store, controller } = await fixture();
  f.crawl.mockResolvedValueOnce(undefined);
  f.adapter.finishRun.mockRejectedValueOnce(new Error("host unavailable"));
  const first = await controller.startCrawl("scheduled");
  await expect(first.activity!.completion).resolves.toMatchObject({
    running: false,
    phase: "paused",
    message: "host unavailable",
  });
  expect(controller.isCrawling()).toBe(false);
  expect(store.acquire("next")).toBe(true);
});

it("T14 原生完整采集增加saved时及时通知跟随分析，不因普通状态更新重复通知", async () => {
  const { controller } = await fixture();
  f.crawl.mockImplementationOnce(async (_source, _db, _signal, publish) => {
    publish({ saved: 1 });
    publish({ saved: 1, page: 2 });
  });
  const first = await controller.startCrawl();
  await first.activity!.completion;
  await vi.waitFor(() => expect(f.enqueue).toHaveBeenCalledOnce());
});

it("T21 原生通路明确拒绝不支持的并发，不静默覆盖用户配置", async () => {
  const { controller } = await fixture();
  await expect(controller.startCrawl("manual", undefined, { concurrency: 2 })).rejects.toThrow(
    "只支持并发 1",
  );
  expect(f.crawl).not.toHaveBeenCalled();
});
