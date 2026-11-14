import { readFileSync } from "node:fs";
import { expect, it, vi } from "vite-plus/test";
import { analysisRecord, valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { AnalysisRunner } from "./runner";
import type { SavedRoleRecord } from "../crawler/types";
import {
  equipmentInventory,
  combineEquipmentPricing,
  type EquipmentPricingSnapshot,
} from "./equipment-pricing";
import { petInventory, combinePetPricing, type PetPricingSnapshot } from "./pet-pricing";
import { validateExactPricing } from "./pricing-integrity";
import { calculateValuation } from "./valuation-calculator";
import { applyValuationRange } from "./valuation-range";
import { validateValuation } from "./valuation-contract";
import { defaultConditions, type ConditionGroup } from "./conditions";
import { RULE_ENGINE_VERSION, describeRule, type RuleExpression } from "./condition-rule-types";

const allAssets: RuleExpression = {
  op: "count",
  collections: ["equipment", "jewelry", "petEquipment", "pets"],
};
function configured(threshold = 8): ConditionGroup {
  const tree = defaultConditions();
  tree.children[0] = {
    id: "C1",
    text: "",
    price: { comparison: "lte", adjustment: "none", value: 0, unit: "amount" },
  };
  const text = `人物装备、灵饰、宝宝装备和召唤兽总数大于${threshold}`;
  const expression: RuleExpression = {
    op: "gt",
    args: [allAssets, { op: "literal", value: threshold }],
  };
  tree.children.push({
    id: "C2",
    join: "and",
    text,
    rule: {
      version: RULE_ENGINE_VERSION,
      sourceText: text,
      status: "ready",
      expression,
      explanation: describeRule(expression),
      issues: [],
    },
  });
  return tree;
}
function source() {
  const record = analysisRecord("three-pets");
  record.listing.price = "999";
  const gear = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
  gear.items = [
    { index: 0, name: "法宝不算装备", kind: "equipment", category: "法宝", description: "等级1" },
  ];
  gear.text = "没有装备";
  record.detail!.equipmentCapture!.emptyProof = "explicit-text";
  const pets = record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
  pets.pets = pets.pets!.slice(0, 3).map((pet) => ({ ...pet, equipment: [] }));
  pets.petCount = 3;
  return record;
}

it("旧AI把3件标满足不能入榜；修改可执行规则立即重算并保持旧证据", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    const record = source();
    crawl.observe(record.listing);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
    const legacy = configured();
    delete (legacy.children[1] as { rule?: unknown }).rule;
    const oldProfile = createProfile("local rule regression", {
      ...DEFAULT_SETTINGS,
      conditions: legacy,
    });
    const store = new AnalysisStore(crawl.db);
    const runId = store.createRun("codex", "fixture", false, oldProfile);
    const archived = {
      valuation: {
        asking_price: 999,
        bare_role_value: 1024.5,
        decision: "BUY",
        condition_review: {
          tree: legacy,
          results: [
            { id: "C2", status: "met", reason: "实际3件，不大于8" },
            { id: "G1", status: "met", reason: "错误合计" },
          ],
        },
      },
    };
    const json = JSON.stringify(archived);
    crawl.db
      .prepare("UPDATE analysis_tasks SET status='completed',result_json=? WHERE run_id=?")
      .run(json, runId);
    const taskId = String(
      crawl.db.prepare("SELECT id FROM analysis_tasks WHERE run_id=?").get(runId)!.id,
    );
    const current = createProfile(oldProfile.template, {
      ...DEFAULT_SETTINGS,
      conditions: configured(),
    });
    expect(store.overview({ runId, currentProfile: current }).ranking).toHaveLength(0);
    const detail = store.detail(taskId, current)!;
    expect(detail.profileChanged).toBe(false);
    expect(
      detail.result?.valuation?.condition_review?.results.find((r) => r.id === "C2"),
    ).toMatchObject({ status: "unmet" });
    expect(
      detail.result?.valuation?.condition_review?.results.find((r) => r.id === "C2")?.reason,
    ).toContain("3");
    const changed = createProfile(oldProfile.template, {
      ...DEFAULT_SETTINGS,
      conditions: configured(2),
    });
    const updated = store.overview({ runId, currentProfile: changed });
    expect(updated.ranking).toHaveLength(1);
    expect(
      updated.ranking[0].recommendation?.conditionReview?.results.find((r) => r.id === "C2")
        ?.status,
    ).toBe("met");
    expect(updated.ranking[0].valuation?.condition_review).toEqual(
      updated.ranking[0].recommendation?.conditionReview,
    );
    expect(store.detail(taskId, changed)!.result?.valuation?.condition_review).toEqual(
      updated.ranking[0].recommendation?.conditionReview,
    );
    expect(
      crawl.db.prepare("SELECT result_json FROM analysis_tasks WHERE id=?").get(taskId)
        ?.result_json,
    ).toBe(json);
    expect(
      store.overview({ runId, currentProfile: createProfile("pricing changed", changed.settings) })
        .ranking,
    ).toHaveLength(0);
    // Re-reading the first rule must invalidate the warm cache from the second rule.
    expect(store.overview({ runId, currentProfile: current }).ranking).toHaveLength(0);
  } finally {
    crawl.close();
  }
});

