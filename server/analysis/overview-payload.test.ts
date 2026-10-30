import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import type { ProductAnalysis } from "./types";

function result(evidence: string): ProductAnalysis {
  const dimension = {
    score: null,
    reason: "维度说明",
    evidence: [{ path: "人物/修炼", value: evidence, reason: "合成测试证据" }],
  };
  return {
    productKey: "fixture",
    inputHash: "fixture",
    summary: "合成角色价格摘要",
    highlights: [],
    risks: [],
    missingData: [],
    dimensions: { foundation: dimension, equipment: dimension, pets: dimension },
    score: null,
    valuation: {
      asset_scope: "body",
      decision: "PASS",
      comparison_mode: "listing-only",
      asking_price: 1000,
      extra_cost: 0,
      total_cost: 1000,
      model_value: 900,
      bare_role_value: 900,
      max_listing_price: 900,
      ideal_listing_price: 850,
      margin_of_safety: -0.1,
      price_difference: -100,
      price_difference_ratio: -0.1,
      items: [
        {
          name: "角色本体",
          amount: 900,
          confirmed: true,
          input: evidence,
          formula: evidence,
          evidence: [{ path: "人物/修炼", value: evidence, reason: "合成测试证据" }],
        },
      ],
      missing_fields: [],
      pending_rules: [],
      reason: "保留报价与决策",
      next_action: "",
      known_subtotal: 900,
      calculation_version: "fixture",
      extracted_facts: [{ name: "属性", value: evidence, quote: evidence, path: "人物/修炼" }],
      ai_explanation: evidence,
    },
  };
}

function fixture(count: number, filename = ":memory:", evidence = "完整证据") {
  const crawl = new CrawlStore(filename);
  try {
    for (let index = 0; index < count; index++) {
      const record = analysisRecord(`payload-${String(index).padStart(4, "0")}`);
      crawl.observe(record.listing);
      if (!crawl.save(record.listing, record.detail!)) throw new Error("合成角色未完整入库");
    }
  } catch (error) {
    crawl.close();
    throw error;
  }
  const store = new AnalysisStore(crawl.db);
  const runId = store.createRun("codex", "payload-fixture", true);
  crawl.db
    .prepare(
      `UPDATE analysis_tasks SET status='completed',completed_at='2026-10-28T00:00:00Z',
      result_json=json_set(?,'$.productKey',listing_key,'$.inputHash',input_hash)`,
    )
    .run(JSON.stringify(result(evidence)));
  return { crawl, store, runId };
}

it("未打开的页签不读取结果明细，但分页计数和旧调用保持一致", () => {
  const { crawl, store, runId } = fixture(41);
  const options = { runId, includeRanking: false, page: 2, resultsPage: 2 };
  try {
    const legacy = store.overview(options);
    expect(legacy.records.items).toHaveLength(20);
    expect(legacy.results.items).toHaveLength(20);
    const prepare = crawl.db.prepare.bind(crawl.db);
    let resultReads = 0;
    const spy = vi.spyOn(crawl.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const all = statement.all.bind(statement);
      statement.all = (...args) => {
        const rows = Reflect.apply(all, undefined, args) as ReturnType<typeof all>;
        resultReads += rows.filter((row) => row.result_json != null).length;
        return rows;
      };
      return statement;
    });
    try {
      const neither = store.overview({ ...options, includeRecords: false, includeResults: false });
      expect(neither.records).toMatchObject({ page: 2, totalPages: 3, total: 41 });
      expect(neither.results).toMatchObject({ page: 2, totalPages: 3, total: 41 });
      expect(neither.records.items).toHaveLength(0);
      expect(neither.results.items).toHaveLength(0);
      expect(resultReads).toBe(0);
      const history = store.overview({ ...options, includeRecords: false });
      expect(history.records.items).toHaveLength(0);
      expect(history.results).toEqual(legacy.results);
      expect(resultReads).toBe(20);
      resultReads = 0;
      const records = store.overview({ ...options, includeResults: false });
      expect(records.records).toEqual(legacy.records);
      expect(records.results.items).toHaveLength(0);
      expect(resultReads).toBe(20);
    } finally {
      spy.mockRestore();
    }
  } finally {
    crawl.close();
  }
});

