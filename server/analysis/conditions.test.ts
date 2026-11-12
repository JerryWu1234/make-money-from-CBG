import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { normalizeConditions, validateConditionResults, type ConditionGroup } from "./conditions";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { calculateValuation } from "./valuation-calculator";
import { buildProductDocument } from "./product-document";
import { validateValuation, valuationSchema, VALUATION_SCHEMA } from "./valuation-contract";

const tree: ConditionGroup = {
  id: "G1",
  operator: "and",
  children: [
    { id: "C1", text: "等级175" },
    { id: "G2", operator: "or", children: [{ id: "C2", text: "化生寺" }] },
  ],
};
const results = ["G1", "C1", "G2", "C2"].map((id) => ({
  id,
  status: "unknown",
  reason: "缺少依据",
}));
// Failure cases: malformed/empty/deep/oversized groups, duplicate IDs, empty text,
// missing/extra/duplicate response IDs, invalid statuses/reasons, and stale-condition reuse.
describe("补充分析条件", () => {
  it("接受分组，拒绝空条件、空组、重复编号与超出深度", () => {
    expect(normalizeConditions(tree)).toEqual(tree);
    for (const value of [
      { ...tree, children: [] },
      { ...tree, children: [{ id: "C1", text: " " }] },
      { ...tree, children: [tree] },
    ])
      expect(() => normalizeConditions(value)).toThrow();
    let deep = tree;
    for (let i = 3; i < 8; i++) deep = { id: `G${i}`, operator: "or", children: [deep] };
    expect(() => normalizeConditions(deep)).toThrow();
  });
  it("要求每个条件和组都有唯一、有效且有依据的结果", () => {
    expect(validateConditionResults(results, tree)?.tree).toEqual(tree);
    for (const raw of [
      results.slice(1),
      [...results, results[0]],
      results.map(() => results[0]),
      results.map((r) => ({ ...r, status: "yes" })),
      results.map((r) => ({ ...r, reason: "" })),
    ])
      expect(() => validateConditionResults(raw, tree)).toThrow();
  });
  it("条件改变配置哈希，保留原价格结论并存入条件快照", () => {
    const template = readFileSync(PROMPT_FILE, "utf8");
    const base = createProfile(template, DEFAULT_SETTINGS);
    const profile = createProfile(template, { ...DEFAULT_SETTINGS, conditions: tree });
    expect(profile.hash).not.toBe(base.hash);
    expect(valuationSchema(base)).toBe(VALUATION_SCHEMA);
    expect(valuationSchema(profile).required).toContain("condition_results");
    const record = valuationRecord();
    const expected = calculateValuation(record, profile);
    const raw = {
      decision: expected.decision,
      reason: expected.reason,
      extracted_facts: [],
      condition_results: results,
    };
    const result = validateValuation(
      JSON.stringify(raw),
      buildProductDocument(record),
      record,
      profile,
    );
    expect(result.valuation?.condition_review).toEqual({ tree, results });
    expect(result.valuation?.bare_role_value).toBe(expected.bare_role_value);
    expect(() =>
      validateValuation(
        JSON.stringify({ ...raw, condition_results: [] }),
        buildProductDocument(record),
        record,
        profile,
      ),
    ).toThrow();
  });
});
