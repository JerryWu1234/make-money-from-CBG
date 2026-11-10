import { expect, it } from "vite-plus/test";
import { createCaptureFailureBudget } from "./failure-budget";
import { crawl } from "./runner";
import { CrawlStore } from "./store";
import { analysisRecord } from "../../tests/fixtures/analysis";
import type { CrawlSource } from "./types";

it("连续三件失败暂停；进度通知和相同失败计数不会重复累计", () => {
  const record = createCaptureFailureBudget();
  expect(record({ failed: 1 })).toBeUndefined();
  expect(record({ detailProgress: "读取下一件" })).toBeUndefined();
  expect(record({ failed: 1 })).toBeUndefined();
  expect(record({ failed: 2 })).toBeUndefined();
  expect(record({ failed: 3 })).toMatchObject({ code: "CRAWL_FAILURE_LIMIT", failures: 3 });
});

it("成功入库重置连续失败，旧的成功计数和跳过商品不会重置", () => {
  const record = createCaptureFailureBudget();
  record({ saved: 1 });
  record({ failed: 2 });
  expect(record({ saved: 2 })).toBeUndefined();
  expect(record({ failed: 4 })).toBeUndefined();
  expect(record({ saved: 2, skipped: 5 })).toBeUndefined();
  expect(record({ failed: 5 })).toMatchObject({ failures: 3 });
});

it("每轮单独计数，暂停后手动重新开始不沿用失败预算", () => {
  const previous = createCaptureFailureBudget();
  expect(previous({ failed: 3 })).toBeDefined();
  const next = createCaptureFailureBudget();
  expect(next({ failed: 1 })).toBeUndefined();
});

it("并发补采触及预算后停止派发，完整数据和全部失败/未派发任务仍可续采", async () => {
  const store = new CrawlStore(":memory:");
  const control = new AbortController();
  const record = createCaptureFailureBudget();
  const complete = analysisRecord("complete");
  const queued = Array.from({ length: 8 }, (_, index) => analysisRecord(`queued-${index}`));
  let started = 0;
  const source: CrawlSource = {
    prepare: async () => {
      throw new Error("不应开始列表发现");
    },
    page: async () => {
      throw new Error("不应翻页");
    },
    onShelf: async () => true,
    hover: async (row) => row,
    detail: async () => {
      started++;
      throw Object.assign(new Error("资料缺项"), { name: "IncompleteDetailError" });
    },
  };
  try {
    store.observe(complete.listing);
    expect(store.save(complete.listing, complete.detail!)).toBe(true);
    queued.forEach((row) => store.observe(row.listing));
    await expect(
      crawl(
        source,
        store,
        control.signal,
        (update) => {
          const error = record(update);
          if (error) control.abort(error);
        },
        { backfillOnly: true, concurrency: 2 },
      ),
    ).rejects.toMatchObject({ code: "CRAWL_FAILURE_LIMIT" });
    expect(started).toBeLessThanOrEqual(4);
    expect(store.count()).toBe(1);
    expect(
      store
        .retryItems()
        .map((row) => row.key)
        .sort(),
    ).toEqual(queued.map((row) => row.listing.key).sort());
  } finally {
    store.close();
  }
});
