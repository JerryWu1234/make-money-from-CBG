import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { CAPTURE_VERSION } from "./compact";
import { crawl } from "./runner";
import { CrawlStore } from "./store";
import {
  SellingOrderUnavailableError,
  type CrawlSource,
  type CrawlStatus,
  type Listing,
  type ListingPage,
  type RoleDetail,
} from "./types";

const row = (id: number, second = 10000 - id): Listing => {
  const time = new Date(second * 1000).toISOString();
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
const chunk = (items: Listing[]) =>
  Array.from({ length: Math.ceil(items.length / 15) }, (_, i) => items.slice(i * 15, i * 15 + 15));
const runs: { stop: () => Promise<void>; db: CrawlStore }[] = [];
function start(pages: Listing[][], initialPages = 5, order = "selling_time DESC") {
  const db = new CrawlStore(":memory:");
  const control = new AbortController();
  const states: Partial<CrawlStatus>[] = [];
  const read = (number: number): ListingPage => ({
    page: number,
    totalPages: pages.length,
    order,
    items: [...pages[number - 1]!],
  });
  const src: CrawlSource = {
    prepare: vi.fn(async (requested) => {
      if (order === "expire_time DESC" && requested === "selling_time DESC")
        throw new SellingOrderUnavailableError();
      return read(1);
    }),
    refresh: vi.fn(async () => read(1)),
    page: vi.fn(async (number) => read(number)),
    onShelf: vi.fn(async () => true),
    hover: vi.fn(async (item) => item),
    detail: vi.fn(async (item) => detail(item)),
  };
  let outcome: Promise<unknown>;
  const run = () => {
    outcome = crawl(src, db, control.signal, (state) => states.push(state), {
      watch: true,
      concurrency: 2,
      headRefresh: { intervalSeconds: 1, random: false, initialPages },
    }).catch((error: unknown) => error);
    return outcome;
  };
  runs.push({
    db,
    stop: async () => {
      control.abort(new Error("测试暂停"));
      await outcome;
    },
  });
  return { db, src, states, run, signal: control.signal };
}
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const entry of runs.splice(0)) {
    await entry.stop();
    entry.db.close();
  }
  vi.useRealTimers();
});

it.each(
  ["selling_time DESC", "expire_time DESC"].flatMap((order) =>
    [1, 2, 5, 7].map((limit) => ({ order, limit })),
  ),
)("排序$order首次仅采配置的$limit页，少于总页数时不标记全表补齐", async ({ order, limit }) => {
  const pages = chunk(Array.from({ length: 120 }, (_, i) => row(i + 1)));
  const { db, src, run } = start(pages, limit, order);
  void run();
  await vi.advanceTimersByTimeAsync(0);
  expect(db.count()).toBe(limit * 15);
  expect(vi.mocked(src.page).mock.calls.map(([number]) => number)).toEqual(
    Array.from({ length: limit - 1 }, (_, i) => i + 2),
  );
  expect(db.backfillComplete()).toBe(false);
  expect(db.headCheckpoint()).toEqual({
    time: pages[0]![0]!.sellingTime,
    keys: [pages[0]![0]!.key],
    mode: "latest-only",
  });
});

it("总页数不足配置时只读到末页，空列表不会建立无效边界", async () => {
  const short = start([[row(1)]]);
  void short.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(short.db.count()).toBe(1);
  expect(short.src.page).not.toHaveBeenCalled();
  const empty = start([[]]);
  void empty.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(empty.db.headCheckpoint()).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1000);
  expect(empty.src.refresh).toHaveBeenCalledOnce();
});

it.each(
  ["selling_time DESC", "expire_time DESC"].flatMap((order) =>
    [0, 5, 20, 100].map((addedCount) => ({ order, addedCount })),
  ),
)("排序$order刷新后新增$addedCount个，后续不受首次页数上限限制", async ({ order, addedCount }) => {
  const original = Array.from({ length: 90 }, (_, i) => row(i + 1));
  const pages = chunk(original);
  const { db, src, run } = start(pages, 1, order);
  void run();
  await vi.advanceTimersByTimeAsync(0);
  expect(db.count()).toBe(15);
  vi.mocked(src.page).mockClear();
  const added = Array.from({ length: addedCount }, (_, i) => row(1000 + i, 20000 - i));
  pages.splice(0, pages.length, ...chunk([...added, ...original]));
  await vi.advanceTimersByTimeAsync(1000);
  expect(src.refresh).toHaveBeenCalledOnce();
  expect(db.count()).toBe(15 + addedCount);
  const lastPage = order === "expire_time DESC" ? pages.length : Math.floor(addedCount / 15) + 1;
  expect(vi.mocked(src.page).mock.calls.map(([number]) => number)).toEqual(
    Array.from({ length: lastPage - 1 }, (_, i) => i + 2),
  );
  expect(db.hasListing(original[15]!.key)).toBe(false);
  expect(db.headCheckpoint()?.time).toBe((added[0] ?? original[0])!.sellingTime);
});

