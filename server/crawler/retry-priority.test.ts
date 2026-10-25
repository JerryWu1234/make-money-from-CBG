import { afterEach, expect, it, vi } from "vite-plus/test";
import { CrawlStore } from "./store";
import { crawl } from "./runner";
import { CAPTURE_VERSION } from "./compact";
import {
  ListingUnavailableError,
  type CrawlSource,
  type CrawlStatus,
  type Listing,
  type ListingPage,
  type RoleDetail,
} from "./types";

// 内存数据库和模拟详情，不打开浏览器，也不读取真实采集数据。
const stores: CrawlStore[] = [];
const memory = () => {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  return store;
};
const item = (id: number): Listing => {
  const time = new Date((1000 - id) * 1000).toISOString();
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
const detail = (row: Listing): RoleDetail => ({
  captureVersion: CAPTURE_VERSION,
  url: row.url,
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
  petCapture: {
    version: 1,
    collectedAt: new Date().toISOString(),
    complete: true,
    issues: [],
  },
});
const source = (rows: Listing[] = []): CrawlSource => {
  const page = (): ListingPage => ({
    page: 1,
    totalPages: 1,
    order: "selling_time DESC",
    items: rows,
  });
  return {
    prepare: vi.fn(async () => page()),
    page: vi.fn(async () => page()),
    hover: vi.fn(async (row) => row),
    onShelf: vi.fn(async () => true),
    detail: vi.fn(async (row) => detail(row)),
  };
};
async function flush() {
  for (let index = 0; index < 120; index++) await Promise.resolve();
}
function holdDetails(src: CrawlSource) {
  const active = new Map<string, () => void>();
  src.detail = vi.fn(async (row) => {
    await new Promise<void>((resolve) => active.set(row.key, resolve));
    active.delete(row.key);
    return detail(row);
  });
  return active;
}
function seed(db: CrawlStore, newCount = 12, oldCount = 10) {
  const old = Array.from({ length: oldCount }, (_, index) => item(100 + index));
  const fresh = Array.from({ length: newCount }, (_, index) => item(200 + index));
  // 故意让老号先入库，补采应按已保存任务顺序混合使用完整并发池。
  old.forEach((row) => db.observe(row, "old"));
  fresh.forEach((row) => db.observe(row, "new"));
  return { fresh, old };
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

it("已保存混合补采任务持续占满10槽，全部补采完成后才开始发现新角色", async () => {
  const db = memory();
  const { fresh, old } = seed(db);
  const src = source();
  const active = holdDetails(src);
  const control = new AbortController();
  const latest: Partial<CrawlStatus> = {};
  const publish = vi.fn((state: Partial<CrawlStatus>) => Object.assign(latest, state));
  const stopped = new Error("测试结束");
  const outcome = crawl(src, db, control.signal, publish, {
    watch: true,
    concurrency: 10,
  }).catch((error: unknown) => error);
  try {
    await flush();
    expect(active.size).toBe(10);
    expect(vi.mocked(src.detail).mock.calls.map(([row]) => row.key)).toEqual(
      old.map((row) => row.key),
    );
    expect(latest).toMatchObject({ newRunning: 0, oldRunning: 10, newQueued: 12, oldQueued: 0 });
    expect(src.prepare).not.toHaveBeenCalled();
    for (let released = 0; released < fresh.length; released++) {
      const first = [...active.values()][0];
      first();
      await flush();
      expect(active.size).toBe(10);
      expect(src.detail).toHaveBeenCalledTimes(11 + released);
      expect(src.prepare).not.toHaveBeenCalled();
      if (released === 0)
        expect(latest).toMatchObject({
          newRunning: 1,
          oldRunning: 9,
          newQueued: 11,
          oldQueued: 0,
        });
    }
    expect(db.count()).toBe(fresh.length);
    expect(latest).toMatchObject({ newRunning: 10, oldRunning: 0, newQueued: 0, oldQueued: 0 });
    const held = [...active.keys()][0];
    for (const [key, release] of active) if (key !== held) release();
    await flush();
    expect(db.count()).toBe(fresh.length + old.length - 1);
    expect(active.size).toBe(1);
    expect(src.prepare).not.toHaveBeenCalled();
    active.get(held)!();
    await flush();
    expect(db.count()).toBe(fresh.length + old.length);
    expect(src.prepare).toHaveBeenCalledOnce();
    expect(src.detail).toHaveBeenCalledTimes(fresh.length + old.length);
  } finally {
    control.abort(stopped);
    active.forEach((release) => release());
    await outcome;
  }
});

it("混合补采不完整失败本轮隔离，不阻塞其他商品且列表重现同版本时不无限重试", async () => {
  const db = memory();
  const { fresh, old } = seed(db, 3, 2);
  const bad = fresh[0];
  const src = source([bad]);
  const control = new AbortController();
  const latest: Partial<CrawlStatus> = {};
  const publish = vi.fn((state: Partial<CrawlStatus>) => Object.assign(latest, state));
  src.detail = vi.fn(async (row) => {
    if (row.key === bad.key)
      throw Object.assign(new Error("模拟新号资料缺项"), { name: "IncompleteDetailError" });
    return detail(row);
  });
  const outcome = crawl(src, db, control.signal, publish, {
    watch: true,
    concurrency: 10,
  }).catch((error: unknown) => error);
  try {
    await flush();
    expect(vi.mocked(src.detail).mock.calls.map(([row]) => db.captureLane(row.key))).toEqual([
      "old",
      "old",
      "new",
      "new",
      "new",
    ]);
    expect(vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === bad.key)).toHaveLength(1);
    expect(db.detail(bad.key)).toMatchObject({ status: "failed", error: "模拟新号资料缺项" });
    expect(db.count()).toBe(fresh.length + old.length - 1);
    expect(src.prepare).toHaveBeenCalledOnce();
    expect(latest).toMatchObject({ failed: 1, retryCompleted: 5 });
    await flush();
    expect(src.detail).toHaveBeenCalledTimes(5);
  } finally {
    control.abort(new Error("测试结束"));
    await outcome;
  }
});

it("补采阶段暂停后不再派发，等所有在途结束才退出且保留未完成任务", async () => {
  const db = memory();
  const { fresh, old } = seed(db);
  const src = source();
  const active = holdDetails(src);
  const control = new AbortController();
  const stopped = new Error("用户暂停");
  let settled = false;
  const outcome = crawl(src, db, control.signal, vi.fn(), {
    backfillOnly: true,
    concurrency: 10,
  })
    .catch((error: unknown) => error)
    .finally(() => {
      settled = true;
    });
  try {
    await flush();
    expect(active.size).toBe(10);
    expect([...active.keys()].every((key) => db.captureLane(key) === "old")).toBe(true);
    control.abort(stopped);
    await flush();
    expect(settled).toBe(false);
    expect(src.detail).toHaveBeenCalledTimes(10);
    expect(src.prepare).not.toHaveBeenCalled();
  } finally {
    control.abort(stopped);
    active.forEach((release) => release());
    await outcome;
  }
  expect(await outcome).toBe(stopped);
  expect(src.detail).toHaveBeenCalledTimes(10);
  expect(db.count()).toBe(0);
  expect(db.retryItems()).toHaveLength(fresh.length + old.length);
  expect(src.prepare).not.toHaveBeenCalled();
});

it.each(["complete", "unavailable"])(
  "%s 终态进度回调同步暂停，不把已结束补采重新计入排队",
  async (status) => {
    const db = memory();
    const { fresh, old } = seed(db, 1, 1);
    const src = source();
    const control = new AbortController();
    const stopped = new Error("收到终态进度后暂停");
    const latest: Partial<CrawlStatus> = {};
    const publish = vi.fn((state: Partial<CrawlStatus>) => {
      Object.assign(latest, state);
      if (state.saved === 1 || state.skipped === 1) control.abort(stopped);
    });
    if (status === "unavailable")
      src.detail = vi.fn(async () => {
        throw new ListingUnavailableError("模拟官网确认商品不存在");
      });

    const outcome = await crawl(src, db, control.signal, publish, {
      backfillOnly: true,
      concurrency: 10,
    }).catch((error: unknown) => error);
    expect(outcome).toBe(stopped);
    expect(db.detail(old[0].key)).toMatchObject({ status });
    expect(db.detail(fresh[0].key)).toMatchObject({ status: "pending" });
    expect(latest).toMatchObject({
      newRunning: 0,
      oldRunning: 0,
      newQueued: 1,
      oldQueued: 0,
      retryCompleted: 1,
    });
    expect(db.retryItems().map((row) => row.key)).toEqual([fresh[0].key]);
    expect(src.detail).toHaveBeenCalledTimes(2);
    expect(src.detail).toHaveBeenNthCalledWith(1, expect.objectContaining(old[0]));
    expect(src.prepare).not.toHaveBeenCalled();
  },
);