function fullValuationFixture() {
  const record = valuationRecord("full-condition-reuse");
  record.detail!.equipmentCapture!.emptyProof = undefined;
  record.detail!.tabs.push(
    {
      name: "道具/法宝",
      text: "",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [
        {
          index: 0,
          kind: "equipment",
          name: "测试腰带",
          category: "腰带",
          description: "等级：100\n防御：50\n气血：250\n耐久：100\n修理失败：0",
        },
      ],
    },
    {
      name: "召唤兽/孩子",
      text: "",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      petCount: 1,
      pets: [
        {
          index: 0,
          name: "泡泡",
          fields: Object.entries({
            类型: "泡泡",
            等级: "1",
            成长: "1.2",
            攻击资质: "1200",
            防御资质: "1200",
            体力资质: "3000",
            法力资质: "1500",
            速度资质: "1000",
            躲闪资质: "1000",
          }).map(([name, value]) => ({ name, value })),
          skills: [],
          innerSkills: [],
          equipment: [],
        },
      ],
    },
  );
  const conditions = configured(1);
  conditions.children = conditions.children.slice(1).map((node) => ({ ...node, join: undefined }));
  const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), {
    ...DEFAULT_SETTINGS,
    analyzeEquipment: true,
    conditions,
    servers: [{ serverId: record.listing.serverId, age: "three", rank: 10 }],
  });
  const gearInventory = equipmentInventory(record, profile.settings);
  const petsInventory = petInventory(record);
  const candidate = (price: number) => ({
    url: `https://xyq.cbg.163.com/equip?s=1&eid=mock-condition-price-${price}`,
    title: "模拟测试有效挂牌样本",
    price,
    priceType: "listing" as const,
    quote: `挂牌价：${price}`,
    verified: true,
    matchType: "exact" as const,
    differences: [],
    reason: "模拟测试的同等级和属性样本",
    fetchedAt: new Date().toISOString(),
    sourceHash: `fixture-condition-${price}`,
  });
  const equipment: EquipmentPricingSnapshot = {
    version: 1,
    inputHash: gearInventory.inputHash,
    searchedAt: new Date().toISOString(),
    provider: "browser",
    model: "browser",
    queries: ["模拟测试查价"],
    rawResponse: null,
    captureComplete: true,
    searchComplete: true,
    total: 100,
    knownTotal: 100,
    items: gearInventory.items.map((item) => ({
      ...item,
      status: "priced",
      referencePrice: 100,
      searchState: "completed",
      candidates: [candidate(100)],
    })),
    issues: [],
  };
  const pets: PetPricingSnapshot = {
    ...equipment,
    inputHash: petsInventory.inputHash,
    total: 300,
    knownTotal: 300,
    items: petsInventory.items.map((item) => ({
      ...item,
      status: "priced",
      referencePrice: 300,
      searchState: "completed",
      candidates: [candidate(300)],
    })),
  };
  expect(equipment.items).toHaveLength(1);
  expect(pets.items).toHaveLength(1);
  expect(validateExactPricing(equipment, gearInventory.items)).toBe(true);
  expect(validateExactPricing(pets, petsInventory.items)).toBe(true);
  const crawl = new CrawlStore(":memory:");
  crawl.observe(record.listing);
  expect(crawl.save(record.listing, record.detail!)).toBe(true);
  const store = new AnalysisStore(crawl.db);
  const id = store.createRun("codex", "full-condition-fixture", true, profile);
  store.acquire("seed");
  let task = store.next(id)!;
  store.beginEquipmentSearch(task, "seed");
  task = store.saveEquipmentPricing(task, equipment, "seed");
  store.beginPetSearch(task, "seed");
  task = store.savePetPricing(task, pets, "seed");
  const bare = calculateValuation(record, profile);
  const computed = applyValuationRange(
    combinePetPricing(
      combineEquipmentPricing(bare, record, equipment, profile.settings),
      record,
      pets,
    ),
    bare,
    record,
    profile,
  );
  const raw = JSON.stringify({
    decision: computed.decision,
    reason: "已核对完整角色资料及保存的装备和宝宝报价",
    extracted_facts: [],
  });
  const attempt = store.begin(task, "seed");
  const result = validateValuation(raw, task.document, task.record, profile, equipment, pets);
  store.finish(task, attempt, "seed", { state: "completed", raw, result });
  store.setRun(id, "completed", null, "seed");
  store.release("seed");
  const changedConditions = configured(2);
  changedConditions.children = changedConditions.children
    .slice(1)
    .map((node) => ({ ...node, join: undefined }));
  const changed = createProfile(profile.template, {
    ...profile.settings,
    conditions: changedConditions,
  });
  return { crawl, store, profile, changed, taskId: task.id, raw, result };
}

