import { afterEach, expect, it, vi } from "vite-plus/test";
import { CrawlStore } from "./store";
import { crawl } from "./runner";
import { CAPTURE_VERSION } from "./compact";
import {
  ListingChangedError,
  type CrawlSource,
  type CrawlStatus,
  type Listing,
  type RoleDetail,
} from "./types";

const stores: CrawlStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const row = (id: number): Listing => ({
  key: `1:${id}`,
  eid: String(id),
  serverId: "1",
  ordersn: String(id),
  name: String(id),
  price: "100",
  url: `https://xyq.cbg.163.com/equip?s=1&eid=${id}`,
  attrs: {},
  summary: null,
  sellingTime: new Date((10000 - id) * 1000).toISOString(),
  createdTime: null,
  orderTime: new Date((10000 - id) * 1000).toISOString(),
});
const detail = (item: Listing): RoleDetail => ({
  url: item.url,
  collectedAt: new Date().toISOString(),
  captureVersion: CAPTURE_VERSION,
  tabs: [],
  raw: {},
  equipmentCapture: {
    version: 1,
    collectedAt: "fixture",
    complete: true,
    issues: [],
    emptyProof: "official-containers",
  },
  petCapture: { version: 1, collectedAt: "fixture", complete: true, issues: [] },
});
const pending = (store: CrawlStore) =>
  Number(store.db.prepare("SELECT count(*) AS n FROM listings WHERE status='pending'").get()!.n);
async function flush() {
  for (let index = 0; index < 200; index++) await Promise.resolve();
}
function setup(limit: number, items: Listing[], concurrency = 10, abortAtTarget = true) {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  store.setRoleLimit(limit);
  const active = new Map<string, () => void>(),
    control = new AbortController();
  const page = { page: 1, totalPages: 1, order: "selling_time DESC", items };
  const source: CrawlSource = {
    prepare: vi.fn(async () => page),
    page: vi.fn(async () => page),
    onShelf: vi.fn(async () => true),
    hover: vi.fn(async (item) => item),
    detail: vi.fn(async (item) => {
      await new Promise<void>((resolve) => active.set(item.key, resolve));
      active.delete(item.key);
      return detail(item);
    }),
  };
  let maximumAccepted = 0,
    settled = false;
  const publish = vi.fn((_update: Partial<CrawlStatus>) => {
    maximumAccepted = Math.max(maximumAccepted, store.countRoles() + pending(store));
    if (abortAtTarget && store.countRoles() >= limit)
      control.abort(
        Object.assign(new Error("fixture target reached"), {
          name: "RoleTargetReachedError",
          limit,
        }),
      );
  });
  const start = () =>
    crawl(source, store, control.signal, publish, { watch: true, concurrency }).then(
      () => {
        settled = true;
        return undefined;
      },
      (error) => {
        settled = true;
        return error as Error;
      },
    );
  const stop = async (outcome: ReturnType<typeof start>) => {
    control.abort(new Error("fixture pause"));
    active.forEach((release) => release());
    await outcome;
  };
  return {
    store,
    source,
    active,
    control,
    publish,
    start,
    stop,
    maximumAccepted: () => maximumAccepted,
    settled: () => settled,
  };
}

it.each([2, 3])(
  "小目标%s低于10并发时只接收剩余额度，controller同步停采后没有普通pending",
  async (limit) => {
    const x = setup(
        limit,
        Array.from({ length: 12 }, (_, index) => row(index + 1)),
      ),
      outcome = x.start();
    try {
      await flush();
      expect(x.active.size).toBe(limit);
      expect(pending(x.store)).toBe(limit);
      expect(x.source.hover).toHaveBeenCalledTimes(limit);
      x.active.forEach((release) => release());
      await flush();
      expect(x.store.countRoles()).toBe(limit);
      expect(x.maximumAccepted()).toBeLessThanOrEqual(limit);
      expect(pending(x.store)).toBe(0);
      expect(x.active.size).toBe(0);
      expect(x.settled()).toBe(true);
      expect(await outcome).toMatchObject({ name: "RoleTargetReachedError" });
      expect(
        x.publish.mock.calls
          .map(([state]) => state)
          .filter((state) => state.newRunning !== undefined)
          .at(-1),
      ).toMatchObject({ newRunning: 0, oldRunning: 0, newQueued: 0, oldQueued: 0 });
    } finally {
      await x.stop(outcome);
    }
  },
);

