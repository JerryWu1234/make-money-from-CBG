import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "./store";

// 重复页不能丢失到重启，也不能被误当作完整历史扫描；同一页在不同排序下独立核验。
it("待复核页按排序和页码持久保存，重复登记不覆盖发现时间或商品断点", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "cbg-page-reviews-"));
  const filename = path.join(folder, "capture.sqlite");
  let store = new CrawlStore(filename);
  try {
    const record = analysisRecord("retained");
    const point = {
      key: record.listing.key,
      time: record.listing.sellingTime,
      order: "selling_time DESC",
      page: 3,
      savedAt: record.detail!.collectedAt,
    };
    store.observe(record.listing);
    expect(store.save(record.listing, record.detail!, point)).toBe(true);
    store.markBackfillComplete();
    store.deferPageReview("selling_time DESC", 41, "1:a|1:b");
    const detectedAt = store.pageReviews()[0]!.detectedAt;
    store.deferPageReview("selling_time DESC", 41, "1:a|1:c");
    store.deferPageReview("expire_time DESC", 41, "1:a|1:b");
    store.deferPageReview("selling_time DESC", 9, "1:d");
    expect(store.pageReviews("selling_time DESC").map((review) => review.page)).toEqual([9, 41]);
    expect(store.pageReviews()).toHaveLength(3);
    expect(store.backfillComplete()).toBe(false);
    store.markBackfillComplete();
    expect(store.backfillComplete()).toBe(false);
    store.close();
    store = new CrawlStore(filename);
    expect(store.pageReviews("selling_time DESC")[1]).toEqual({
      order: "selling_time DESC",
      page: 41,
      signature: "1:a|1:c",
      detectedAt,
    });
    expect(store.pageReviews()).toHaveLength(3);
    expect(store.checkpoint()).toEqual(point);
    expect(store.count()).toBe(1);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it("仅清除已核实的排序和页码，所有待复核页解除前不能标记历史完成", () => {
  const store = new CrawlStore(":memory:");
  try {
    store.deferPageReview("selling_time DESC", 2, "1:a");
    store.deferPageReview("expire_time DESC", 2, "1:a");
    store.resolvePageReview("selling_time DESC", 2);
    expect(store.pageReviews()).toEqual([
      expect.objectContaining({ order: "expire_time DESC", page: 2 }),
    ]);
    store.resolvePageReview("selling_time DESC", 2);
    store.markBackfillComplete();
    expect(store.backfillComplete()).toBe(false);
    store.resolvePageReview("expire_time DESC", 2);
    expect(store.backfillComplete()).toBe(false);
    store.markBackfillComplete();
    expect(store.backfillComplete()).toBe(true);
    store.deferPageReview("selling_time DESC", 3, "1:b");
    store.clear();
    expect(store.pageReviews()).toEqual([]);
    expect(store.backfillComplete()).toBe(false);
  } finally {
    store.close();
  }
});

it("旧数据库新增待复核字段时保留已有商品和完成状态", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "cbg-page-review-migration-"));
  const filename = path.join(folder, "capture.sqlite");
  let store = new CrawlStore(filename);
  try {
    const record = analysisRecord("old-database");
    store.observe(record.listing);
    expect(store.save(record.listing, record.detail!)).toBe(true);
    store.markBackfillComplete();
    const before = store.db.prepare("SELECT listing_json,detail_json FROM listings").get();
    store.close();
    const legacy = new DatabaseSync(filename);
    legacy.exec("ALTER TABLE crawl_state DROP COLUMN page_reviews_json");
    legacy.close();
    store = new CrawlStore(filename);
    expect(store.pageReviews()).toEqual([]);
    expect(store.backfillComplete()).toBe(true);
    expect(store.db.prepare("SELECT listing_json,detail_json FROM listings").get()).toEqual(before);
    expect(store.count()).toBe(1);
  } finally {
    store.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
