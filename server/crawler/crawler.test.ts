import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { parseListing, timestamp } from "./listing";
import { CrawlStore } from "./store";
import { crawl, validateCrawlOptions } from "./runner";
import { locateCheckpoint, prepareCrawlPages } from "./resume";
import type { CrawlSource, SavedRoleRecord } from "./types";
import {
  ListingChangedError,
  ListingUnavailableError,
  type Checkpoint,
  type Listing,
  type ListingPage,
  type RoleDetail,
} from "./types";
import { gunzipSync } from "node:zlib";
import {
  CAPTURE_VERSION,
  compactDetail,
  itemFromAttributes,
  coreEquipmentDescription,
} from "./compact";
import { equipmentCaptureSummary, onShelfFromText, MAIN_TABS } from "./detail";
import { IncompleteCaptureError } from "./capture-readiness";
import { BrowserConnectionError } from "../browser-connection";
const signal = () => new AbortController().signal;
const item = (id: number, time = 10000 - id): Listing => ({
  ...parseListing(
    `https://xyq.cbg.163.com/equip?s=367&eid=item-${id}`,
    { data_selling_time: "2026-09-07 12:00:00", data_ordersn: `order-${id}` },
    null,
    "selling_time DESC",
  ),
  orderTime: new Date(time * 1000).toISOString(),
});
const detail = (listing: Listing): RoleDetail => ({
  captureVersion: CAPTURE_VERSION,
  equipmentCapture: {
    version: 1,
    collectedAt: new Date().toISOString(),
    complete: true,
    issues: [],
  },
  petCapture: {
    version: 1,
    collectedAt: new Date().toISOString(),
    complete: true,
    issues: [],
  },
  url: listing.url,
  collectedAt: new Date().toISOString(),
  tabs: [
    {
      name: "人物/修炼",
      text: "攻击修炼：20",
      fields: [{ name: "攻击修炼", value: "20" }],
      tables: [],
      elements: [],
      tooltips: [],
      items: [{ index: 0, name: "宝宝项圈", kind: "equipment", description: "速度：20" }],
    },
  ],
  raw: {
    AllEquip: [{ name: "测试武器", damage: 500 }],
    AllSummon: [{ name: "测试宝宝", equips: [{ speed: 20 }] }],
  },
});
const checkpoint = (listing: Listing, page = 1): Checkpoint => ({
  key: listing.key,
  time: listing.orderTime,
  order: "selling_time DESC",
  page,
  savedAt: new Date().toISOString(),
});
const stores: CrawlStore[] = [];
const memory = () => {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  return store;
};
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
const source = (pages: Listing[][]): CrawlSource => {
  const read = (number: number): ListingPage => ({
    page: number,
    totalPages: pages.length,
    order: "selling_time DESC",
    items: pages[number - 1],
  });
  return {
    prepare: async () => read(1),
    page: vi.fn(async (n) => read(n)),
    onShelf: vi.fn(async () => true),
    hover: vi.fn(async (row) => row),
    detail: vi.fn(async (row) => detail(row)),
  };
};
const refreshDetail = (listing: Listing, price = "500.00"): RoleDetail => ({
  ...detail(listing),
  equipmentCapture: { ...detail(listing).equipmentCapture!, emptyProof: "official-containers" },
  tabs: MAIN_TABS.map((name) => ({
    name,
    text: "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [],
    ...(name === "道具/法宝" ? { equipmentEmptyProof: "official-containers" as const } : {}),
    ...(name === "召唤兽/孩子" ? { petCount: 0, pets: [] } : {}),
  })),
  valuation: {
    version: 1,
    fields: [],
    issues: [],
    source: { eid: listing.eid, serverId: listing.serverId, askingPrice: price },
  },
});
const readSaved = (db: CrawlStore, key: string) => db.detail(key) as SavedRoleRecord | null;

