import { describe, expect, it } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import {
  DIRECT_CONDITION_RESULTS_SCHEMA,
  DIRECT_CONDITION_VERSION,
  directConditionNodes,
  directConditionPrompt,
  evaluateDirectConditions,
  hasCurrentDirectReview,
  validateDirectConditionResults,
  type DirectConditionOutput,
} from "./direct-condition-review";
import {
  defaultConditions,
  type Condition,
  type ConditionGroup,
  type ConditionPrices,
} from "./conditions";

const prices: ConditionPrices = { asking: 999, bare: 1024.5 };
function fixture() {
  const record = valuationRecord();
  record.listing.price = "999";
  record.detail!.tabs[0].fields = [];
  record.detail!.tabs[0].tables = [
    [
      ["攻击修炼：", "12/20"],
      ["法术修炼：", "0/20"],
      ["防御修炼：", "7/20"],
      ["抗法修炼：", "7/20"],
      ["猎术修炼：", "15"],
      ["攻击控制力：", "20"],
    ],
  ];
  record.detail!.tabs[0].text = "攻击修炼：12/20\n法术修炼：0/20\n防御修炼：7/20\n抗法修炼：7/20";
  record.detail!.raw = { html: "UNNEEDED_HTML_MARKER" };
  record.detail!.tabs.push({
    name: "道具/法宝",
    text: "已采集完整装备",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [7, 5, 6, 4, 4, 4].map((grade, index) => ({
      index,
      name: "人物装备" + index,
      kind: "equipment" as const,
      category: "人物装备",
      description: "锻炼等级 " + grade,
    })),
  });
  return record;
}
function tree(...texts: string[]): ConditionGroup {
  return {
    id: "G1",
    operator: "and",
    evaluation: "sequence",
    children: texts.map((text, index) => ({
      id: `C${index + 1}`,
      text,
      ...(index ? { join: "and" as const } : {}),
    })),
  };
}
function training(target = 27): DirectConditionOutput {
  return {
    id: "C1",
    sourceText: `角色修为大于等于${target}`,
    matched: 26 >= target,
    reason: "四项当前等级合计26，不含上限、猎术和宠修。",
    observations: ["攻击修炼", "法术修炼", "防御修炼", "抗法修炼"].map((label, index) => ({
      label,
      path: `/detail/tabs/0/tables/0/${index}/1`,
      quote: ["12/20", "0/20", "7/20", "7/20"][index],
      numericValue: [12, 0, 7, 7][index],
    })),
    calculation: { operation: "sum", inputs: [0, 1, 2, 3], result: 26 },
    comparison: { operator: "gte", target },
  };
}
function proof(sourceText = "人物等级至少100"): DirectConditionOutput {
  return {
    id: "C1",
    sourceText,
    matched: true,
    reason: "有明确的已采集人物名称。",
    observations: [
      { label: "名称", path: "/listing/name", quote: fixture().listing.name, numericValue: null },
    ],
    calculation: null,
    comparison: null,
  };
}
const copy = <T>(input: T): T => structuredClone(input);

