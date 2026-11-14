import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  assertConditionsCompiled,
  normalizeConditions,
  defaultConditions,
  evaluateConditions,
  validateConditionResults,
  type ConditionGroup,
  type ConditionResult,
} from "./conditions";
import {
  RULE_ENGINE_VERSION,
  describeRule,
  type RuleExpression,
  type CompiledConditionRule,
} from "./condition-rule-types";
import { evaluateSavedConditions } from "./condition-evaluation";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { calculateValuation } from "./valuation-calculator";
import { buildProductDocument } from "./product-document";
import { validateValuation, valuationSchema, VALUATION_SCHEMA } from "./valuation-contract";

const rule = (text: string, expression: RuleExpression): CompiledConditionRule => ({
  version: RULE_ENGINE_VERSION,
  sourceText: text,
  status: "ready" as const,
  expression,
  explanation: describeRule(expression),
  issues: [],
});
const predicate = (value: boolean): RuleExpression => ({
  op: value ? "gt" : "lt",
  args: [
    { op: "field", path: "listing.price" },
    { op: "literal", value: 0 },
  ],
});
const list = (values: (boolean | null)[], joins: ("and" | "or")[] = []): ConditionGroup => ({
  id: "G1",
  operator: "and",
  evaluation: "sequence",
  children: values.map((value, index) => ({
    id: `C${index + 1}`,
    text: `测试条件${index + 1}`,
    ...(index ? { join: joins[index - 1] || "and" } : {}),
    ...(value === null ? {} : { rule: rule(`测试条件${index + 1}`, predicate(value)) }),
  })),
});

describe("自由文字条件编译与本地执行", () => {
  it("旧条件仍可读取，未解析条件不可依靠AI满足入榜", () => {
    const tree: ConditionGroup = {
      id: "G1",
      operator: "and",
      children: [{ id: "C1", text: "数量大于8" }],
    };
    expect(normalizeConditions(tree)).toEqual(tree);
    expect(() => assertConditionsCompiled(tree)).toThrow("先解析");
    expect(
      validateConditionResults(
        [{ id: "C1", status: "met", reason: "实际只有3件" }],
        tree,
      )?.results.at(-1)?.status,
    ).toBe("unknown");
    expect(validateConditionResults({ malicious: "met" }, tree)?.results.at(-1)?.status).toBe(
      "unknown",
    );
  });
  it("拒绝空文字、重复id、空列表、嵌套列表和缺失连接关系", () => {
    const root = list([true, false]);
    for (const value of [
      { ...root, children: [] },
      { ...root, children: [{ id: "C1", text: " " }] },
      { ...root, children: [root] },
      { ...root, children: [root.children[0], root.children[0]] },
      { ...root, children: [root.children[0], { id: "C2", text: "另一条" }] },
    ])
      expect(() => normalizeConditions(value)).toThrow();
  });
  it("文字变化不能继续使用旧计划；未知字段和可执行代码被拒绝", () => {
    const tree = list([true]);
    expect(() =>
      normalizeConditions({ ...tree, children: [{ ...tree.children[0], text: "另一意思" }] }),
    ).toThrow();
    for (const expression of [
      { op: "eval", code: "return true" },
      { op: "field", path: "__proto__.admin" },
      { op: "literal", value: "true" },
    ])
      expect(() =>
        normalizeConditions({
          ...tree,
          children: [
            { id: "C1", text: "测试", rule: { ...rule("测试", predicate(true)), expression } },
          ],
        }),
      ).toThrow();
  });
  it.each([
    [[true, false, false], ["or", "and"], "unmet"],
    [[null, false], ["and"], "unmet"],
    [[null, true], ["or"], "met"],
    [[null, true], ["and"], "unknown"],
    [[null, false], ["or"], "unknown"],
  ] as const)("顺序和三态 %j %j => %s", (values, joins, expected) => {
    const tree = list([...values], [...joins]);
    expect(
      evaluateSavedConditions(tree, valuationRecord(), { asking: 500, bare: 600 }).results.at(-1)
        ?.status,
    ).toBe(expected);
  });
  it("不采信模型提供的文字、价格、整体状态", () => {
    const tree = list([false]);
    const evidence: ConditionResult[] = [
      { id: "C1", status: "met", reason: "不满足却说满足" },
      { id: "G1", status: "met", reason: "模型合计" },
    ];
    expect(evaluateConditions(tree, evidence).results.at(-1)?.status).toBe("unknown");
    expect(
      evaluateSavedConditions(tree, valuationRecord(), { asking: 500, bare: 600 }).results.at(-1)
        ?.status,
    ).toBe("unmet");
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
    "价格由程序按分比较 %s %s %s %s",
    (comparison, adjustment, unit, value, bare, expected) => {
      const tree = defaultConditions();
      tree.children = [{ id: "C1", text: "", price: { comparison, adjustment, unit, value } }];
      expect(
        evaluateSavedConditions(tree, valuationRecord(), { asking: 1000.1, bare }).results.at(-1)
          ?.status,
      ).toBe(expected);
      expect(
        evaluateSavedConditions(tree, valuationRecord(), { asking: 1000, bare: null }).results.at(
          -1,
        )?.status,
      ).toBe("unknown");
    },
  );
  it("估值模型无需条件结论，规则变化不改变裸号公式和价差", () => {
    const text = "人物等级至少100";
    const tree = list([true]);
    tree.children = [
      {
        id: "C1",
        text,
        rule: rule(text, {
          op: "gte",
          args: [
            { op: "field", path: "role.level" },
            { op: "literal", value: 100 },
          ],
        }),
      },
    ];
    const template = readFileSync(PROMPT_FILE, "utf8");
    const profile = createProfile(template, { ...DEFAULT_SETTINGS, conditions: tree });
    expect(valuationSchema(profile)).toBe(VALUATION_SCHEMA);
    const record = valuationRecord();
    const expected = calculateValuation(record, profile);
    const result = validateValuation(
      JSON.stringify({
        decision: expected.decision,
        reason: expected.reason,
        extracted_facts: [],
        condition_results: [{ id: "C1", status: "unmet", reason: "不可信AI" }],
      }),
      buildProductDocument(record),
      record,
      profile,
    );
    expect(result.valuation?.condition_review?.results.find((r) => r.id === "C1")?.status).toBe(
      "met",
    );
    expect(result.valuation?.bare_role_value).toBe(expected.bare_role_value);
    expect(result.valuation?.condition_review?.engineVersion).toBe(RULE_ENGINE_VERSION);
  });
});
