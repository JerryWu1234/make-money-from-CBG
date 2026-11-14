import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import {
  assertConditionsCompiled,
  normalizeConditions,
  defaultConditions,
  evaluateConditions,
  validateConditionResults,
  priceConditionLabel,
  type ConditionGroup,
  type ConditionResult,
  CONDITION_REVIEW_VERSION,
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

describe("价格条件百分比", () => {
  function percentage(comparison: "lt" | "gt", value: number) {
    const tree = defaultConditions();
    tree.children = [
      {
        id: "C1",
        text: "",
        price: {
          comparison,
          adjustment: comparison === "lt" ? "minus" : "plus",
          unit: "percent",
          value,
        },
      },
    ];
    return tree;
  }

  it.each([
    ["lt", 10, 899.99, "met", "900.00"],
    ["lt", 10, 900, "unmet", "900.00"],
    ["lt", 10, 900.01, "unmet", "900.00"],
    ["gt", 10, 1099.99, "unmet", "1100.00"],
    ["gt", 10, 1100, "unmet", "1100.00"],
    ["gt", 10, 1100.01, "met", "1100.00"],
    ["lt", 0, 999.99, "met", "1000.00"],
    ["lt", 0, 1000, "unmet", "1000.00"],
    ["gt", 0, 1000, "unmet", "1000.00"],
    ["gt", 0, 1000.01, "met", "1000.00"],
    ["lt", 2.5, 974.99, "met", "975.00"],
    ["lt", 2.5, 975, "unmet", "975.00"],
    ["gt", 2.5, 1025, "unmet", "1025.00"],
    ["gt", 2.5, 1025.01, "met", "1025.00"],
    ["lt", 100, 0.01, "unmet", "0.00"],
    ["gt", 150, 2500, "unmet", "2500.00"],
    ["gt", 150, 2500.01, "met", "2500.00"],
  ] as const)(
    "裸号1000元，%s幅度%s%%，挂牌%s => %s",
    (comparison, value, asking, status, target) => {
      const tree = normalizeConditions(percentage(comparison, value))!;
      const review = evaluateConditions(tree, [], { asking, bare: 1000 });
      expect(review.results.find((result) => result.id === "C1")).toMatchObject({ status });
      expect(review.results.find((result) => result.id === "C1")?.reason).toContain(
        `比较目标${target}元`,
      );
      expect(review.results.at(-1)?.status).toBe(status);
    },
  );

  it.each([
    ["lt", 5346.65, 10, 4811.98, "met", "4811.99"],
    ["lt", 5346.65, 10, 4811.99, "unmet", "4811.99"],
    ["gt", 5346.65, 10, 5881.32, "unmet", "5881.32"],
    ["gt", 5346.65, 10, 5881.33, "met", "5881.32"],
    ["lt", 1000, 0.00050000000001, 999.99, "unmet", "999.99"],
    ["lt", 1000, 0.0005, 999.99, "met", "1000.00"],
    ["lt", 1000, 0.00049999999999, 999.99, "met", "1000.00"],
    ["gt", 1000, 0.00049999999999, 1000.01, "met", "1000.00"],
    ["gt", 1000, 0.0005, 1000.01, "unmet", "1000.01"],
    ["gt", 1000, 0.00050000000001, 1000.01, "unmet", "1000.01"],
    ["lt", 10000000, 1e-7, 9999999.98, "met", "9999999.99"],
    ["lt", 10000000, 1e-7, 9999999.99, "unmet", "9999999.99"],
    ["gt", 10000000, 1e-7, 10000000.01, "unmet", "10000000.01"],
    ["gt", 10000000, 1e-7, 10000000.02, "met", "10000000.01"],
  ] as const)(
    "百分比十进制精确舍入 %s 裸号%s 幅度%s%% 挂牌%s => %s",
    (comparison, bare, value, asking, status, target) => {
      const tree = normalizeConditions(percentage(comparison, value))!;
      const review = evaluateConditions(tree, [], { asking, bare });
      expect(review.results.find((result) => result.id === "C1")).toMatchObject({ status });
      expect(review.results.find((result) => result.id === "C1")?.reason).toContain(
        `比较目标${target}元`,
      );
    },
  );

  it("下浮最多100%，非有限值和负数不能保存，上浮可超过100%", () => {
    expect(normalizeConditions(percentage("lt", 100))).toBeDefined();
    expect(normalizeConditions(percentage("gt", 150))).toBeDefined();
    for (const value of [100.01, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => normalizeConditions(percentage("lt", value))).toThrow("价格条件数值无效");
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => normalizeConditions(percentage("gt", value))).toThrow("价格条件数值无效");
  });

  it("切换为不限制后清除百分比并跳过比较", () => {
    const tree = defaultConditions();
    tree.children = [
      {
        id: "C1",
        text: "",
        price: { comparison: "none", adjustment: "minus", unit: "percent", value: 42 },
      },
    ];
    const normalized = normalizeConditions(tree)!;
    expect(normalized.children[0]).toMatchObject({
      price: { comparison: "none", adjustment: "none", unit: "amount", value: 0 },
    });
    expect(
      evaluateConditions(normalized, [], { asking: null, bare: null }).results.find(
        (result) => result.id === "C1",
      ),
    ).toMatchObject({ status: "met", skipped: true });
  });

  it("百分比直接说明低／高幅度，旧金额及包含边界的价格条件保留原意", () => {
    expect(
      priceConditionLabel({
        comparison: "lt",
        adjustment: "minus",
        unit: "percent",
        value: 10,
      }),
    ).toBe("挂牌价比裸号估值低10%");
    expect(
      priceConditionLabel({
        comparison: "gt",
        adjustment: "plus",
        unit: "percent",
        value: 2.5,
      }),
    ).toBe("挂牌价比裸号估值高2.5%");
    expect(
      priceConditionLabel({
        comparison: "lt",
        adjustment: "minus",
        unit: "amount",
        value: 100,
      }),
    ).toBe("挂牌价小于裸号估值减去100元");
    expect(
      priceConditionLabel({
        comparison: "gte",
        adjustment: "plus",
        unit: "percent",
        value: 10,
      }),
    ).toBe("挂牌价大于或等于裸号估值加上10%");
  });
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
    expect(() => assertConditionsCompiled(tree)).toThrow("条件尚未准备完成");
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
  it("默认价格不限制，缺少价格时也跳过比较", () => {
    const tree = defaultConditions();
    expect(tree.children[0]).toMatchObject({ price: { comparison: "none" } });
    const review = evaluateSavedConditions(tree, valuationRecord(), { asking: null, bare: null });
    expect(review.results.find((result) => result.id === "C1")).toMatchObject({
      status: "met",
      skipped: true,
    });
    expect(review.results.at(-1)?.status).toBe("met");
  });
  it.each(["and", "or"] as const)("不限制价格不参与%s运算，不会覆盖其他条件", (join) => {
    const tree = defaultConditions();
    tree.children.push({
      id: "C2",
      text: "挂牌价小于0",
      join,
      rule: rule("挂牌价小于0", predicate(false)),
    });
    expect(
      evaluateSavedConditions(tree, valuationRecord(), { asking: 500, bare: null }).results.at(-1)
        ?.status,
    ).toBe("unmet");
    tree.children[1] = { id: "C2", text: "尚未解析的其他条件", join };
    expect(
      evaluateSavedConditions(tree, valuationRecord(), { asking: 500, bare: null }).results.at(-1)
        ?.status,
    ).toBe("unknown");
  });
  it.each([
    ["eq", "none", "amount", 0, 1000.104, "met"],
    ["lt", "none", "amount", 0, 1000.1, "unmet"],
    ["gt", "none", "amount", 0, 1000.1, "unmet"],
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
      expect(normalizeConditions(tree)).toEqual(tree);
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
  it("逐条条件返回true及可核对过程，价格公式保持独立", () => {
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
    expect(valuationSchema(profile).required).toContain("condition_results");
    expect(valuationSchema(createProfile(template))).toBe(VALUATION_SCHEMA);
    const record = valuationRecord();
    const expected = calculateValuation(record, profile);
    const result = validateValuation(
      JSON.stringify({
        decision: expected.decision,
        reason: expected.reason,
        extracted_facts: [],
        condition_results: [
          {
            id: "C1",
            sourceText: text,
            matched: true,
            reason: "当前等级109达到100",
            observations: [
              {
                label: "人物等级",
                path: "/detail/tabs/0/fields/1/value",
                quote: "109",
                numericValue: 109,
              },
            ],
            calculation: { operation: "identity", inputs: [0], result: 109 },
            comparison: { operator: "gte", target: 100 },
          },
        ],
      }),
      buildProductDocument(record),
      record,
      profile,
      undefined,
      undefined,
      { requireConditions: true },
    );
    expect(result.valuation?.condition_review?.results.find((r) => r.id === "C1")?.status).toBe(
      "met",
    );
    expect(result.valuation?.bare_role_value).toBe(expected.bare_role_value);
    expect(result.valuation?.condition_review?.engineVersion).toBe(CONDITION_REVIEW_VERSION);
  });
});