it("接近200目标时198个完整角色只再接收2个，超额度候选不登记", async () => {
  const x = setup(
    200,
    Array.from({ length: 6 }, (_, index) => row(index + 1)),
  );
  for (let index = 0; index < 198; index++) {
    const old = row(index + 1000);
    x.store.observe(old);
    x.store.save(old, detail(old));
  }
  const outcome = x.start();
  try {
    await flush();
    expect(x.active.size).toBe(2);
    expect(pending(x.store)).toBe(2);
    x.active.forEach((release) => release());
    await flush();
    expect(x.store.countRoles()).toBe(200);
    expect(pending(x.store)).toBe(0);
    expect(x.store.detail("1:3")).toBeNull();
    expect(x.maximumAccepted()).toBeLessThanOrEqual(200);
  } finally {
    await x.stop(outcome);
  }
});

it("重复角色完成和独立失败释放临时名额，继续替补到目标且保留失败原因", async () => {
  const items = Array.from({ length: 5 }, (_, index) => row(index + 1));
  items[0].attrs.data_seller_roleid = "same-character";
  items[1].attrs.data_seller_roleid = "same-character";
  const x = setup(3, items),
    original = x.source.detail;
  x.source.detail = vi.fn(async (item) => {
    const captured = await original(item);
    if (item.key === "1:3")
      throw Object.assign(new Error("fixture missing detail"), { name: "IncompleteDetailError" });
    return captured;
  });
  const outcome = x.start();
  try {
    await flush();
    expect([...x.active.keys()]).toEqual(["1:1", "1:2", "1:3"]);
    x.active.forEach((release) => release());
    await flush();
    expect(x.store.countRoles()).toBe(1);
    expect([...x.active.keys()]).toEqual(["1:4", "1:5"]);
    x.active.forEach((release) => release());
    await flush();
    expect(x.store.countRoles()).toBe(3);
    expect(x.store.count()).toBe(4);
    expect(pending(x.store)).toBe(0);
    expect(x.store.detail("1:3")).toMatchObject({
      status: "failed",
      error: "fixture missing detail",
    });
    expect(x.source.detail).toHaveBeenCalledTimes(5);
    expect(x.maximumAccepted()).toBeLessThanOrEqual(3);
  } finally {
    await x.stop(outcome);
  }
});

it("无controller的目标完成也自然返回并发布completed，不在无任务时等待", async () => {
  const x = setup(
      2,
      Array.from({ length: 5 }, (_, index) => row(index + 1)),
      4,
      false,
    ),
    outcome = x.start();
  try {
    await flush();
    expect(x.active.size).toBe(2);
    x.active.forEach((release) => release());
    await flush();
    expect(x.settled()).toBe(true);
    expect(await outcome).toBeUndefined();
    expect(x.publish).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "completed", running: false, roleLimit: 2, totalRoles: 2 }),
    );
    expect(pending(x.store)).toBe(0);
    expect(x.active.size).toBe(0);
  } finally {
    await x.stop(outcome);
  }
});

it("hover期间额度缩小会丢弃结果，重复角色释放额度后重新hover并保存新快照", async () => {
  const existing = row(900),
    duplicate = row(1);
  existing.attrs.data_seller_roleid = "same-character";
  duplicate.attrs.data_seller_roleid = "same-character";
  const x = setup(3, [duplicate, row(2), row(3)], 4, false);
  x.store.observe(existing);
  x.store.save(existing, detail(existing));
  let releaseHover: (() => void) | undefined,
    secondHovers = 0;
  x.source.hover = vi.fn(async (item) => {
    if (item.key !== "1:2") return item;
    if (++secondHovers === 1)
      await new Promise<void>((resolve) => {
        releaseHover = resolve;
      });
    return { ...item, price: secondHovers === 1 ? "100" : "200" };
  });
  const outcome = x.start();
  try {
    await flush();
    expect(x.source.hover).toHaveBeenCalledTimes(2);
    x.store.setRoleLimit(2);
    releaseHover!();
    await flush();
    expect([...x.active.keys()]).toEqual(["1:1"]);
    expect(x.store.detail("1:2")).toBeNull();
    x.active.forEach((release) => release());
    await flush();
    expect([...x.active.keys()]).toEqual(["1:2"]);
    expect(x.store.detail("1:2")).toMatchObject({ listing: { price: "200" } });
    x.active.forEach((release) => release());
    await flush();
    expect(await outcome).toBeUndefined();
    expect(x.store.countRoles()).toBe(2);
    expect(pending(x.store)).toBe(0);
    expect(x.source.hover).toHaveBeenCalledTimes(3);
  } finally {
    releaseHover?.();
    await x.stop(outcome);
  }
});

