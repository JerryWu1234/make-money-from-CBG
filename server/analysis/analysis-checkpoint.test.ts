import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import type { SavedRoleRecord } from "../crawler/types";
import { AnalysisStore } from "./store";
import { AnalysisRunner } from "./runner";
import { analysisDataHash, buildProductDocument } from "./product-document";
import { createProfile, PROMPT_FILE } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import { validateValuation } from "./valuation-contract";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "cbg-analysis-checkpoint-"));
  const filename = join(directory, "checkpoint.sqlite");
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const crawl = new CrawlStore(filename);
  cleanups.push(async () => crawl.close());
  const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), undefined, false);
  for (const key of ["a", "b", "c"]) {
    const record = valuationRecord(key);
    if (key === "a")
      record.detail!.tabs[0].fields.find((field) => field.name === "靓号特效")!.value = "土豪金";
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
  }
  const store = new AnalysisStore(crawl.db);
  const id = store.createRun("codex", "checkpoint-model", true, profile);
  store.acquire("seed");
  store.setRun(id, "running", null, "seed");
  for (let i = 0; i < 2; i++) {
    const task = store.next(id)!;
    const raw = JSON.stringify({
      decision: calculateValuation(task.record, profile).decision,
      reason: "模拟已完成核对",
      extracted_facts: [],
    });
    const attempt = store.begin(task, "seed");
    store.finish(task, attempt, "seed", {
      state: "completed",
      raw,
      result: validateValuation(raw, task.document, task.record, profile),
    });
  }
  store.release("seed");
  const analyze = vi.fn(async (prompt: string) => {
    const key = prompt.match(/商品 ID：([^。\n]+)[。\n]/)![1];
    return {
      text: JSON.stringify({
        decision: calculateValuation(crawl.detail(key) as SavedRoleRecord, profile).decision,
        reason: "模拟剩余商品核对",
        extracted_facts: [],
      }),
    };
  });
  return { directory, filename, crawl, store, profile, id, analyze };
}

