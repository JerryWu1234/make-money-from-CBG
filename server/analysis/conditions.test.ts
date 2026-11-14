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
    expect(() => normalizeConditions({ ...tree, children: [{ id: "C7", text: "  " }] })).toThrow(
      "C7 条件须填写",
    );
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

// Ordered mixed operators must never use normal AND precedence or AI's aggregate answer.
describe("单层入榜条件", () => {
  const list = (joins: ("and" | "or")[] = ["or", "and"]): ConditionGroup => ({
    id: "G1",
    operator: "and",
    evaluation: "sequence",
    children: ["C1", "C2", "C3"].map((id, index) => ({
      id,
      text: id,
      ...(index ? { join: joins[index - 1] } : {}),
    })),
  });
  it("按顺序计算（满足 或 不满足）且 不满足，结果为不满足", async () => {
    const { evaluateConditions } = await import("./conditions");
    const review = evaluateConditions(
      list(),
      ["met", "unmet", "unmet"].map((status, index) => ({
        id: `C${index + 1}`,
        status: status as "met" | "unmet",
        reason: "测试依据",
      })),
    );
    expect(review.results.at(-1)?.status).toBe("unmet");
  });
  it.each([
    ["unknown", "and", "unmet", "unmet"],
    ["unknown", "or", "met", "met"],
    ["unknown", "and", "met", "unknown"],
    ["unknown", "or", "unmet", "unknown"],
  ] as const)("三态计算 %s %s %s = %s", async (left, join, right, expected) => {
    const { evaluateConditions } = await import("./conditions");
    const tree = list([join]);
    tree.children.pop();
    expect(
      evaluateConditions(tree, [
        { id: "C1", status: left, reason: "左" },
        { id: "C2", status: right, reason: "右" },
      ]).results.at(-1)?.status,
    ).toBe(expected);
  });
  it("拒绝嵌套列表、遗漏连接关系、无效金额和百分比", async () => {
    const { defaultConditions } = await import("./conditions");
    expect(() => normalizeConditions({ ...list(), children: [tree] })).toThrow("不能嵌套");
    expect(() =>
      normalizeConditions({
        ...list(),
        children: [
          { id: "C1", text: "a" },
          { id: "C2", text: "b" },
        ],
      }),
    ).toThrow("选择且或");
    for (const value of [null, -1, NaN, Infinity, 101]) {
      const root = defaultConditions();
      root.children = [
        {
          id: "C1",
          text: "",
          price: { comparison: "lt", adjustment: "minus", unit: "percent", value: value as number },
        },
      ];
      expect(() => normalizeConditions(root)).toThrow("数值无效");
    }
  });
  it.each([
    ["eq", "none", "amount", 0, 1000.104, "met"],
    ["lt", "none", "amount", 0, 1000.11, "met"],
    ["gt", "none", "amount", 0, 1000.09, "met"],
    ["lte", "minus", "amount", 100, 1100.1, "met"],
    ["lt", "minus", "amount", 100, 1100.1, "unmet"],
    ["gte", "plus", "amount", 100, 900.1, "met"],
    ["lt", "minus", "percent", 10, 1200, "met"],
    ["gt", "plus", "percent", 10, 900, "met"],
  ] as const)(
    "本地价格比较 %s %s %s %s",
    async (comparison, adjustment, unit, value, bare, expected) => {
      const { defaultConditions, evaluateConditions, conditionPrompt } =
        await import("./conditions");
      const root = defaultConditions();
      root.children = [{ id: "C1", text: "", price: { comparison, adjustment, unit, value } }];
      expect(evaluateConditions(root, [], { asking: 1000.1, bare }).results.at(-1)?.status).toBe(
        expected,
      );
      expect(
        evaluateConditions(root, [], { asking: 1000, bare: null }).results.at(-1)?.status,
      ).toBe("unknown");
      expect(conditionPrompt(root)).toBe("");
    },
  );
  it("价格条件不要求AI返回结果；混合条件只收文字证据，本地计算整体结果", async () => {
    const { defaultConditions } = await import("./conditions");
    const root = defaultConditions();
    const prices = { asking: 1000, bare: 1000 };
    expect(validateConditionResults(undefined, root, prices)?.results.at(-1)?.status).toBe("met");
    root.children.push({ id: "C2", text: "速度800", join: "and" });
    expect(() => validateConditionResults(undefined, root, prices)).toThrow("缺项");
    const evidence = [{ id: "C2", status: "unmet", reason: "速度700" }];
    expect(validateConditionResults(evidence, root, prices)?.results.at(-1)?.status).toBe("unmet");
    expect(() =>
      validateConditionResults(
        [...evidence, { id: "G1", status: "met", reason: "模型自行判断" }],
        root,
        prices,
      ),
    ).toThrow();
    const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), {
      ...DEFAULT_SETTINGS,
      conditions: defaultConditions(),
    });
    expect(valuationSchema(profile)).toBe(VALUATION_SCHEMA);
    const record = valuationRecord();
    const expected = calculateValuation(record, profile);
    const result = validateValuation(
      JSON.stringify({ decision: expected.decision, reason: expected.reason, extracted_facts: [] }),
      buildProductDocument(record),
      record,
      profile,
    );
    expect(result.valuation?.condition_review?.results).toHaveLength(2);
  });
});