// 失败方式：超出并发上限、乱序完成使断点倒退、失败后继续派发、暂停后落库、续采漏掉未完成项。
describe("并发采集", () => {
  it.each([false, true])(
    "确证不存在跳过且不增加待重试，重启补采不重复请求；优先补采：%s",
    async (backfillOnly) => {
      const db = memory(),
        gone = item(1),
        good = item(2),
        src = source([[gone, good]]),
        publish = vi.fn();
      if (backfillOnly) {
        db.observe(gone);
        db.observe(good);
      }
      src.detail = vi.fn(async (row) => {
        if (row.key === gone.key) throw new ListingUnavailableError("目标详情返回 HTTP 404");
        return detail(row);
      });
      await crawl(src, db, signal(), publish, { backfillOnly });
      expect(readSaved(db, gone.key)).toMatchObject({
        status: "unavailable",
        error: expect.stringContaining("不再重试"),
      });
      expect(readSaved(db, good.key)).toMatchObject({ status: "complete" });
      expect(db.retryItems()).toEqual([]);
      expect(db.checkpoint()?.key).not.toBe(gone.key);
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          skipped: 1,
          detailProgress: expect.stringContaining("无法补齐"),
        }),
      );
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({ saved: 1, skipped: 1, failed: 0 }),
      );
      await crawl(src, db, signal(), vi.fn(), { backfillOnly: true });
      expect(vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === gone.key)).toHaveLength(
        1,
      );
    },
  );
  it("刷新前官网确证不存在保留旧详情并跳过，不再请求详情", async () => {
    const db = memory(),
      gone = item(1),
      src = source([]),
      publish = vi.fn();
    db.observe(gone);
    db.save(gone, refreshDetail(gone));
    const before = readSaved(db, gone.key)?.detail;
    src.onShelf = vi.fn(async () => {
      throw new ListingUnavailableError("目标详情返回 HTTP 410");
    });
    await crawl(src, db, signal(), publish, {
      backfillOnly: true,
      refresh: true,
      keys: [gone.key],
    });
    expect(src.detail).not.toHaveBeenCalled();
    expect(readSaved(db, gone.key)).toMatchObject({ status: "unavailable", detail: before });
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ skipped: 1, failed: 0, saved: 0 }),
    );
  });
  it.each([1, 3, 5, 0, -2, 2.5, Number.MAX_SAFE_INTEGER + 1])(
    "并发配置 %s 在读取列表前拒绝，不能绕过页面限制",
    async (concurrency) => {
      const db = memory(),
        src = source([[item(1)]]);
      src.prepare = vi.fn(src.prepare);
      src.detail = vi.fn(src.detail);
      expect(() => validateCrawlOptions({ concurrency })).toThrow("正偶数");
      await expect(crawl(src, db, signal(), vi.fn(), { concurrency })).rejects.toThrow("正偶数");
      expect(src.prepare).not.toHaveBeenCalled();
      expect(src.detail).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, 2, 4, 6])("并发配置 %s 限制在途数量且不重复采集", async (concurrency) => {
    const db = memory();
    const rows = Array.from({ length: 11 }, (_, index) => item(index + 1));
    const src = source([rows]);
    const releases: Array<() => void> = [];
    let active = 0,
      maximum = 0;
    src.detail = vi.fn(async (row) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
      return detail(row);
    });
    const task = crawl(src, db, signal(), vi.fn(), { concurrency });
    const limit = concurrency ?? 6;
    await vi.waitFor(() => expect(releases).toHaveLength(limit));
    expect(db.retryItems()).toHaveLength(rows.length);
    while (db.count() < rows.length) {
      releases.splice(0).forEach((release) => release());
      await vi.waitFor(() => expect(releases.length > 0 || db.count() === rows.length).toBe(true));
    }
    await task;
    expect(maximum).toBe(limit);
    expect(src.detail).toHaveBeenCalledTimes(rows.length);
    expect(db.checkpoint()?.key).toBe(rows.at(-1)!.key);
    expect(db.backfillComplete()).toBe(true);
  });

  it("后面的角色先完成，前面的结果仍保存且断点不倒退", async () => {
    const db = memory(),
      rows = [item(1), item(2), item(3)];
    const src = source([rows]);
    const releases = new Map<string, () => void>();
    src.detail = vi.fn(async (row) => {
      await new Promise<void>((resolve) => releases.set(row.key, resolve));
      return detail(row);
    });
    const task = crawl(src, db, signal(), vi.fn());
    await vi.waitFor(() => expect(releases.size).toBe(3));
    for (const row of [...rows].reverse()) {
      releases.get(row.key)!();
      await vi.waitFor(() => expect(readSaved(db, row.key)?.status).toBe("complete"));
      expect(db.checkpoint()?.key).toBe(rows[2].key);
    }
    await task;
    expect(db.count()).toBe(3);
  });

  it("安全验证停止派发，等在途任务结束后才退出，随后补采不漏项", async () => {
    const db = memory(),
      rows = [item(1), item(2), item(3), item(4)];
    const src = source([rows]);
    const releases = new Map<string, () => void>();
    src.detail = vi.fn(async (row) => {
      await new Promise<void>((resolve) => releases.set(row.key, resolve));
      if (row.key === rows[0].key) throw new Error("安全验证");
      return detail(row);
    });
    let settled = false;
    const outcome = crawl(src, db, signal(), vi.fn(), { concurrency: 2 }).then(
      () => {
        settled = true;
        return null;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(releases.size).toBe(2));
    releases.get(rows[0].key)!();
    await vi.waitFor(() => expect(readSaved(db, rows[0].key)?.status).toBe("failed"));
    expect(settled).toBe(false);
    expect(src.detail).toHaveBeenCalledTimes(2);
    releases.get(rows[1].key)!();
    expect(await outcome).toMatchObject({ message: "安全验证" });
    expect(db.count()).toBe(1);
    expect(db.backfillComplete()).toBe(false);
    const resumed = source([[]]);
    await crawl(resumed, db, signal(), vi.fn(), { backfillOnly: true });
    expect(db.count()).toBe(4);
    expect(resumed.detail).toHaveBeenCalledTimes(3);
  });

  it("暂停保留所有在途与未开始角色，续采可更换并发数", async () => {
    const db = memory(),
      rows = [item(1), item(2), item(3), item(4)];
    const control = new AbortController(),
      src = source([rows]);
    src.detail = vi.fn(async (row) => {
      await new Promise<void>((resolve) =>
        control.signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      return detail(row);
    });
    const outcome = crawl(src, db, control.signal, vi.fn()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(src.detail).toHaveBeenCalledTimes(4));
    control.abort(new Error("用户暂停采集"));
    expect(await outcome).toMatchObject({ message: "用户暂停采集" });
    expect(db.count()).toBe(0);
    expect(db.retryItems()).toHaveLength(4);
    expect(db.checkpoint()).toBeUndefined();
    const resumed = source([[]]);
    await crawl(resumed, db, signal(), vi.fn(), { backfillOnly: true, concurrency: 2 });
    expect(db.count()).toBe(4);
    expect(db.checkpoint()).toBeUndefined();
  });

  it.each([0, -1, 1.5, NaN, Infinity])("拒绝无效并发数 %s 且不读取列表", async (concurrency) => {
    const src = source([[item(1)]]),
      db = memory();
    await expect(crawl(src, db, signal(), vi.fn(), { concurrency })).rejects.toThrow("并发数");
    expect(src.page).not.toHaveBeenCalled();
    expect(db.count()).toBe(0);
  });
});
it.each(["backfill", "scan", "watch"])(
  "%s 中途断连保留部分资料为待采，不算单品失败",
  async (mode) => {
    const db = memory(),
      target = item(1),
      partial = detail(target);
    const failure = new BrowserConnectionError("disconnected");
    target.orderTime = target.sellingTime;
    partial.equipmentCapture!.complete = false;
    if (mode === "backfill") db.observe(target);
    const collector = source([[target]]),
      publish = vi.fn();
    collector.detail = vi
      .fn()
      .mockRejectedValue(new IncompleteCaptureError("断连中断", partial, failure));
    await expect(
      crawl(collector, db, signal(), publish, {
        backfillOnly: mode === "backfill",
        watch: mode === "watch",
      }),
    ).rejects.toBe(failure);
    expect(readSaved(db, target.key)).toMatchObject({
      status: "pending",
      detail: { tabs: [{ name: "人物/修炼" }] },
    });
    expect(collector.detail).toHaveBeenCalledOnce();
    expect(db.checkpoint()).toBeUndefined();
    expect(db.count()).toBe(0);
    if (mode === "backfill")
      expect(publish).toHaveBeenLastCalledWith(
        expect.objectContaining({ oldRunning: 0, oldQueued: 1 }),
      );
  },
);
it.each([false, true])(
  "采集失败保留部分详情且不推进成功断点，补采模式=%s",
  async (backfillOnly) => {
    const db = memory(),
      target = item(1),
      partial = detail(target);
    partial.equipmentCapture!.complete = false;
    partial.equipmentCapture!.issues = ["装备库存未核验"];
    if (backfillOnly) db.observe(target);
    const collector = source([[target]]);
    collector.detail = vi
      .fn()
      .mockRejectedValue(
        new IncompleteCaptureError("重读后仍缺项", partial, new Error("装备库存未核验")),
      );
    await crawl(collector, db, signal(), vi.fn(), { backfillOnly });
    expect(db.detail(target.key)).toMatchObject({
      status: "failed",
      error: "重读后仍缺项",
      detail: {
        equipmentCapture: { complete: false },
        tabs: [{ fields: [{ name: "攻击修炼", value: "20" }] }],
      },
    });
    expect(db.count()).toBe(0);
    expect(db.checkpoint()).toBeUndefined();
  },
);

