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

async function fixture(queueBeforeCompletion = false) {
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
  const queued = queueBeforeCompletion
    ? store.createRun("codex", "checkpoint-model", false, profile)
    : undefined;
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
  return { directory, filename, crawl, store, profile, id, queued, analyze };
}

describe("数据库保存的分析断点和有效版本", () => {
  // Failure cases: an older queue repeats newer completions, a disconnect loses
  // reused results, or a failed attempt is skipped as though it had succeeded.
  it("旧队列逐件跳过后来已完成的商品，断网重启后只重试未完成项", async () => {
    const x = await fixture(true);
    const queued = x.queued!;
    const original = x.analyze.getMockImplementation()!;
    x.analyze.mockImplementationOnce(async () => {
      throw new Error("Codex network disconnected");
    });
    const runner = new AnalysisRunner(x.store, async () => ({
      model: "checkpoint-model",
      analyze: x.analyze,
    }));
    cleanups.push(() => runner.shutdown());
    await runner.resume(queued, false, 1);
    await vi.waitFor(() => expect(x.store.run(queued)?.status).toBe("paused"));
    expect(x.store.run(queued)).toMatchObject({ completed: 2, reused: 2, failed: 1 });
    expect(x.analyze.mock.calls.map(([prompt]) => prompt.match(/商品 ID：([^。\n]+)/)![1])).toEqual(
      ["c"],
    );
    const saved = x.store.db
      .prepare(
        "SELECT listing_key,result_json,source_task_id FROM analysis_tasks WHERE run_id=? AND status='completed' ORDER BY listing_key",
      )
      .all(queued);
    expect(saved).toHaveLength(2);
    for (const row of saved) {
      const source = x.store.db
        .prepare("SELECT id,result_json FROM analysis_tasks WHERE run_id=? AND listing_key=?")
        .get(x.id, row.listing_key)!;
      expect(row.source_task_id).toBe(source.id);
      expect(row.result_json).toBe(source.result_json);
    }
    await runner.shutdown();
    const reopened = new CrawlStore(x.filename);
    cleanups.push(async () => reopened.close());
    const store = new AnalysisStore(reopened.db);
    x.analyze.mockImplementation(original);
    const resumed = new AnalysisRunner(store, async () => ({
      model: "checkpoint-model",
      analyze: x.analyze,
    }));
    cleanups.push(() => resumed.shutdown());
    await resumed.resume(queued, true, 1);
    await vi.waitFor(() => expect(store.run(queued)?.completed).toBe(3));
    expect(store.run(queued)).toMatchObject({ reused: 2, failed: 0, queued: 0 });
    expect(x.analyze.mock.calls.map(([prompt]) => prompt.match(/商品 ID：([^。\n]+)/)![1])).toEqual(
      ["c", "c"],
    );
    const remaining = store.db
      .prepare("SELECT id FROM analysis_tasks WHERE run_id=? AND listing_key='c'")
      .get(queued)!;
    expect(store.detail(String(remaining.id))?.attempts.map((attempt) => attempt.state)).toEqual([
      "failed",
      "completed",
    ]);
  });

  // Invalid source/proof, changed rules/model, and expired pricing must remain queued.
  it.each(["source", "rules", "model", "proof", "pricing"])(
    "派发前检查仍重算已失效的历史：%s",
    async (changed) => {
      const x = await fixture(true);
      const queued = x.queued!;
      if (changed === "source") {
        const record = x.crawl.detail("a") as SavedRoleRecord;
        record.listing.price = "1234";
        x.crawl.save(record.listing, record.detail!);
      } else if (changed === "rules") {
        x.store.db
          .prepare("UPDATE analysis_runs SET profile_json=? WHERE id=?")
          .run(
            JSON.stringify({ ...x.profile, template: x.profile.template + "\n新的事实核对要求" }),
            queued,
          );
      } else if (changed === "model") {
        x.store.db.prepare("UPDATE analysis_runs SET model='other-model' WHERE id=?").run(queued);
      } else if (changed === "proof") {
        x.store.db
          .prepare(
            "UPDATE analysis_attempts SET raw_response='invalid' WHERE task_id IN (SELECT id FROM analysis_tasks WHERE run_id=? AND listing_key='a')",
          )
          .run(x.id);
      } else {
        x.store.db
          .prepare(
            "UPDATE analysis_tasks SET result_json=json_set(result_json,'$.valuation.equipment_pricing',json(?)) WHERE run_id=? AND listing_key='a'",
          )
          .run(
            JSON.stringify({
              searchedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
            }),
            x.id,
          );
      }
      const runner = new AnalysisRunner(x.store, async () => ({
        model: changed === "model" ? "other-model" : "checkpoint-model",
        analyze: x.analyze,
      }));
      cleanups.push(() => runner.shutdown());
      await runner.resume(queued, false, 1);
      await vi.waitFor(() => expect(x.store.run(queued)?.completed).toBe(3));
      const calls = x.analyze.mock.calls.map(([prompt]) => prompt.match(/商品 ID：([^。\n]+)/)![1]);
      expect(calls).toEqual(
        changed === "rules" || changed === "model" ? ["a", "b", "c"] : ["a", "c"],
      );
    },
  );

  it("显式强制分析重启后继续调用AI，不被派发前的历史检查跳过", async () => {
    const x = await fixture();
    const id = x.store.createRun("codex", "checkpoint-model", true, x.profile, true, 2);
    const reopened = new CrawlStore(x.filename);
    cleanups.push(async () => reopened.close());
    const store = new AnalysisStore(reopened.db);
    const runner = new AnalysisRunner(store, async () => ({
      model: "checkpoint-model",
      analyze: x.analyze,
    }));
    cleanups.push(() => runner.shutdown());
    await runner.resume(id, false, 1);
    await vi.waitFor(() => expect(store.run(id)?.completed).toBe(2));
    expect(store.run(id)).toMatchObject({ reused: 0 });
    expect(x.analyze.mock.calls.map(([prompt]) => prompt.match(/商品 ID：([^。\n]+)/)![1])).toEqual(
      ["a", "b"],
    );
  });

  it("旧队列缺少强制标记时可迁移，复用时间变化的结果并保留中断尝试", async () => {
    const x = await fixture(true);
    const queued = x.queued!;
    x.store.acquire("interrupted");
    const task = x.store.next(queued)!;
    const attempt = x.store.begin(task, "interrupted");
    x.store.finish(task, attempt, "interrupted", {
      state: "interrupted",
      error: "Codex连接已断开",
      requeue: true,
    });
    x.store.release("interrupted");
    x.store.db.exec("ALTER TABLE analysis_tasks DROP COLUMN force_reanalysis");
    const migrated = new AnalysisStore(x.crawl.db);
    const record = x.crawl.detail("a") as SavedRoleRecord;
    record.detail!.collectedAt = new Date().toISOString();
    x.crawl.save(record.listing, record.detail!);
    const runner = new AnalysisRunner(migrated, async () => ({
      model: "checkpoint-model",
      analyze: x.analyze,
    }));
    cleanups.push(() => runner.shutdown());
    await runner.resume(queued, false, 1);
    await vi.waitFor(() => expect(migrated.run(queued)?.completed).toBe(3));
    expect(migrated.run(queued)).toMatchObject({ reused: 2 });
    expect(x.analyze.mock.calls.map(([prompt]) => prompt.match(/商品 ID：([^。\n]+)/)![1])).toEqual(
      ["c"],
    );
    const attempts = migrated.db
      .prepare("SELECT state,usage_json FROM analysis_attempts WHERE task_id=? ORDER BY rowid")
      .all(task.id);
    expect(attempts.map((row) => row.state)).toEqual(["interrupted", "completed"]);
    expect(JSON.parse(String(attempts[1]!.usage_json)).source).toBe("validated-body-recalculation");
    expect(migrated.detail(task.id)?.inputHash).toBe(buildProductDocument(record).contentHash);
  });

  it("没有执行锁时不能写入复用结果", async () => {
    const x = await fixture(true);
    const task = x.store.next(x.queued!)!;
    expect(() => x.store.reuseCompletedTask(task, "expired-owner")).toThrow("分析锁已失效");
    expect(x.store.run(x.queued!)).toMatchObject({ queued: 3, completed: 0, reused: 0 });
  });

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
