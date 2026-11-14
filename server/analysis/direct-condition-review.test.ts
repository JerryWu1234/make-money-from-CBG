import { describe, expect, it } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import {
  DIRECT_CONDITION_RESULTS_SCHEMA,
  DIRECT_CONDITION_VERSION,
  directConditionNodes,
  directConditionPrompt,
  directConditionSources,
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
function proof(sourceText = "人物名称已采集"): DirectConditionOutput {
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
    expect(prompt).toContain(
      JSON.stringify({ path: "/detail/tabs/0/tables/0/0/1", value: "12/20" }),
    );
    expect(prompt).not.toContain("UNNEEDED_HTML_MARKER");
    expect(prompt).toContain("sourceText（与输入原文完全一致）");
    expect(prompt).toContain("每条独立判断，不能把其他条件或整组的false传播到本条");
    expect(directConditionPrompt(defaultConditions(), fixture(), prices)).toBe("");
    expect(DIRECT_CONDITION_RESULTS_SCHEMA.items.required).toContain("sourceText");
  });

  it("动态列出真实路径，保留转义键、数组索引、原始值及空容器", () => {
    const record = fixture();
    record.listing.attrs = {};
    record.listing.summary = {
      "扩展/记录~名": { entries: ["第一项", "", null, false, 0, [], {}] },
      rawOnly: { raw: "DUPLICATE_RAW_ONLY_MARKER" },
      absent: undefined,
    };
    const sources = directConditionSources(record, prices);
    expect(sources).toContainEqual({ path: "/listing/attrs", value: {} });
    expect(sources).toContainEqual({ path: "/detail/tabs/0/fields", value: [] });
    expect(sources).toContainEqual({ path: "/detail/tabs/0/tables/0/1/1", value: "0/20" });
    for (const [index, value] of ["第一项", "", null, false, 0, [], {}].entries())
      expect(sources).toContainEqual({
        path: `/listing/summary/扩展~1记录~0名/entries/${index}`,
        value,
      });
    expect(sources).toContainEqual({ path: "/prices/asking", value: 999 });
    expect(sources).toContainEqual({ path: "/prices/bare", value: 1024.5 });
    expect(sources.some((entry) => entry.path.startsWith("/listing/tabs"))).toBe(false);
    expect(sources.some((entry) => entry.path.startsWith("/listing/summary/rawOnly"))).toBe(false);
    expect(sources.some((entry) => entry.path.endsWith("/absent"))).toBe(false);
    expect(JSON.stringify(sources)).not.toContain("DUPLICATE_RAW_ONLY_MARKER");
    expect(JSON.stringify(sources)).not.toContain("UNNEEDED_HTML_MARKER");
    const prompt = directConditionPrompt(tree("角色修为大于等于27"), record, prices);
    expect(prompt).toContain(JSON.stringify(sources));
    expect(prompt).toContain("path必须逐字复制下方证据清单中的path");
    expect(prompt).toContain("不要引用清单条目的/path或/value");
  });

  it("完整提供穿戴及背包装备证据，不按六个穿戴槽截断或依赖category存在", () => {
    const record = fixture();
    const tabIndex = record.detail!.tabs.length - 1;
    record.detail!.tabs[tabIndex].items!.push(
      ...Array.from({ length: 200 }, (_, index) => ({
        index: 1000 + index,
        name: "背包装备" + index,
        location: "store_equip_tips" + index,
        description: "等级 100\n锻炼等级 11",
        attributes: { 装备角色: "人物" },
        officialModel: { modelId: String(index), description: "装备角色 人物" },
      })),
    );
    const sources = directConditionSources(record, prices);
    expect(sources).toContainEqual({
      path: `/detail/tabs/${tabIndex}/items/205/description`,
      value: "等级 100\n锻炼等级 11",
    });
    expect(sources).toContainEqual({
      path: `/detail/tabs/${tabIndex}/items/205/attributes/装备角色`,
      value: "人物",
    });
    expect(sources).toContainEqual({
      path: `/detail/tabs/${tabIndex}/items/205/location`,
      value: "store_equip_tips199",
    });
    const prompt = directConditionPrompt(tree("总宝石数量大于等于20"), record, prices);
    expect(prompt).toContain("穿戴、背包及已采集仓库");
    expect(prompt).toContain("不能只取六个穿戴槽");
    expect(prompt).toContain("category缺失不等于不存在");
    expect(prompt).toContain(JSON.stringify(sources));
  });

  it("合计要求逐项核算，保留四项当前等级而不取摘要或上限", () => {
    const record = fixture();
    record.listing.summary = { xiulian: 80 };
    const prompt = directConditionPrompt(tree("角色修为大于等于27"), record, prices);
    expect(prompt).toContain("有逐项明细时必须列出各组成项并重新求和");
    expect(prompt).toContain("分别引用攻击、法术、防御、抗法四项当前等级");
    expect(prompt).toContain("不要以摘要xiulian或斜杠后的上限代替四项明细");
    expect(prompt).toContain(
      JSON.stringify({ path: "/detail/tabs/0/tables/0/0/1", value: "12/20" }),
    );
    expect(prompt).toContain(JSON.stringify({ path: "/listing/summary/xiulian", value: 80 }));
  });

  it.each([
    [5, true],
    [20, null],
  ] as const)("非负合计缺数值时保留已知下界，阈值%d的结果为%s", (target, matched) => {
    const record = fixture(),
      ti = record.detail!.tabs.length - 1;
    record.detail!.tabs[ti].items = record.detail!.tabs[ti].items!.slice(0, 2);
    record.detail!.tabs[ti].items![1].description = "等级 100\n未采集宝石明细";
    const sourceText = `总宝石数量大于等于${target}`;
    const output: DirectConditionOutput = {
      id: "C1",
      sourceText,
      matched,
      reason: "已知至少7，另1项缺少数值，不能将已知下界当作准确总数。",
      observations: [
        {
          label: "已知宝石段数",
          path: `/detail/tabs/${ti}/items/0/description`,
          quote: "锻炼等级 7",
          numericValue: 7,
        },
        {
          label: "缺少宝石段数的装备",
          path: `/detail/tabs/${ti}/items/1/description`,
          quote: "等级 100\n未采集宝石明细",
          numericValue: null,
        },
      ],
      calculation: null,
      comparison: null,
    };
    const review = validateDirectConditionResults([output], tree(sourceText), record, prices);
    expect(review.results[0]).toMatchObject({ matched, calculation: null, comparison: null });
    expect(review.results[0].reason).toContain("已知至少7，另1项缺少数值");
    const prompt = directConditionPrompt(tree(sourceText), record, prices);
    expect(prompt).toContain("没有锻炼等级字段不是0");
    expect(prompt).toContain("若已知下界不能确定结论，返回matched=null");
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
    const corrected = validateDirectConditionResults(
      [output],
      tree(output.sourceText),
      record,
      prices,
    );
    expect(corrected.results[0]).toMatchObject({
      matched: false,
      modelMatched: true,
      status: "unmet",
    });
    expect(corrected.results[0].reason).toContain("模型原判断true，已按算式校正");
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
    output.sourceText = "挂牌价小于1000";
    expect(
      validateDirectConditionResults([output], tree(output.sourceText), record, prices).results[0]
        .matched,
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
      output.sourceText = `角色修为${
        {
          eq: "等于",
          ne: "不等于",
          gt: "大于",
          gte: "大于等于",
          lt: "小于",
          lte: "小于等于",
        }[operator]
      }26`;
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
  it("简单明确数值条件不能省略计算或将27换成21", () => {
    const output = training();
    output.matched = true;
    output.calculation = null;
    output.comparison = null;
    expect(() =>
      validateDirectConditionResults([output], tree(output.sourceText), fixture(), prices),
    ).toThrow("必须提供计算");
    const wrongTarget = training();
    wrongTarget.matched = true;
    wrongTarget.comparison!.target = 21;
    expect(() =>
      validateDirectConditionResults(
        [wrongTarget],
        tree(wrongTarget.sourceText),
        fixture(),
        prices,
      ),
    ).toThrow("与原文不一致");
    const wrongDirection = training();
    wrongDirection.matched = true;
    wrongDirection.comparison!.operator = "lt";
    expect(() =>
      validateDirectConditionResults(
        [wrongDirection],
        tree(wrongDirection.sourceText),
        fixture(),
        prices,
      ),
    ).toThrow("与原文不一致");
  });

  it.each([
    "人物等级大于100且人物速度大于800",
    "人物门派为化生寺且人物等级大于100",
    "挂牌价低于裸号估值10%",
    "人物名称为测试角色",
  ])("复杂或文本条件保留逐条事实判断：%s", (sourceText) => {
    const output = proof(sourceText);
    expect(
      validateDirectConditionResults([output], tree(sourceText), fixture(), prices).results[0]
        .matched,
    ).toBe(true);
  });

  it.each(["不能", "非", "未", "无", "否", "没", "勿", "别"])(
    "未解析否定前缀%s不能触发原文比较绑定或布尔自动校正",
    (prefix) => {
      const record = fixture();
      record.detail!.tabs[0].tables[0][0][1] = "14/20";
      record.detail!.tabs[0].text = record.detail!.tabs[0].text.replace("12/20", "14/20");
      const output = training(27);
      output.sourceText = `角色修为${prefix}低于27`;
      output.observations[0].quote = "14/20";
      output.observations[0].numericValue = 14;
      output.calculation!.result = 28;
      output.matched = true;
      const result = validateDirectConditionResults(
        [output],
        tree(output.sourceText),
        record,
        prices,
      ).results[0];
      expect(result).toMatchObject({ matched: true, status: "met" });
      expect(result.modelMatched).toBeUndefined();
      output.matched = false;
      expect(() =>
        validateDirectConditionResults([output], tree(output.sourceText), record, prices),
      ).toThrow("矛盾");
    },
  );

  it("已识别的不低于仍绑定原文方向，不能将其当作低于", () => {
    const output = training(27);
    output.sourceText = "角色修为不低于27";
    output.comparison!.operator = "lt";
    output.matched = true;
    expect(() =>
      validateDirectConditionResults([output], tree(output.sourceText), fixture(), prices),
    ).toThrow("与原文不一致");
  });

  it("无充分非负下界的简单比较不能伪装成不完整资料而跳过计算", () => {
    const record = fixture(),
      ti = record.detail!.tabs.length - 1;
    const output = proof("总宝石数量大于等于20");
    output.reason = "已知至少7，另1项缺少数值";
    output.observations.push({
      label: "已知段数",
      path: `/detail/tabs/${ti}/items/0/description`,
      quote: "锻炼等级 7",
      numericValue: 7,
    });
    expect(() =>
      validateDirectConditionResults([output], tree(output.sourceText), record, prices),
    ).toThrow("必须提供计算");
    output.sourceText = "总宝石数量小于20";
    expect(() =>
      validateDirectConditionResults([output], tree(output.sourceText), record, prices),
    ).toThrow("必须提供计算");
  });

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

  it("原文数值比较的布尔值按已核验算式校正，保留原判断及缓存审计说明", () => {
    const output = training(21);
    output.matched = false;
    const record = fixture(),
      conditions = tree(output.sourceText);
    const review = validateDirectConditionResults([output], conditions, record, prices);
    expect(review.results[0]).toMatchObject({ matched: true, modelMatched: false, status: "met" });
    expect(review.results[0].reason).toContain("26 ≥ 21，满足");
    expect(review.results[0].reason).toContain("模型原判断false，已按算式校正");
    expect(review.results.at(-1)?.matched).toBe(true);
    expect(hasCurrentDirectReview(conditions, record, prices, review)).toBe(true);
    const cached = evaluateDirectConditions(conditions, record, prices, review);
    expect(cached.results[0]).toMatchObject({ matched: true, modelMatched: false, status: "met" });
    expect(cached.results[0].reason).toBe(review.results[0].reason);
  });

  it("没有单一原文数值比较的复合条件及null结果不自动校正", () => {
    const compound = training(21);
    compound.sourceText = "角色修为至少21且其他条件完整";
    compound.matched = false;
    expect(() =>
      validateDirectConditionResults([compound], tree(compound.sourceText), fixture(), prices),
    ).toThrow("矛盾");
    const unknown = training(21);
    unknown.matched = null;
    expect(() =>
      validateDirectConditionResults([unknown], tree(unknown.sourceText), fixture(), prices),
    ).toThrow("矛盾");
  });

  it("即使布尔值可校正，错误原文、假引用和错误算式仍被拒绝", () => {
    const output = training(21);
    output.matched = false;
    output.comparison!.target = 27;
    expect(() =>
      validateDirectConditionResults([output], tree(output.sourceText), fixture(), prices),
    ).toThrow("与原文不一致");
    const badQuote = training(21);
    badQuote.matched = false;
    badQuote.observations[0].quote = "11/20";
    expect(() =>
      validateDirectConditionResults([badQuote], tree(badQuote.sourceText), fixture(), prices),
    ).toThrow("引用与原始资料不一致");
    const badMath = training(21);
    badMath.matched = false;
    badMath.calculation!.result = 25;
    expect(() =>
      validateDirectConditionResults([badMath], tree(badMath.sourceText), fixture(), prices),
    ).toThrow("计算结果与观察值不一致");
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
