import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";
import { parseListing, timestamp } from "./listing";
import { CrawlStore } from "./store";
import { crawl } from "./runner";
import { locateCheckpoint } from "./resume";
import type { CrawlSource } from "./types";
import {
  ListingChangedError,
  type Checkpoint,
  type Listing,
  type ListingPage,
  type RoleDetail,
} from "./types";
import { gunzipSync } from "node:zlib";
import { compactDetail, itemFromAttributes, coreEquipmentDescription } from "./compact";
import { onShelfFromText } from "./detail";
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
  captureVersion: 3,
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
describe("商品身份和时间", () => {
  it("仅将明确显示已上架的商品作为续采锚点", () => {
    expect(onShelfFromText("是否上架：已上架")).toBe(true);
    expect(onShelfFromText("是否上架：已下架")).toBe(false);
    expect(onShelfFromText("是否上架：已售出")).toBe(false);
    expect(onShelfFromText("商品详情")).toBe(false);
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
  it("翻页无变化会停止，不重复循环；暂停不会继续点击", async () => {
    const db = memory(),
      src = source([[item(1)], [item(1)]]);
    await expect(crawl(src, db, signal(), () => {})).rejects.toThrow("连续两页");
    const controller = new AbortController();
    controller.abort(new Error("暂停"));
    await expect(crawl(src, db, controller.signal, () => {})).rejects.toThrow("暂停");
  });
});
