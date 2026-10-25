import { afterEach, expect, it } from "vite-plus/test";
import { CrawlStore } from "./crawler/store";
import { analysisRecord } from "../tests/fixtures/analysis";

const stores: CrawlStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});

it("输入版本只跟踪实际输入变化，支持UPSERT、事务回滚及同key删除后重建", () => {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  const record = analysisRecord("versioned");
  store.observe(record.listing);
  store.save(record.listing, record.detail!);
  const revision = () =>
    Number(
      store.db
        .prepare("SELECT revision FROM record_versions WHERE entity='listings' AND record_key=?")
        .get(record.listing.key)!.revision,
    );
  const first = revision();
  store.acquire("owner");
  store.observe(record.listing);
  expect(revision()).toBe(first);
  store.observe({ ...record.listing, price: "200" });
  const changed = revision();
  expect(changed).toBeGreaterThan(first);
  store.db.exec("BEGIN");
  store.db.prepare("UPDATE listings SET detail_json=NULL WHERE key=?").run(record.listing.key);
  expect(revision()).toBeGreaterThan(changed);
  store.db.exec("ROLLBACK");
  expect(revision()).toBe(changed);
  store.db.prepare("DELETE FROM listings WHERE key=?").run(record.listing.key);
  store.observe(record.listing);
  store.save(record.listing, record.detail!);
  expect(revision()).toBeGreaterThan(changed);
});
