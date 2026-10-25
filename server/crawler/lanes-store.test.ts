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

it("最近完整采集独立于历史断点，待采和失败快照不能冒充最新商品", () => {
  const store = new CrawlStore(":memory:");
  try {
    expect(store.latestComplete()).toBeUndefined();
    const old = analysisRecord("history"),
      fresh = analysisRecord("new");
    old.detail!.collectedAt = "2026-10-25T04:21:14.000Z";
    fresh.detail!.collectedAt = "2026-10-25T05:00:20.000Z";
    store.observe(old.listing);
    const point = {
      key: old.listing.key,
      time: old.listing.sellingTime,
      order: "expire_time DESC",
      page: 4,
      savedAt: old.detail!.collectedAt,
    };
    expect(store.save(old.listing, old.detail!, point)).toBe(true);
    store.observe(fresh.listing, "new");
    expect(store.save(fresh.listing, fresh.detail!)).toBe(true);
    expect(store.latestComplete()).toEqual({
      key: fresh.listing.key,
      collectedAt: fresh.detail!.collectedAt,
    });
    expect(store.checkpoint()).toEqual(point);
    store.fail(fresh.listing.key, "资料已失效");
    expect(store.latestComplete()).toEqual({
      key: old.listing.key,
      collectedAt: old.detail!.collectedAt,
    });
    expect(store.checkpoint()).toEqual(point);
  } finally {
    store.close();
  }
});
