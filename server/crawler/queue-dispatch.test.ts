import { afterEach, expect, it, vi } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "./store";

const stores: CrawlStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  stores.splice(0).forEach((store) => store.close());
});

it("实时待采派发不读取完整角色原文，无关写入后仍只读取待采任务", () => {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  const complete = analysisRecord("complete");
  store.observe(complete.listing);
  expect(store.save(complete.listing, complete.detail!)).toBe(true);
  store.db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1000)
    INSERT INTO listings(key,server_id,eid,ordersn,url,name,price,listing_json,detail_json,status,first_seen_at,last_seen_at)
    SELECT 'complete-'||i,'1',i,i,'fixture','fixture','100','{}','{}','complete','old','old' FROM n`);
  const pending = analysisRecord("pending"),
    failed = analysisRecord("failed");
  store.observe(failed.listing);
  store.fail(failed.listing.key, "未读完");
  store.observe(pending.listing, "new");
  const prepare = store.db.prepare.bind(store.db);
  vi.spyOn(store.db, "prepare").mockImplementation((sql) => {
    if (/\bdetail_json\b/i.test(sql)) throw new Error("派发不应读取完整角色原文");
    return prepare(sql);
  });
  expect(store.pendingItems().map((row) => row.key)).toEqual([
    pending.listing.key,
    failed.listing.key,
  ]);
  store.db.exec("CREATE TABLE unrelated(value); INSERT INTO unrelated VALUES(1)");
  expect(store.pendingItems().map((row) => row.key)).toEqual([
    pending.listing.key,
    failed.listing.key,
  ]);
  const plan = prepare(`EXPLAIN QUERY PLAN SELECT listing_json FROM listings
    WHERE status IN ('pending','failed') ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END,first_seen_at,key`).all();
  expect(plan.some((row) => String(row.detail).includes("listings_capture_queue"))).toBe(true);
});

it("待采任务成功、失败或重新上架后，实时队列立即更新且不沿用旧缓存", () => {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  const row = analysisRecord("changing");
  store.observe(row.listing);
  expect(store.pendingItems()).toHaveLength(1);
  store.save(row.listing, row.detail!);
  expect(store.pendingItems()).toEqual([]);
  store.fail(row.listing.key, "需要补采");
  expect(store.pendingItems()).toHaveLength(1);
  store.markUnavailable(row.listing.key, "官网已删除");
  expect(store.pendingItems()).toEqual([]);
});
