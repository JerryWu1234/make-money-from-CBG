import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CrawlStore } from "./store";
import { crawl } from "./runner";
import { CAPTURE_VERSION } from "./compact";
import { isRecentListing } from "./head-refresh";
import {
  SellingOrderUnavailableError,
  type CrawlSource,
  type CrawlStatus,
  type Listing,
  type RoleDetail,
} from "./types";

// Failure modes: page limit survives; saved watermark excludes recent roles;
// stale retry jobs still run; missing times accepted; boundary closes active
// detail reads; refresh stops permanently; saved records are lost on resume.
const runs: Array<{ db: CrawlStore; stop: () => Promise<void> }> = [];
const row = (id: number, ageMinutes: number): Listing => {
  const time = new Date(Date.now() - ageMinutes * 60_000).toISOString();
  return {
    key: `1:${id}`,
    serverId: "1",
    eid: String(id),
    ordersn: String(id),
    url: `https://xyq.cbg.163.com/equip?s=1&eid=${id}`,
    sellingTime: time,
    createdTime: time,
    orderTime: time,
    name: String(id),
    price: "100",
    attrs: {},
    summary: null,
  };
};
const detail = (item: Listing): RoleDetail => ({
  captureVersion: CAPTURE_VERSION,
  url: item.url,
  collectedAt: new Date().toISOString(),
  tabs: [],
  raw: {},
  equipmentCapture: {
    version: 1,
    collectedAt: new Date().toISOString(),
    complete: true,
    issues: [],
    emptyProof: "official-containers",
  },
  petCapture: { version: 1, collectedAt: new Date().toISOString(), complete: true, issues: [] },
});
function start(pages: Listing[][], order = "selling_time DESC", db = new CrawlStore(":memory:")) {
  const read = (page: number) => ({
    page,
    totalPages: pages.length,
    order,
    items: pages[page - 1]!,
  });
  const source: CrawlSource = {
    prepare: vi.fn(async (requested) => {
      if (requested === "selling_time DESC" && order !== requested)
        throw new SellingOrderUnavailableError();
      return read(1);
    }),
    refresh: vi.fn(async () => read(1)),
    page: vi.fn(async (page) => read(page)),
    onShelf: vi.fn(async () => true),
    hover: vi.fn(async (item) => item),
    detail: vi.fn(async (item) => detail(item)),
  };
  const states: Partial<CrawlStatus>[] = [];
  const control = new AbortController();
  let outcome: Promise<unknown> | undefined;
  const run = () =>
    (outcome = crawl(source, db, control.signal, (state) => states.push(state), {
      watch: true,
      concurrency: 2,
      headRefresh: { intervalSeconds: 120, random: false, listingAgeMinutes: 10 },
    }).catch((error: unknown) => error));
  const stop = async () => {
    control.abort(new Error("测试暂停"));
    await outcome;
  };
  runs.push({ db, stop });
  return { db, source, states, run, stop };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-10T03:00:00Z"));
});
afterEach(async () => {
  const finished = runs.splice(0);
  for (const run of finished) await run.stop();
  for (const db of new Set(finished.map((run) => run.db))) db.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("按真实上架时间包含恰好10分钟的边界，缺失时间不能当作新上架", () => {
  const now = Date.now();
  expect(isRecentListing(new Date(now - 600_000).toISOString(), 10, now)).toBe(true);
  expect(isRecentListing(new Date(now - 600_001).toISOString(), 10, now)).toBe(false);
  expect(isRecentListing(null, 10, now)).toBe(false);
  expect(isRecentListing("invalid", 10, now)).toBe(false);
});

it.each(["selling_time DESC", "expire_time DESC"])(
  "%s：遇到第一条超窗角色停止，不悬停或继续翻页",
  async (order) => {
    const current = row(1, 2),
      boundary = row(2, 10),
      old = row(3, 10 + 1 / 60_000),
      behind = row(4, 1);
    const run = start([[current, boundary, old], [behind]], order);
    void run.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.db.count()).toBe(2);
    expect(run.source.hover).toHaveBeenCalledTimes(2);
    expect(run.source.page).not.toHaveBeenCalled();
    expect(run.db.hasListing(old.key)).toBe(false);
    expect(run.states.some((state) => state.message?.includes("等待下次刷新"))).toBe(true);
    expect(run.db.backfillComplete()).toBe(false);
  },
);

it("等待设定刷新时间后从首页采集新出现的角色，已保存商品不重复读取", async () => {
  const original = row(1, 2),
    old = row(2, 11);
  const run = start([[original, old]], "expire_time DESC");
  void run.run();
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(119_999);
  expect(run.source.refresh).not.toHaveBeenCalled();
  const added = row(3, 0);
  vi.mocked(run.source.refresh!).mockResolvedValue({
    page: 1,
    totalPages: 1,
    order: "expire_time DESC",
    items: [added, original, old],
  });
  await vi.advanceTimersByTimeAsync(1);
  expect(run.source.refresh).toHaveBeenCalledOnce();
  expect(run.db.count()).toBe(2);
  expect(run.source.detail).toHaveBeenCalledTimes(2);
});

it("已有旧水位也执行时间窗口；范围内可以超过5页，第一条超窗处即停", async () => {
  const recent = Array.from({ length: 6 }, (_, index) => row(index + 1, index + 1));
  const run = start(
    [...recent.map((item) => [item]), [row(7, 11)], [row(8, 1)]],
    "expire_time DESC",
  );
  run.db.setHeadCheckpoint({
    time: new Date().toISOString(),
    keys: ["old-watermark"],
    mode: "latest-only",
  });
  void run.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(run.db.count()).toBe(6);
  expect(vi.mocked(run.source.page).mock.calls.map(([page]) => page)).toEqual([2, 3, 4, 5, 6, 7]);
  expect(run.db.hasListing("1:8")).toBe(false);
});

it("自动继续保留超窗旧任务但不派发，窗口内待补任务仍可完成", async () => {
  const pending = row(1, 1),
    expired = row(2, 20);
  const run = start([[pending, expired]]);
  run.db.observe(pending, "old");
  run.db.observe(expired, "old");
  void run.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(run.source.detail).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ key: pending.key }),
  );
  expect(run.db.detail(expired.key)).toMatchObject({ status: "pending" });
  expect(
    run.db.db.prepare("SELECT attempt_count FROM listings WHERE key=?").get(expired.key)
      ?.attempt_count,
  ).toBe(0);
});

