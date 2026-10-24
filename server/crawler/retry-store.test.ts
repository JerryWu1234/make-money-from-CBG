import { expect, it, vi } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CAPTURE_VERSION } from "./compact";
import { CrawlStore } from "./store";
import { ListingUnavailableError } from "./types";
import { AnalysisStore } from "../analysis/store";

it("回滚事务期间读取的队列不会进入缓存", () => {
  const store = new CrawlStore(":memory:");
  try {
    const record = analysisRecord("rolled-back");
    store.db.exec("BEGIN");
    store.observe(record.listing);
    expect(store.retryItems()).toHaveLength(1);
    store.db.exec("ROLLBACK");
    expect(store.retryItems()).toEqual([]);
  } finally {
    store.close();
  }
});

it("其他连接更新待采原文后，队列缓存立即失效", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-retry-cache-"));
  const filename = path.join(directory, "capture.sqlite");
  const store = new CrawlStore(filename);
  const other = new DatabaseSync(filename);
  try {
    const record = analysisRecord("external-write");
    store.observe(record.listing);
    expect(store.retryItems()[0].name).toBe(record.listing.name);
    other
      .prepare("UPDATE listings SET listing_json=json_set(listing_json,'$.name',?) WHERE key=?")
      .run("其他连接刚更新的名称", record.listing.key);
    expect(store.retryItems()[0].name).toBe("其他连接刚更新的名称");
  } finally {
    other.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("同一数据版本的队列查询只扫描一次，本连接写入后立即重新核对", () => {
  const store = new CrawlStore(":memory:");
  try {
    const record = analysisRecord("cached-pending");
    store.observe(record.listing);
    const prepare = store.db.prepare.bind(store.db);
    let scans = 0;
    vi.spyOn(store.db, "prepare").mockImplementation((sql) => {
      if (sql.includes("ORDER BY CASE status")) scans++;
      return prepare(sql);
    });
    const first = store.retryItems();
    first[0].name = "调用方修改不应污染缓存";
    expect(store.retryItems()[0].name).toBe(record.listing.name);
    expect(store.retryItems()).toHaveLength(1);
    expect(scans).toBe(1);
    expect(store.save(record.listing, record.detail!)).toBe(true);
    expect(store.retryItems()).toEqual([]);
    expect(scans).toBe(2);
    store.fail(record.listing.key, "保留失败供重试");
    expect(store.retryItems().map((item) => item.key)).toEqual([record.listing.key]);
    expect(scans).toBe(3);
  } finally {
    store.close();
  }
});

it.each(["listing_json", "detail_json"] as const)(
  "指定商品补采不会读取其他商品的损坏 %s，也只累计指定商品的派发次数",
  (column) => {
    const store = new CrawlStore(":memory:");
    try {
      const target = analysisRecord("selected"),
        unrelated = analysisRecord("unrelated");
      store.observe(target.listing);
      store.observe(unrelated.listing);
      store.db
        .prepare(`UPDATE listings SET ${column}=?,status=? WHERE key=?`)
        .run("{invalid", column === "detail_json" ? "complete" : "pending", unrelated.listing.key);
      expect(store.retryItems([target.listing.key]).map((item) => item.key)).toEqual([
        target.listing.key,
      ]);
      store.beginRetry(target.listing.key);
      expect(
        store.db.prepare("SELECT attempt_count FROM listings WHERE key=?").get(target.listing.key),
      ).toMatchObject({ attempt_count: 1 });
      expect(
        store.db
          .prepare("SELECT attempt_count FROM listings WHERE key=?")
          .get(unrelated.listing.key),
      ).toMatchObject({ attempt_count: 0 });
    } finally {
      store.close();
    }
  },
);

it("空的指定范围不扫描任何商品，刷新模式仍拒绝空范围", () => {
  const store = new CrawlStore(":memory:");
  try {
    const record = analysisRecord("unrelated");
    store.observe(record.listing);
    store.db.prepare("UPDATE listings SET listing_json='{invalid'").run();
    expect(store.retryItems([])).toEqual([]);
    expect(() => store.retryItems([], true)).toThrow("刷新采集仅支持明确指定一个已保存商品");
  } finally {
    store.close();
  }
});

it("指定范围保持待采优先和原发现顺序，重复、未知以及 SQL 特殊字符键不会扩大范围", () => {
  const store = new CrawlStore(":memory:");
  try {
    const keys = [
      "pending-late",
      "pending-early",
      "failed",
      "outdated",
      "complete",
      "x') OR 1=1 --",
    ];
    for (const key of keys) {
      const record = analysisRecord(key);
      store.observe(record.listing);
      if (key === "outdated" || key === "complete")
        expect(store.save(record.listing, record.detail!)).toBe(true);
    }
    store.fail("failed", "保留的单件错误");
    store.db
      .prepare(
        "UPDATE listings SET detail_json=json_set(detail_json,'$.captureVersion',?) WHERE key=?",
      )
      .run(CAPTURE_VERSION - 1, "outdated");
    for (const [index, key] of [
      "failed",
      "outdated",
      "complete",
      "pending-early",
      "pending-late",
      keys[5],
    ].entries())
      store.db.prepare("UPDATE listings SET first_seen_at=? WHERE key=?").run(String(index), key);
    const expected = ["pending-early", "pending-late", keys[5], "failed", "outdated"];
    expect(store.retryItems().map((item) => item.key)).toEqual(expected);
    expect(
      store
        .retryItems(["outdated", ...[...keys].reverse(), "pending-early", "missing"])
        .map((item) => item.key),
    ).toEqual(expected);
    expect(store.retryItems([keys[5]]).map((item) => item.key)).toEqual([keys[5]]);
    expect(store.retryItems(["missing"])).toEqual([]);
  } finally {
    store.close();
  }
});

it("指定键仍校验原文商品身份，完整商品只在明确刷新时重新派发", () => {
  const store = new CrawlStore(":memory:");
  try {
    const record = analysisRecord("complete"),
      mismatched = analysisRecord("mismatched");
    store.observe(record.listing);
    expect(store.save(record.listing, record.detail!)).toBe(true);
    store.observe(mismatched.listing);
    store.db
      .prepare("UPDATE listings SET listing_json=json_set(listing_json,'$.key',?) WHERE key=?")
      .run("another-item", mismatched.listing.key);
    expect(store.retryItems([mismatched.listing.key])).toEqual([]);
    expect(() => store.beginRetry(mismatched.listing.key)).toThrow("待补采商品不存在或已完成");
    expect(store.retryItems([record.listing.key])).toEqual([]);
    expect(() => store.beginRetry(record.listing.key)).toThrow("待补采商品不存在或已完成");
    expect(store.retryItems([record.listing.key], true).map((item) => item.key)).toEqual([
      record.listing.key,
    ]);
    store.beginRetry(record.listing.key, true);
    expect(
      store.db.prepare("SELECT attempt_count FROM listings WHERE key=?").get(record.listing.key),
    ).toMatchObject({ attempt_count: 1 });
    expect(() => store.retryItems(["missing"], true)).toThrow("指定刷新商品不存在");
    expect(() => store.retryItems([record.listing.key, record.listing.key], true)).toThrow(
      "刷新采集仅支持明确指定一个已保存商品",
    );
  } finally {
    store.close();
  }
});

it("大资料补采排序不携带详情和列表原文，指定键查询使用主键索引", () => {
  const store = new CrawlStore(":memory:");
  try {
    for (let index = 0; index < 12; index++) {
      const record = analysisRecord(`large-${index}`);
      record.detail!.tabs[0].text += "采集凭据".repeat(16384);
      store.observe(record.listing);
      expect(store.save(record.listing, record.detail!)).toBe(true);
      store.db
        .prepare(
          "UPDATE listings SET detail_json=json_set(detail_json,'$.captureVersion',?) WHERE key=?",
        )
        .run(CAPTURE_VERSION - 1, record.listing.key);
    }
    const prepare = store.db.prepare.bind(store.db);
    const ordered: { columns: string[]; sql: string }[] = [];
    const spy = vi.spyOn(store.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("ORDER BY CASE status"))
        ordered.push({ columns: statement.columns().map((column) => column.name), sql });
      return statement;
    });
    try {
      expect(store.retryItems()).toHaveLength(12);
      expect(store.retryItems(["large-5"]).map((item) => item.key)).toEqual(["large-5"]);
      expect(ordered).toHaveLength(2);
      for (const query of ordered) {
        expect(query.columns).not.toContain("listing_json");
        expect(query.columns).not.toContain("detail_json");
      }
      expect(
        prepare("EXPLAIN QUERY PLAN " + ordered[1].sql)
          .all("large-5")
          .some((row) =>
            String(row.detail).includes(
              "SEARCH listings USING INDEX sqlite_autoindex_listings_1 (key=?)",
            ),
          ),
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  } finally {
    store.close();
  }
});

it("官网确证不存在保留部分原档并终止重试，重复发现、失败回写或晚到结果不能复活", () => {
  const store = new CrawlStore(":memory:");
  try {
    const record = analysisRecord("gone-partial");
    const partial = structuredClone(record.detail!);
    partial.petCapture!.complete = false;
    partial.petCapture!.issues = ["宝宝资料未齐"];
    store.observe(record.listing);
    expect(store.save(record.listing, partial)).toBe(false);
    store.beginRetry(record.listing.key);
    const before = store.detail(record.listing.key) as { detail: unknown };
    const reason = new ListingUnavailableError("目标详情返回 HTTP 404").message;
    store.markUnavailable(record.listing.key, reason);
    expect(store.detail(record.listing.key)).toMatchObject({
      status: "unavailable",
      error: reason,
      detail: before.detail,
    });
    expect(store.retryItems()).toEqual([]);
    expect(store.retryItems([record.listing.key])).toEqual([]);
    expect(() => store.retryItems([record.listing.key], true)).toThrow("无法补齐");
    expect(() => store.beginRetry(record.listing.key)).toThrow();
    expect(store.observe({ ...record.listing, sellingTime: "2026-10-24T10:00:00Z" })).toBe(true);
    store.fail(record.listing.key, "晚到失败不能恢复待重试");
    expect(
      store.save(record.listing, record.detail!, {
        key: record.listing.key,
        time: null,
        order: "selling_time DESC",
        page: 1,
        savedAt: "now",
      }),
    ).toBe(false);
    expect(store.retryItems()).toEqual([]);
    expect(store.count()).toBe(0);
    expect(store.checkpoint()).toBeUndefined();
    expect(store.records().items[0]).toMatchObject({
      status: "unavailable",
      published: false,
      valuationReady: false,
      error: reason,
    });
    expect(store.detail(record.listing.key)).toMatchObject({ detail: before.detail });
    expect(
      store.db
        .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
        .get(record.listing.key)?.source_gzip,
    ).toBeTruthy();
  } finally {
    store.close();
  }
});
it("无法补齐的旧完整记录退出待补齐统计，分析入队拒绝且历史资料保留", () => {
  const store = new CrawlStore(":memory:");
  try {
    const unavailable = analysisRecord("gone-complete"),
      pending = analysisRecord("still-pending");
    store.observe(unavailable.listing);
    expect(store.save(unavailable.listing, unavailable.detail!)).toBe(true);
    store.observe(pending.listing);
    const analysis = new AnalysisStore(store.db);
    store.markUnavailable(
      unavailable.listing.key,
      new ListingUnavailableError("目标详情返回 HTTP 410").message,
    );
    expect(analysis.counts()).toEqual({
      total: 2,
      complete: 0,
      waitingDetail: 1,
      pendingDetail: 1,
      failedDetail: 0,
    });
    expect(store.detail(unavailable.listing.key)).toMatchObject({
      detail: expect.any(Object),
      status: "unavailable",
    });
    expect(() =>
      analysis.createRun("codex", "test", false, undefined, true, 1, [unavailable.listing.key]),
    ).toThrow("指定商品不存在或详情未完成");
    expect(store.db.prepare("SELECT count(*) n FROM analysis_tasks").get()?.n).toBe(0);
  } finally {
    store.close();
  }
});

it("先进入分析队列后确认不存在，领取时跳过且不残留queued或待重试统计", () => {
  const store = new CrawlStore(":memory:");
  try {
    const gone = analysisRecord("gone-queued"),
      good = analysisRecord("good-queued");
    for (const record of [gone, good]) {
      store.observe(record.listing);
      store.save(record.listing, record.detail!);
    }
    const analysis = new AnalysisStore(store.db);
    const run = analysis.createRun("codex", "test");
    store.markUnavailable(
      gone.listing.key,
      new ListingUnavailableError("目标详情返回 HTTP 404").message,
    );
    expect(analysis.next(run)?.document.productKey).toBe(good.listing.key);
    expect(analysis.run(run)).toMatchObject({ total: 1, queued: 1, failed: 0, completed: 0 });
    expect(
      store.db
        .prepare("SELECT status,error FROM analysis_tasks WHERE listing_key=?")
        .get(gone.listing.key),
    ).toMatchObject({ status: "skipped", error: expect.stringContaining("不再重试") });
    analysis.retry(run);
    expect(analysis.next(run)?.document.productKey).toBe(good.listing.key);
    expect(store.db.prepare("SELECT count(*) n FROM analysis_attempts").get()?.n).toBe(0);
  } finally {
    store.close();
  }
});
