import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CrawlStore } from "./store";
import { crawl } from "./runner";
import { CAPTURE_VERSION } from "./compact";
import {
  ListingChangedError,
  type CrawlSource,
  type Listing,
  type ListingPage,
  type RoleDetail,
  type SavedRoleRecord,
} from "./types";

// 失败方式：超出总并发或丢失 2/2 配额、借位打断在途、详情阻挡头扫、同秒跨页漏采、
// 水位早于 pending 落库、新号覆盖历史断点、旧失败阻挡新号、异常或暂停未等在途退出。
const stores: CrawlStore[] = [];
const memory = () => {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  return store;
};
const readSaved = (store: CrawlStore, key: string) => store.detail(key) as SavedRoleRecord | null;
const item = (id: number, second = 1000 - id): Listing => {
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
const source = (pages: Listing[][]): CrawlSource => {
  const read = (number: number): ListingPage => ({
    page: number,
    totalPages: pages.length,
    order: "selling_time DESC",
    items: pages[number - 1]!,
  });
  return {
    prepare: vi.fn(async () => read(1)),
    page: vi.fn(async (number) => read(number)),
    onShelf: vi.fn(async () => true),
    hover: vi.fn(async (row) => row),
    detail: vi.fn(async (row) => detail(row)),
  };
};
async function flush() {
  for (let index = 0; index < 80; index++) await Promise.resolve();
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
afterEach(() => {
  vi.useRealTimers();
  for (const store of stores.splice(0)) store.close();
});

describe("持续发现新号和历史详情共享采集池", () => {
  it("双方待采时分配 2 新 2 老；老号清空后新号借用空位", async () => {
    const db = memory(),
      fresh = [item(1), item(2), item(3), item(4), item(5)],
      old = [item(20), item(21)];
    old.forEach((row) => db.observe(row, "old"));
    const src = source([fresh]),
      active = holdDetails(src),
      control = new AbortController(),
      publish = vi.fn();
    const outcome = crawl(src, db, control.signal, publish, { watch: true }).catch(
      (error: unknown) => error,
    );
    await flush();
    expect(active.size).toBe(4);
    expect([...active.keys()].filter((key) => db.captureLane(key) === "new")).toHaveLength(2);
    expect([...active.keys()].filter((key) => db.captureLane(key) === "old")).toHaveLength(2);
    old.forEach((row) => active.get(row.key)!());
    await flush();
    expect(active.size).toBe(4);
    expect([...active.keys()].every((key) => db.captureLane(key) === "new")).toBe(true);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ newRunning: 4, oldRunning: 0, newLimit: 2, oldLimit: 2 }),
    );
    control.abort(new Error("暂停"));
    active.forEach((release) => release());
    expect(await outcome).toMatchObject({ message: "暂停" });
  });

  it("历史列表与头部定时检查均不等待详情池清空，借位也不打断在途", async () => {
    vi.useFakeTimers();
    const db = memory(),
      fresh = [item(1), item(2), item(3), item(4)],
      old = [item(20), item(21)];
    const pages = [fresh, old],
      src = source(pages),
      active = holdDetails(src),
      control = new AbortController();
    const outcome = crawl(src, db, control.signal, vi.fn(), {
      watch: true,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    await flush();
    expect(active.size).toBe(4);
    expect(src.page).toHaveBeenCalledWith(2);
    expect(db.captureLane(old[0]!.key)).toBe("old");
    const added = item(0, 1001);
    pages[0] = [added, ...fresh];
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(src.prepare).toHaveBeenCalledTimes(2);
    expect(src.prepare).toHaveBeenLastCalledWith("selling_time DESC");
    expect(db.retryItems().some((row) => row.key === added.key)).toBe(true);
    expect(active.size).toBe(4);
    expect(src.detail).toHaveBeenCalledTimes(4);
    active.get(fresh[0]!.key)!();
    await flush();
    expect([...active.keys()].some((key) => db.captureLane(key) === "old")).toBe(true);
    control.abort(new Error("暂停"));
    active.forEach((release) => release());
    expect(await outcome).toMatchObject({ message: "暂停" });
  });

  it("头扫越过已知 key 并覆盖旧水位的整秒，登记后才推进水位", async () => {
    const db = memory(),
      known = item(1, 100),
      sameSecond = item(2, 100),
      newer = item(3, 101),
      older = item(4, 99);
    db.setHeadCheckpoint({ time: known.sellingTime!, keys: [known.key] });
    db.markBackfillComplete();
    const src = source([[newer, known], [sameSecond], [older]]),
      active = holdDetails(src),
      control = new AbortController();
    const setPoint = vi.spyOn(db, "setHeadCheckpoint").mockImplementation((point) => {
      expect(db.retryItems().map((row) => row.key)).toEqual(
        expect.arrayContaining([newer.key, known.key, sameSecond.key]),
      );
      expect(point).toEqual({ time: newer.sellingTime, keys: [newer.key] });
    });
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true }).catch(
      (error: unknown) => error,
    );
    await flush();
    expect(src.page).toHaveBeenCalledWith(2);
    expect(src.page).toHaveBeenCalledWith(3);
    expect(setPoint).toHaveBeenCalledTimes(1);
    expect(db.detail(older.key)).toBeNull();
    control.abort(new Error("暂停"));
    active.forEach((release) => release());
    await outcome;
  });

  it("已补齐的旧库首次启用头扫时，补查到旧 selling 断点并覆盖同秒", async () => {
    const db = memory(),
      old = item(20, 80),
      sameSecond = item(21, 80),
      first = item(1, 100),
      between = item(2, 90),
      older = item(22, 79);
    db.observe(old);
    const point = {
      key: old.key,
      time: old.sellingTime,
      order: "selling_time DESC",
      page: 3,
      savedAt: "2026-10-23T00:00:00.000Z",
    };
    db.save(old, detail(old), point);
    db.markBackfillComplete();
    const src = source([[first], [between], [old, sameSecond, older]]),
      active = holdDetails(src),
      control = new AbortController(),
      setPoint = vi.spyOn(db, "setHeadCheckpoint");
    setPoint.mockImplementation((head) => {
      expect(db.retryItems().map((row) => row.key)).toEqual(
        expect.arrayContaining([first.key, between.key, sameSecond.key]),
      );
      expect(head).toEqual({ time: first.sellingTime, keys: [first.key] });
    });
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true }).catch(
      (error: unknown) => error,
    );
    await flush();
    expect(src.page).toHaveBeenCalledWith(3);
    expect(db.detail(older.key)).toBeNull();
    expect(db.captureLane(between.key)).toBe("new");
    expect(setPoint).toHaveBeenCalledTimes(1);
    expect(db.checkpoint()).toEqual(point);
    control.abort(new Error("暂停"));
    active.forEach((release) => release());
    await outcome;
  });

  it.each(["expire_time DESC", undefined])(
    "旧库无可靠 selling 边界（%s）时先扫到尾，再建立头水位",
    async (order) => {
      const db = memory(),
        first = item(1, 100),
        older = item(2, 90);
      if (order) {
        const old = item(20, 80);
        db.observe(old);
        db.save(old, detail(old), {
          key: old.key,
          time: old.sellingTime,
          order,
          page: 2,
          savedAt: "2026-10-23T00:00:00.000Z",
        });
      }
      db.markBackfillComplete();
      const src = source([[first], [older]]),
        active = holdDetails(src),
        control = new AbortController();
      const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true }).catch(
        (error: unknown) => error,
      );
      await flush();
      expect(src.page).toHaveBeenCalledWith(2);
      expect(db.captureLane(older.key)).toBe("new");
      expect(db.headCheckpoint()).toEqual({ time: first.sellingTime, keys: [first.key] });
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    },
  );

  it("新号成功不改旧断点，也不把仍有历史在途的任务标为补齐", async () => {
    const db = memory(),
      saved = item(20, 80),
      old = item(21, 79),
      fresh = item(1, 100);
    db.observe(saved);
    const point = {
      key: saved.key,
      time: saved.orderTime,
      order: "selling_time DESC",
      page: 2,
      savedAt: "2026-10-23T00:00:00.000Z",
    };
    db.save(saved, detail(saved), point);
    const src = source([[fresh], [saved, old]]),
      control = new AbortController();
    let releaseOld = () => {};
    src.detail = vi.fn(async (row) => {
      if (row.key === old.key) await new Promise<void>((resolve) => (releaseOld = resolve));
      return detail(row);
    });
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true }).catch(
      (error: unknown) => error,
    );
    await flush();
    expect(readSaved(db, fresh.key)?.status).toBe("complete");
    expect(db.checkpoint()).toEqual(point);
    expect(db.backfillComplete()).toBe(false);
    expect(src.onShelf).not.toHaveBeenCalled();
    control.abort(new Error("暂停"));
    releaseOld();
    await outcome;
  });

  it("旧号完整性失败本轮不反复重试，仍按时发现新号", async () => {
    vi.useFakeTimers();
    const db = memory(),
      old = item(20),
      fresh = item(1),
      pages = [[fresh]],
      src = source(pages),
      control = new AbortController();
    db.observe(old, "old");
    src.detail = vi.fn(async (row) => {
      if (row.key === old.key)
        throw Object.assign(new Error("资料缺项"), { name: "IncompleteDetailError" });
      return detail(row);
    });
    const outcome = crawl(src, db, control.signal, vi.fn(), {
      watch: true,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    await flush();
    const added = item(0, 1001);
    pages[0] = [added, fresh];
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(readSaved(db, added.key)?.status).toBe("complete");
    expect(vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === old.key)).toHaveLength(1);
    expect(readSaved(db, old.key)?.status).toBe("failed");
    expect(db.backfillComplete()).toBe(false);
    control.abort(new Error("暂停"));
    await outcome;
  });

  it("历史排队达到老号配额时先等详情，等待期间仍检查头部", async () => {
    vi.useFakeTimers();
    const db = memory(),
      fresh = [item(1), item(2), item(3), item(4)],
      old = Array.from({ length: 7 }, (_, index) => item(20 + index)),
      pages = [fresh, old, [item(40)]],
      src = source(pages),
      active = holdDetails(src),
      control = new AbortController();
    const outcome = crawl(src, db, control.signal, vi.fn(), {
      watch: true,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    await flush();
    expect(src.page).toHaveBeenCalledWith(2);
    expect(src.page).not.toHaveBeenCalledWith(3);
    pages[0] = [item(0, 1001), ...fresh];
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(src.prepare).toHaveBeenCalledTimes(2);
    expect(db.detail("1:0")).not.toBeNull();
    expect(src.page).not.toHaveBeenCalledWith(3);
    control.abort(new Error("暂停"));
    active.forEach((release) => release());
    await outcome;
  });

  // 失败方式：正常整页上新使历史页后移，却被跨首页刷新保留的签名误判成重复页。
  it.each([false, true])("首页整页上新后历史重叠去重继续（同秒跨页=%s）", async (sameSecond) => {
    vi.useFakeTimers();
    const db = memory(),
      fresh = [1, 2, 3, 4].map((id) => item(id, sameSecond ? 1000 : undefined)),
      old = [item(20), item(21), item(22), item(23)],
      tail = item(40),
      pages = [fresh, old, [tail]],
      src = source(pages),
      active = holdDetails(src),
      control = new AbortController();
    const outcome = crawl(src, db, control.signal, vi.fn(), {
      watch: true,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    await flush();
    expect(src.page).toHaveBeenCalledWith(2);
    expect(src.page).not.toHaveBeenCalledWith(3);
    if (sameSecond)
      pages.splice(
        1,
        0,
        [100, 101, 102, 103].map((id) => item(id, 1000)),
      );
    else pages.unshift([item(0, 1004), item(100, 1003), item(101, 1002), item(102, 1001)]);
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(src.prepare).toHaveBeenCalledTimes(2);
    if (sameSecond) expect(db.headCheckpoint()?.keys).toHaveLength(8);
    fresh.forEach((row) => active.get(row.key)!());
    await flush();
    const runningOld = old.filter((row) => active.has(row.key));
    expect(runningOld).toHaveLength(2);
    active.get(runningOld[0]!.key)!();
    await flush();
    expect(src.page).toHaveBeenCalledWith(3);
    expect(src.page).toHaveBeenCalledWith(4);
    expect(db.detail(tail.key)).not.toBeNull();
    expect(
      vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === old[0]!.key),
    ).toHaveLength(1);
    control.abort(new Error("暂停"));
    active.forEach((release) => release());
    expect(await outcome).toMatchObject({ message: "暂停" });
  });

  it("同一次首页刷新周期内的真实重复历史页仍安全停止", async () => {
    const db = memory(),
      old = item(20),
      src = source([[item(1)], [old], [old]]);
    await expect(
      crawl(src, db, new AbortController().signal, vi.fn(), { watch: true }),
    ).rejects.toThrow("连续两页返回相同商品");
    expect(src.page).toHaveBeenCalledWith(3);
    expect(db.backfillComplete()).toBe(false);
  });

  // 失败方式：首页没变，但慢历史读取跨过巡检周期后清空签名，重复页被误标历史补齐。
  it("首页不变时，历史读取跨巡检周期仍识别真正重复页", async () => {
    vi.useFakeTimers();
    const db = memory(),
      old = item(20),
      src = source([[item(1), item(2)], [old], [old]]),
      readPage = src.page,
      control = new AbortController();
    src.page = vi.fn(async (number) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 110));
      return readPage(number);
    });
    let failure: unknown;
    const outcome = crawl(src, db, control.signal, vi.fn(), {
      watch: true,
      headIntervalMs: 100,
    }).catch((error: unknown) => {
      failure = error;
      return error;
    });
    try {
      await flush();
      await vi.advanceTimersByTimeAsync(400);
      await flush();
      expect(failure).toMatchObject({ message: "连续两页返回相同商品，已暂停，避免循环翻页" });
      expect(db.backfillComplete()).toBe(false);
      expect(src.prepare).toHaveBeenCalledTimes(3);
      expect(src.page).toHaveBeenCalledWith(3);
    } finally {
      control.abort(new Error("暂停"));
      await vi.runOnlyPendingTimersAsync();
      await outcome;
    }
  });

  // 失败方式：失败排除只看 key，重上架仍不派发；解除过宽使同版本或仅改价反复重试。
  it("失败商品同版本不重试，真正重上架后重新采集并解除历史失败门槛", async () => {
    vi.useFakeTimers();
    const db = memory(),
      old = item(20, 999),
      fresh = item(1),
      pages = [[fresh]],
      src = source(pages),
      control = new AbortController();
    db.observe(old, "old");
    src.detail = vi.fn(async (row) => {
      if (row.key === old.key && row.sellingTime === old.sellingTime)
        throw Object.assign(new Error("资料缺项"), { name: "IncompleteDetailError" });
      return detail(row);
    });
    const outcome = crawl(src, db, control.signal, vi.fn(), {
      watch: true,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    await flush();
    expect(db.backfillComplete()).toBe(false);
    pages[0] = [fresh, { ...old, price: "200" }];
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === old.key)).toHaveLength(1);
    expect(readSaved(db, old.key)?.listing.price).toBe("200");
    const relisted = { ...item(20, 1001), price: "200" };
    pages[0] = [relisted, fresh];
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(readSaved(db, old.key)?.status).toBe("complete");
    expect(vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === old.key)).toHaveLength(2);
    expect(db.backfillComplete()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === old.key)).toHaveLength(2);
    control.abort(new Error("暂停"));
    expect(await outcome).toMatchObject({ message: "暂停" });
  });

  it("旧库缺上架时间的待补项不因空失败表被排除，页面仍使用可靠上架时间", async () => {
    const db = memory(),
      old = item(20),
      src = source([[item(1)]]),
      control = new AbortController();
    db.observe(old, "old");
    db.db
      .prepare(
        "UPDATE listings SET selling_time=NULL,listing_json=json_remove(listing_json,'$.sellingTime') WHERE key=?",
      )
      .run(old.key);
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true }).catch(
      (error: unknown) => error,
    );
    await flush();
    expect(src.detail).toHaveBeenCalledWith(expect.objectContaining({ key: old.key }));
    expect(readSaved(db, old.key)?.status).toBe("complete");
    control.abort(new Error("暂停"));
    expect(await outcome).toMatchObject({ message: "暂停" });
  });

  it("跨页时间倒序失效时保留旧头水位并等在途结束", async () => {
    const db = memory(),
      oldPoint = { time: item(1, 100).sellingTime!, keys: ["1:1"] },
      src = source([
        [item(2, 102), item(3, 101)],
        [item(4, 103), item(5, 100)],
      ]),
      active = holdDetails(src);
    db.setHeadCheckpoint(oldPoint);
    db.markBackfillComplete();
    const outcome = crawl(src, db, new AbortController().signal, vi.fn(), { watch: true }).catch(
      (error: unknown) => error,
    );
    await flush();
    expect(db.headCheckpoint()).toEqual(oldPoint);
    active.forEach((release) => release());
    expect(await outcome).toMatchObject({
      message: "相邻列表页未保持上架时间倒序，已暂停以免漏采",
    });
    expect(src.detail).toHaveBeenCalledTimes(2);
  });

  it("历史详情乱序成功时断点保持在更老的已完成商品", async () => {
    const db = memory(),
      fresh = item(1, 100),
      old = [item(2, 90), item(3, 89), item(4, 88)],
      src = source([[fresh], old]),
      active = holdDetails(src),
      control = new AbortController();
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true }).catch(
      (error: unknown) => error,
    );
    await flush();
    for (const row of [...old].reverse()) {
      active.get(row.key)!();
      await flush();
      expect(db.checkpoint()?.key).toBe(old[2]!.key);
    }
    expect(db.backfillComplete()).toBe(true);
    control.abort(new Error("暂停"));
    active.forEach((release) => release());
    await outcome;
  });

  it("列表变化停止派发，等全部在途退出后才返回错误", async () => {
    const db = memory(),
      fresh = [item(1), item(2), item(3), item(4), item(5)],
      src = source([fresh, [item(20)]]),
      active = holdDetails(src),
      control = new AbortController();
    src.page = vi.fn(async (number) => {
      if (number === 2) throw new ListingChangedError();
      return { page: 1, totalPages: 2, order: "selling_time DESC", items: fresh };
    });
    let settled = false;
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true }).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await flush();
    expect(settled).toBe(false);
    expect(src.detail).toHaveBeenCalledTimes(4);
    active.forEach((release) => release());
    expect(await outcome).toBeInstanceOf(ListingChangedError);
    expect(src.detail).toHaveBeenCalledTimes(4);
    expect(db.count()).toBe(0);
    expect(db.backfillComplete()).toBe(false);
  });

  it.each(["sellingTime", "price"] as const)(
    "同 key 在途期间观察到 %s 改变时暂停，旧详情不得覆盖记录",
    async (field) => {
      vi.useFakeTimers();
      const db = memory(),
        original = item(1),
        pages = [[original]],
        src = source(pages),
        active = holdDetails(src),
        control = new AbortController();
      const outcome = crawl(src, db, control.signal, vi.fn(), {
        watch: true,
        headIntervalMs: 100,
      }).catch((error: unknown) => error);
      await flush();
      pages[0] = [
        field === "price"
          ? { ...original, price: "200" }
          : {
              ...original,
              sellingTime: item(2, 1001).sellingTime,
              orderTime: item(2, 1001).orderTime,
            },
      ];
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(db.count()).toBe(0);
      active.forEach((release) => release());
      expect(await outcome).toBeInstanceOf(ListingChangedError);
      expect(db.count()).toBe(0);
      expect(db.checkpoint()).toBeUndefined();
      expect(readSaved(db, original.key)?.status).toBe("pending");
    },
  );

  it.each(["expire_time DESC", "selling_time ASC"])(
    "排序为 %s 时不拿到期时间建头水位",
    async (order) => {
      const db = memory(),
        src = source([[item(1)]]);
      src.prepare = vi.fn(async () => ({ page: 1, totalPages: 1, order, items: [item(1)] }));
      await expect(
        crawl(src, db, new AbortController().signal, vi.fn(), { watch: true }),
      ).rejects.toThrow("上架时间倒序");
      expect(src.detail).not.toHaveBeenCalled();
      expect(db.headCheckpoint()).toBeUndefined();
    },
  );
});