it("队列等待期间超窗不再派发，已经在途的详情仍完整保存", async () => {
  const run = start([[row(1, 9.99), row(2, 9.99), row(3, 9.99), row(4, 11)]]);
  const release: Array<() => void> = [];
  run.source.detail = vi.fn(async (item) => {
    await new Promise<void>((resolve) => release.push(resolve));
    return detail(item);
  });
  try {
    void run.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.source.detail).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    release.forEach((done) => done());
    await vi.advanceTimersByTimeAsync(0);
    expect(run.db.count()).toBe(2);
    expect(run.source.detail).toHaveBeenCalledTimes(2);
    expect(run.db.detail("1:3")).toMatchObject({ status: "pending" });
  } finally {
    release.forEach((done) => done());
    await run.stop();
  }
});

it("无可靠上架时间时暂停，不以到期时间代替", async () => {
  const item = { ...row(1, 0), sellingTime: null };
  const run = start([[item]], "expire_time DESC");
  expect(await run.run()).toMatchObject({ message: expect.stringContaining("可靠的上架时间") });
  expect(run.source.detail).not.toHaveBeenCalled();
});

it("停止后继续仍使用相同分钟范围，保留已完成记录并跳过重复角色", async () => {
  const original = row(1, 1),
    old = row(2, 20);
  const first = start([[original, old]]);
  void first.run();
  await vi.advanceTimersByTimeAsync(0);
  await first.stop();
  const next = row(3, 0);
  const resumed = start([[next, original, old]], "selling_time DESC", first.db);
  void resumed.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(resumed.source.detail).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ key: next.key }),
  );
  expect(resumed.db.count()).toBe(2);
  await resumed.stop();
});