describe("按商品刷新完整资料", () => {
  it("仅刷新指定完整商品，不访问其他待采记录、不移动断点", async () => {
    const db = memory(),
      target = item(1),
      other = item(2),
      pending = item(3);
    for (const row of [target, other, pending]) db.observe(row);
    db.save(target, refreshDetail(target));
    db.save(other, refreshDetail(other), checkpoint(other));
    const beforeOther = db.detail(other.key),
      beforePending = db.detail(pending.key);
    const beforeCheckpoint = db.checkpoint();
    const fresh = refreshDetail(target, "666.00");
    fresh.collectedAt = "2026-10-07T07:00:00.000Z";
    const collector = source([]);
    collector.prepare = vi.fn();
    collector.detail = vi.fn(async () => fresh);
    await crawl(collector, db, signal(), () => {}, {
      backfillOnly: true,
      keys: [target.key],
      refresh: true,
    });
    expect(collector.detail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: target.key }),
    );
    expect(collector.onShelf).toHaveBeenCalledTimes(2);
    expect(collector.prepare).not.toHaveBeenCalled();
    expect(collector.page).not.toHaveBeenCalled();
    expect(collector.hover).not.toHaveBeenCalled();
    expect(readSaved(db, target.key)?.listing.price).toBe("666.00");
    expect(readSaved(db, target.key)?.detail?.collectedAt).toBe(fresh.collectedAt);
    expect(readSaved(db, target.key)?.detail?.tabs.map((tab) => tab.name)).toEqual(MAIN_TABS);
    expect(db.detail(other.key)).toEqual(beforeOther);
    expect(db.detail(pending.key)).toEqual(beforePending);
    expect(db.checkpoint()).toEqual(beforeCheckpoint);
  });
  it.each([
    [
      "装备未齐",
      (value: RoleDetail) => {
        value.equipmentCapture!.complete = false;
      },
    ],
    [
      "宝宝未齐",
      (value: RoleDetail) => {
        value.petCapture!.complete = false;
      },
    ],
    [
      "缺标签",
      (value: RoleDetail) => {
        value.tabs = value.tabs.filter((tab) => tab.name !== "技能");
      },
    ],
    [
      "身份不符",
      (value: RoleDetail) => {
        value.valuation!.source.eid = "other";
      },
    ],
    [
      "价格无效",
      (value: RoleDetail) => {
        value.valuation!.source.askingPrice = "0";
      },
    ],
  ])("%s时保留旧详情并留下重试项", async (_name, corrupt) => {
    const db = memory(),
      target = item(1);
    db.observe(target);
    db.save(target, refreshDetail(target), checkpoint(target));
    const before = readSaved(db, target.key)?.detail,
      point = db.checkpoint();
    const fresh = refreshDetail(target, "666.00");
    corrupt(fresh);
    const collector = source([]);
    collector.detail = vi.fn(async () => fresh);
    await crawl(collector, db, signal(), () => {}, {
      backfillOnly: true,
      keys: [target.key],
      refresh: true,
    });
    expect(readSaved(db, target.key)?.status).toBe("failed");
    expect(readSaved(db, target.key)?.detail).toEqual(before);
    expect(readSaved(db, target.key)?.listing.price).not.toBe("666.00");
    expect(db.retryItems().map((row) => row.key)).toEqual([target.key]);
    expect(db.checkpoint()).toEqual(point);
  });
  it.each([[false], [true, false]])("在售核对失败%s时不覆盖旧资料", async (...states) => {
    const db = memory(),
      target = item(1);
    db.observe(target);
    db.save(target, refreshDetail(target), checkpoint(target));
    const before = readSaved(db, target.key)?.detail,
      point = db.checkpoint();
    const collector = source([]);
    collector.detail = vi.fn(async () => refreshDetail(target, "666.00"));
    collector.onShelf = vi.fn(async () => states.shift() ?? false);
    await expect(
      crawl(collector, db, signal(), () => {}, {
        backfillOnly: true,
        keys: [target.key],
        refresh: true,
      }),
    ).rejects.toThrow("未确认商品仍在售");
    expect(readSaved(db, target.key)?.detail).toEqual(before);
    expect(db.checkpoint()).toEqual(point);
  });
  it("普通补采仍跳过完整商品", async () => {
    const db = memory(),
      target = item(1);
    db.observe(target);
    db.save(target, refreshDetail(target));
    const collector = source([]);
    await crawl(collector, db, signal(), () => {}, { backfillOnly: true, keys: [target.key] });
    expect(collector.detail).not.toHaveBeenCalled();
    expect(collector.onShelf).not.toHaveBeenCalled();
  });
  it("拒绝未知商品刷新且不触发采集", async () => {
    const db = memory(),
      collector = source([]);
    await expect(
      crawl(collector, db, signal(), () => {}, {
        backfillOnly: true,
        keys: ["missing"],
        refresh: true,
      }),
    ).rejects.toThrow("指定刷新商品不存在");
    expect(collector.detail).not.toHaveBeenCalled();
    expect(collector.onShelf).not.toHaveBeenCalled();
    expect(db.count()).toBe(0);
  });
});
describe("仅补齐估值资料", () => {
  it("只补采缺空库存证据的旧角色，非空角色不重采，空确认后不重复补采", async () => {
    const db = memory(),
      row = item(1),
      equipped = item(2);
    const makeDetail = (
      listing: Listing,
      items: RoleDetail["tabs"][number]["items"],
    ): RoleDetail => ({
      ...detail(listing),
      tabs: [
        {
          name: "道具/法宝",
          text: "现金：100",
          fields: [],
          tables: [],
          elements: [],
          tooltips: [],
          items,
        },
      ],
    });
    db.observe(row);
    db.observe(equipped);
    const empty = makeDetail(row, [
      { index: 0, name: "法宝", kind: "equipment", category: "法宝" },
    ]);
    db.save(row, empty);
    db.save(
      equipped,
      makeDetail(equipped, [
        {
          index: 0,
          name: "腰带",
          kind: "equipment",
          category: "人物装备",
          description: "等级100\n防御50",
        },
      ]),
    );
    expect(db.retryItems().map((item) => item.key)).toEqual([row.key]);
    expect(db.records().items.find((item) => item.key === row.key)?.valuationReady).toBe(false);
    expect(db.observe(equipped)).toBe(true);
    expect(db.observe(row)).toBe(false);
    const before = db.checkpoint();
    const collector = source([]);
    collector.prepare = vi.fn();
    collector.detail = vi.fn(async () => ({
      ...empty,
      equipmentCapture: { ...empty.equipmentCapture!, emptyProof: "official-containers" as const },
    }));
    await crawl(collector, db, signal(), () => {}, { backfillOnly: true, keys: [row.key] });
    expect(collector.detail).toHaveBeenCalledOnce();
    expect(collector.prepare).not.toHaveBeenCalled();
    expect(db.checkpoint()).toEqual(before);
    expect(db.retryItems()).toEqual([]);
    expect(db.observe(row)).toBe(true);
    expect(db.records().items.find((item) => item.key === row.key)?.valuationReady).toBe(true);
  });
  it("宝宝凭据缺失、未读完整或带异常时都进入补采，补齐后才跳过", () => {
    const db = memory(),
      row = item(1);
    db.observe(row);
    const missing = detail(row);
    delete missing.petCapture;
    for (const incomplete of [
      missing,
      {
        ...detail(row),
        petCapture: {
          version: 1 as const,
          collectedAt: new Date().toISOString(),
          complete: false,
          issues: [],
        },
      },
      {
        ...detail(row),
        petCapture: {
          version: 1 as const,
          collectedAt: new Date().toISOString(),
          complete: true,
          issues: ["宝宝技能未完整读取"],
        },
      },
    ]) {
      db.save(row, incomplete);
      expect(db.retryItems([row.key])).toHaveLength(1);
      expect(db.records().items[0].valuationReady).toBe(false);
      expect(db.observe(row)).toBe(false);
    }
    db.save(row, detail(row));
    expect(db.retryItems([row.key])).toEqual([]);
    expect(db.records().items[0].valuationReady).toBe(true);
    expect(db.observe(row)).toBe(true);
  });
  it("新版资料的装备未采齐仍可补采，补齐后才跳过且断点保持不变", async () => {
    const db = memory(),
      row = item(1),
      anchor = item(2);
    db.observe(row);
    db.observe(anchor);
    db.save(anchor, detail(anchor), checkpoint(anchor));
    db.save(row, {
      ...detail(row),
      equipmentCapture: {
        version: 1,
        collectedAt: new Date().toISOString(),
        complete: false,
        issues: ["武器伤害没有读取"],
      },
    });
    const before = db.checkpoint();
    expect(db.retryItems([row.key])).toHaveLength(1);
    expect(db.records().items.find((record) => record.key === row.key)?.valuationReady).toBe(false);
    expect(db.observe(row)).toBe(false);
    const collector = source([]);
    collector.prepare = vi.fn();
    await crawl(collector, db, signal(), () => {}, { backfillOnly: true, keys: [row.key] });
    expect(collector.detail).toHaveBeenCalledTimes(1);
    expect(collector.prepare).not.toHaveBeenCalled();
    expect(db.checkpoint()).toEqual(before);
    expect(db.retryItems([row.key])).toEqual([]);
    expect(db.observe(row)).toBe(true);
    expect(db.records().items.find((record) => record.key === row.key)?.valuationReady).toBe(true);
    const missingMetadata = detail(row);
    delete missingMetadata.equipmentCapture;
    db.save(row, missingMetadata);
    expect(db.retryItems([row.key])).toHaveLength(1);
  });
  it("旧完整记录和漏采资料可重试，补采不扫列表、不推进断点并更新实际售价", async () => {
    const db = memory(),
      row = item(1),
      anchor = item(2);
    db.observe(row);
    db.observe(anchor);
    db.save(anchor, detail(anchor), checkpoint(anchor));
    db.save(row, { ...detail(row), captureVersion: 3 });
    const before = db.checkpoint();
    const collector = source([]);
    collector.prepare = vi.fn();
    collector.detail = vi.fn(async (listing) => ({
      ...detail(listing),
      valuation: {
        version: 1 as const,
        fields: [],
        issues: [],
        source: { askingPrice: "16888.00" },
      },
    }));
    await crawl(collector, db, signal(), () => {}, { backfillOnly: true, keys: [row.key] });
    expect(collector.prepare).not.toHaveBeenCalled();
    expect(collector.page).not.toHaveBeenCalled();
    expect(db.checkpoint()).toEqual(before);
    expect((db.detail(row.key) as { listing: Listing }).listing.price).toBe("16888.00");
    expect(db.retryItems()).toEqual([]);
    const incomplete = {
      ...detail(row),
      valuation: { version: 1 as const, fields: [], issues: ["坐骑成长缺失"], source: {} },
    };
    db.save(row, incomplete);
    expect(db.retryItems([row.key])).toHaveLength(1);
    expect(db.records().items.find((record) => record.key === row.key)?.valuationReady).toBe(false);
  });
  it("补采保留原始压缩来源，失败后旧详情仍可查看和重试", () => {
    const db = memory(),
      row = item(1);
    db.observe(row);
    const previous = { ...detail(row), captureVersion: 3 };
    db.save(row, previous);
    db.beginRetry(row.key);
    db.fail(row.key, "网页资料未完整读取");
    expect((db.detail(row.key) as { detail: RoleDetail }).detail.tabs).toHaveLength(
      previous.tabs.length,
    );
    expect(db.retryItems()).toHaveLength(1);
    db.save(row, detail(row));
    const archived = db.db
      .prepare("SELECT source_gzip FROM role_source_history WHERE listing_key=?")
      .get(row.key)!;
    expect(JSON.parse(gunzipSync(archived.source_gzip as Uint8Array).toString())).toEqual(previous);
  });
});
describe("商品身份和时间", () => {
  it("仅保留明确提供的官方kindid字符串，不用装备名或其他类型编号推算", () => {
    const attrs = { data_equip_name: "测试武器", data_type: "19", data_equip_type: "20" };
    expect(itemFromAttributes({ ...attrs, data_kindid: "025" }, 0).kindId).toBe("025");
    expect(itemFromAttributes({ ...attrs, "data-kindid": "31" }, 0).kindId).toBe("31");
    expect(itemFromAttributes(attrs, 0).kindId).toBeUndefined();
    expect(
      itemFromAttributes({ ...attrs, data_kindid: "025", data_skill_type: "cifu" }, 0).kindId,
    ).toBeUndefined();
  });
  it("仅将明确显示已上架的商品作为续采锚点", () => {
    expect(onShelfFromText("是否上架：已上架")).toBe(true);
    expect(onShelfFromText("是否上架：已下架")).toBe(false);
    expect(onShelfFromText("是否上架：已售出")).toBe(false);
    expect(onShelfFromText("商品详情")).toBe(false);
    expect(onShelfFromText("服务器：模拟服\n编号：123\n状态：上架中\n价格：￥5888.00")).toBe(true);
    expect(onShelfFromText("状态：已下架\n相关推荐：上架中")).toBe(false);
    expect(onShelfFromText("绑定状态：上架中\n相关推荐：上架中")).toBe(false);
    expect(onShelfFromText("状态：交易中")).toBe(false);
  });
  it("保留估价装备数值和专用限制，剔除背景与功效说明", () => {
    const weapon = itemFromAttributes(
      {
        data_equip_name: "业火三灾",
        data_equip_desc:
          "#r等级 150  五行 金#r命中 +1022 伤害 +678#r耐久度 414#r锻炼等级 15  镶嵌宝石 红玛瑙#r#G敏捷 +31#Y#r特效：非大唐官府使用-43命中#r玩家25766782专用#r符石组合: 百步穿杨#r物理攻击时有20%的几率给目标额外造成100点伤害#r熔炼效果：#r+5敏捷",
        data_equip_type_desc: "周身暗红，如浴血池。#r【装备角色】剑侠客，巨魔王",
      },
      0,
    );
    for (const core of [
      "命中 +1022",
      "伤害 +678",
      "锻炼等级 15",
      "敏捷 +31",
      "玩家25766782专用",
      "+5敏捷",
      "百步穿杨",
    ])
      expect(weapon.description).toContain(core);
    expect(JSON.stringify(weapon)).not.toMatch(/如浴血池|20%的几率|equip_type/);
    expect(weapon.attributes?.装备角色).toBe("剑侠客，巨魔王");
    expect(
      coreEquipmentDescription(
        "其状如牛，相传远古奇兽夔牛皮…\n功能：战斗时增加伤害\n等级 150\n防御 +80",
      ),
    ).toBe("等级 150\n防御 +80");
  });
  it("技能只保留名称、明确类别及等级，不保存技能作用和内部键", () => {
    const skill = itemFromAttributes(
      {
        data_equip_name: "坐骑测试技能",
        data_skill_type: "riderSkill",
        data_equip_level: "1",
        data_equip_desc: "提高统御召唤兽效果的长篇说明",
      },
      0,
    );
    expect(skill).toEqual({
      index: 0,
      name: "坐骑测试技能",
      kind: "skill",
      category: "坐骑技能",
      level: "1",
    });
    const pet = itemFromAttributes(
      {
        data_equip_name: "高级必杀",
        data_skill_type: "cifu",
        data_equip_desc: "攻击时有几率造成双倍伤害",
      },
      0,
    );
    expect(pet.description).toBeUndefined();
    expect(pet.attributes).toBeUndefined();
  });
  it("保留独立魔力和修理专用限制，HTML换行不会串入下一条限制", () => {
    const equip = itemFromAttributes(
      {
        data_equip_name: "测试衣服",
        data_equip_desc:
          "等级 100<br />防御 +150<br>魔力 +20#r修理失败 2次#r玩家 1234 专用#r不可交易",
        data_equip_type_desc: "【装备条件】等级100<br />【装备角色】女",
        data_equip_category: "铠甲",
        data_equip_location: "已装备",
      },
      0,
    );
    expect(equip.description).toContain("魔力 +20");
    expect(equip.description).toContain("修理失败 2次");
    expect(equip.description).toContain("玩家 1234 专用");
    expect(equip.description).toContain("不可交易");
    expect(equip.attributes).toEqual({ 装备条件: "等级100", 装备角色: "女" });
    expect(equip.category).toBe("铠甲");
    expect(equip.location).toBe("已装备");
  });
  it("未知图标和只有装备名字时不宣称完整，明确法宝不会当普通装备", () => {
    const empty = {
      name: "道具/法宝",
      text: "道具和法宝",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [itemFromAttributes({ data_equip_name: "测试武器" }, 0)],
    };
    expect(equipmentCaptureSummary([empty], "now").complete).toBe(false);
    expect(equipmentCaptureSummary([empty], "now").issues).toContain(
      "道具/法宝：测试武器 的装备属性未完整读取",
    );
    empty.items[0].description = "等级 100\n耐久度 200";
    expect(equipmentCaptureSummary([empty], "now").complete).toBe(false);
    empty.items[0].attributes = { 等级: "100", 耐久: "200", 修理失败: "0" };
    expect(equipmentCaptureSummary([empty], "now").complete).toBe(false);
    delete empty.items[0].attributes;
    empty.items[0].description = "伤害 +420";
    expect(equipmentCaptureSummary([empty], "now").issues).toContain(
      "道具/法宝：测试武器 的装备等级未完整读取",
    );
    empty.items[0].description = "等级 100\n伤害 +420";
    expect(equipmentCaptureSummary([empty], "now").complete).toBe(true);
    empty.items = [
      itemFromAttributes(
        { data_equip_name: "测试法宝", data_equip_desc: "灵气：500 修炼境界：第15层" },
        0,
      ),
    ];
    expect(empty.items[0].category).toBe("法宝");
    expect(equipmentCaptureSummary([empty], "now").complete).toBe(false);
    expect(equipmentCaptureSummary([{ ...empty, text: "没有装备" }], "now").complete).toBe(true);
    expect(equipmentCaptureSummary([], "now").complete).toBe(false);
    expect(equipmentCaptureSummary([{ ...empty, text: "", items: [] }], "now").complete).toBe(
      false,
    );
  });
  it("数字model不会覆盖官网法宝、灵宝、神器容器及灵气证据", () => {
    const samples = [
      [{ data_equip_type: "17320", data_equip_desc: "灵气：29" }, "法宝"],
      [
        {
          data_equip_type: "6033",
          data_equip_location: "RoleStoreFabao",
          data_equip_desc: "灵气：500 五行：火\n修炼境界：第15层 天人合一",
        },
        "法宝",
      ],
      [{ data_equip_location: "RoleStoreShenqi" }, "神器"],
      [{ data_equip_type: "6145", data_equip_location: "RoleUsingFabao" }, "法宝"],
      [{ data_equip_type: " 6030 ", data_equip_location: "RoleStoreLingbao" }, "灵宝"],
      [{ data_equip_type: "6030", data_storage_type: "法宝" }, "法宝"],
    ] as const;
    const items = samples.map(([attrs, category], index) => {
      const item = itemFromAttributes({ data_equip_name: `测试物品${index}`, ...attrs }, index);
      expect(item.category).toBe(category);
      return item;
    });
    const snapshot = {
      name: "道具/法宝",
      text: "道具和法宝",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items,
    };
    expect(equipmentCaptureSummary([snapshot], "now").complete).toBe(false);
    expect(
      equipmentCaptureSummary([{ ...snapshot, equipmentEmptyProof: "official-containers" }], "now")
        .complete,
    ).toBe(true);
    const unknown = itemFromAttributes({ data_equip_name: "未知物品", data_equip_type: "6033" }, 5);
    expect(unknown.category).toBeUndefined();
    expect(equipmentCaptureSummary([{ ...snapshot, items: [unknown] }], "now").complete).toBe(
      false,
    );
    const gear = itemFromAttributes(
      {
        data_equip_name: "测试鞋",
        data_equip_type: "2755",
        data_equip_desc: "等级130\n防御70\n敏捷50",
      },
      6,
    );
    expect(gear.category).toBeUndefined();
    expect(equipmentCaptureSummary([{ ...snapshot, items: [gear] }], "now").complete).toBe(true);
    gear.description = "等级130";
    expect(equipmentCaptureSummary([{ ...snapshot, items: [gear] }], "now").complete).toBe(false);
  });
  it("跟踪参数、悬停时间和 URL 时间片段不会改变商品身份或时间", () => {
    const a = parseListing(
      "https://xyq.cbg.163.com/equip?s=367&eid=202607021800113-367-abc&reco_request_id=999",
      { data_selling_time: "2026-09-02 13:24:14", mouse_over_begin: "Mon Sep 07 2026" },
      null,
      "",
    );
    const b = parseListing(
      "https://xyq.cbg.163.com/equip?s=367&amp;eid=202607021800113-367-abc&from_shareid=different",
      {},
      null,
      "",
    );
    expect(a.key).toBe(b.key);
    expect(a.sellingTime).toBe("2026-09-02T05:24:14.000Z");
    expect(b.sellingTime).toBeNull();
    expect(a.createdTime).toBeNull();
  });
  it("拒绝无法确认的商品标识和日期", () => {
    expect(() => parseListing("https://example.com/equip?s=1&eid=1", {}, null, "")).toThrow();
    expect(() => parseListing("/equip?s=1", {}, null, "")).toThrow();
    expect(timestamp("Mon Sep 07 2026")).toBeNull();
  });
});
describe("SQLite 去重与断点", () => {
  it("清空包含商品、详情、参数、原文和断点；运行中拒绝清空", () => {
    const db = memory(),
      a = item(1);
    db.observe(a);
    db.save(a, detail(a), checkpoint(a));
    expect(db.acquire("running")).toBe(true);
    expect(() => db.clear()).toThrow("请先暂停");
    expect(db.count()).toBe(1);
    db.release("running");
    db.clear();
    for (const table of [
      "listings",
      "role_tabs",
      "role_parameters",
      "role_sources",
      "crawl_state",
      "crawl_lock",
    ])
      expect(db.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    expect(db.checkpoint()).toBeUndefined();
  });
  it("压缩原始数据且精简 JSON，旧记录需要重采以补全逐件属性", () => {
    const db = memory(),
      a = item(1);
    const legacy = detail(a);
    delete legacy.captureVersion;
    delete legacy.tabs[0].items;
    legacy.tabs[0].elements = [
      { tag: "TEXTAREA", id: "equip_desc_value", value: "original-source".repeat(5000) },
      {
        tag: "IMG",
        src: "unused.gif",
        data_equip_name: "测试刀",
        data_equip_desc: "伤害：500#r特技：罗汉金钟",
        data_tip_box: "RoleEquipTipsBox",
      },
    ];
    db.observe(a);
    db.save(a, legacy, checkpoint(a));
    const saved = db.detail(a.key) as { detail: RoleDetail };
    expect(JSON.stringify(saved).length).toBeLessThan(JSON.stringify(legacy).length / 10);
    expect(saved.detail.tabs[0].items?.[0].description).toContain("特技：罗汉金钟");
    const archive = db.db
      .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
      .get(a.key)!;
    expect(JSON.parse(gunzipSync(archive.source_gzip as Uint8Array).toString())).toEqual(legacy);
    expect(compactDetail(saved.detail)).toEqual(saved.detail);
    expect(db.observe(a)).toBe(false);
    db.save(a, detail(a), checkpoint(a));
    expect(db.observe(a)).toBe(true);
  });
  it("完整详情、参数和断点一次提交；重复采集不增加行", () => {
    const db = memory(),
      a = item(1);
    expect(db.observe(a)).toBe(false);
    db.save(a, detail(a), checkpoint(a));
    expect(db.observe({ ...a, price: "99" })).toBe(true);
    expect(db.count()).toBe(1);
    expect(db.checkpoint()?.key).toBe(a.key);
    expect(
      db.db
        .prepare(
          "SELECT value_json FROM role_parameters WHERE section='items:0' AND path='/0/description'",
        )
        .get()?.value_json,
    ).toBe(JSON.stringify("速度：20"));
    expect(db.db.prepare("SELECT count(*) AS n FROM role_tabs").get()?.n).toBe(1);
  });
  it("失败不推进断点，重新上架更新原记录并重新获取详情", () => {
    const db = memory(),
      a = item(1),
      b = item(2);
    db.observe(a);
    db.save(a, detail(a), checkpoint(a));
    db.observe(b);
    db.fail(b.key, "验证");
    expect(db.checkpoint()?.key).toBe(a.key);
    expect(db.observe(b)).toBe(false);
    expect(db.observe({ ...a, sellingTime: "2026-09-08T00:00:00.000Z" })).toBe(false);
    expect(db.db.prepare("SELECT count(*) AS n FROM listings").get()?.n).toBe(2);
  });
  it("事务失败时详情和断点同时回滚", () => {
    const db = memory(),
      a = item(1);
    db.observe(a);
    const broken = { ...detail(a), raw: { bad: BigInt(1) } };
    expect(() => db.save(a, broken, checkpoint(a))).toThrow();
    expect(db.count()).toBe(0);
    expect(db.checkpoint()).toBeUndefined();
  });
  it("升级旧库时精简已有 JSON，保留压缩原文和断点", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cbg-upgrade-test-"));
    const filename = path.join(dir, "db.sqlite");
    let db = new CrawlStore(filename);
    const a = item(1),
      original = detail(a);
    delete original.captureVersion;
    original.tabs[0].elements = [{ tag: "TEXTAREA", value: "encoded-value".repeat(1000) }];
    try {
      db.observe(a);
      db.save(a, detail(a), checkpoint(a));
      const point = db.checkpoint();
      db.db
        .prepare("UPDATE listings SET detail_json=? WHERE key=?")
        .run(JSON.stringify(original), a.key);
      db.close();
      db = new CrawlStore(filename);
      const saved = db.detail(a.key) as { detail: RoleDetail };
      expect(saved.detail.formatVersion).toBe(3);
      expect(saved.detail.tabs[0].elements).toEqual([]);
      expect(db.checkpoint()).toEqual(point);
      const source = db.db
        .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
        .get(a.key)!;
      expect(JSON.parse(gunzipSync(source.source_gzip as Uint8Array).toString())).toEqual(original);
      expect(db.observe(a)).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("升级已有 SQLite 时保留记录并加入补采次数字段", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cbg-retry-upgrade-test-"));
    const filename = path.join(dir, "cbg.sqlite");
    const old = new DatabaseSync(filename);
    try {
      old.exec(`CREATE TABLE listings (
        key TEXT PRIMARY KEY, server_id TEXT NOT NULL, eid TEXT NOT NULL, ordersn TEXT NOT NULL,
        url TEXT NOT NULL, selling_time TEXT, created_time TEXT, name TEXT NOT NULL, price TEXT NOT NULL,
        listing_json TEXT NOT NULL, detail_json TEXT, status TEXT NOT NULL DEFAULT 'pending', error TEXT,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, collected_at TEXT
      )`);
      old.exec(
        "CREATE TABLE crawl_state (id INTEGER PRIMARY KEY CHECK(id=1), checkpoint_json TEXT)",
      );
    } finally {
      old.close();
    }
    const db = new CrawlStore(filename);
    try {
      const columns = db.db
        .prepare("SELECT name FROM pragma_table_info('listings')")
        .all()
        .map((row) => String(row.name));
      expect(columns).toContain("attempt_count");
      expect(columns).toContain("last_attempt_at");
      expect(
        db.db
          .prepare("SELECT name FROM pragma_table_info('crawl_state')")
          .all()
          .map((row) => String(row.name)),
      ).toContain("backfill_complete");
      expect(db.backfillComplete()).toBe(false);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("程序关闭再打开仍可恢复断点，两个进程不能同时持有采集锁", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cbg-db-test-"));
    const filename = path.join(dir, "db.sqlite");
    const a = item(1);
    let db = new CrawlStore(filename);
    try {
      db.observe(a);
      db.save(a, detail(a), checkpoint(a));
      expect(db.acquire("one", 1000)).toBe(true);
      db.close();
      db = new CrawlStore(filename);
      expect(db.checkpoint()?.key).toBe(a.key);
      expect(db.observe(a)).toBe(true);
      expect(db.acquire("two", 2000)).toBe(false);
      expect(db.acquire("two", 122000)).toBe(true);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("二分定位与动态翻页", () => {
  it("旧锚点时间早于整份当前列表时放弃二分并核对全部页面", async () => {
    const db = memory(),
      old = item(1000),
      src = source(Array.from({ length: 8 }, (_, index) => [item(index)]));
    db.observe(old);
    db.save(old, detail(old), checkpoint(old, 4));
    const point = db.checkpoint()!;
    expect(await locateCheckpoint(src, await src.prepare(), point, signal())).toBeNull();
    const plan = await prepareCrawlPages(src, db, signal(), vi.fn());
    expect(plan.fullScan).toBe(true);
    expect(plan.numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(db.checkpoint()).toEqual(point);
  });

  it("千页列表对数次定位，重叠一页而非按时间丢弃相等商品", async () => {
    const pages = Array.from({ length: 1024 }, (_, i) => [item(i * 2), item(i * 2 + 1)]);
    const src = source(pages);
    const result = await locateCheckpoint(
      src,
      await src.prepare(),
      checkpoint(pages[699][1], 700),
      signal(),
    );
    expect(result).toBe(699);
    expect(vi.mocked(src.page).mock.calls.length).toBeLessThanOrEqual(11);
  });
  it("推荐乱序和缺失时间降级逐页，不用无效二分结果跳过数据", async () => {
    const src = source([[item(1), item(2)], [item(4), item(3)], [item(5)]]);
    expect(
      await locateCheckpoint(src, await src.prepare(), checkpoint(item(4)), signal()),
    ).toBeNull();
    const first = await src.prepare();
    first.items[0].orderTime = null;
    expect(await locateCheckpoint(src, first, checkpoint(item(4)), signal())).toBeNull();
  });
  it("再次运行会发现前段新增和同时间商品，已保存详情不再打开", async () => {
    const db = memory(),
      old = item(2),
      newer = item(1),
      same = { ...item(3), orderTime: old.orderTime };
    db.observe(old);
    db.save(old, detail(old), checkpoint(old));
    const src = source([
      [newer, old],
      [old, same],
    ]);
    await crawl(src, db, signal(), () => {});
    expect(db.count()).toBe(3);
    expect(db.backfillComplete()).toBe(true);
    expect(vi.mocked(src.detail).mock.calls.map((call) => call[0].key)).toEqual([
      newer.key,
      same.key,
    ]);
    expect(src.hover).toHaveBeenCalledTimes(4);
    await crawl(src, db, signal(), () => {});
    expect(src.detail).toHaveBeenCalledTimes(2);
  });
  it("详情中断后保留成功断点，续采重试失败商品", async () => {
    const db = memory(),
      a = item(1),
      b = item(2),
      src = source([[a, b]]);
    src.detail = vi.fn(async (row) => {
      if (row.key === b.key) throw new Error("安全验证");
      return detail(row);
    });
    await expect(crawl(src, db, signal(), () => {})).rejects.toThrow("安全验证");
    expect(db.checkpoint()?.key).toBe(a.key);
    expect(db.count()).toBe(1);
    src.detail = vi.fn(async (row) => detail(row));
    await crawl(src, db, signal(), () => {});
    expect(src.detail).toHaveBeenCalledTimes(1);
    expect(db.count()).toBe(2);
  });
  it("暂停中的商品保留待续采，下一次先按保存链接补采", async () => {
    const db = memory(),
      a = item(1),
      first = source([[a]]),
      controller = new AbortController();
    first.detail = vi.fn(async () => {
      controller.abort(new Error("用户暂停采集"));
      controller.signal.throwIfAborted();
      return detail(a);
    });
    await expect(crawl(first, db, controller.signal, () => {})).rejects.toThrow("用户暂停采集");
    expect(db.detail(a.key)).toMatchObject({ status: "pending", detail: null, error: null });
    expect(db.checkpoint()).toBeUndefined();

    const resumed = source([[]]);
    await crawl(resumed, db, signal(), () => {});
    expect(resumed.detail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: a.key, url: a.url }),
    );
    expect(db.detail(a.key)).toMatchObject({ status: "complete" });
  });
  it("补采不依赖当前列表且不会推进旧记录的断点", async () => {
    const db = memory(),
      a = item(1),
      b = item(2),
      c = item(3);
    db.observe(a);
    db.save(a, detail(a), checkpoint(a));
    db.observe(b);
    db.fail(b.key, "召唤兽数量不一致");
    const src = source([[c]]);
    await crawl(src, db, signal(), () => {});
    expect(src.detail).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ key: b.key, url: b.url }),
    );
    expect(src.detail).toHaveBeenNthCalledWith(2, c);
    expect(db.detail(b.key)).toMatchObject({ status: "complete" });
    expect(db.checkpoint()?.key).toBe(c.key);
  });
  it("单条召唤兽详情不完整不阻断后续翻页，失败商品仍可续采", async () => {
    const db = memory(),
      a = item(1),
      b = item(2),
      c = item(3),
      src = source([[a, b], [c]]);
    src.detail = vi.fn(async (row) => {
      if (row.key === b.key)
        throw Object.assign(new Error("召唤兽数量不一致"), { name: "IncompleteDetailError" });
      return detail(row);
    });
    const publish = vi.fn();
    await crawl(src, db, signal(), publish);
    expect(db.count()).toBe(2);
    expect(db.detail(b.key)).toMatchObject({ status: "failed", detail: null });
    expect(db.checkpoint()?.key).toBe(c.key);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: "completed", saved: 2, failed: 1 }),
    );
    src.detail = vi.fn(async (row) => detail(row));
    await crawl(src, db, signal(), () => {});
    expect(src.detail).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ key: b.key, url: b.url }),
    );
    expect(db.count()).toBe(3);
  });
  it("商品在悬停时消失后刷新当前页，继续采集剩余商品", async () => {
    const a = item(1),
      b = item(2),
      c = item(3);
    for (const [gone, remaining] of [
      [a, [b, c]],
      [b, [a, c]],
      [c, [a, b]],
    ] as const) {
      const db = memory(),
        src = source([[a, b, c]]);
      let current: Listing[] = [a, b, c];
      src.page = vi.fn(async () => ({
        page: 1,
        totalPages: 1,
        order: "selling_time DESC",
        items: current,
      }));
      src.hover = vi.fn(async (row) => {
        if (row.key === gone.key) {
          current = [...remaining];
          throw new ListingChangedError();
        }
        return row;
      });

      await crawl(src, db, signal(), () => {});
      expect(vi.mocked(src.detail).mock.calls.map(([row]) => row.key)).toEqual(
        remaining.map((row) => row.key),
      );
      expect(db.count()).toBe(remaining.length);
      expect(src.page).toHaveBeenCalledTimes(2);
    }
  });
  it("采集记录按数据库分页，含失败状态、服务器、亮点及持久化时间", () => {
    const db = memory();
    for (let id = 1; id <= 45; id++) {
      const row = {
        ...item(id),
        serverName: "测试服",
        attrs: { data_highlights: JSON.stringify([["总修100", 90, { value: 100 }]]) },
      };
      db.observe(row);
      if (id === 45) db.fail(row.key, "待重试");
      else db.save(row, detail(row), checkpoint(row));
    }
    const pages = [1, 2, 3].map((page) => db.records(page));
    expect(pages.map((page) => page.items.length)).toEqual([20, 20, 5]);
    expect(new Set(pages.flatMap((page) => page.items.map((item) => item.key))).size).toBe(45);
    expect(pages[0]).toMatchObject({ total: 45, totalPages: 3 });
    expect(pages.flatMap((page) => page.items).find((item) => item.key === "367:item-1")?.url).toBe(
      "https://xyq.cbg.163.com/equip?s=367&eid=item-1",
    );
    expect(
      pages.flatMap((page) => page.items).find((item) => item.status === "failed"),
    ).toMatchObject({
      serverName: "测试服",
      highlights: ["总修100"],
      error: "待重试",
      collectedAt: null,
    });
    expect(
      pages.flatMap((page) => page.items).find((item) => item.status === "complete")?.collectedAt,
    ).toBeTruthy();
    expect(db.records(999).page).toBe(3);
    expect(db.records(NaN, NaN).pageSize).toBe(20);
  });
  it("历史未补齐时只从二分断点附近继续向后采集", async () => {
    const db = memory();
    const pages = Array.from({ length: 5 }, (_, index) => [item(index + 1)]);
    const old = pages[3][0];
    db.observe(old);
    db.save(old, detail(old), checkpoint(old, 4));
    const src = source(pages);
    await crawl(src, db, signal(), () => {});
    expect(vi.mocked(src.detail).mock.calls.map(([row]) => row.key)).toEqual([
      pages[2][0].key,
      pages[4][0].key,
    ]);
    expect(db.count()).toBe(3);
  });
  it("最后锚点已下架时改用前一条上架商品，不回扫前段", async () => {
    const db = memory();
    const pages = Array.from({ length: 5 }, (_, index) => [item(index + 1)]);
    const previous = pages[2][0];
    const last = pages[3][0];
    db.observe(previous);
    db.save(
      previous,
      { ...detail(previous), collectedAt: "2026-01-01T00:00:01.000Z" },
      checkpoint(previous, 3),
    );
    db.observe(last);
    db.save(
      last,
      { ...detail(last), collectedAt: "2026-01-01T00:00:02.000Z" },
      checkpoint(last, 4),
    );
    const src = source(pages);
    src.onShelf = vi.fn(async (row) => row.key === previous.key);

    await crawl(src, db, signal(), () => {});
    expect(src.onShelf).toHaveBeenNthCalledWith(1, expect.objectContaining({ key: last.key }));
    expect(src.onShelf).toHaveBeenNthCalledWith(2, expect.objectContaining({ key: previous.key }));
    expect(vi.mocked(src.page).mock.calls.map(([page]) => page)).not.toContain(1);
    expect(vi.mocked(src.detail).mock.calls.map(([row]) => row.key)).toEqual([
      pages[1][0].key,
      pages[4][0].key,
    ]);
  });
  it("历史补齐后只检查上架锚点前的新增页", async () => {
    const db = memory();
    const pages = Array.from({ length: 5 }, (_, index) => [item(index + 1)]);
    const previous = pages[2][0];
    const last = pages[3][0];
    db.observe(previous);
    db.save(previous, detail(previous), checkpoint(previous, 3));
    db.observe(last);
    db.save(last, detail(last), checkpoint(last, 4));
    db.markBackfillComplete();
    const src = source(pages);

    await crawl(src, db, signal(), () => {});
    expect(vi.mocked(src.detail).mock.calls.map(([row]) => row.key)).toEqual([
      pages[0][0].key,
      pages[1][0].key,
    ]);
    expect(vi.mocked(src.page).mock.calls.map(([page]) => page)).not.toContain(5);
  });
  it("历史锚点全部失效时全量核对，但不重开已完整商品详情", async () => {
    const db = memory();
    const old = item(3);
    db.observe(old);
    db.save(old, detail(old), checkpoint(old, 3));
    db.markBackfillComplete();
    const pages = [[item(1)], [item(2)], [old], [item(4)]];
    const src = source(pages);
    src.onShelf = vi.fn(async () => false);

    await crawl(src, db, signal(), () => {});
    expect(vi.mocked(src.page).mock.calls.map(([page]) => page)).toEqual([1, 2, 3, 4]);
    expect(vi.mocked(src.detail).mock.calls.map(([row]) => row.key)).toEqual([
      pages[0][0].key,
      pages[1][0].key,
      pages[3][0].key,
    ]);
  });
  it("排序不能确认时全量核对，不按旧页码截断", async () => {
    const db = memory();
    const old = item(3);
    db.observe(old);
    db.save(old, detail(old), checkpoint(old, 3));
    db.markBackfillComplete();
    const src = source([[item(1)], [item(2)], [old], [item(4)]]);
    const originalPrepare = src.prepare;
    src.prepare = async () => ({ ...(await originalPrepare()), order: "推荐排序" });

    await crawl(src, db, signal(), () => {});
    expect(vi.mocked(src.page).mock.calls.map(([page]) => page)).toEqual([1, 2, 3, 4]);
    expect(vi.mocked(src.detail).mock.calls.map(([row]) => row.key)).toContain(item(4).key);
  });
  it("重复页刷新仍相同则继续后页，有限补查后保留待复核而不标记历史补齐", async () => {
    const db = memory(),
      first = item(1),
      tail = item(3),
      src = source([[first], [first], [tail]]),
      publish = vi.fn();
    await crawl(src, db, signal(), publish);
    expect(src.page).toHaveBeenCalledWith(2, true);
    expect(src.page).toHaveBeenCalledWith(3);
    expect(vi.mocked(src.page).mock.calls.filter(([number]) => number === 2)).toHaveLength(3);
    expect(db.count()).toBe(2);
    expect(readSaved(db, tail.key)?.status).toBe("complete");
    expect(db.pageReviews()).toEqual([
      expect.objectContaining({ order: "selling_time DESC", page: 2, signature: first.key }),
    ]);
    expect(db.backfillComplete()).toBe(false);
    expect(db.checkpoint()?.key).toBe(first.key);
    expect(publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: "completed",
        pageReviews: [expect.objectContaining({ page: 2 })],
        message: expect.stringContaining("复核"),
      }),
    );
    const controller = new AbortController();
    controller.abort(new Error("暂停"));
    const calls = vi.mocked(src.page).mock.calls.length;
    await expect(crawl(src, db, controller.signal, () => {})).rejects.toThrow("暂停");
    expect(src.page).toHaveBeenCalledTimes(calls);
  });

  it.each([1, 2])("重复页在第 %s 次强制重读恢复，采集遗漏商品且不重复保存原商品", async (at) => {
    const db = memory(),
      first = item(1),
      missing = item(2),
      tail = item(3),
      src = source([[first], [missing], [tail]]),
      readPage = src.page;
    let refreshes = 0;
    src.page = vi.fn(async (number, refresh) => {
      const page = await readPage(number, refresh);
      if (number === 2 && (!refresh || ++refreshes < at)) return { ...page, items: [first] };
      return page;
    });
    await crawl(src, db, signal(), vi.fn());
    expect(refreshes).toBe(at);
    expect(db.pageReviews()).toEqual([]);
    expect(db.backfillComplete()).toBe(true);
    expect(db.count()).toBe(3);
    expect(readSaved(db, missing.key)?.status).toBe("complete");
    expect(vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === first.key)).toHaveLength(
      1,
    );
    if (at === 2) expect(db.checkpoint()?.key).toBe(first.key);
  });

  it("续采有待复核页时从首页完整核对，不因较后的成功断点漏掉早页", async () => {
    const db = memory(),
      pages = Array.from({ length: 8 }, (_, index) => [item(index + 1)]),
      anchor = pages[5][0],
      src = source(pages);
    db.observe(anchor);
    db.save(anchor, detail(anchor), checkpoint(anchor, 6));
    db.markBackfillComplete();
    db.deferPageReview("selling_time DESC", 2, pages[0][0].key);
    await crawl(src, db, signal(), vi.fn());
    expect(src.page).toHaveBeenCalledWith(1);
    expect(readSaved(db, pages[1][0].key)?.status).toBe("complete");
    expect(db.pageReviews()).toEqual([]);
    expect(db.backfillComplete()).toBe(true);
    expect(db.count()).toBe(8);
    expect(vi.mocked(src.detail).mock.calls.filter(([row]) => row.key === anchor.key)).toHaveLength(
      0,
    );
  });

  it("整轮全部页面重复也只推进到总页数，补查次数有界并保留全部疑点", async () => {
    const db = memory(),
      row = item(1),
      src = source(Array.from({ length: 7 }, () => [row]));
    await crawl(src, db, signal(), vi.fn());
    expect(src.page).toHaveBeenCalledTimes(25);
    expect(Math.max(...vi.mocked(src.page).mock.calls.map(([number]) => number))).toBe(7);
    expect(db.pageReviews().map(({ page }) => page)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(src.detail).toHaveBeenCalledTimes(1);
    expect(db.count()).toBe(1);
    expect(db.backfillComplete()).toBe(false);
  });

  it.each([
    ["首次刷新", 1, false],
    ["首次刷新", 1, true],
    ["本轮补查", 2, false],
    ["本轮补查", 2, true],
  ] as const)(
    "重复页%s第 %i 次强制读取发现总页数增加时继续采集尾页，重复解除=%s",
    async (_where, at, recovered) => {
      const db = memory(),
        first = item(1),
        old = item(2),
        missing = item(3),
        tail = item(4),
        src = source([[first], [old], [missing], [tail]]),
        readPage = src.page;
      let refreshes = 0,
        totalPages = 3;
      src.prepare = vi.fn(async () => ({ ...(await readPage(1)), totalPages }));
      src.page = vi.fn(async (number, refresh) => {
        if (number === 3 && refresh && ++refreshes >= at) totalPages = 4;
        const page = { ...(await readPage(number, refresh)), totalPages };
        if (number === 3 && (!recovered || refreshes < at)) return { ...page, items: [old] };
        return page;
      });
      await crawl(src, db, signal(), vi.fn());
      expect(src.page).toHaveBeenCalledWith(4);
      expect(readSaved(db, tail.key)?.status).toBe("complete");
      expect(db.pageReviews()).toHaveLength(recovered ? 0 : 1);
      expect(db.backfillComplete()).toBe(recovered);
    },
  );

  it("列表总页数缩小时保留范围外待复核记录，不越界翻页或误标补齐", async () => {
    const db = memory(),
      src = source([[item(1)], [item(2)], [item(3)]]);
    db.deferPageReview("selling_time DESC", 4, item(3).key);
    await crawl(src, db, signal(), vi.fn());
    expect(src.page).not.toHaveBeenCalledWith(4);
    expect(src.page).not.toHaveBeenCalledWith(4, true);
    expect(db.pageReviews()).toEqual([expect.objectContaining({ page: 4 })]);
    expect(db.count()).toBe(3);
    expect(db.backfillComplete()).toBe(false);
  });
});
