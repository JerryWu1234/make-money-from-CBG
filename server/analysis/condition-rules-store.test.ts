import { expect, it } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { createProfile, DEFAULT_SETTINGS } from "./profile";
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