describe("逐商品逐条条件输入与协议", () => {
  it("保持原文和源路径，提供全部语义资料而不限定字段目录", () => {
    const conditions = tree("总宝石数量大于等于20", "角色修为大于等于27");
    conditions.children.unshift(defaultConditions().children[0]);
    conditions.children[0].id = "C0";
    const prompt = directConditionPrompt(conditions, fixture(), prices);
    expect(directConditionNodes(conditions).map((node) => node.text)).toEqual([
      "总宝石数量大于等于20",
      "角色修为大于等于27",
    ]);
    expect(prompt).toContain("没有预定义字段目录限制");
    expect(prompt).toContain("12/20取12，0/25取0");
    expect(prompt).toContain("不含灵饰精炼等级／星辉石");
    expect(prompt).toContain('"tables":[[["攻击修炼：","12/20"]');
    expect(prompt).not.toContain("UNNEEDED_HTML_MARKER");
    expect(prompt).toContain("sourceText（与输入原文完全一致）");
    expect(directConditionPrompt(defaultConditions(), fixture(), prices)).toBe("");
    expect(DIRECT_CONDITION_RESULTS_SCHEMA.items.required).toContain("sourceText");
  });

  it.each([21, 27])("四项当前修炼合计26，与阈值%d比较而非读取上限", (target) => {
    const output = training(target);
    const review = validateDirectConditionResults(
      [output],
      tree(output.sourceText),
      fixture(),
      prices,
    );
    expect(review.engineVersion).toBe(DIRECT_CONDITION_VERSION);
    expect(review.results[0]).toMatchObject({
      sourceText: output.sourceText,
      matched: target === 21,
      status: target === 21 ? "met" : "unmet",
    });
    expect(review.results[0].reason).toContain("12＋0＋7＋7＝26");
    expect(review.results[0].reason).toContain(`26 ≥ ${target}`);
    expect(review.results[0].evidence?.[1]).toMatchObject({
      value: "0/20",
      path: "/detail/tabs/0/tables/0/1/1",
    });
    expect(hasCurrentDirectReview(tree(output.sourceText), fixture(), prices, review)).toBe(true);
  });

  it("宝石段数合计30直接用逐件原文，不需要宝石数量预定义字段", () => {
    const record = fixture(),
      index = record.detail!.tabs.length - 1;
    const output: DirectConditionOutput = {
      id: "C1",
      sourceText: "总宝石数量大于等于20",
      matched: true,
      reason: "人物装备宝石段数合计30。",
      observations: [7, 5, 6, 4, 4, 4].map((grade, item) => ({
        label: "人物装备" + item,
        path: `/detail/tabs/${index}/items/${item}/description`,
        quote: "锻炼等级 " + grade,
        numericValue: grade,
      })),
      calculation: { operation: "sum", inputs: [0, 1, 2, 3, 4, 5], result: 30 },
      comparison: { operator: "gte", target: 20 },
    };
    const review = validateDirectConditionResults(
      { condition_results: [output] },
      tree(output.sourceText),
      record,
      prices,
    );
    expect(review.results[0]).toMatchObject({ matched: true, status: "met" });
    expect(review.results[0].reason).toContain("7＋5＋6＋4＋4＋4＝30");
  });

  it("计数使用不同原文路径，非数值证据可参与计数", () => {
    const record = fixture();
    const output = proof("装备数量大于8");
    const ti = record.detail!.tabs.length - 1;
    output.observations = [0, 1, 2].map((index) => ({
      label: "人物装备",
      path: `/detail/tabs/${ti}/items/${index}/name`,
      quote: "人物装备" + index,
      numericValue: null,
    }));
    output.calculation = { operation: "count", inputs: [0, 1, 2], result: 3 };
    output.comparison = { operator: "gt", target: 8 };
    output.matched = false;
    expect(
      validateDirectConditionResults([output], tree(output.sourceText), record, prices).results[0]
        .reason,
    ).toContain("3 > 8，不满足");
    output.matched = true;
    expect(() =>
      validateDirectConditionResults([output], tree(output.sourceText), record, prices),
    ).toThrow("矛盾");
  });

  it("无法判断是独立null，不伪装成false且可缓存", () => {
    const output: DirectConditionOutput = {
      id: "C1",
      sourceText: "缺少的属性至少10",
      matched: null,
      reason: "未采集这项属性。",
      observations: [],
      calculation: null,
      comparison: null,
    };
    const conditions = tree(output.sourceText),
      record = fixture();
    const review = validateDirectConditionResults([output], conditions, record, prices);
    expect(review.results[0]).toMatchObject({ matched: null, status: "unknown" });
    expect(hasCurrentDirectReview(conditions, record, prices, review)).toBe(true);
    expect(
      evaluateDirectConditions(conditions, record, prices, review).results[0].matched,
    ).toBeNull();
  });

  it("文字价格条件可引用本轮程序提供的裸号估值，价格变化后失效", () => {
    const output = proof("裸号估值大于等于1000");
    output.observations = [
      { label: "裸号估值", path: "/prices/bare", quote: "1024.5", numericValue: 1024.5 },
    ];
    output.calculation = { operation: "identity", inputs: [0], result: 1024.5 };
    output.comparison = { operator: "gte", target: 1000 };
    const conditions = tree(output.sourceText),
      record = fixture();
    const review = validateDirectConditionResults([output], conditions, record, prices);
    expect(review.results[0]).toMatchObject({ matched: true, status: "met" });
    expect(hasCurrentDirectReview(conditions, record, prices, review)).toBe(true);
    expect(hasCurrentDirectReview(conditions, record, { ...prices, bare: 999 }, review)).toBe(
      false,
    );
    expect(
      evaluateDirectConditions(conditions, record, { ...prices, bare: 999 }, review).results[0]
        .matched,
    ).toBeNull();
    expect(() =>
      validateDirectConditionResults([output], conditions, record, { ...prices, bare: null }),
    ).toThrow("尚未有效计算");
    output.observations[0] = {
      label: "挂牌价",
      path: "/prices/asking",
      quote: "999",
      numericValue: 999,
    };
    output.calculation = { operation: "identity", inputs: [0], result: 999 };
    output.comparison = { operator: "lt", target: 1000 };
    expect(
      validateDirectConditionResults([output], conditions, record, prices).results[0].matched,
    ).toBe(true);
  });

  it.each([
    ["sum", [0, 1], 12],
    ["min", [0, 1], 0],
    ["max", [0, 1], 12],
    ["identity", [1], 0],
  ] as const)("复核%s，保留原文里的0", (operation, inputs, result) => {
    const output = training(0);
    output.calculation = { operation, inputs: [...inputs], result };
    expect(
      validateDirectConditionResults([output], tree(output.sourceText), fixture(), prices)
        .results[0].matched,
    ).toBe(true);
  });

  it("严格的比较方向和等值边界逐一核对", () => {
    const output = training(26);
    for (const [operator, matched] of [
      ["eq", true],
      ["ne", false],
      ["gt", false],
      ["gte", true],
      ["lt", false],
      ["lte", true],
    ] as const) {
      output.comparison = { operator, target: 26 };
      output.matched = matched;
      expect(
        validateDirectConditionResults([output], tree(output.sourceText), fixture(), prices)
          .results[0].matched,
      ).toBe(matched);
    }
  });

  it("原始数值和转义路径也能引用，不能读取原型属性", () => {
    const record = fixture();
    record.listing.attrs["测试/属性~"] = "0";
    const output = proof("测试属性等于0");
    output.observations = [
      { label: "测试属性", path: "/listing/attrs/测试~1属性~0", quote: "0", numericValue: 0 },
    ];
    output.calculation = { operation: "identity", inputs: [0], result: 0 };
    output.comparison = { operator: "eq", target: 0 };
    expect(
      validateDirectConditionResults([output], tree(output.sourceText), record, prices).results[0]
        .matched,
    ).toBe(true);
    output.observations[0].path = "/listing/constructor";
    expect(() =>
      validateDirectConditionResults([output], tree(output.sourceText), record, prices),
    ).toThrow("路径不存在");
  });
});

