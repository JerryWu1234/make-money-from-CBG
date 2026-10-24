import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "./store";

it("发现和重复扫描只登记待采，实际派发详情时才累计尝试次数", () => {
  const store = new CrawlStore(":memory:");
  const row = analysisRecord("not-started");
  const attempts = () =>
    store.db
      .prepare("SELECT attempt_count,last_attempt_at FROM listings WHERE key=?")
      .get(row.listing.key);
  try {
    store.observe(row.listing);
    store.observe(row.listing);
    expect(attempts()).toMatchObject({ attempt_count: 0, last_attempt_at: null });
    store.beginRetry(row.listing.key);
    expect(attempts()).toMatchObject({ attempt_count: 1, last_attempt_at: expect.any(String) });
    store.fail(row.listing.key, "详情未读完");
    const failedAttempt = attempts();
    store.observe(row.listing);
    expect(attempts()).toEqual(failedAttempt);
    expect(store.detail(row.listing.key)).toMatchObject({ status: "failed", error: "详情未读完" });
    store.beginRetry(row.listing.key);
    expect(attempts()).toMatchObject({ attempt_count: 2 });
  } finally {
    store.close();
  }
});

it("采集目标按完整的不同角色计数，同角色重复商品和未完成资料不占额度，重开保留目标", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "cbg-target-"));
  const filename = path.join(folder, "capture.sqlite");
  let db = new CrawlStore(filename);
  try {
    db.setRoleLimit(500);
    const first = analysisRecord("first"),
      repeat = analysisRecord("repeat"),
      pending = analysisRecord("pending");
    for (const row of [first, repeat]) {
      row.listing.attrs.data_seller_roleid = "same-role";
      db.observe(row.listing);
      expect(db.save(row.listing, row.detail!)).toBe(true);
    }
    db.observe(pending.listing);
    expect(db.count()).toBe(2);
    expect(db.countRoles()).toBe(1);
    db.close();
    db = new CrawlStore(filename);
    expect(db.roleLimit()).toBe(500);
    expect(db.countRoles()).toBe(1);
    for (const bad of [0, -1, 1.5, "500", NaN])
      expect(() => db.setRoleLimit(bad)).toThrow("正整数");
    expect(db.roleLimit()).toBe(500);
  } finally {
    db.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

// Failure cases: a lane changes frozen input, history demotes a new item, head discovery
// overwrites history progress, restart loses either cursor, or migration deletes old records.
it("新旧来源不改变商品原文，历史观察不降级新号，两个进度重启后分别保留", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "cbg-lanes-"));
  const filename = path.join(folder, "capture.sqlite");
  let store = new CrawlStore(filename);
  try {
    const fresh = analysisRecord("fresh"),
      old = analysisRecord("old");
    store.observe(old.listing);
    const history = {
      key: old.listing.key,
      time: old.listing.sellingTime,
      order: "selling_time DESC",
      page: 5,
      savedAt: old.detail!.collectedAt,
    };
    expect(store.save(old.listing, old.detail!, history)).toBe(true);
    store.observe(fresh.listing, "new");
    const input = store.db
      .prepare("SELECT listing_json FROM listings WHERE key=?")
      .get(fresh.listing.key)!.listing_json;
    store.observe(fresh.listing, "old");
    expect(store.captureLane(fresh.listing.key)).toBe("new");
    expect(store.captureLane(old.listing.key)).toBe("old");
    expect(
      store.db.prepare("SELECT listing_json FROM listings WHERE key=?").get(fresh.listing.key)!
        .listing_json,
    ).toBe(input);
    const head = { time: "2026-10-23T01:00:00.000Z", keys: [fresh.listing.key] };
    store.setHeadCheckpoint(head);
    expect(store.checkpoint()).toEqual(history);
    expect(store.backfillComplete()).toBe(false);
    expect(store.save(fresh.listing, fresh.detail!)).toBe(true);
    expect(store.checkpoint()).toEqual(history);
    store.close();
    store = new CrawlStore(filename);
    expect(store.captureLane(fresh.listing.key)).toBe("new");
    expect(store.headCheckpoint()).toEqual(head);
    expect(store.checkpoint()).toEqual(history);
    expect(store.count()).toBe(2);
    for (const bad of [
      { time: "invalid", keys: ["key"] },
      { time: head.time, keys: [] },
      { time: head.time, keys: ["key", "key"] },
    ])
      expect(() => store.setHeadCheckpoint(bad)).toThrow("首页巡检边界无效");
    expect(store.headCheckpoint()).toEqual(head);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it("旧数据库升级为老号来源，保留商品、详情和历史断点", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "cbg-lane-migration-"));
  const filename = path.join(folder, "capture.sqlite");
  let store = new CrawlStore(filename);
  try {
    const record = analysisRecord("retained");
    store.observe(record.listing);
    expect(store.save(record.listing, record.detail!)).toBe(true);
    const before = store.db.prepare("SELECT listing_json,detail_json FROM listings").get();
    store.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec(
      "ALTER TABLE listings DROP COLUMN capture_lane; ALTER TABLE crawl_state DROP COLUMN head_checkpoint_json",
    );
    legacy.close();
    store = new CrawlStore(filename);
    expect(store.captureLane(record.listing.key)).toBe("old");
    expect(store.headCheckpoint()).toBeUndefined();
    expect(store.db.prepare("SELECT listing_json,detail_json FROM listings").get()).toEqual(before);
    expect(store.count()).toBe(1);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