describe("数据库保存的分析断点和有效版本", () => {
  it("重新打开数据库后继续原批次，只调用未完成的商品", async () => {
    const x = await fixture();
    const reopened = new CrawlStore(x.filename);
    cleanups.push(async () => reopened.close());
    const store = new AnalysisStore(reopened.db);
    const runner = new AnalysisRunner(store, async () => ({
      model: "checkpoint-model",
      analyze: x.analyze,
    }));
    cleanups.push(() => runner.shutdown());
    expect(store.run(x.id)).toMatchObject({ status: "paused", completed: 2, queued: 1 });
    await runner.resume(x.id);
    await vi.waitFor(() => expect(store.run(x.id)?.completed).toBe(3));
    expect(x.analyze).toHaveBeenCalledTimes(1);
    expect(x.analyze.mock.calls[0][0]).toContain("商品 ID：c。");
  });

  it("新批次识别历史完成记录，回填旧版本字段并跳过已完成商品", async () => {
    const x = await fixture();
    x.store.db.exec(
      "DROP INDEX analysis_tasks_data; ALTER TABLE analysis_tasks DROP COLUMN analysis_data_hash",
    );
    const reopened = new AnalysisStore(x.crawl.db);
    const id = reopened.createRun("codex", "checkpoint-model", false, x.profile);
    expect(reopened.run(id)).toMatchObject({ total: 1, queued: 1 });
    expect(
      reopened.db
        .prepare(
          "SELECT count(*) n FROM analysis_tasks WHERE status='completed' AND analysis_data_hash IS NOT NULL",
        )
        .get()!.n,
    ).toBe(2);
    expect(x.analyze).not.toHaveBeenCalled();
  });

  it("数据库中的有效断点让新批次和持续队列直接跳过历史资料读取", async () => {
    const x = await fixture();
    const reopened = new AnalysisStore(x.crawl.db);
    const prepare = vi.spyOn(reopened.db, "prepare");
    try {
      const id = reopened.createRun("codex", "checkpoint-model", false, x.profile);
      expect(reopened.run(id)).toMatchObject({ total: 1, queued: 1 });
      expect(
        prepare.mock.calls.filter(([sql]) => sql.includes("AND (t.input_hash=?")),
      ).toHaveLength(1);
      reopened.acquire("cached");
      reopened.setRun(id, "running", null, "cached");
      try {
        expect(reopened.appendCaptured(id, "cached")).toBe(0);
        expect(
          prepare.mock.calls.filter(([sql]) => sql.includes("AND (t.input_hash=?")),
        ).toHaveLength(1);
      } finally {
        reopened.release("cached");
      }
    } finally {
      prepare.mockRestore();
    }
  });

  it("持续队列收到相同资料的新采集时间时直接保存完成结果，不追加AI任务", async () => {
    const x = await fixture();
    const id = x.store.createRun("codex", "checkpoint-model", false, x.profile);
    x.store.acquire("stream");
    x.store.setRun(id, "running", null, "stream");
    try {
      const record = x.crawl.detail("a") as SavedRoleRecord;
      record.detail!.collectedAt = "2026-11-01T01:00:00.000Z";
      x.crawl.save(record.listing, record.detail!);
      expect(x.store.appendCaptured(id, "stream")).toBe(1);
      expect(x.store.run(id)).toMatchObject({ completed: 1, reused: 1, queued: 1 });
      expect(x.store.appendCaptured(id, "stream")).toBe(0);
      expect(x.analyze).not.toHaveBeenCalled();
    } finally {
      x.store.release("stream");
    }
  });

  it("仅采集时间变化时保存当前快照并本地复算，再次重启也不调用AI", async () => {
    const x = await fixture();
    const record = x.crawl.detail("a") as SavedRoleRecord;
    const originalHash = buildProductDocument(record).contentHash;
    const dataHash = analysisDataHash(record);
    record.detail!.collectedAt = "2026-11-01T00:00:00.000Z";
    record.detail!.equipmentCapture!.collectedAt = record.detail!.collectedAt;
    record.detail!.petCapture!.collectedAt = record.detail!.collectedAt;
    record.detail!.tabs[0].collectedAt = record.detail!.collectedAt;
    x.crawl.save(record.listing, record.detail!);
    const current = x.crawl.detail("a") as SavedRoleRecord;
    expect(buildProductDocument(current).contentHash).not.toBe(originalHash);
    expect(analysisDataHash(current)).toBe(dataHash);
    const id = x.store.createRun("codex", "checkpoint-model", false, x.profile);
    expect(x.store.run(id)).toMatchObject({ completed: 1, reused: 1, queued: 1 });
    const saved = x.store.db
      .prepare("SELECT * FROM analysis_tasks WHERE run_id=? AND listing_key='a'")
      .get(id)!;
    expect(saved.input_hash).toBe(buildProductDocument(current).contentHash);
    const detail = x.store.detail(String(saved.id))!;
    expect(
      detail.attempts.some(
        (attempt) =>
          (attempt.usage as { source?: string } | null)?.source === "validated-body-recalculation",
      ),
    ).toBe(true);
    expect(
      x.store.overview({ runId: id }).records.items.find((item) => item.key === "a")?.state,
    ).toBe("completed");
    const reopened = new AnalysisStore(x.crawl.db);
    const next = reopened.createRun("codex", "checkpoint-model", false, x.profile);
    expect(reopened.run(next)).toMatchObject({ completed: 0, queued: 1 });
    expect(x.analyze).not.toHaveBeenCalled();
  });

  it("旧1400元公式和配置变化只本地复算，并留下可复用的新完成记录", async () => {
    const x = await fixture();
    x.store.db.prepare("UPDATE analysis_runs SET profile_json=? WHERE id=?").run(
      JSON.stringify({
        ...x.profile,
        template: x.profile.template.replace(
          "确认具有“靓号特效：土豪金”时加 800 元。",
          "确认具有“靓号特效：土豪金”时加 1400 元。",
        ),
        calculationVersion: "price-comparison-v38",
      }),
      x.id,
    );
    x.store.db.exec(
      "UPDATE analysis_tasks SET result_json=json_set(result_json,'$.valuation.calculation_version','price-comparison-v38') WHERE status='completed'",
    );
    x.store.db.exec(`UPDATE analysis_tasks SET result_json=json_set(result_json,
      '$.valuation.items[' || (SELECT j.key FROM json_each(analysis_tasks.result_json,'$.valuation.items') j WHERE json_extract(j.value,'$.name')='土豪金ID') || '].formula',
      '明确土豪金+1400；明确没有为0') WHERE status='completed'`);
    x.store.db.exec(`UPDATE analysis_tasks SET result_json=json_set(result_json,
      '$.valuation.items[' || (SELECT j.key FROM json_each(analysis_tasks.result_json,'$.valuation.items') j WHERE json_extract(j.value,'$.name')='土豪金ID') || '].amount',
      1400) WHERE listing_key='a' AND status='completed'`);
    const changed = createProfile(
      x.profile.template,
      { ...x.profile.settings, capMode: "both" },
      false,
    );
    const id = x.store.createRun("codex", "checkpoint-model", false, changed);
    expect(x.store.run(id)).toMatchObject({ completed: 2, reused: 2, queued: 1 });
    expect(x.store.run(id)?.calculationVersion).toBe("price-comparison-v39");
    const row = x.store.db
      .prepare("SELECT id FROM analysis_tasks WHERE run_id=? AND listing_key='a'")
      .get(id)!;
    expect(
      x.store
        .detail(String(row.id))
        ?.result?.valuation?.items.find((item) => item.name === "土豪金ID")?.formula,
    ).toContain("800");
    expect(
      x.store
        .detail(String(row.id))
        ?.result?.valuation?.items.find((item) => item.name === "土豪金ID")?.amount,
    ).toBe(800);
    const next = x.store.createRun("codex", "checkpoint-model", false, changed);
    expect(x.store.run(next)).toMatchObject({ total: 1, queued: 1 });
    expect(x.analyze).not.toHaveBeenCalled();
  });

  it("真正的字段变化、缺少原始依据或更换模型仍进入分析队列", async () => {
    const x = await fixture();
    const record = x.crawl.detail("a") as SavedRoleRecord;
    record.detail!.tabs[0].fields[0].value = "已飞升";
    x.crawl.save(record.listing, record.detail!);
    x.store.db.exec(
      "DELETE FROM analysis_attempts WHERE task_id IN (SELECT id FROM analysis_tasks WHERE listing_key='b')",
    );
    const id = x.store.createRun("codex", "checkpoint-model", false, x.profile);
    expect(x.store.run(id)).toMatchObject({ completed: 0, queued: 3 });
    const other = x.store.createRun("codex", "other-model", false, x.profile);
    expect(x.store.run(other)).toMatchObject({ completed: 0, queued: 3 });
  });
});
