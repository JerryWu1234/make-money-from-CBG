import { afterEach, expect, it, vi } from "vite-plus/test";
import { gunzipSync } from "node:zlib";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { AnalysisStore } from "../analysis/store";
import { collectCompleteCapture, IncompleteCaptureError } from "./capture-readiness";
import { crawl } from "./runner";
import { CrawlStore } from "./store";
import type { CrawlSource, SavedRoleRecord } from "./types";

const stores: CrawlStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
});
function setup() {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  const record = analysisRecord("paused-partial");
  record.listing.orderTime = record.listing.sellingTime;
  const partial = structuredClone(record.detail!);
  partial.equipmentCapture!.complete = false;
  partial.equipmentCapture!.issues = ["装备库存是否为空尚未核验"];
  partial.raw = { preserved: "暂停前已读原文", attributes: { test: 42 } };
  const control = new AbortController();
  const read = vi.fn(async () => {
    await new Promise<void>((_resolve, reject) => {
      control.signal.addEventListener(
        "abort",
        () =>
          reject(
            new IncompleteCaptureError("读取暂停，保留本轮资料", partial, control.signal.reason),
          ),
        { once: true },
      );
    });
    return partial;
  });
  const source: CrawlSource = {
    prepare: vi.fn(async () => ({
      page: 1,
      totalPages: 1,
      order: "selling_time DESC",
      items: [record.listing],
    })),
    page: vi.fn(async () => ({
      page: 1,
      totalPages: 1,
      order: "selling_time DESC",
      items: [record.listing],
    })),
    hover: vi.fn(async (item) => item),
    onShelf: vi.fn(async () => true),
    detail: vi.fn(() => collectCompleteCapture(read, control.signal, vi.fn(), record.listing)),
  };
  return { store, record, partial, control, read, source };
}

it.each(["finite", "backfill", "watch"])(
  "%s链路单次读取已有部分资料时暂停，原文持久化为pending且不发布分析",
  async (mode) => {
    const { store, record, partial, control, read, source } = setup();
    if (mode === "backfill") store.observe(record.listing);
    const publish = vi.fn();
    const outcome = crawl(source, store, control.signal, publish, {
      concurrency: 2,
      watch: mode === "watch",
      backfillOnly: mode === "backfill",
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    const reason = new Error("用户暂停采集");
    control.abort(reason);
    expect(await outcome).toBe(reason);
    const saved = store.detail(record.listing.key) as SavedRoleRecord;
    expect(saved).toMatchObject({
      status: "pending",
      error: expect.stringContaining("已暂停"),
      detail: { tabs: expect.any(Array), equipmentCapture: { complete: false } },
    });
    expect(saved.detail!.tabs.map((tab) => tab.name)).toEqual(partial.tabs.map((tab) => tab.name));
    const original = store.db
      .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
      .get(record.listing.key)!;
    expect(JSON.parse(gunzipSync(original.source_gzip as Uint8Array).toString()).raw).toEqual(
      partial.raw,
    );
    expect(
      store.db
        .prepare("SELECT count(*) n FROM role_tabs WHERE listing_key=?")
        .get(record.listing.key)?.n,
    ).toBe(partial.tabs.length);
    expect(store.count()).toBe(0);
    expect(store.records(1, 20, "complete").items).toEqual([]);
    expect(store.retryItems().map((item) => item.key)).toContain(record.listing.key);
    expect(store.checkpoint()).toBeUndefined();
    expect(publish.mock.calls.some(([update]) => update.failed > 0 || update.saved > 0)).toBe(
      false,
    );
    const analysis = new AnalysisStore(store.db);
    expect(() =>
      analysis.createRun("codex", "fixture", false, undefined, true, 1, [record.listing.key]),
    ).toThrow("详情未完成");
    expect(store.db.prepare("SELECT count(*) n FROM analysis_tasks").get()?.n).toBe(0);
  },
);

it("强制保存暂停快照即使输入完整也保持pending，不复活unavailable或覆盖完整商品", () => {
  const { store, record, partial } = setup();
  store.observe(record.listing);
  expect(store.savePartial(record.listing, record.detail!)).toBe(false);
  expect(store.detail(record.listing.key)).toMatchObject({ status: "pending" });
  expect(store.count()).toBe(0);
  expect(store.save(record.listing, record.detail!)).toBe(true);
  const before = store.detail(record.listing.key);
  expect(store.savePartial(record.listing, partial)).toBe(false);
  expect(store.detail(record.listing.key)).toEqual(before);
  store.markUnavailable(record.listing.key, "官网商品已不存在");
  const unavailable = store.detail(record.listing.key);
  expect(store.savePartial(record.listing, partial)).toBe(false);
  expect(store.detail(record.listing.key)).toEqual(unavailable);
});

it("刷新已有完整商品时暂停保留旧完整详情，不用本轮partial覆盖", async () => {
  const { store, record, control, read, source } = setup();
  store.observe(record.listing);
  store.save(record.listing, record.detail!);
  const before = (store.detail(record.listing.key) as SavedRoleRecord).detail;
  const outcome = crawl(source, store, control.signal, vi.fn(), {
    backfillOnly: true,
    refresh: true,
    keys: [record.listing.key],
    concurrency: 2,
  }).catch((error: unknown) => error);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  const reason = new Error("用户暂停采集");
  control.abort(reason);
  expect(await outcome).toBe(reason);
  expect((store.detail(record.listing.key) as SavedRoleRecord).detail).toEqual(before);
  expect(store.checkpoint()).toBeUndefined();
});
