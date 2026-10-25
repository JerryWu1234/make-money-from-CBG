import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CrawlStore } from "./store";
import { crawl } from "./runner";
import { CAPTURE_VERSION } from "./compact";
import { collectCompleteCapture } from "./capture-readiness";
import {
  ListingChangedError,
  ListingDisappearedError,
  ListingUnavailableError,
  SellingOrderUnavailableError,
  type CrawlStatus,
  type CrawlSource,
  type Listing,
  type ListingPage,
  type RoleDetail,
  type SavedRoleRecord,
} from "./types";

// 失败方式：超出总并发、新号排队时先派老、空位未补满、抢占旧在途、详情阻挡头扫、同秒跨页漏采、
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
  it("历史待采池满时让出头扫，旧在途逐个释放的空位优先派新且两侧队列有界", async () => {
    vi.useFakeTimers();
    const db = memory(),
      known = item(10, 1000),
      fresh = Array.from({ length: 6 }, (_, index) => item(index + 1, 2000 - index)),
      old = Array.from({ length: 12 }, (_, index) => item(20 + index)),
      pages: Listing[][] = [[known], old],
      src = source(pages),
      active = holdDetails(src),
      control = new AbortController();
    db.observe(known);
    db.save(known, detail(known));
    let maximumPending = 0;
    const publish = vi.fn((_state: Partial<CrawlStatus>) => {
      maximumPending = Math.max(maximumPending, db.retryItems().length);
    });
    const outcome = crawl(src, db, control.signal, publish, {
      watch: true,
      concurrency: 4,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    try {
      await flush();
      await flush();
      expect(active.size).toBe(4);
      expect(db.retryItems()).toHaveLength(8);
      pages[0] = fresh;
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(src.prepare).toHaveBeenCalledTimes(2);
      expect(fresh.slice(0, 4).every((row) => readSaved(db, row.key)?.status === "pending")).toBe(
        true,
      );
      expect(db.detail(fresh[4]!.key)).toBeNull();
      expect([...active.keys()]).toEqual(old.slice(0, 4).map((row) => row.key));
      for (let index = 0; index < 4; index++) {
        active.get(old[index]!.key)!();
        await flush();
        expect(active.has(fresh[index]!.key)).toBe(true);
        expect(old.slice(index + 1, 4).every((row) => active.has(row.key))).toBe(true);
        expect(old.slice(4).every((row) => !active.has(row.key))).toBe(true);
        expect(active.size).toBe(4);
      }
      active.get(fresh[0]!.key)!();
      active.get(fresh[1]!.key)!();
      await flush();
      expect(active.has(fresh[4]!.key)).toBe(true);
      expect(active.has(fresh[5]!.key)).toBe(true);
      expect([...active.keys()].every((key) => db.captureLane(key) === "new")).toBe(true);
      active.get(fresh[2]!.key)!();
      await flush();
      expect(active.has(old[4]!.key)).toBe(true);
      expect(active.size).toBe(4);
      expect(maximumPending).toBe(12);
      expect(
        publish.mock.calls.every(
          ([state]) =>
            (state.newQueued ?? 0) <= 4 &&
            (state.oldQueued ?? 0) <= 4 &&
            (state.newRunning ?? 0) + (state.oldRunning ?? 0) <= 4,
        ),
      ).toBe(true);
    } finally {
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    }
  });
  it("官网确证不存在的详情在持续采集中只跳过一次，重现不再派发且其它商品继续保存", async () => {
    const db = memory(),
      gone = item(1),
      good = item(2),
      src = source([[gone, good]]),
      control = new AbortController(),
      publish = vi.fn();
    src.detail = vi.fn(async (row) => {
      if (row.key === gone.key) throw new ListingUnavailableError("目标详情返回 HTTP 404");
      return detail(row);
    });
    const outcome = crawl(src, db, control.signal, publish, {
      watch: true,
      headIntervalMs: 1000,
    }).catch((error: unknown) => error);
    try {
      await flush();
      expect(readSaved(db, gone.key)).toMatchObject({ status: "unavailable" });
      expect(readSaved(db, good.key)).toMatchObject({ status: "complete" });
      expect(db.retryItems()).toEqual([]);
      expect(db.observe(gone)).toBe(true);
      await flush();
      expect(vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === gone.key)).toHaveLength(
        1,
      );
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          skipped: 1,
          detailProgress: expect.stringContaining("无法补齐"),
        }),
      );
      expect(publish.mock.calls.every(([state]) => !state.failed)).toBe(true);
      expect(db.checkpoint()?.key).not.toBe(gone.key);
    } finally {
      control.abort(new Error("验证停止"));
      await outcome;
    }
  });
  it("旧库目标不限制采集，外部中止后不继续保存在途详情", async () => {
    const db = memory(),
      src = source([Array.from({ length: 6 }, (_, i) => item(i + 1))]),
      active = holdDetails(src),
      control = new AbortController();
    db.db.exec(
      "ALTER TABLE crawl_state ADD COLUMN role_limit INTEGER; INSERT INTO crawl_state(id,role_limit) VALUES(1,1)",
    );
    const outcome = crawl(
      src,
      db,
      control.signal,
      (status) => {
        if (status.saved === 3) control.abort(new Error("外部验证任务停止采集"));
      },
      { watch: true, concurrency: 4 },
    ).catch((error: unknown) => error);
    await flush();
    expect(active.size).toBe(4);
    [...active.values()].forEach((release) => release());
    await flush();
    try {
      expect(db.count()).toBe(3);
    } finally {
      control.abort(new Error("结束测试"));
      active.forEach((release) => release());
      await outcome;
    }
  });
  it("详情较慢时限制排队量，不把后续整页持续堆进未完成记录", async () => {
    const db = memory(),
      fresh = Array.from({ length: 8 }, (_, i) => item(i + 1)),
      old = Array.from({ length: 12 }, (_, i) => item(i + 20)),
      src = source([fresh, old]),
      active = holdDetails(src),
      control = new AbortController();
    let maximumPending = 0;
    const outcome = crawl(
      src,
      db,
      control.signal,
      () => {
        maximumPending = Math.max(maximumPending, db.retryItems().length);
      },
      { watch: true, concurrency: 4 },
    ).catch((error: unknown) => error);
    try {
      await flush();
      expect(active.size).toBe(4);
      expect(db.retryItems().length).toBeLessThanOrEqual(8);
      for (let round = 0; round < 20 && db.count() < 20; round++) {
        [...active.values()].forEach((release) => release());
        await flush();
      }
      expect(db.count()).toBe(20);
      expect(maximumPending).toBeLessThanOrEqual(8);
      expect(src.detail).toHaveBeenCalledTimes(20);
    } finally {
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    }
  });
  it("续采先用全部10个名额混合补齐已保存详情，再开始列表发现", async () => {
    const db = memory(),
      old = Array.from({ length: 12 }, (_, i) => item(i + 20)),
      fresh = item(1),
      src = source([[fresh]]),
      control = new AbortController(),
      publish = vi.fn();
    old.forEach((row, i) => db.observe(row, i % 2 ? "new" : "old"));
    const active = holdDetails(src);
    const outcome = crawl(src, db, control.signal, publish, { watch: true, concurrency: 10 }).catch(
      (error: unknown) => error,
    );
    try {
      await flush();
      expect(active.size).toBe(10);
      expect([...active.keys()].filter((key) => db.captureLane(key) === "new")).toHaveLength(5);
      expect([...active.keys()].filter((key) => db.captureLane(key) === "old")).toHaveLength(5);
      expect(src.prepare).not.toHaveBeenCalled();
      expect(src.hover).not.toHaveBeenCalled();
      [...active.values()].forEach((release) => release());
      await flush();
      expect(active.size).toBe(2);
      expect(db.count()).toBe(10);
      expect([...active.keys()].filter((key) => db.captureLane(key) === "new")).toHaveLength(1);
      expect([...active.keys()].filter((key) => db.captureLane(key) === "old")).toHaveLength(1);
      expect(src.prepare).not.toHaveBeenCalled();
      [...active.values()].forEach((release) => release());
      await flush();
      expect(db.count()).toBe(12);
      expect(src.prepare).toHaveBeenCalledOnce();
      expect([...active.keys()]).toEqual([fresh.key]);
      active.get(fresh.key)!();
      await flush();
      expect(db.count()).toBe(13);
      const saved = publish.mock.calls.flatMap(([state]) =>
        typeof state.saved === "number" ? [state.saved] : [],
      );
      expect(saved.at(-1)).toBe(13);
      expect(saved).toEqual([...saved].sort((a, b) => a - b));
    } finally {
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    }
  });

  it.each([false, true])(
    "优先补采失败本轮隔离，排序回退：%s，同版本不清除失败或占用名额",
    async (unordered) => {
      const db = memory(),
        bad = item(20),
        good = item(21),
        fresh = item(1),
        src = source([[fresh, bad]]),
        control = new AbortController(),
        publish = vi.fn();
      db.observe(bad, "old");
      db.observe(good, "old");
      let attemptsBeforeDiscovery: unknown;
      const prepare = src.prepare;
      src.prepare = vi.fn(async (order) => {
        attemptsBeforeDiscovery = db.db
          .prepare("SELECT attempt_count FROM listings WHERE key=?")
          .get(bad.key)?.attempt_count;
        if (unordered && order === "selling_time DESC") throw new SellingOrderUnavailableError();
        const result = await prepare(order);
        return { ...result, order: unordered ? "expire_time DESC" : result.order };
      });
      if (unordered)
        src.page = vi.fn(async () => ({
          page: 1,
          totalPages: 1,
          order: "expire_time DESC",
          items: [fresh, bad],
        }));
      src.detail = vi.fn(async (row) => {
        if (row.key === bad.key)
          throw Object.assign(new Error("资料缺项"), { name: "IncompleteDetailError" });
        return detail(row);
      });
      const outcome = crawl(src, db, control.signal, publish, {
        watch: true,
        concurrency: 10,
      }).catch((error: unknown) => error);
      try {
        await flush();
        expect(
          vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === bad.key),
        ).toHaveLength(1);
        expect(readSaved(db, bad.key)).toMatchObject({ status: "failed", error: "资料缺项" });
        expect(db.count()).toBe(2);
        expect(
          db.db.prepare("SELECT attempt_count FROM listings WHERE key=?").get(bad.key)
            ?.attempt_count,
        ).toBe(attemptsBeforeDiscovery);
        expect(publish).toHaveBeenCalledWith(expect.objectContaining({ saved: 2, failed: 1 }));
        const patches = publish.mock.calls.map(([patch]) => patch as Partial<CrawlStatus>);
        const failedAt = patches.findIndex((patch) => patch.lastItemError?.includes(bad.key));
        expect(patches[failedAt]).toMatchObject({ current: bad.name });
        const discovery = patches.slice(failedAt + 1).find((patch) => patch.phase === "collecting");
        expect(discovery).toHaveProperty("detailProgress", undefined);
        expect(discovery).toHaveProperty("current", undefined);
        expect(db.checkpoint()?.key).not.toBe(good.key);
      } finally {
        control.abort(new Error("暂停"));
        await outcome;
      }
    },
  );

  it("优先补采中暂停会等在途结束，不开始发现或推进原断点", async () => {
    const db = memory(),
      saved = item(30),
      old = [item(20), item(21), item(22)],
      src = source([[item(1)]]),
      control = new AbortController();
    db.observe(saved);
    const point = {
      key: saved.key,
      time: saved.orderTime,
      order: "selling_time DESC",
      page: 3,
      savedAt: "2026-10-23T00:00:00.000Z",
    };
    db.save(saved, detail(saved), point);
    old.forEach((row) => db.observe(row));
    const active = holdDetails(src);
    let settled = false;
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true, concurrency: 2 })
      .catch((error: unknown) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await flush();
      expect(active.size).toBe(2);
      control.abort(new Error("暂停"));
      await flush();
      expect(settled).toBe(false);
    } finally {
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    }
    expect(src.prepare).not.toHaveBeenCalled();
    expect(src.detail).toHaveBeenCalledTimes(2);
    expect(db.count()).toBe(1);
    expect(db.checkpoint()).toEqual(point);
    expect(db.retryItems()).toHaveLength(3);
  });

  it("无上架排序时持续检查首页并逐页核对，保留旧记录且不拿到期时间建立头水位", async () => {
    vi.useFakeTimers();
    const db = memory(),
      saved = item(20),
      older = item(1, 80),
      newer = item(2, 2000);
    db.observe(saved);
    db.save(saved, detail(saved), {
      key: saved.key,
      time: saved.orderTime,
      order: "selling_time DESC",
      page: 2,
      savedAt: "2026-10-23T00:00:00.000Z",
    });
    db.markBackfillComplete();
    const pages = [[older], [saved, newer]].map((rows, index) => ({
      page: index + 1,
      totalPages: 2,
      order: "expire_time DESC",
      items: rows.map((row) => ({ ...row, orderTime: null })),
    }));
    const src = source([]);
    src.prepare = vi.fn(async (order) => {
      if (order === "selling_time DESC") throw new SellingOrderUnavailableError();
      return pages[0];
    });
    src.page = vi.fn(async (number) => pages[number - 1]!);
    const publish = vi.fn();
    const control = new AbortController();
    const outcome = crawl(src, db, control.signal, publish, {
      watch: true,
      concurrency: 4,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    await flush();
    expect(src.prepare).toHaveBeenNthCalledWith(1, "selling_time DESC");
    expect(src.prepare).toHaveBeenLastCalledWith("expire_time DESC");
    expect(src.page).toHaveBeenCalledWith(1);
    expect(src.page).toHaveBeenCalledWith(2);
    expect(src.detail).toHaveBeenCalledTimes(2);
    expect(db.count()).toBe(3);
    expect(readSaved(db, saved.key)?.status).toBe("complete");
    expect(db.headCheckpoint()).toBeUndefined();
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: expect.stringContaining("定时检查首页新增") }),
    );
    // 首页未变，后页新增也必须由下一轮全表检查发现，不能遇到已知商品就截断。
    const added = item(3, 1);
    pages[1].items.push({ ...added, orderTime: null });
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(src.prepare).toHaveBeenCalledTimes(3);
    expect(db.count()).toBe(4);
    expect(db.captureLane(added.key)).toBe("new");
    expect(db.headCheckpoint()).toBeUndefined();
    control.abort(new Error("暂停"));
    expect(await outcome).toMatchObject({ message: "暂停" });
  });

  it.each([undefined, 4, 6, 8, 10])(
    "无上架排序时 %s 并发（默认10）新号排队优先，排队清空后老号补满空位",
    async (concurrency) => {
      vi.useFakeTimers();
      const db = memory(),
        pool = concurrency ?? 10,
        fresh = Array.from({ length: pool + 2 }, (_, i) => item(i + 1)),
        old = Array.from({ length: pool }, (_, i) => item(i + 20));
      const src = source([fresh, old]);
      const read = (page: number): ListingPage => ({
        page,
        totalPages: 2,
        order: "expire_time DESC",
        items: page === 1 ? fresh : old,
      });
      src.prepare = vi.fn(async (order) => {
        if (order === "selling_time DESC") throw new SellingOrderUnavailableError();
        // 启动补采结束后登记老号，验证稳态新号优先而非启动补采排序。
        old.forEach((row) => db.observe(row, "old"));
        return read(1);
      });
      src.page = vi.fn(async (number) => read(number));
      const active = holdDetails(src),
        control = new AbortController(),
        publish = vi.fn();
      const outcome = crawl(src, db, control.signal, publish, {
        watch: true,
        concurrency,
        headIntervalMs: 100,
      }).catch((error: unknown) => error);
      try {
        await flush();
        expect(active.size).toBe(pool);
        expect([...active.keys()].every((key) => db.captureLane(key) === "new")).toBe(true);
        const added = item(0, 2000);
        fresh.unshift(added);
        await vi.advanceTimersByTimeAsync(100);
        await flush();
        expect(db.retryItems().some((row) => row.key === added.key)).toBe(true);
        expect(src.detail).toHaveBeenCalledTimes(pool);
        expect(publish).toHaveBeenCalledWith(
          expect.objectContaining({
            captureStrategy: "new-first",
            newRunning: pool,
            oldRunning: 0,
          }),
        );
        [...active.values()].forEach((release) => release());
        await flush();
        expect(active.size).toBe(pool);
        const remainingNew = [...active.keys()].filter((key) => db.captureLane(key) === "new");
        expect(remainingNew).toHaveLength(3);
        expect([...active.keys()].filter((key) => db.captureLane(key) === "old")).toHaveLength(
          pool - 3,
        );
        for (const key of remainingNew.slice(0, 2)) active.get(key)!();
        await flush();
        expect(active.size).toBe(pool);
        expect([...active.keys()].filter((key) => db.captureLane(key) === "new")).toHaveLength(1);
        expect([...active.keys()].filter((key) => db.captureLane(key) === "old")).toHaveLength(
          pool - 1,
        );
        active.get(remainingNew[2]!)!();
        await flush();
        expect([...active.keys()].sort()).toEqual(old.map((row) => row.key).sort());
        expect(db.count()).toBe(pool + 3);
      } finally {
        control.abort(new Error("暂停"));
        active.forEach((release) => release());
        await outcome;
      }
    },
  );

  it.each(["网站登录已失效", "网站要求安全验证", "网站繁忙"])(
    "%s 时保留错误，不切换采集方式继续访问",
    async (message) => {
      const db = memory(),
        src = source([]);
      src.prepare = vi.fn().mockRejectedValue(new Error(message));
      await expect(
        crawl(src, db, new AbortController().signal, vi.fn(), { watch: true, concurrency: 4 }),
      ).rejects.toThrow(message);
      expect(src.prepare).toHaveBeenCalledTimes(1);
      expect(src.detail).not.toHaveBeenCalled();
    },
  );

  it("新号排队时全部四个名额给新号，排队清空后不等在途清空就由老号补满", async () => {
    const db = memory(),
      fresh = [item(1), item(2), item(3), item(4), item(5)],
      old = [item(20), item(21), item(22), item(23)];
    const src = source([fresh]),
      active = holdDetails(src),
      control = new AbortController(),
      publish = vi.fn();
    const prepare = src.prepare;
    src.prepare = vi.fn(async (order) => {
      old.forEach((row) => db.observe(row, "old"));
      return prepare(order);
    });
    const outcome = crawl(src, db, control.signal, publish, { watch: true, concurrency: 4 }).catch(
      (error: unknown) => error,
    );
    try {
      await flush();
      expect(active.size).toBe(4);
      expect([...active.keys()].every((key) => db.captureLane(key) === "new")).toBe(true);
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({ captureStrategy: "new-first", newRunning: 4, oldRunning: 0 }),
      );
      [...active.values()].forEach((release) => release());
      await flush();
      expect(active.has(fresh[4]!.key)).toBe(true);
      expect(active.size).toBe(4);
      expect([...active.keys()].filter((key) => db.captureLane(key) === "old")).toHaveLength(3);
      expect(src.detail).toHaveBeenCalledTimes(8);
      expect(db.retryItems().filter((row) => db.captureLane(row.key) === "old")).toHaveLength(4);
      active.get(fresh[4]!.key)!();
      await flush();
      expect([...active.keys()].sort()).toEqual(old.map((row) => row.key).sort());
    } finally {
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    }
  });

  it("新号在途时头扫和有界历史发现继续，新号排队优先占用下一个空位", async () => {
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
      concurrency: 4,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    try {
      await flush();
      expect(active.size).toBe(4);
      expect(src.page).toHaveBeenCalledWith(2);
      expect(db.detail(old[0]!.key)).not.toBeNull();
      const added = item(0, 1001);
      pages[0] = [added, ...fresh];
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(src.prepare).toHaveBeenCalledTimes(2);
      expect(src.prepare).toHaveBeenLastCalledWith("selling_time DESC");
      expect(db.retryItems().some((row) => row.key === added.key)).toBe(true);
      expect(src.detail).toHaveBeenCalledTimes(4);
      active.get(fresh[0]!.key)!();
      await flush();
      expect(active.has(added.key)).toBe(true);
      expect(active.size).toBe(4);
      expect([...active.keys()].every((key) => db.captureLane(key) === "new")).toBe(true);
      active.get(fresh[1]!.key)!();
      await flush();
      expect([...active.keys()].filter((key) => db.captureLane(key) === "old")).toHaveLength(1);
      expect(active.has(added.key)).toBe(true);
      expect(active.size).toBe(4);
    } finally {
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    }
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
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true, concurrency: 4 }).catch(
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
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true, concurrency: 4 }).catch(
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
      const outcome = crawl(src, db, control.signal, vi.fn(), {
        watch: true,
        concurrency: 4,
      }).catch((error: unknown) => error);
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
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true, concurrency: 4 }).catch(
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
      concurrency: 4,
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

  it("单件同URL导航连续中断仅隔离该角色，其他完整详情仍保存并继续发现新号", async () => {
    vi.useFakeTimers();
    const db = memory(),
      fresh = [item(1), item(2), item(3)],
      pages = [fresh],
      src = source(pages),
      control = new AbortController();
    const broken = fresh[1];
    const read = vi.fn(async () => {
      throw new Error(
        `page.goto: Navigation to "${broken.url}" is interrupted by another navigation to "${broken.url}"`,
      );
    });
    src.detail = vi.fn(async (row) =>
      row.key === broken.key ? collectCompleteCapture(read, control.signal, vi.fn()) : detail(row),
    );
    const outcome = crawl(src, db, control.signal, vi.fn(), {
      watch: true,
      concurrency: 4,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    await flush();
    expect(read).toHaveBeenCalledTimes(3);
    expect(readSaved(db, broken.key)?.status).toBe("failed");
    expect(db.count()).toBe(2);
    const added = item(0, 1001);
    pages[0] = [added, ...fresh];
    await vi.advanceTimersByTimeAsync(100);
    await flush();
    expect(readSaved(db, added.key)?.status).toBe("complete");
    expect(read).toHaveBeenCalledTimes(3);
    control.abort(new Error("暂停"));
    await outcome;
  });

  it("新号待采池已满时有界等待，释放名额后继续头扫", async () => {
    vi.useFakeTimers();
    const db = memory(),
      fresh = Array.from({ length: 8 }, (_, index) => item(index + 1)),
      old = Array.from({ length: 7 }, (_, index) => item(20 + index)),
      pages = [fresh, old, [item(40)]],
      src = source(pages),
      active = holdDetails(src),
      control = new AbortController();
    const outcome = crawl(src, db, control.signal, vi.fn(), {
      watch: true,
      concurrency: 4,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    try {
      await flush();
      expect(active.size).toBe(4);
      expect(db.retryItems()).toHaveLength(8);
      expect(src.page).not.toHaveBeenCalledWith(2);
      pages[0] = [item(0, 1001), ...fresh];
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(src.prepare).toHaveBeenCalledTimes(2);
      expect(db.detail("1:0")).toBeNull();
      active.get(fresh[0]!.key)!();
      await flush();
      expect(db.detail("1:0")).not.toBeNull();
      expect(db.retryItems().length).toBeLessThanOrEqual(8);
      for (let round = 0; round < 4 && db.count() < 9; round++) {
        [...active.entries()]
          .filter(([key]) => db.captureLane(key) === "new")
          .forEach(([, release]) => release());
        await flush();
      }
      expect(db.count()).toBe(9);
      expect(src.page).toHaveBeenCalledWith(2);
    } finally {
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    }
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
      concurrency: 4,
      headIntervalMs: 100,
    }).catch((error: unknown) => error);
    try {
      await flush();
      expect(src.page).toHaveBeenCalledWith(2);
      expect(src.page).not.toHaveBeenCalledWith(3);
      const added = sameSecond
        ? [100, 101, 102, 103].map((id) => item(id, 1000))
        : [item(0, 1004), item(100, 1003), item(101, 1002), item(102, 1001)];
      if (sameSecond) pages.splice(1, 0, added);
      else pages.unshift(added);
      await vi.advanceTimersByTimeAsync(100);
      await flush();
      expect(src.prepare).toHaveBeenCalledTimes(2);
      expect(added.every((row) => readSaved(db, row.key)?.status === "pending")).toBe(true);
      // 同秒新增全部持久登记后可推进发现水位；不要求详情先完成。
      if (sameSecond) expect(db.headCheckpoint()?.keys).toHaveLength(8);
      fresh.forEach((row) => active.get(row.key)!());
      await flush();
      expect([...active.keys()].sort()).toEqual(added.map((row) => row.key).sort());
      if (sameSecond) expect(db.headCheckpoint()?.keys).toHaveLength(8);
      added.slice(0, 2).forEach((row) => active.get(row.key)!());
      await flush();
      expect(old.filter((row) => active.has(row.key))).toHaveLength(2);
      expect(added.slice(2).every((row) => active.has(row.key))).toBe(true);
      expect(src.page).toHaveBeenCalledWith(3);
      expect(src.page).toHaveBeenCalledWith(4);
      expect(db.detail(tail.key)).not.toBeNull();
      expect(
        vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === old[0]!.key),
      ).toHaveLength(1);
    } finally {
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    }
  });

  it("同一次首页刷新周期内的真实重复历史页仍安全停止", async () => {
    const db = memory(),
      old = item(20),
      src = source([[item(1)], [old], [old]]);
    await expect(
      crawl(src, db, new AbortController().signal, vi.fn(), { watch: true, concurrency: 4 }),
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
      concurrency: 4,
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
      concurrency: 4,
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
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true, concurrency: 4 }).catch(
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
    const outcome = crawl(src, db, new AbortController().signal, vi.fn(), {
      watch: true,
      concurrency: 4,
    }).catch((error: unknown) => error);
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
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true, concurrency: 4 }).catch(
      (error: unknown) => error,
    );
    try {
      await flush();
      expect(active.has(fresh.key)).toBe(true);
      active.get(fresh.key)!();
      await flush();
      expect([...active.keys()].sort()).toEqual(old.map((row) => row.key).sort());
      for (const row of [...old].reverse()) {
        active.get(row.key)!();
        await flush();
        expect(db.checkpoint()?.key).toBe(old[2]!.key);
      }
      expect(db.backfillComplete()).toBe(true);
    } finally {
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    }
  });

  it.each(["head", "history"])("%s 商品消失时重读当前页，保留已发现项且继续采集", async (where) => {
    const db = memory();
    const pages =
      where === "head" ? [[item(1), item(2), item(3)]] : [[item(1)], [item(2), item(3)]];
    const src = source(pages);
    const control = new AbortController();
    let changed = false;
    src.hover = vi.fn(async (row) => {
      if (!changed && row.key === "1:2") {
        changed = true;
        pages[where === "head" ? 0 : 1] =
          where === "head" ? [item(1), item(3), item(4)] : [item(3), item(4)];
        throw new ListingDisappearedError();
      }
      return row;
    });
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true, concurrency: 4 }).catch(
      (error: unknown) => error,
    );
    await flush();
    expect(db.count()).toBe(3);
    expect(
      vi
        .mocked(src.detail)
        .mock.calls.map(([row]) => row.key)
        .sort(),
    ).toEqual(["1:1", "1:3", "1:4"]);
    expect(db.detail("1:2")).toBeNull();
    control.abort(new Error("暂停"));
    expect(await outcome).toMatchObject({ message: "暂停" });
  });

  it("重读后商品仍连续消失时停止，不无限重试或推进头水位", async () => {
    const db = memory();
    const src = source([[item(1)]]);
    src.hover = vi.fn(async () => {
      throw new ListingDisappearedError();
    });
    await expect(
      crawl(src, db, new AbortController().signal, vi.fn(), { watch: true }),
    ).rejects.toBeInstanceOf(ListingDisappearedError);
    expect(src.prepare).toHaveBeenCalledTimes(2);
    expect(src.hover).toHaveBeenCalledTimes(2);
    expect(src.detail).not.toHaveBeenCalled();
    expect(db.headCheckpoint()).toBeUndefined();
  });

  it("列表变化停止派发，等全部在途退出后才返回错误", async () => {
    const db = memory(),
      fresh = [item(1), item(2), item(3), item(4), item(5)],
      src = source([fresh, [item(20)]]),
      active = holdDetails(src),
      control = new AbortController();
    src.hover = vi.fn(async (row) => {
      if (row.key === fresh[4]!.key) throw new ListingChangedError();
      return row;
    });
    let settled = false;
    const outcome = crawl(src, db, control.signal, vi.fn(), { watch: true, concurrency: 4 }).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await flush();
      expect(settled).toBe(false);
      expect(src.detail).toHaveBeenCalledTimes(4);
      active.forEach((release) => release());
      expect(await outcome).toBeInstanceOf(ListingChangedError);
      expect(src.detail).toHaveBeenCalledTimes(4);
      expect(db.count()).toBe(0);
      expect(db.backfillComplete()).toBe(false);
    } finally {
      control.abort(new Error("暂停"));
      active.forEach((release) => release());
      await outcome;
    }
  });

  it.each([null, "price", "sellingTime"] as const)(
    "列表悬停超时后保留匹配版本的在途完整详情，已更新字段：%s",
    async (changed) => {
      const db = memory(),
        fresh = [item(1), item(2), item(3), item(4), item(5)],
        src = source([fresh, [item(20)]]),
        active = holdDetails(src),
        publish = vi.fn(),
        control = new AbortController();
      const error = Object.assign(new Error("locator.hover: Timeout 5000ms exceeded"), {
        name: "TimeoutError",
      });
      src.hover = vi.fn(async (row) => {
        if (row.key === fresh[4]!.key) throw error;
        return row;
      });
      const outcome = crawl(src, db, control.signal, publish, {
        watch: true,
        concurrency: 4,
      }).catch((failure: unknown) => failure);
      try {
        await flush();
        expect(active.size).toBe(4);
        expect(publish).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining("已停止派发") }),
        );
        if (changed)
          db.observe({
            ...fresh[0],
            ...(changed === "price"
              ? { price: "200" }
              : { sellingTime: item(1, 2000).sellingTime }),
          });
        active.forEach((release) => release());
        expect(await outcome).toBe(error);
        expect(db.count()).toBe(changed ? 3 : 4);
        expect(src.detail).toHaveBeenCalledTimes(4);
        expect(readSaved(db, fresh[4].key)).toMatchObject({
          status: "failed",
          error: error.message,
        });
        expect(db.retryItems().some((row) => row.key === fresh[4].key)).toBe(true);
        expect(readSaved(db, fresh[0].key)?.status).toBe(changed ? "pending" : "complete");
        expect(db.checkpoint()).toBeUndefined();
        expect(db.backfillComplete()).toBe(false);
      } finally {
        control.abort(new Error("暂停"));
        active.forEach((release) => release());
        await outcome;
      }
    },
  );

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
        concurrency: 4,
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
        crawl(src, db, new AbortController().signal, vi.fn(), { watch: true, concurrency: 4 }),
      ).rejects.toThrow("上架时间倒序");
      expect(src.detail).not.toHaveBeenCalled();
      expect(db.headCheckpoint()).toBeUndefined();
    },
  );
});