it("同秒商品跨页时全部核对，不在第一个已采号处停止；零散旧记录也不截断发现", async () => {
  const known = row(1, 100);
  const seen = row(2, 200);
  const fresh = row(3, 150);
  const tied = [row(4, 100), row(5, 100)];
  const older = row(6, 99);
  const { db, src, run } = start([
    [seen, fresh, known, tied[0]!],
    [tied[1]!, older],
  ]);
  for (const item of [known, seen]) {
    db.observe(item);
    db.save(item, detail(item));
  }
  db.setHeadCheckpoint({ time: known.sellingTime!, keys: [known.key], mode: "latest-only" });
  void run();
  await vi.advanceTimersByTimeAsync(0);
  expect(src.page).toHaveBeenCalledExactlyOnceWith(2);
  expect(vi.mocked(src.hover).mock.calls.map(([item]) => item.key)).toEqual([
    fresh.key,
    ...tied.map((item) => item.key),
  ]);
  expect(db.hasListing(older.key)).toBe(false);
  expect(db.backfillComplete()).toBe(false);
});

it("上轮同秒商品消失时仍保留已确认身份，新增同秒身份合并到持久边界", async () => {
  const known = row(1, 100),
    fresh = row(2, 100);
  const { db, run } = start([[fresh], [row(3, 99)]]);
  db.setHeadCheckpoint({ time: known.sellingTime!, keys: [known.key], mode: "latest-only" });
  void run();
  await vi.advanceTimersByTimeAsync(0);
  expect(db.headCheckpoint()?.keys).toEqual([known.key, fresh.key]);
});

it("旧全表扫描水位不能跳过首次限定页数，建立新边界后继续启动只检查新增", async () => {
  const pages = [[row(1)], [row(2)], [row(3)]];
  const first = start(pages, 2);
  first.db.setHeadCheckpoint({ time: row(999, 20000).sellingTime!, keys: ["old-mode"] });
  void first.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(first.db.count()).toBe(2);
  const head = first.db.headCheckpoint()!;
  expect(head.mode).toBe("latest-only");
  const resumed = start(pages, 5);
  resumed.db.setHeadCheckpoint(head);
  for (const item of pages.flat().slice(0, 2)) {
    resumed.db.observe(item);
    resumed.db.save(item, detail(item));
  }
  void resumed.run();
  await vi.advanceTimersByTimeAsync(0);
  expect(resumed.src.page).toHaveBeenCalledExactlyOnceWith(2);
  expect(resumed.src.hover).not.toHaveBeenCalled();
  expect(resumed.db.hasListing(pages[2]![0]!.key)).toBe(false);
});

it("出售剩余时间排序采用真实上架时间边界，orderTime不参与新增判断", async () => {
  const known = row(1, 100),
    fresh = row(2, 101),
    older = row(3, 99);
  const { db, src, run } = start(
    [
      [
        { ...fresh, orderTime: null },
        { ...known, orderTime: null },
      ],
      [{ ...older, orderTime: null }],
    ],
    5,
    "expire_time DESC",
  );
  db.setHeadCheckpoint({ time: known.sellingTime!, keys: [known.key], mode: "latest-only" });
  db.observe(known);
  db.save(known, detail(known));
  void run();
  await vi.advanceTimersByTimeAsync(0);
  expect(db.count()).toBe(2);
  expect(db.hasListing(older.key)).toBe(false);
  expect(src.detail).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ key: fresh.key }));
  expect(db.headCheckpoint()?.time).toBe(fresh.sellingTime);
});

it("到期排序第一页越过旧时间后仍读取第二页，不漏掉较新的105并保留110边界", async () => {
  const newer = row(1, 110),
    old = row(2, 90),
    hiddenNew = row(3, 105),
    older = row(4, 80);
  const { db, src, run } = start(
    [
      [newer, old],
      [hiddenNew, older],
    ],
    5,
    "expire_time DESC",
  );
  db.setHeadCheckpoint({ time: row(99, 100).sellingTime!, keys: ["1:99"], mode: "latest-only" });
  void run();
  await vi.advanceTimersByTimeAsync(0);
  expect(src.page).toHaveBeenCalledExactlyOnceWith(2);
  expect(vi.mocked(src.detail).mock.calls.map(([item]) => item.key)).toEqual([
    newer.key,
    hiddenNew.key,
  ]);
  expect(db.hasListing(old.key)).toBe(false);
  expect(db.hasListing(older.key)).toBe(false);
  expect(db.headCheckpoint()?.time).toBe(newer.sellingTime);
  expect(db.backfillComplete()).toBe(false);
});

