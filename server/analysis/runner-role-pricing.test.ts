import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vite-plus/test";
import { rolePricingFixture, rolePricingRecord } from "../../tests/fixtures/role-pricing";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { AnalysisRunner, type AnalysisClient } from "./runner";
import { createProfile, PROMPT_FILE } from "./profile";
import { equipmentInventory } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";
import { buildProductDocument } from "./product-document";
import { validateValuation, valuationPrompt } from "./valuation-contract";
import type { SavedRoleRecord } from "../crawler/types";
import { GLOBAL_MARKET_SCOPE_VERSION, MARKET_SEARCH_UI_VERSION } from "./market-scope";
import { ROLE_SEARCH_QUERY_POLICY } from "./role-search-query";

function setup() {
  const sourceRecord = rolePricingRecord();
  const crawl = new CrawlStore(":memory:");
  crawl.observe(sourceRecord.listing);
  crawl.save(sourceRecord.listing, sourceRecord.detail!);
  const record = crawl.detail(sourceRecord.listing.key) as SavedRoleRecord;
  const store = new AnalysisStore(crawl.db),
    profile = createProfile(readFileSync(PROMPT_FILE, "utf8"));
  const base = {
    version: 1 as const,
    searchedAt: new Date().toISOString(),
    provider: "browser" as const,
    model: "browser",
    queries: [],
    rawResponse: null,
    captureComplete: true,
    searchComplete: true,
    total: 0,
    knownTotal: 0,
    issues: [],
  };
  const equipment = { ...base, ...equipmentInventory(record) },
    pets = { ...base, ...petInventory(record) };
  const role = rolePricingFixture(record);
  const searchEquipment = vi
    .fn<NonNullable<AnalysisClient["searchEquipment"]>>()
    .mockResolvedValue(equipment);
  const searchPets = vi.fn<NonNullable<AnalysisClient["searchPets"]>>().mockResolvedValue(pets);
  const searchRole = vi.fn<NonNullable<AnalysisClient["searchRole"]>>().mockResolvedValue(role);
  const response = {
    text: JSON.stringify({
      decision: "NEED_INFO",
      reason: "模拟整号市场参考独立展示，分项资料仍待补齐。",
      extracted_facts: [],
    }),
  };
  const analyze = vi.fn<AnalysisClient["analyze"]>().mockResolvedValue(response);
  const runner = new AnalysisRunner(store, async () => ({
    model: "fixture",
    analyze,
    searchEquipment,
    searchPets,
    searchRole,
  }));
  return {
    record,
    crawl,
    store,
    profile,
    equipment,
    pets,
    role,
    searchEquipment,
    searchPets,
    searchRole,
    analyze,
    runner,
    response,
  };
}

it("自动顺序为装备、宝宝、整号、AI，完整整号结果增量复用且金额不重复增加", async () => {
  const c = setup();
  c.searchRole.mockImplementationOnce(async () => {
    expect(c.searchEquipment).toHaveBeenCalledOnce();
    expect(c.searchPets).toHaveBeenCalledOnce();
    expect(c.store.activeRun()?.phase).toBe("role_search");
    expect(c.analyze).not.toHaveBeenCalled();
    return c.role;
  });
  try {
    const id = await c.runner.start("codex", false, c.profile);
    await c.runner.settled();
    expect(c.store.run(id)?.status, c.store.run(id)?.error || "completed").toBe("completed");
    const task = c.store.overview().results.items[0];
    expect(c.store.detail(task.taskId)?.rolePricing).toEqual(c.role);
    expect(task.result.valuation?.role_pricing?.marketReference.status).toBe("range");
    const document = buildProductDocument(c.record);
    const without = validateValuation(
      c.response.text,
      document,
      { ...c.record },
      { ...c.profile, roleSearch: false },
      c.equipment,
      c.pets,
    ).valuation;
    const { role_pricing: _role, ...withAmounts } = task.result.valuation!;
    expect(withAmounts).toEqual(without);
    expect(c.analyze.mock.calls[0][0]).toContain("绝不相加");
    expect(c.analyze.mock.calls[0][0]).not.toContain('"observedTarget"');
    expect(await c.runner.start("codex", false, c.profile)).toBe(id);
    await c.runner.settled();
    expect(c.searchRole).toHaveBeenCalledOnce();
    expect(c.analyze).toHaveBeenCalledOnce();
  } finally {
    await c.runner.shutdown();
    c.crawl.db.close();
  }
});

