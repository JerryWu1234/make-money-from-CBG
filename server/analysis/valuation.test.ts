import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vite-plus/test";
import { analysisRecord, valuationRecord as completeRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { AnalysisRunner } from "./runner";
import {
  createProfile,
  DEFAULT_SETTINGS,
  loadProfile,
  normalizeSettings,
  PROMPT_FILE,
  saveProfile,
} from "./profile";
import {
  artifactPrice,
  calculateValuation,
  compareListingPrice,
  floorPrice,
  mountPrice,
  opportunityPrice,
  purchase,
  schoolPrice,
  strengthPrice,
  trainingPrice,
} from "./valuation-calculator";
import { buildProductDocument } from "./product-document";
import { validateValuation, valuationPrompt, VALUATION_SCHEMA } from "./valuation-contract";
import { readValuationFact, validateValuationFacts } from "./valuation-facts";
const template = readFileSync(PROMPT_FILE, "utf8");
const profile = () =>
  createProfile(
    template,
    {
      ...DEFAULT_SETTINGS,
      b: 0.8,
      extraCost: 0,
      capMode: "both",
      servers: [
        {
          serverId: completeRecord().listing.serverId,
          age: "three",
          rank: 10,
          goldPrice: null,
          goldUnit: null,
        },
      ],
    },
    false,
  );
describe("裸号估值的复算与可追溯输入", () => {
  it("挂牌差额有明确方向，比例以挂牌为分母，等价与缺价格单独处理", () => {
    expect(compareListingPrice(1500, 1000)).toMatchObject({
      comparison_mode: "listing-only",
      decision: "BUY",
      price_difference: 500,
      price_difference_ratio: 0.5,
      extra_cost: null,
      total_cost: null,
      max_listing_price: null,
      ideal_listing_price: null,
      margin_of_safety: null,
    });
    expect(compareListingPrice(1000, 1000)).toMatchObject({
      decision: "WATCH",
      price_difference: 0,
      price_difference_ratio: 0,
    });
    expect(compareListingPrice(1000, 1500)).toMatchObject({
      decision: "PASS",
      price_difference: -500,
    });
    expect(compareListingPrice(1000, 1500).price_difference_ratio).toBeCloseTo(-1 / 3);
    for (const [value, asking] of [
      [null, 1000],
      [1000, null],
      [1000, 0],
      [0, 1000],
      [1000, -1],
    ])
      expect(compareListingPrice(value, asking)).toMatchObject({
        decision: "NEED_INFO",
        price_difference: null,
        price_difference_ratio: null,
      });
  });
  it("低级修炼按明示经验规则估算，飞升异常仍阻塞完整价格", () => {
    const training = completeRecord();
    for (const label of ["攻击修炼", "法术修炼"])
      training.detail!.tabs[0].fields.find((field) => field.name === label)!.value = "3/25";
    const estimatedTraining = calculateValuation(training, profile());
    expect(estimatedTraining.model_value).not.toBeNull();
    const lowItem = estimatedTraining.items.find((item) => item.name === "人物有效攻法修炼")!;
    expect(lowItem.amount).toBeCloseTo((30 * 650) / 1550, 2);
    expect(lowItem.formula).toContain("经验比例估算");
    expect(estimatedTraining.missing_fields).toEqual([]);
    const flying = completeRecord();
    flying.detail!.tabs[0].fields.find((field) => field.name === "飞升/渡劫/化圣")!.value =
      "已飞升";
    for (const skill of flying.detail!.tabs[1].items!.filter(
      (item) => item.category === "师门技能",
    ))
      skill.level = "160";
    const anomalous = calculateValuation(flying, profile());
    expect(anomalous).toMatchObject({
      decision: "NEED_INFO",
      model_value: null,
      bare_role_value: null,
      price_difference: null,
    });
    expect(anomalous.pending_rules).toContain("飞升师门技能公式出现反常溢价，需核实适用范围");
  });
  it("飞升异常检查只核对实际参与公式的最高五项，不阻塞未参与的低技能", () => {
    const record = completeRecord();
    record.detail!.tabs[0].fields.find((field) => field.name === "飞升/渡劫/化圣")!.value =
      "已飞升";
    const skills = record.detail!.tabs[1].items!.filter((item) => item.category === "师门技能");
    const setLevels = (levels: number[]) => {
      skills.forEach((skill, index) => {
        skill.level = String(levels[index]);
      });
    };
    setLevels([150, 130, 150, 139, 150, 130, 50]);
    const normal = calculateValuation(record, profile());
    expect(normal.items.find((item) => item.name === "师门技能")?.amount).toBeCloseTo(32.46);
    expect(normal.pending_rules).not.toContain("飞升师门技能公式出现反常溢价，需核实适用范围");
    expect(normal.model_value).not.toBeNull();
    expect(normal.bare_role_value).toBe(normal.model_value);
    expect(normal.decision).not.toBe("NEED_INFO");

    const participatingLow = [150, 130, 150, 139, 55, 54, 50];
    setLevels(participatingLow);
    const anomalous = calculateValuation(record, profile());
    expect(anomalous.items.find((item) => item.name === "师门技能")?.amount).toBe(
      schoolPrice(participatingLow, "已飞升", false),
    );
    expect(anomalous.pending_rules).toContain("飞升师门技能公式出现反常溢价，需核实适用范围");
    expect(anomalous).toMatchObject({
      decision: "NEED_INFO",
      model_value: null,
      bare_role_value: null,
      price_difference: null,
    });
  });
  it("飞升原公式确认仅适用于同一角色和已确认的最高五项技能", () => {
    const record = completeRecord();
    record.detail!.tabs[0].fields.find((field) => field.name === "飞升/渡劫/化圣")!.value =
      "已飞升";
    const skills = record.detail!.tabs[1].items!.filter((item) => item.category === "师门技能");
    [150, 154, 130, 130, 130, 150, 125].forEach((level, index) => {
      skills[index].level = String(level);
    });
    const configured = {
      ...profile(),
      ascendedSchoolFormulaConfirmations: { [record.listing.key]: [154, 150, 150, 130, 130] },
    };
    const actual = calculateValuation(record, configured);
    expect(actual.items.find((item) => item.name === "师门技能")?.amount).toBeCloseTo(16.36);
    expect(actual.pending_rules).toEqual([]);
    expect(actual.model_value).not.toBeNull();
    expect(actual.items.find((item) => item.name === "机缘调整")?.confirmed).toBe(true);

    const unconfirmed = "飞升师门技能公式出现反常溢价，需核实适用范围";
    expect(calculateValuation(record, profile()).pending_rules).toContain(unconfirmed);
    record.listing.key += "-another";
    expect(calculateValuation(record, configured).pending_rules).toContain(unconfirmed);
    record.listing.key = Object.keys(configured.ascendedSchoolFormulaConfirmations)[0];
    skills[1].level = "155";
    expect(calculateValuation(record, configured).pending_rules).toContain(unconfirmed);
    expect(calculateValuation(record, configured).model_value).toBeNull();
  });
  it("冻结的飞升公式确认按角色比较，其他角色确认不改变本角色规则", () => {
    const crawl = new CrawlStore(":memory:");
    const record = completeRecord();
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const store = new AnalysisStore(crawl.db);
    const confirmed = {
      ...profile(),
      ascendedSchoolFormulaConfirmations: { [record.listing.key]: [154, 150, 150, 130, 130] },
    };
    try {
      const id = store.createRun("codex", "test", true, confirmed);
      const taskId = store.overview({ runId: id }).records.items[0].taskId!;
      expect(store.detail(taskId, confirmed)?.profileChanged).toBe(false);
      expect(store.detail(taskId, profile())?.profileChanged).toBe(true);
      expect(
        store.detail(taskId, {
          ...confirmed,
          ascendedSchoolFormulaConfirmations: {
            ...confirmed.ascendedSchoolFormulaConfirmations,
            another: [160, 160, 160, 160, 160],
          },
        })?.profileChanged,
      ).toBe(false);
      expect(
        store.detail(taskId, {
          ...confirmed,
          ascendedSchoolFormulaConfirmations: { [record.listing.key]: [155, 150, 150, 130, 130] },
        })?.profileChanged,
      ).toBe(true);
    } finally {
      crawl.db.close();
    }
  });
  it("AI只核对结论，金额和缺项由程序产生；错误买入结论仍拒绝", () => {
    const record = completeRecord();
    record.listing.price = "100000";
    const actual = calculateValuation(record, profile());
    const output = {
      decision: "PASS",
      reason: "挂牌价格超过裸号估值，不建议买入。",
      extracted_facts: [],
    };
    const result = validateValuation(
      JSON.stringify(output),
      buildProductDocument(record),
      record,
      profile(),
    );
    expect(result.valuation?.model_value).toBe(actual.model_value);
    expect(result.valuation?.items).toEqual(actual.items);
    expect(result.valuation?.decision).toBe("PASS");
    expect(() =>
      validateValuation(
        JSON.stringify({ ...output, decision: "BUY" }),
        buildProductDocument(record),
        record,
        profile(),
      ),
    ).toThrow("价格比较结论不一致");
    expect(VALUATION_SCHEMA.required).toEqual(["decision", "reason", "extracted_facts"]);
  });
  it("AI重复声明已核对字段时丢弃其引用，不覆盖网页事实、不放宽缺项引用校验", () => {
    const record = completeRecord();
    record.detail!.valuation = {
      version: 1,
      source: {},
      issues: [],
      fields: [{ name: "坐骑总数", value: "0", tab: "坐骑" }],
    };
    const duplicate = {
      name: "坐骑总数",
      value: "0",
      path: "/detail/tabs/4/petCount",
      quote: "AI给出了不真实的引用",
    };
    expect(validateValuationFacts([duplicate], record)).toEqual([]);
    expect(() => validateValuationFacts([{ ...duplicate, value: "1" }], record)).toThrow(
      "已采集字段冲突",
    );
    expect(() =>
      validateValuationFacts([{ ...duplicate, name: "神器1满槽", value: "是" }], record),
    ).toThrow("文字字段");
    const computed = calculateValuation(record, profile());
    const result = validateValuation(
      JSON.stringify({ ...computed, extracted_facts: [duplicate] }),
      buildProductDocument(record),
      record,
      profile(),
    );
    expect(result.valuation?.extracted_facts).toEqual([]);
    expect(
      result.valuation?.items.find((item) => item.name === "坐骑")?.evidence[0].path,
    ).toContain("/detail/valuation/fields/");
  });
  it("无土豪金不误加1400，新采财产覆盖旧摘要，金额引用实际字段", () => {
    const record = completeRecord();
    record.listing.summary = { iCash: 999999999, iSaving: 999999999, xianyu: 999999 };
    record.detail!.valuation = {
      version: 1,
      source: {},
      issues: [],
      fields: [
        { name: "靓号特效", value: "无土豪金", tab: "人物/修炼" },
        ...["现金", "存银", "仙玉", "储备金"].map((name) => ({
          name,
          value: "0",
          tab: "道具/法宝",
        })),
      ],
    };
    const result = calculateValuation(record, profile());
    expect(result.items.find((item) => item.name === "土豪金ID")?.amount).toBe(0);
    expect(result.model_value).toBe(calculateValuation(completeRecord(), profile()).model_value);
    expect(result.items.find((item) => item.name === "土豪金ID")?.evidence[0].path).toContain(
      "/detail/valuation/fields/",
    );
  });
  it("资料漏采不能输出完整估值；费用未知不影响完整估值的挂牌差价", () => {
    const configured = createProfile(template, { ...profile().settings, extraCost: null }, false);
    const record = completeRecord();
    record.listing.price = "100000";
    const result = calculateValuation(record, configured);
    expect(result.decision).toBe("PASS");
    expect(result.price_difference).toBeCloseTo(result.model_value! - 100000, 2);
    expect(result.price_difference_ratio).toBeCloseTo((result.model_value! - 100000) / 100000, 7);
    expect(result.max_total_cost).toBeNull();
    expect(result.max_listing_price).toBeNull();
    expect(result.total_cost).toBeNull();
    record.detail!.valuation = {
      version: 1,
      source: {},
      fields: [],
      issues: ["神器1槽位状态或五行未完整读取"],
    };
    const incomplete = calculateValuation(record, configured);
    expect(incomplete.model_value).toBeNull();
    expect(incomplete.decision).toBe("NEED_INFO");
    expect(incomplete.missing_fields).toContain("神器1槽位状态或五行未完整读取");
  });
  it("低级经验折算不提前舍入，强壮口径分别计算", () => {
    expect(trainingPrice(6, "defense")).toBe(50 / 1.5);
    expect(trainingPrice(17, "defense")).toBe(230);
    for (const [level, experience] of [150, 360, 650, 1040].map((experience, i) => [
      i + 1,
      experience,
    ])) {
      expect(trainingPrice(level, "attack")).toBe((30 * experience) / 1550);
      expect(trainingPrice(level, "defense")).toBe((20 * experience) / 1550);
      expect(trainingPrice(level, "petAttack")).toBe((40 * experience) / 1550);
      expect(trainingPrice(level, "petDefense")).toBe((30 * experience) / 1550);
    }
    for (const level of [-1, 26, 1.5, NaN]) expect(trainingPrice(level, "attack")).toBeNull();
    expect(trainingPrice(0, "petAttack")).toBe(0);
    expect(strengthPrice(2, "single")).toBe(8 / 270);
    expect(strengthPrice(2, "cumulative")).toBe(9 / 270);
    expect(schoolPrice([180, 180, 180, 180, 180, 180, 180], "已化圣", false)).toBeCloseTo(
      4814.86,
      2,
    );
    expect(schoolPrice([180, 180, 186, 180, 180, 180, 180], "已化圣", false)).toBe(
      schoolPrice([180, 180, 180, 180, 180, 180, 180], "已化圣", false),
    );
    expect(schoolPrice([160, 130, 130, 130, 130, 130, 130], "未飞升", false)).toBeNull();
    expect(schoolPrice([160, 160, 160, 160, 160, 160, 160], "已飞升", false)).toBeGreaterThan(250);
  });
  it("机缘负向扣分只用完整基数，69级差异不自动择一", () => {
    expect(opportunityPrice(69, 7, 2000, null)).toBe(-132);
    expect(opportunityPrice(69, 7, null, "formula")).toBeNull();
    expect(opportunityPrice(69, 55, 2000, null)).toBeNull();
    expect(opportunityPrice(69, 55, 2000, "formula")).toBe(150);
    expect(opportunityPrice(69, 55, 2000, "discrete")).toBe(180);
    expect(opportunityPrice(69, 56, 2000, "discrete")).toBeNull();
  });
  it("神器先选最高套，坐骑边界不默认，高价向下取分", () => {
    expect(
      artifactPrice([
        { full: true, type: "十二火", score: 91 },
        { full: true, type: "十二水", score: 91 },
      ]),
    ).toBe(1900);
    expect(artifactPrice([{ full: null, type: "十二水", score: 91 }])).toBeNull();
    expect(mountPrice(2.35, true, 70, null)).toBeNull();
    expect(mountPrice(2.35, true, 70, "lower")).toBe(100);
    expect(mountPrice(2.35, true, 70, "upper")).toBe(200);
    expect(mountPrice(2.35, true, 95, null)).toBe(775);
    expect(floorPrice(123.459)).toBe(123.45);
    expect(purchase(1000, 801, { ...DEFAULT_SETTINGS, b: 0.8, extraCost: 0 }).decision).toBe(
      "WATCH",
    );
    expect(purchase(1000, 1001, { ...DEFAULT_SETTINGS, b: 0.8, extraCost: 0 }).decision).toBe(
      "PASS",
    );
  });
  it("完整条件可比较；20级上限无溢价，未覆盖上限阻塞，未知费用不阻塞", () => {
    const record = completeRecord(),
      configured = profile();
    const full = calculateValuation(record, configured);
    expect(full.decision).toBe("BUY");
    expect(full.model_value).toBeGreaterThan(4000);
    const field = record.detail!.tabs[0].fields.find((item) => item.name === "防御修炼")!;
    field.value = "17/20";
    const basicCap = calculateValuation(record, configured);
    expect(basicCap.decision).toBe("BUY");
    expect(basicCap.items.find((item) => item.name === "防御修炼上限")?.amount).toBe(0);
    field.value = "17/26";
    const partial = calculateValuation(record, configured);
    expect(partial.decision).toBe("NEED_INFO");
    expect(partial.model_value).toBeNull();
    expect(partial.items.find((item) => item.name === "防御修炼")?.amount).toBe(230);
    expect(partial.items.find((item) => item.name === "防御修炼上限")?.amount).toBeNull();
    const noFees = calculateValuation(
      completeRecord(),
      createProfile(template, { ...configured.settings, extraCost: null }, false),
    );
    expect(noFees.decision).toBe("BUY");
    expect(noFees.total_cost).toBeNull();
    expect(noFees.model_value).not.toBeNull();
  });
  it("已采集储备字段映射为储备金，缺金价只留金额待确认", () => {
    const record = completeRecord(),
      configured = profile();
    const field = record.detail!.tabs[0].fields.find((item) => item.name === "储备金")!;
    field.name = "储备";
    field.value = "1947803";
    const result = calculateValuation(record, configured),
      asset = result.items.find((item) => item.name === "储备金")!;
    expect(asset.input).toBe("1947803");
    expect(asset.amount).toBeNull();
    expect(asset.evidence[0].value).toBe("1947803");
    expect(result.body_value).toBeGreaterThan(0);
    expect(result.model_value).toBeNull();
    expect(result.decision).toBe("NEED_INFO");
  });
  it("读取真实页面的相邻单元格、内嵌标签和进阶文字，祥瑞不当坐骑", () => {
    const record = completeRecord();
    record.detail!.tabs[0].fields = record.detail!.tabs[0].fields.filter(
      (field) => !["神器套数", "坐骑总数"].includes(field.name),
    );
    record.detail!.tabs.push({
      name: "坐骑",
      text: "坐骑·已进阶\n祥瑞总数：5",
      fields: [],
      elements: [],
      tooltips: [],
      tables: [[["成长：2.3500"], ["主属性：", "敏捷"], ["敏捷：", "68+3(63%)"]]],
    });
    expect(readValuationFact(record, "成长", "坐骑")?.raw).toBe("2.3500");
    expect(readValuationFact(record, "主属性", "坐骑")?.raw).toBe("敏捷");
    expect(readValuationFact(record, "进阶状态", "坐骑")?.raw).toBe("已进阶");
    expect(readValuationFact(record, "坐骑总数")).toBeNull();
    record.detail!.tabs[0].text = "神器";
    const missing = calculateValuation(record, profile());
    expect(missing.model_value).toBeNull();
    expect(missing.suggestions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("补采神器"),
        expect.stringContaining("补采全部坐骑"),
      ]),
    );
    record.detail!.tabs[0].fields.push({ name: "坐骑总数", value: "1" });
    const mount = calculateValuation(record, profile()).items.find((item) => item.name === "坐骑")!;
    expect(mount.amount).toBe(100);
    expect(mount.evidence.some((proof) => proof.value === "68+3(63%)")).toBe(true);
  });
  it("非零神器与多只坐骑接入完整核算，单套神器未满槽不估作满槽", () => {
    const record = completeRecord(),
      fields = record.detail!.tabs[0].fields;
    fields.find((field) => field.name === "神器套数")!.value = "2";
    fields.find((field) => field.name === "坐骑总数")!.value = "2";
    for (const [name, value] of Object.entries({
      神器1满槽: "是",
      神器1类型: "十二水",
      神器1总分: "91",
      神器2满槽: "是",
      神器2类型: "十二火",
      神器2总分: "91",
    }))
      fields.push({ name, value });
    for (const [i, percent] of [63, 75].entries())
      record.detail!.tabs.push({
        name: `坐骑 / ${i + 1}`,
        text: "坐骑·已进阶",
        fields: [],
        elements: [],
        tooltips: [],
        tables: [[["成长：2.3500", "主属性百分比：" + percent + "%"]]],
      });
    const result = calculateValuation(record, profile());
    expect(result.items.find((item) => item.name === "神器")?.amount).toBe(1900);
    expect(result.items.find((item) => item.name === "坐骑")?.amount).toBe(300);
    expect(result.decision).toBe("BUY");
    expect(result.model_value).toBeGreaterThan(
      calculateValuation(completeRecord(), profile()).model_value!,
    );
    fields.find((field) => field.name === "神器2满槽")!.value = "否";
    expect(
      calculateValuation(record, profile()).items.find((item) => item.name === "神器")?.amount,
    ).toBe(1400);
    expect(artifactPrice([{ full: true, type: "未知", score: 91 }])).toBeNull();
  });
  it("AI补提必须引用真实原文，补提后重新核算并生成结论", () => {
    const record = completeRecord();
    record.detail!.tabs[0].fields = record.detail!.tabs[0].fields.filter(
      (field) => field.name !== "神器套数",
    );
    const quote = "共有1套神器；第1套神器：十二水，总分：91，12/12。";
    record.detail!.tabs[0].text = quote;
    const facts = [
      { name: "神器套数", value: "1" },
      { name: "神器1满槽", value: "是" },
      { name: "神器1类型", value: "十二水" },
      { name: "神器1总分", value: "91" },
    ].map((entry) => ({ ...entry, path: "/detail/tabs/0/text", quote }));
    expect(calculateValuation(record, profile()).decision).toBe("NEED_INFO");
    expect(validateValuationFacts(facts, record)).toEqual(facts);
    const full = calculateValuation(record, profile(), facts);
    const result = validateValuation(
      JSON.stringify({ ...full, reason: "建议买入，已核对神器资料。" }),
      buildProductDocument(record),
      record,
      profile(),
    );
    expect(result.valuation?.decision).toBe("BUY");
    expect(result.valuation?.items.find((item) => item.name === "神器")?.amount).toBe(1400);
    expect(result.valuation?.ai_explanation).toContain("已核对神器");
    expect(() =>
      validateValuationFacts([{ ...facts[0], quote: "共有0套神器", value: "0" }], record),
    ).toThrow("原文不一致");
    expect(() => validateValuationFacts([{ ...facts[0], value: "0" }], record)).toThrow(
      "无法从引用中复核",
    );
    expect(() => validateValuationFacts([facts[0], facts[0]], record)).toThrow("名称或引用无效");
    record.detail!.tabs[0].fields.push({ name: "神器套数", value: "0" });
    expect(() => validateValuationFacts(facts, record)).toThrow("已采集字段冲突");
  });
  it("历史购买函数保留原语义，新挂牌比较完全忽略预算、费用和买入系数", () => {
    expect(purchase(1000, 1001, { ...DEFAULT_SETTINGS, b: null }).decision).toBe("PASS");
    expect(purchase(null, 1001, { ...DEFAULT_SETTINGS, budget: 1000 }).decision).toBe("PASS");
    expect(purchase(1000, 500, DEFAULT_SETTINGS).decision).toBe("NEED_INFO");
    const record = completeRecord();
    record.listing.price = "100000";
    expect(
      calculateValuation(
        record,
        createProfile(template, { ...profile().settings, extraCost: null }, false),
      ).decision,
    ).toBe("PASS");
    const overBudget = calculateValuation(
      completeRecord(),
      createProfile(template, { ...profile().settings, budget: 1 }, false),
    );
    expect(overBudget.decision).toBe("BUY");
    expect(overBudget.reason).not.toContain("预算");
    const ignored = calculateValuation(
      completeRecord(),
      createProfile(
        template,
        {
          ...profile().settings,
          b: null,
          a: null,
          extraCost: 1000000,
          budget: 0,
        },
        false,
      ),
    );
    const baseline = calculateValuation(completeRecord(), profile());
    expect(ignored).toEqual(baseline);
    expect(ignored.missing_fields.some((field) => /费用|成本|系数|预算/.test(field))).toBe(false);
    expect(ignored.suggestions!.some((suggestion) => /费用|成本|系数|预算/.test(suggestion))).toBe(
      false,
    );
  });
  it("执行中参数修改不影响已冻结批次，失败停止后人工重试保存实际请求", async () => {
    const crawl = new CrawlStore(":memory:"),
      record = completeRecord(),
      configured = profile();
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const expected = calculateValuation(record, configured),
      store = new AnalysisStore(crawl.db);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const analyze = vi
      .fn()
      .mockImplementationOnce(async () => {
        await wait;
        return { text: JSON.stringify({ ...expected, model_value: 1 }) };
      })
      .mockResolvedValue({ text: JSON.stringify(expected) });
    const runner = new AnalysisRunner(store, async () => ({ model: "test", analyze }));
    try {
      const id = await runner.start("codex", true, configured, true);
      configured.settings.b = 0.01;
      configured.template = "下一批的新规则";
      release();
      await runner.settled();
      expect(store.run(id)).toMatchObject({ status: "paused", failed: 1, completed: 0 });
      await runner.resume(id, true);
      await runner.settled();
      expect(store.run(id)?.completed).toBe(1);
      const detail = store.detail(store.overview({ runId: id }).records.items[0].taskId!)!;
      expect(detail.profile?.settings.b).toBe(0.8);
      expect(detail.profile?.template).toBe(template);
      expect(detail.attempts).toHaveLength(2);
      expect(detail.attempts[1].requestText).toContain(detail.attempts[0].error!);
      expect(detail.attempts[1].requestText).toBe(analyze.mock.calls[1][0]);
      expect(detail.attempts[1].requestHash).not.toBe(detail.promptHash);
      expect(detail.result?.valuation?.decision).toBe("BUY");
    } finally {
      await runner.shutdown();
      crawl.db.close();
    }
  });
  it("完整原文只出现一次，金额严格复算；AI改写待确认项时保留程序完整列表", () => {
    const record = completeRecord(),
      configured = profile(),
      doc = buildProductDocument(record);
    const prompt = valuationPrompt(doc, record, configured);
    expect(prompt.startsWith(template)).toBe(true);
    expect(prompt.split(doc.text)).toHaveLength(2);
    const computed = calculateValuation(record, configured);
    const result = validateValuation(JSON.stringify(computed), doc, record, configured);
    expect(result.valuation?.decision).toBe("BUY");
    expect(() =>
      validateValuation(
        JSON.stringify({ ...computed, model_value: computed.model_value! + 1 }),
        doc,
        record,
        configured,
      ),
    ).toThrow("核算不一致");
    const pendingProfile = createProfile(template, DEFAULT_SETTINGS, false),
      pending = calculateValuation(record, pendingProfile);
    for (const wording of [
      { missing_fields: ["AI省略了区服参数"], pending_rules: ["计价口径需确认"] },
      { missing_fields: [], pending_rules: [] },
    ]) {
      const preserved = validateValuation(
        JSON.stringify({ ...pending, ...wording }),
        doc,
        record,
        pendingProfile,
      );
      expect(preserved.valuation?.decision).toBe("NEED_INFO");
      expect(preserved.valuation?.body_value).toBeGreaterThan(0);
      expect(preserved.valuation?.missing_fields).toEqual(pending.missing_fields);
      expect(preserved.valuation?.pending_rules).toEqual(pending.pending_rules);
      expect(preserved.missingData).toEqual([...pending.missing_fields, ...pending.pending_rules]);
    }
  });
  it("修改计价规则停用旧算法；默认仅裸号，费用不参与新设置指纹", () => {
    expect(createProfile(template).calculationCompatible).toBe(true);
    expect(createProfile(template + "\n请简洁解释。").calculationCompatible).toBe(true);
    const changed = createProfile(template.replace("| 未飞升 | 0 元 |", "| 未飞升 | 10 元 |"));
    expect(changed.calculationCompatible).toBe(false);
    expect(calculateValuation(completeRecord(), changed).model_value).toBeNull();
    expect(normalizeSettings({})).toMatchObject({
      b: 0.8,
      extraCost: null,
      strengthMode: "single",
      capMode: "effective",
    });
    expect(normalizeSettings({ b: null, strengthMode: null })).toMatchObject({
      b: null,
      strengthMode: null,
    });
    expect(normalizeSettings({ extraCost: 0, budget: 0 })).toMatchObject({
      extraCost: 0,
      budget: 0,
    });
    expect(() => normalizeSettings({ b: 0.8, a: 0.9 })).toThrow("0 < a ≤ b");
    const automatic = createProfile(template);
    expect(automatic.equipmentSearch).toBe(false);
    expect(automatic.petSearch).toBe(false);
    const ignoredPolicy = createProfile(template, {
      ...DEFAULT_SETTINGS,
      b: 0.3,
      a: 0.1,
      budget: 1,
      extraCost: 999,
    });
    expect(ignoredPolicy.settingsHash).toBe(automatic.settingsHash);
    expect(ignoredPolicy.hash).toBe(automatic.hash);
    expect(createProfile(template, { ...DEFAULT_SETTINGS, analyzeEquipment: true }).hash).not.toBe(
      automatic.hash,
    );
  });
  it("保存设置防止覆盖并持久化，保留原Prompt逐字内容", () => {
    const directory = mkdtempSync(join(tmpdir(), "cbg-profile-")),
      file = join(directory, "prompt.md"),
      crawl = new CrawlStore(":memory:");
    try {
      writeFileSync(file, template);
      const before = loadProfile(crawl.db, file);
      const saved = saveProfile(
        crawl.db,
        {
          template,
          settings: { ...DEFAULT_SETTINGS, b: 0.75, extraCost: 0 },
          baseHash: before.hash,
        },
        file,
      );
      expect(readFileSync(file, "utf8")).toBe(template);
      expect(loadProfile(crawl.db, file).hash).toBe(saved.hash);
      const cleared = saveProfile(
        crawl.db,
        {
          template,
          settings: { ...saved.settings, b: null, strengthMode: null, schoolCapConfirmed: false },
          baseHash: saved.hash,
        },
        file,
      );
      expect(loadProfile(crawl.db, file).settings).toMatchObject({
        b: null,
        strengthMode: null,
        schoolCapConfirmed: false,
        extraCost: 0,
      });
      expect(cleared.hash).not.toBe(saved.hash);
      expect(() =>
        saveProfile(
          crawl.db,
          { template: template + "过时修改", settings: {}, baseHash: before.hash },
          file,
        ),
      ).toThrow("已被修改");
      expect(readFileSync(file, "utf8")).toBe(template);
    } finally {
      crawl.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("旧的未设置规则改用建议方案，但不填造金价和额外费用", () => {
    const crawl = new CrawlStore(":memory:");
    try {
      loadProfile(crawl.db);
      crawl.db.prepare("INSERT INTO analysis_settings VALUES(1,?)").run(
        JSON.stringify({
          ...DEFAULT_SETTINGS,
          b: null,
          strengthMode: null,
          capMode: null,
          holyLevelPremium: null,
          opportunityMode: null,
          mountBoundary: null,
          adjustmentMode: null,
          adjustmentScope: null,
          schoolCapConfirmed: false,
          sumAdvancedMounts: false,
        }),
      );
      const migrated = loadProfile(crawl.db);
      expect(migrated.settings).toMatchObject({
        b: 0.8,
        strengthMode: "single",
        capMode: "effective",
        holyLevelPremium: false,
        opportunityMode: "formula",
        mountBoundary: "lower",
        adjustmentMode: "add",
        adjustmentScope: "body",
        schoolCapConfirmed: true,
        sumAdvancedMounts: true,
        extraCost: null,
        servers: [],
      });
    } finally {
      crawl.db.close();
    }
  });
  it("算法升级后旧批次不能续算混入新价格，也不会调用AI", async () => {
    const crawl = new CrawlStore(":memory:"),
      record = completeRecord();
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const store = new AnalysisStore(crawl.db),
      client = vi.fn();
    const runner = new AnalysisRunner(store, client);
    try {
      const old = { ...profile(), calculationVersion: "bare-role-v2" };
      const id = store.createRun("codex", "fixture-model", true, old);
      expect(store.run(id)?.calculationVersion).toBe("bare-role-v2");
      await expect(runner.resume(id)).rejects.toThrow("按新规则开始分析");
      await expect(runner.start("codex", true, old)).rejects.toThrow("按新规则开始分析");
      expect(client).not.toHaveBeenCalled();
    } finally {
      await runner.shutdown();
      crawl.db.close();
    }
  });
  it("只分析1件，缓存区分Prompt和参数，调用和批次冻结输入", async () => {
    const crawl = new CrawlStore(":memory:");
    const first = completeRecord();
    crawl.observe(first.listing);
    crawl.save(first.listing, first.detail!);
    const second = analysisRecord("second");
    crawl.observe(second.listing);
    crawl.save(second.listing, second.detail!);
    const store = new AnalysisStore(crawl.db),
      configured = profile();
    let current = configured;
    const analyze = vi.fn(async () => ({
      text: JSON.stringify(calculateValuation(first, current)),
    }));
    const runner = new AnalysisRunner(store, async () => ({ model: "test", analyze }));
    try {
      const one = await runner.start("codex", true, configured, true);
      await runner.settled();
      expect(store.run(one)).toMatchObject({
        total: 1,
        completed: 1,
        profileHash: configured.hash,
      });
      const task = store.overview({ runId: one }).ranking[0].taskId!;
      const detail = store.detail(task)!;
      expect(detail.profile?.template).toBe(template);
      expect(detail.attempts[0].requestText).toBe(detail.promptText);
      const reused = await runner.start("codex", false, configured, true);
      await runner.settled();
      expect(store.run(reused)?.reused).toBe(1);
      expect(analyze).toHaveBeenCalledTimes(1);
      current = createProfile(template, { ...configured.settings, capMode: "effective" }, false);
      const newParameters = await runner.start("codex", false, current, true);
      await runner.settled();
      expect(store.run(newParameters)?.reused).toBe(0);
      expect(analyze).toHaveBeenCalledTimes(2);
      current = createProfile(template + "\n分析说明调整。", current.settings, false);
      const newPrompt = await runner.start("codex", false, current, true);
      await runner.settled();
      expect(store.run(newPrompt)?.reused).toBe(0);
      expect(analyze).toHaveBeenCalledTimes(3);
      expect(store.detail(task)?.profile?.hash).toBe(configured.hash);
    } finally {
      await runner.shutdown();
      crawl.db.close();
    }
  });
});