it("完整装备宝宝估值仅修改条件时直接复用，逐条重算而不再调用商品AI", async () => {
  const x = fullValuationFixture();
  const analyze = vi.fn().mockRejectedValue(new Error("不得重复调用商品AI"));
  const runner = new AnalysisRunner(x.store, async () => ({
    model: "full-condition-fixture",
    analyze,
  }));
  try {
    const archived = x.crawl.db
      .prepare("SELECT result_json FROM analysis_tasks WHERE id=?")
      .get(x.taskId)!.result_json;
    expect(
      x.result.valuation?.condition_review?.results.find((item) => item.id === "C2")?.status,
    ).toBe("met");
    const id = await runner.start("codex", false, x.changed, true, "full-condition-fixture");
    await runner.settled();
    expect(x.store.run(id)).toMatchObject({ completed: 1, reused: 1, queued: 0 });
    expect(analyze).not.toHaveBeenCalled();
    const row = x.crawl.db
      .prepare("SELECT result_json,source_task_id FROM analysis_tasks WHERE run_id=?")
      .get(id)!;
    const reused = JSON.parse(String(row.result_json));
    expect(
      reused.valuation.condition_review.results.find((item: { id: string }) => item.id === "C2")
        .status,
    ).toBe("unmet");
    expect(reused.valuation.equipment_pricing).toEqual(x.result.valuation?.equipment_pricing);
    expect(reused.valuation.pet_pricing).toEqual(x.result.valuation?.pet_pricing);
    expect(row.source_task_id).toBe(x.taskId);
    expect(
      x.crawl.db.prepare("SELECT result_json FROM analysis_tasks WHERE id=?").get(x.taskId)!
        .result_json,
    ).toBe(archived);
    expect(
      x.crawl.db
        .prepare("SELECT raw_response FROM analysis_attempts WHERE task_id=?")
        .get(x.taskId)!.raw_response,
    ).toBe(x.raw);
  } finally {
    await runner.shutdown();
    x.crawl.close();
  }
});

it.each(["proof", "valuation", "equipment", "pets", "source"] as const)(
  "条件复用仍拒绝%s证据变化",
  (kind) => {
    const x = fullValuationFixture();
    try {
      if (kind === "proof")
        x.crawl.db
          .prepare("UPDATE analysis_attempts SET raw_response='invalid' WHERE task_id=?")
          .run(x.taskId);
      else if (kind === "valuation") {
        const changed = structuredClone(x.result);
        changed.valuation!.asking_price! += 1;
        x.crawl.db
          .prepare("UPDATE analysis_tasks SET result_json=? WHERE id=?")
          .run(JSON.stringify(changed), x.taskId);
      } else if (kind === "source") {
        const changed = x.crawl.detail("full-condition-reuse") as SavedRoleRecord;
        changed.listing.price = "501";
        x.crawl.observe(changed.listing);
      } else {
        const column = kind === "equipment" ? "equipment_pricing_json" : "pet_pricing_json";
        const snapshot = JSON.parse(
          String(
            x.crawl.db
              .prepare(`SELECT ${column} AS snapshot FROM analysis_tasks WHERE id=?`)
              .get(x.taskId)!.snapshot,
          ),
        );
        snapshot.searchComplete = false;
        x.crawl.db
          .prepare(`UPDATE analysis_tasks SET ${column}=? WHERE id=?`)
          .run(JSON.stringify(snapshot), x.taskId);
      }
      const next = x.store.createRun("codex", "full-condition-fixture", false, x.changed);
      expect(x.store.run(next)).toMatchObject({ reused: 0, queued: 1 });
    } finally {
      x.crawl.close();
    }
  },
);