it("整号失败与刷新恢复只重查整号，已完成资产不重复查", async () => {
  const c = setup();
  c.searchRole.mockRejectedValueOnce(new Error("官网要求登录"));
  try {
    const id = await c.runner.start("codex", false, c.profile);
    await c.runner.settled();
    expect(c.store.run(id)?.status).toBe("paused");
    expect(c.analyze).not.toHaveBeenCalled();
    expect(c.store.next(id)).toMatchObject({ equipmentPricing: c.equipment, petPricing: c.pets });
    await c.runner.resume(id);
    await c.runner.settled();
    expect(c.store.run(id)?.status, c.store.run(id)?.error || "completed").toBe("completed");
    expect(c.searchEquipment).toHaveBeenCalledOnce();
    expect(c.searchPets).toHaveBeenCalledOnce();
    expect(c.searchRole).toHaveBeenCalledTimes(2);
    expect(c.analyze).toHaveBeenCalledOnce();
  } finally {
    await c.runner.shutdown();
    c.crawl.db.close();
  }
});

it("整号保存后AI登录失败，恢复和不足样本均不重复整号查询", async () => {
  const c = setup();
  c.searchRole.mockResolvedValue(rolePricingFixture(c.record, [4800, 5000]));
  c.analyze.mockRejectedValueOnce(new Error("AI登录失效"));
  try {
    const id = await c.runner.start("codex", false, c.profile);
    await c.runner.settled();
    expect(c.store.run(id)?.status).toBe("paused");
    expect(c.store.next(id)?.rolePricing).toMatchObject({
      searchComplete: true,
      marketReference: { status: "insufficient", range: null, median: null },
    });
    await c.runner.resume(id);
    await c.runner.settled();
    expect(c.store.run(id)?.status).toBe("completed");
    expect(c.searchRole).toHaveBeenCalledOnce();
  } finally {
    await c.runner.shutdown();
    c.crawl.db.close();
  }
});

it.each(["identity", "stale", "price", "missing"])(
  "无效整号%s证据不保存、不进入AI",
  async (kind) => {
    const c = setup();
    if (kind === "identity") c.role.inputHash = "other-role";
    if (kind === "stale") c.role.searchedAt = "2000-01-01T00:00:00Z";
    if (kind === "price") c.role.candidates[0].price = 9999;
    const connect =
      kind === "missing"
        ? new AnalysisRunner(c.store, async () => ({
            model: "fixture",
            analyze: c.analyze,
            searchEquipment: c.searchEquipment,
            searchPets: c.searchPets,
          }))
        : c.runner;
    try {
      const id = await connect.start("codex", false, c.profile);
      await connect.settled();
      expect(c.store.run(id)?.status).toBe("paused");
      expect(c.store.next(id)?.rolePricing).toBeUndefined();
      expect(c.analyze).not.toHaveBeenCalled();
    } finally {
      await connect.shutdown();
      c.crawl.db.close();
    }
  },
);

it.each(["过期", "旧比较策略"])(
  "旧profile缺省关闭，新profile默认开启但%s整号缓存不复用",
  async (version) => {
    const c = setup();
    try {
      expect(c.profile.roleSearch).toBe(true);
      expect(createProfile("fixture", undefined, false).roleSearch).toBe(false);
      expect(createProfile("fixture", undefined, true, true, false).hash).not.toBe(
        createProfile("fixture").hash,
      );
      const id = await c.runner.start("codex", false, c.profile);
      await c.runner.settled();
      const row = c.crawl.db
        .prepare("SELECT id,role_pricing_json,result_json FROM analysis_tasks WHERE run_id=?")
        .get(id)!;
      const stale = JSON.parse(String(row.role_pricing_json));
      if (version === "过期") stale.searchedAt = "2000-01-01T00:00:00Z";
      else {
        stale.inputHash = createHash("sha256")
          .update(
            JSON.stringify({
              key: c.record.listing.key,
              sourceHash: buildProductDocument(c.record).contentHash,
              scope: GLOBAL_MARKET_SCOPE_VERSION,
              searchUI: MARKET_SEARCH_UI_VERSION,
              query: ROLE_SEARCH_QUERY_POLICY,
              comparison: "whole-role-core-config-v1",
            }),
          )
          .digest("hex");
        stale.marketReference.policyVersion = "whole-role-core-config-v1";
        expect(stale.inputHash).not.toBe(c.role.inputHash);
      }
      const result = JSON.parse(String(row.result_json));
      result.valuation.role_pricing = stale;
      c.crawl.db
        .prepare("UPDATE analysis_tasks SET role_pricing_json=?,result_json=? WHERE id=?")
        .run(JSON.stringify(stale), JSON.stringify(result), row.id);
      expect(await c.runner.start("codex", false, c.profile)).not.toBe(id);
      await c.runner.settled();
      expect(c.searchRole).toHaveBeenCalledTimes(2);
      const oldProfile = { ...c.profile };
      delete oldProfile.roleSearch;
      const prompt = valuationPrompt(
        buildProductDocument(c.record),
        c.record,
        oldProfile,
        c.equipment,
        c.pets,
      );
      expect(prompt).not.toContain("role_pricing是");
      expect(c.analyze).toHaveBeenCalledTimes(2);
    } finally {
      await c.runner.shutdown();
      c.crawl.db.close();
    }
  },
);