it("列表摘要减去推导证据，保留报价、条目数量及详情原文", () => {
  const evidence = "只用于性能验证的合成证据".repeat(2000);
  const { crawl, store, runId } = fixture(1, ":memory:", evidence);
  try {
    const full = store.overview({ runId, includeRanking: false });
    const taskId = full.results.items[0].taskId;
    const detail = store.detail(taskId)!;
    const summary = store.overview({ runId, includeRanking: false, summary: true });
    const saved = full.results.items[0].result;
    const compact = summary.results.items[0].result;
    expect(compact.summary).toBe(saved.summary);
    expect(compact.valuation).toMatchObject({
      model_value: 900,
      bare_role_value: 900,
      decision: "PASS",
      comparison_mode: "listing-only",
      price_difference: -100,
      items: [{ name: "角色本体", amount: 900, confirmed: true }],
    });
    expect(compact.valuation!.items).toHaveLength(saved.valuation!.items.length);
    const quote = (value: NonNullable<ProductAnalysis["valuation"]>) => {
      const {
        items: _items,
        extracted_facts: _facts,
        ai_explanation: _explanation,
        equipment_pricing: _equipment,
        pet_pricing: _pets,
        ...amounts
      } = value;
      return amounts;
    };
    expect(quote(compact.valuation!)).toEqual(quote(saved.valuation!));
    expect(compact.valuation!.items[0]).toMatchObject({ input: "", formula: "", evidence: [] });
    expect(compact.dimensions.foundation.evidence).toEqual([]);
    expect(compact.valuation!.extracted_facts).toBeUndefined();
    expect(compact.valuation!.ai_explanation).toBeUndefined();
    expect(summary.records.items[0].valuation).toEqual(compact.valuation);
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(full)) / 10,
    );
    expect(store.detail(taskId)).toEqual(detail);
    expect(store.detail(taskId)!.result!.valuation!.items[0].evidence[0].value).toBe(evidence);
    expect(store.overview({ runId, includeRanking: false })).toEqual(full);
  } finally {
    crawl.close();
  }
});

it("一千条合成结果仍只返回当前页轻量摘要，并输出可复跑证据", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cbg-overview-payload-"));
  const filename = path.join(directory, "fixture.sqlite");
  const { crawl, store, runId } = fixture(1000, filename, "合成明细证据".repeat(500));
  try {
    const beforeStart = performance.now();
    const before = store.overview({ runId, includeRanking: false });
    const beforeMs = performance.now() - beforeStart;
    const afterStart = performance.now();
    const after = store.overview({
      runId,
      includeRanking: false,
      includeRecords: false,
      summary: true,
    });
    const afterMs = performance.now() - afterStart;
    const beforeBytes = Buffer.byteLength(JSON.stringify(before));
    const afterBytes = Buffer.byteLength(JSON.stringify(after));
    expect(after.records.total).toBe(1000);
    expect(after.records.items).toHaveLength(0);
    expect(after.results.total).toBe(1000);
    expect(after.results.items).toHaveLength(20);
    expect(afterBytes).toBeLessThan(beforeBytes / 10);
    const artifact = path.join(directory, "evidence.json");
    await writeFile(
      artifact,
      JSON.stringify(
        {
          repeat: "vp test server/analysis/overview-payload.test.ts --maxWorkers=1",
          source: "temporary SQLite with 1000 synthetic complete roles; no real collection or AI",
          records: 1000,
          before: { ms: beforeMs, bytes: beforeBytes, recordItems: 20, resultItems: 20 },
          after: { ms: afterMs, bytes: afterBytes, recordItems: 0, resultItems: 20 },
          limits: "timings are observations, not pass thresholds; ranking SQL is unchanged",
        },
        null,
        2,
      ) + "\n",
    );
    console.info("OVERVIEW_PAYLOAD_EVIDENCE", artifact);
  } finally {
    crawl.close();
    for (const suffix of ["", "-wal", "-shm"]) await rm(filename + suffix, { force: true });
  }
}, 60_000);
