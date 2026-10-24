import { expect, it, vi } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CAPTURE_VERSION } from "./compact";
import { CrawlStore } from "./store";

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
