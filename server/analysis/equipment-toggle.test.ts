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

const template = readFileSync(PROMPT_FILE, "utf8");
function bodyRecord() {
  const record = valuationRecord();
  record.detail!.captureMode = "body";
  record.detail!.captureVersion = CAPTURE_VERSION;
  record.detail!.valuation = { version: 1, fields: [], issues: [], source: {} };
  delete record.detail!.equipmentCapture;
  delete record.detail!.petCapture;
  record.detail!.tabs = record.detail!.tabs.filter((tab) => tab.name !== "召唤兽/孩子");
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
    const record = bodyRecord();
    crawl.observe(record.listing, false);
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
    expect(() => store.createRun("codex", "test", true, enabled, true)).toThrow("尚未完整采集");
  } finally {
    crawl.close();
    rmSync(folder, { recursive: true, force: true });
  }
});

it("裸号资料可保存、续采跳过；开启后要求补采资产；裸号本体缺项仍失败", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    const record = bodyRecord();
    crawl.observe(record.listing, false);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
    expect(crawl.retryItems(undefined, false, false)).toEqual([]);
    expect(crawl.observe(record.listing, false)).toBe(true);
    expect(crawl.retryItems(undefined, false, true)).toHaveLength(1);
    expect(crawl.observe(record.listing, true)).toBe(false);
    expect(captureIssues(record.detail!, true, true)).toContain(
      "本次仅采集裸号，装备和宝宝尚未核验",
    );
    record.detail!.valuation!.issues = ["坐骑成长缺失"];
    expect(crawl.save(record.listing, record.detail!)).toBe(false);
  } finally {
    crawl.close();
  }
});

it("裸号从队列到结果正常完成，绝不调用装备/宝宝查价，不生成资产待补齐", async () => {
  const crawl = new CrawlStore(":memory:");
  const store = new AnalysisStore(crawl.db);
  const record = bodyRecord();
  const profile = createProfile(template, {
    ...DEFAULT_SETTINGS,
    servers: [{ serverId: record.listing.serverId, age: "three", rank: 10 }],
  });
  const search = vi.fn().mockRejectedValue(new Error("不应查价"));
  const analyze = vi.fn(async () => ({
    text: JSON.stringify({
      decision: calculateValuation(record, profile).decision,
      reason: "仅核对裸号资料",
      extracted_facts: [],
    }),
  }));
  const runner = new AnalysisRunner(store, async () => ({
    model: "test",
    analyze,
    searchEquipment: search,
    searchPets: search,
    searchPetGear: search,
  }));
  try {
    crawl.observe(record.listing, false);
    crawl.save(record.listing, record.detail!);
    const id = await runner.start("codex", true, profile, true);
    await runner.settled();
    expect(store.run(id)?.status).toBe("completed");
    expect(search).not.toHaveBeenCalled();
    expect(analyze).toHaveBeenCalledOnce();
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