it("到期排序允许新旧时间页内混排，旧号之间的同秒新号全部登记，边界取全轮最大值", async () => {
  const old = row(1, 90),
    fresh = row(2, 110),
    tiedA = row(3, 100);
  const latest = row(4, 120),
    older = row(5, 80),
    tiedB = row(6, 100);
  const { db, src, run } = start(
    [
      [old, fresh, tiedA],
      [latest, older, tiedB],
    ],
    5,
    "expire_time DESC",
  );
  db.setHeadCheckpoint({ time: tiedA.sellingTime!, keys: ["previous"], mode: "latest-only" });
  void run();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.mocked(src.detail).mock.calls.map(([item]) => item.key)).toEqual([
    fresh.key,
    tiedA.key,
    latest.key,
    tiedB.key,
  ]);
  expect(db.headCheckpoint()).toEqual({
    time: latest.sellingTime!,
    keys: [latest.key],
    mode: "latest-only",
  });
  expect(db.hasListing(old.key)).toBe(false);
  expect(db.hasListing(older.key)).toBe(false);
});

it("到期排序首次限定页数不依赖时间单调性，初始边界取配置范围内最大上架时间", async () => {
  const latest = row(3, 130),
    tied = row(5, 130);
  const { db, src, run } = start(
    [[row(1, 80), row(2, 110)], [latest, row(4, 90), tied], [row(6, 150)]],
    2,
    "expire_time DESC",
  );
  void run();
  await vi.advanceTimersByTimeAsync(0);
  expect(db.count()).toBe(5);
  expect(src.page).toHaveBeenCalledExactlyOnceWith(2);
  expect(db.headCheckpoint()).toEqual({
    time: latest.sellingTime!,
    keys: [latest.key, tied.key],
    mode: "latest-only",
  });
  expect(db.hasListing("1:6")).toBe(false);
});

it("到期排序后页检查失败时保留上轮边界，不能提交首页的较新时间", async () => {
  const { db, src, run } = start([[row(1, 110), row(2, 90)], [row(3, 105)]], 5, "expire_time DESC");
  const previous = {
    time: row(99, 100).sellingTime!,
    keys: ["1:99"],
    mode: "latest-only" as const,
  };
  db.setHeadCheckpoint(previous);
  src.page = vi.fn(async () => {
    throw new Error("后页读取失败");
  });
  const outcome = run();
  await vi.advanceTimersByTimeAsync(0);
  expect(await outcome).toMatchObject({ message: "后页读取失败" });
  expect(db.headCheckpoint()).toEqual(previous);
});

it("有界队列未登记完时不刷新、不推进边界；登记完成即可刷新，无须等详情全部完成", async () => {
  const rows = Array.from({ length: 6 }, (_, i) => row(i + 1, 200 - i));
  const { db, src, run, signal } = start([rows]);
  const previous = {
    time: row(99, 100).sellingTime!,
    keys: ["1:99"],
    mode: "latest-only" as const,
  };
  db.setHeadCheckpoint(previous);
  const active = new Map<string, () => void>();
  src.detail = vi.fn(async (item) => {
    await new Promise<void>((resolve) => {
      active.set(item.key, resolve);
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    active.delete(item.key);
    return detail(item);
  });
  vi.spyOn(db, "setHeadCheckpoint").mockImplementation((head) => {
    expect(rows.every((item) => db.hasListing(item.key))).toBe(true);
    db.db
      .prepare("UPDATE crawl_state SET head_checkpoint_json=? WHERE id=1")
      .run(JSON.stringify(head));
  });
  void run();
  await vi.advanceTimersByTimeAsync(0);
  expect(db.retryItems()).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(1000);
  expect(src.refresh).not.toHaveBeenCalled();
  expect(db.headCheckpoint()).toEqual(previous);
  active.forEach((release) => release());
  await vi.advanceTimersByTimeAsync(0);
  expect(src.refresh).toHaveBeenCalledOnce();
  expect(db.headCheckpoint()?.time).toBe(rows[0]!.sellingTime);
  expect(db.count()).toBe(2);
  expect(db.retryItems()).toHaveLength(4);
});

it.each(["page", "cross-page", "missing"])(
  "上架排序失序或真实上架时间缺失%s时暂停，不推进边界",
  async (kind) => {
    const first = row(1, 200),
      second = row(2, 201);
    const bad = kind === "missing" ? { ...second, sellingTime: null } : second;
    const pages = kind === "cross-page" ? [[first], [bad]] : [[first, bad]];
    const { db, run } = start(
      pages,
      5,
      kind === "missing" ? "expire_time DESC" : "selling_time DESC",
    );
    const previous = {
      time: row(3, 100).sellingTime!,
      keys: ["1:3"],
      mode: "latest-only" as const,
    };
    db.setHeadCheckpoint(previous);
    const outcome = run();
    await vi.advanceTimersByTimeAsync(0);
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/上架时间/) });
    expect(db.headCheckpoint()).toEqual(previous);
    expect(db.hasListing(second.key)).toBe(false);
  },
);