it("开始watch前已达目标时直接完成，不请求列表或留下等待", async () => {
  const x = setup(2, [row(99)], 4, false);
  for (const item of [row(1), row(2)]) {
    x.store.observe(item);
    x.store.save(item, detail(item));
  }
  const outcome = x.start();
  try {
    await flush();
    expect(await outcome).toBeUndefined();
    expect(x.source.prepare).not.toHaveBeenCalled();
    expect(x.source.hover).not.toHaveBeenCalled();
    expect(x.publish).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "completed", roleLimit: 2, totalRoles: 2 }),
    );
  } finally {
    await x.stop(outcome);
  }
});

it("目标等待期间手动暂停保留已接收队列，不登记余下候选", async () => {
  const x = setup(
      4,
      Array.from({ length: 8 }, (_, index) => row(index + 1)),
      4,
    ),
    outcome = x.start();
  try {
    await flush();
    expect(x.active.size).toBe(4);
    expect(x.publish).toHaveBeenCalledWith(
      expect.objectContaining({ detailProgress: "接近目标，正在完整处理已接收角色…" }),
    );
    x.control.abort(new Error("manual pause"));
    x.active.forEach((release) => release());
    await flush();
    expect(await outcome).toMatchObject({ message: "manual pause" });
    expect(pending(x.store)).toBe(4);
    expect(x.store.count()).toBe(0);
    expect(x.store.detail("1:5")).toBeNull();
  } finally {
    await x.stop(outcome);
  }
});

it("列表错误仍保留所有已接收任务，不因目标流程丢弃队列", async () => {
  const x = setup(
    10,
    Array.from({ length: 6 }, (_, index) => row(index + 1)),
    4,
  );
  x.source.prepare = vi.fn(async () => ({
    page: 1,
    totalPages: 2,
    order: "selling_time DESC",
    items: Array.from({ length: 6 }, (_, index) => row(index + 1)),
  }));
  x.source.page = vi.fn(async (number) => {
    if (number === 2) throw new ListingChangedError();
    return {
      page: 1,
      totalPages: 2,
      order: "selling_time DESC",
      items: Array.from({ length: 6 }, (_, index) => row(index + 1)),
    };
  });
  const outcome = x.start();
  try {
    await flush();
    expect(x.active.size).toBe(4);
    x.active.forEach((release) => release());
    await flush();
    expect(await outcome).toBeInstanceOf(ListingChangedError);
    expect(pending(x.store)).toBe(6);
    expect(x.store.count()).toBe(0);
  } finally {
    await x.stop(outcome);
  }
});

it("旧库启动时已有过量重试仍保留全部记录，目标停采不删除旧队列", async () => {
  const x = setup(2, [row(99)], 4);
  for (let index = 1; index <= 8; index++) x.store.observe(row(index));
  const outcome = x.start();
  try {
    await flush();
    expect(x.active.size).toBe(4);
    expect(x.source.prepare).not.toHaveBeenCalled();
    x.active.forEach((release) => release());
    await flush();
    expect(x.store.countRoles()).toBe(2);
    expect(pending(x.store)).toBe(6);
    expect(Number(x.store.db.prepare("SELECT count(*) AS n FROM listings").get()!.n)).toBe(8);
    expect(x.source.hover).not.toHaveBeenCalled();
  } finally {
    await x.stop(outcome);
  }
});
