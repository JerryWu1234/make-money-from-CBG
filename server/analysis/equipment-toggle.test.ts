import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vite-plus/test";
import { CrawlStore } from "../crawler/store";
import { CAPTURE_VERSION } from "../crawler/compact";
import { captureIssues } from "../crawler/capture-readiness";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { AnalysisStore } from "./store";
import { AnalysisRunner } from "./runner";
import { createProfile, DEFAULT_SETTINGS, loadProfile, saveProfile, PROMPT_FILE } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import { valuationPriceSummary } from "../../src/ValuationResultView";
import { buildProductDocument } from "./product-document";
import { BARE_ROLE_TEMPLATE } from "./bare-role-prompt";

const template = readFileSync(PROMPT_FILE, "utf8");
function fullRecord() {
  const record = valuationRecord();
  record.detail!.captureMode = "all";
  record.detail!.captureVersion = CAPTURE_VERSION;
  record.detail!.valuation = { version: 1, fields: [], issues: [], source: {} };
  record.detail!.equipmentCapture = {
    version: 1,
    collectedAt: "now",
    complete: true,
    issues: [],
    emptyProof: "explicit-text",
  };
  record.detail!.petCapture = { version: 1, collectedAt: "now", complete: true, issues: [] };
  for (const name of ["道具/法宝", "坐骑"])
    if (!record.detail!.tabs.some((tab) => tab.name === name))
      record.detail!.tabs.push({
        name,
        text: "",
        fields: [],
        tables: [],
        elements: [],
        tooltips: [],
      });
  return record;
}

it("默认关闭且持久化；开启改变新任务指纹，不改已创建任务", () => {
  const crawl = new CrawlStore(":memory:");
  const folder = mkdtempSync(join(tmpdir(), "cbg-toggle-"));
  const file = join(folder, "prompt.md");
  writeFileSync(file, template);
  try {
    const before = loadProfile(crawl.db, file);
    expect(before).toMatchObject({
      equipmentSearch: false,
      petSearch: false,
      petGearSearch: false,
    });
    expect(() => createProfile(template, { analyzeEquipment: "true" })).toThrow("无效");
    const record = fullRecord();
    crawl.observe(record.listing);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
    const store = new AnalysisStore(crawl.db);
    const runId = store.createRun("codex", "test", true, before, true);
    saveProfile(
      crawl.db,
      {
        template,
        baseHash: before.hash,
        settings: { ...before.settings, analyzeEquipment: true, pricingScope: "all" },
      },
      file,
    );
    const enabled = loadProfile(crawl.db, file);
    expect(enabled).toMatchObject({ equipmentSearch: true, petSearch: true });
    expect(enabled.hash).not.toBe(before.hash);
    expect(
      store.detail(
        store.db.prepare("SELECT id FROM analysis_tasks WHERE run_id=?").get(runId)!.id as string,
      )?.profile?.equipmentSearch,
    ).toBe(false);
    expect(store.createRun("codex", "test", true, enabled, true)).toBeTruthy();
  } finally {
    crawl.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it("关闭装备分析仍须完整采集；旧裸号资料不能冒充完整角色", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    const record = fullRecord();
    const partial = structuredClone(record.detail!);
    partial.captureMode = "body";
    delete partial.equipmentCapture;
    delete partial.petCapture;
    crawl.observe(record.listing);
    expect(crawl.save(record.listing, partial)).toBe(false);
    expect(crawl.retryItems()).toHaveLength(1);
    expect(captureIssues(partial, true)).toContain("本次仅采集裸号，装备和宝宝尚未核验");
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
    expect(crawl.retryItems()).toEqual([]);
    expect(crawl.observe(record.listing)).toBe(true);
    record.detail!.valuation!.issues = ["坐骑成长缺失"];
    expect(crawl.save(record.listing, record.detail!)).toBe(false);
  } finally {
    crawl.close();
  }
});

it("裸号从队列到结果正常完成，绝不调用装备/宝宝查价，不生成资产待补齐", async () => {
  const crawl = new CrawlStore(":memory:");
  const store = new AnalysisStore(crawl.db);
  const record = fullRecord();
  record.detail!.raw = { assetDescription: "未参与分析的装备属性".repeat(40000) };
  const profile = createProfile(template, {
    ...DEFAULT_SETTINGS,
    servers: [{ serverId: record.listing.serverId, age: "three", rank: 10 }],
  });
  const search = vi.fn().mockRejectedValue(new Error("不应查价"));
  const analyze = vi.fn(
    async (
      _prompt: string,
      _schema: unknown,
      _signal: AbortSignal,
      options?: { bareRoleReview?: boolean },
    ) => {
      expect(options).toEqual({ bareRoleReview: true });
      return {
        text: JSON.stringify({
          decision: calculateValuation(record, profile).decision,
          reason: "仅核对裸号资料",
          extracted_facts: [],
        }),
      };
    },
  );
  const runner = new AnalysisRunner(store, async () => ({
    model: "test",
    analyze,
    searchEquipment: search,
    searchPets: search,
    searchPetGear: search,
  }));
  try {
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const id = await runner.start("codex", true, profile, true);
    await runner.settled();
    expect(store.run(id)?.status).toBe("completed");
    expect(search).not.toHaveBeenCalled();
    expect(analyze).toHaveBeenCalledOnce();
    expect(Buffer.byteLength(buildProductDocument(record).text)).toBeGreaterThan(256 * 1024);
    const request = analyze.mock.calls[0][0];
    expect(request.startsWith(BARE_ROLE_TEMPLATE)).toBe(true);
    expect(request).not.toContain("未参与分析的装备属性");
    const row = store.db.prepare("SELECT result_json FROM analysis_tasks WHERE run_id=?").get(id)!;
    const result = JSON.parse(String(row.result_json)).valuation;
    expect(result.asset_scope).toBe("body");
    expect(result.equipment_pricing).toBeUndefined();
    expect(result.pet_pricing).toBeUndefined();
    expect(result.missing_fields.join(" ")).not.toMatch(/装备|宝宝|灵饰|玉魄/);
    expect(valuationPriceSummary(result).label).toBe("裸号参考估值");
  } finally {
    await runner.shutdown();
    crawl.close();
  }
});

it("直接恢复旧body任务也不会绕过完整性检查进入AI", async () => {
  const crawl = new CrawlStore(":memory:"),
    store = new AnalysisStore(crawl.db);
  const analyze = vi.fn().mockRejectedValue(new Error("不应调用AI"));
  const runner = new AnalysisRunner(store, async () => ({ model: "test", analyze }));
  try {
    const record = fullRecord();
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const id = store.createRun("codex", "test", true, createProfile(template), true);
    const legacy = { ...record.detail!, captureMode: "body" };
    crawl.db
      .prepare("UPDATE analysis_tasks SET source_detail_json=? WHERE run_id=?")
      .run(JSON.stringify(legacy), id);
    await runner.resume(id);
    await runner.settled();
    expect(analyze).not.toHaveBeenCalled();
    expect(store.run(id)).toMatchObject({
      status: "paused",
      completed: 0,
      queued: 1,
      error: expect.stringContaining("完整采集"),
    });
  } finally {
    await runner.shutdown();
    crawl.close();
  }
});
