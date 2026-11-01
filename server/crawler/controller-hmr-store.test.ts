import { afterEach, expect, it, vi } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "./store";

vi.mock("./runner", () => ({ crawl: vi.fn(), validateCrawlOptions: vi.fn() }));
vi.mock("../cbg", () => ({ checkCbgStatus: vi.fn() }));
vi.mock("../session", () => ({
  getCbgPage: vi.fn(),
  getBrowser: vi.fn(),
  createHiddenPage: vi.fn(),
}));
vi.mock("./source", () => ({ createCrawlSource: vi.fn() }));
vi.mock("../analysis/controller", () => ({ appendCapturedAnalysis: vi.fn() }));
vi.mock("../diagnostics", () => ({ diagnostics: { record: vi.fn() }, watchWorkPage: vi.fn() }));

const key = Symbol.for("cbg.crawl-runtime.v1");
afterEach(() => {
  Reflect.deleteProperty(globalThis, key);
  vi.resetModules();
});

it("模块重载升级旧采集存储时保留连接、采集控制器、在途任务和已有数据", async () => {
  const store = new CrawlStore(":memory:");
  try {
    const record = analysisRecord("retained-during-hmr");
    store.observe(record.listing);
    expect(store.save(record.listing, record.detail!)).toBe(true);
    expect(store.acquire("active-crawl")).toBe(true);
    const db = store.db;
    // Simulate the live instance/schema from before duplicate-page reviews existed.
    db.exec("ALTER TABLE crawl_state DROP COLUMN page_reviews_json");
    Reflect.deleteProperty(store, "pageReviewSchemaReady");
    const abort = new AbortController();
    const activeRun = {
      origin: "manual",
      startedAt: Date.now(),
      completion: new Promise(() => {}),
    };
    const runtime = {
      storage: store,
      abort,
      activeRun,
      status: {
        running: true,
        phase: "collecting",
        page: 40,
        totalPages: 100,
        saved: 1,
        skipped: 0,
        totalSaved: 1,
        message: "正在采集",
        database: ":memory:",
      },
    };
    Reflect.set(globalThis, key, runtime);
    vi.resetModules();
    const controller = await import("./controller");
    const current = await import("./store");
    expect(Object.getPrototypeOf(store)).not.toBe(current.CrawlStore.prototype);
    expect(controller.crawlStatus()).toMatchObject({
      running: true,
      page: 40,
      saved: 1,
      totalSaved: 1,
      pageReviews: [],
    });
    expect(Object.getPrototypeOf(store)).toBe(current.CrawlStore.prototype);
    expect(runtime.storage).toBe(store);
    expect(controller.crawlDatabase()).toBe(db);
    expect(controller.crawlActivity()).toBe(activeRun);
    expect(store.acquire("another-crawl")).toBe(false);
    store.deferPageReview("expire_time DESC", 41, "1:old");
    expect(controller.crawlStatus().pageReviews).toEqual([
      expect.objectContaining({ order: "expire_time DESC", page: 41 }),
    ]);
    expect(controller.savedDetail(record.listing.key)).toMatchObject({ status: "complete" });
    controller.stopCrawl();
    expect(abort.signal.aborted).toBe(true);
    expect(controller.crawlActivity()).toBe(activeRun);
  } finally {
    store.close();
  }
});