describe("逐条条件结果校验及失效", () => {
  it.each([
    ["缺项", () => []],
    ["重复编号", (item: DirectConditionOutput) => [item, copy(item)]],
    ["新编号", (item: DirectConditionOutput) => [{ ...item, id: "C9" }]],
    ["原文变更", (item: DirectConditionOutput) => [{ ...item, sourceText: "角色修为大于等于21" }]],
    ["旧状态", (item: DirectConditionOutput) => [{ ...item, matched: "met" }]],
    ["额外状态", (item: DirectConditionOutput) => [{ ...item, status: "met" }]],
    [
      "假路径",
      (item: DirectConditionOutput) => {
        item.observations[0].path = "/detail/not-real";
        return [item];
      },
    ],
    [
      "假原文",
      (item: DirectConditionOutput) => {
        item.observations[0].quote = "25/25";
        return [item];
      },
    ],
    [
      "假数值",
      (item: DirectConditionOutput) => {
        item.observations[0].numericValue = 25;
        return [item];
      },
    ],
    [
      "假合计",
      (item: DirectConditionOutput) => {
        item.calculation!.result = 99;
        return [item];
      },
    ],
    [
      "越界索引",
      (item: DirectConditionOutput) => {
        item.calculation!.inputs = [8];
        return [item];
      },
    ],
    [
      "重复计算",
      (item: DirectConditionOutput) => {
        item.calculation!.inputs = [0, 0];
        return [item];
      },
    ],
    [
      "空最值",
      (item: DirectConditionOutput) => {
        item.calculation = { operation: "min", inputs: [], result: 0 };
        return [item];
      },
    ],
    [
      "半个计算",
      (item: DirectConditionOutput) => {
        item.comparison = null;
        return [item];
      },
    ],
    ["布尔矛盾", (item: DirectConditionOutput) => [{ ...item, matched: true }]],
    ["已知又未知", (item: DirectConditionOutput) => [{ ...item, matched: null }]],
  ] as const)("拒绝%s而非采用AI给出的状态", (_label, mutate) => {
    expect(() =>
      validateDirectConditionResults(
        mutate(training()),
        tree(training().sourceText),
        fixture(),
        prices,
      ),
    ).toThrow();
  });

  it("确定结果不能没有原文依据", () => {
    const output = proof();
    output.observations = [];
    expect(() =>
      validateDirectConditionResults([output], tree(output.sourceText), fixture(), prices),
    ).toThrow("必须引用");
  });

  it("count不会将同一路径计数两次", () => {
    const output = training(2);
    output.observations = [copy(output.observations[0]), copy(output.observations[0])];
    output.calculation = { operation: "count", inputs: [0, 1], result: 2 };
    expect(() =>
      validateDirectConditionResults([output], tree(output.sourceText), fixture(), prices),
    ).toThrow("计算结果");
  });

  it("只改且／或可复用已核验逐条结果，按列表顺序重新合并", () => {
    const conditions = tree("角色修为大于等于21", "角色修为大于等于27", "角色修为大于等于27");
    const outputs = [training(21), { ...training(), id: "C2" }, { ...training(), id: "C3" }];
    const record = fixture(),
      review = validateDirectConditionResults(outputs, conditions, record, prices);
    expect(review.results.at(-1)?.status).toBe("unmet");
    expect(review.results.at(-1)?.matched).toBe(false);
    (conditions.children[1] as Condition).join = "or";
    (conditions.children[2] as Condition).join = "and";
    expect(hasCurrentDirectReview(conditions, record, prices, review)).toBe(true);
    expect(
      evaluateDirectConditions(conditions, record, prices, review).results.at(-1)?.status,
    ).toBe("unmet");
    (conditions.children[2] as Condition).join = "or";
    expect(
      evaluateDirectConditions(conditions, record, prices, review).results.at(-1)?.status,
    ).toBe("met");
    expect(
      evaluateDirectConditions(conditions, record, prices, review).results.at(-1)?.matched,
    ).toBe(true);
  });

  it("价格控件始终本地计算，不限制不通过或绕过其他条件", () => {
    const conditions = defaultConditions();
    conditions.children.push({ id: "C2", text: training().sourceText, join: "or" });
    const output = { ...training(), id: "C2" };
    const review = validateDirectConditionResults([output], conditions, fixture(), prices);
    expect(review.results.at(-1)?.status).toBe("unmet");
    expect(review.results[0].matched).toBe(true);
    expect(review.results.at(-1)?.matched).toBe(false);
    expect(hasCurrentDirectReview(defaultConditions(), fixture(), prices)).toBe(true);
  });

  it.each(["来源", "裸号估值", "挂牌价", "原文", "引擎", "引用", "布尔状态", "缺失协议"])(
    "%s改变后不能使用旧true/false",
    (kind) => {
      const record = fixture(),
        conditions = tree(training().sourceText),
        currentPrices = { ...prices };
      const review = validateDirectConditionResults([training()], conditions, record, prices);
      if (kind === "来源") record.detail!.tabs[0].tables[0][0][1] = "25/25";
      if (kind === "裸号估值") currentPrices.bare = 2000;
      if (kind === "挂牌价") currentPrices.asking = 1000;
      if (kind === "原文") (conditions.children[0] as Condition).text = "角色修为大于等于21";
      if (kind === "引擎") review.engineVersion = "condition-rules-v1";
      if (kind === "引用") review.results[0].observations![0].quote = "25/25";
      if (kind === "布尔状态") review.results[0].status = "met";
      if (kind === "缺失协议") delete review.results[0].matched;
      expect(hasCurrentDirectReview(conditions, record, currentPrices, review)).toBe(false);
      expect(
        evaluateDirectConditions(conditions, record, currentPrices, review).results[0],
      ).toMatchObject({ status: "unknown", matched: null });
    },
  );
});
