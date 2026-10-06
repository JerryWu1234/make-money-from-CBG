import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import {
  equipmentPricingPlan,
  combineEquipmentPricing,
  searchEquipmentPrices,
  type EquipmentPricingItem,
} from "./equipment-pricing";
import { createProfile, DEFAULT_SETTINGS, normalizeSettings, PROMPT_FILE } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import { buildProductDocument } from "./product-document";
import { validateValuation, valuationPrompt } from "./valuation-contract";

const signal = () => new AbortController().signal;
function scenario() {
  const record = valuationRecord();
  record.detail!.equipmentCapture = {
    version: 1,
    collectedAt: record.detail!.collectedAt,
    complete: true,
    issues: [],
  };
  record.detail!.tabs = record.detail!.tabs.filter((tab) => !tab.name.startsWith("道具/法宝"));
  record.detail!.tabs.push({
    name: "道具/法宝",
    text: "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [
      {
        index: 0,
        name: "测试普通长剑",
        kind: "equipment",
        category: "人物装备 · 武器",
        description: "等级：70\n命中：255\n伤害：220\n耐久：200\n修理失败：0",
      },
      {
        index: 1,
        name: "测试待补长剑",
        kind: "equipment",
        category: "人物装备 · 武器",
        description: "等级：60\n命中：220\n伤害：190\n耐久：200\n修理失败：0",
      },
      {
        index: 2,
        name: "测试普通铁面扇",
        kind: "equipment",
        category: "人物装备 · 武器",
        description: "等级：30\n命中：115\n伤害：80\n耐久：200\n修理失败：0",
      },
    ],
  });
  const settings = normalizeSettings({
    ...DEFAULT_SETTINGS,
    servers: [
      {
        serverId: String(record.listing.serverId),
        age: "older",
        rank: 70,
        goldPrice: 210,
        goldUnit: 30000000,
        baselineUnitConfirmed: true,
      },
    ],
  });
  const source = {
    findCandidates: vi.fn(async (_items: EquipmentPricingItem[], _signal: AbortSignal) => ({
      queries: ["模拟特殊装备筛选"],
      items: [],
    })),
    readSource: vi.fn(async () => ""),
  };
  return { record, settings, source };
}

describe("普通装备先分流再查价", () => {
  it("已知历史环价、待补默认价和明确低值排除全部跳过联网，保存策略与金价", async () => {
    const { record, settings, source } = scenario();
    const snapshot = await searchEquipmentPrices(record, signal(), source, settings);
    expect(source.findCandidates).not.toHaveBeenCalled();
    expect(source.readSource).not.toHaveBeenCalled();
    expect(snapshot.queries).toEqual([]);
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.items[0].baselineEstimate).toMatchObject({
      kind: "ring",
      gameCurrency: 110000,
      amount: 0.77,
      goldPrice: 210,
      goldUnit: 30000000,
      source: { basis: "historical", publishedAt: "2025-11-22" },
    });
    expect(snapshot.items[1].baselineEstimate).toMatchObject({ gameCurrency: null, amount: null });
    expect(snapshot.items[2].baselineEstimate).toMatchObject({ kind: "ignored", amount: 0 });
    expect(snapshot).toMatchObject({ total: null, knownTotal: 0 });
    expect(snapshot.items.every((item) => item.referencePrice === null)).toBe(true);
    expect(JSON.parse(snapshot.requestText!).baselineItems).toHaveLength(3);
    expect(JSON.parse(snapshot.requestText!).prices).toEqual(settings.equipmentBaselinePrices);
    expect(snapshot.requestHash).toHaveLength(64);
  });

  it("混合库存只把特殊装备传给查价模块，缺默认价不退回逐件检索", async () => {
    const { record, settings, source } = scenario();
    record.detail!.tabs.at(-1)!.items!.push({
      index: 3,
      name: "测试套装项链",
      kind: "equipment",
      category: "人物装备 · 项链",
      description: "等级：60\n灵力：56\n耐久：200\n套装效果：附加状态炼气化神",
    });
    const snapshot = await searchEquipmentPrices(record, signal(), source, settings);
    expect(source.findCandidates).toHaveBeenCalledOnce();
    const lookups = source.findCandidates.mock.calls[0][0];
    expect(lookups.map((item: { name: string }) => item.name)).toEqual(["测试套装项链"]);
    expect(snapshot.items[3].baselineEstimate).toBeUndefined();
    expect(JSON.parse(snapshot.requestText!).baselineItems).toHaveLength(3);
    expect(JSON.parse(snapshot.requestText!).lookupItems).toHaveLength(1);
  });

  it("采集不完整不套默认价，低值标记也不能掩盖缺资料", async () => {
    const { record, settings, source } = scenario();
    record.detail!.equipmentCapture!.complete = false;
    const snapshot = await searchEquipmentPrices(record, signal(), source, settings);
    expect(snapshot.captureComplete).toBe(false);
    expect(snapshot.items.every((item) => !item.baselineEstimate)).toBe(true);
    expect(source.findCandidates).not.toHaveBeenCalled();
  });

  it("金价单位未确认仍识别环装但不给金额，也不触发浏览器", () => {
    const { record, settings } = scenario();
    settings.servers[0].baselineUnitConfirmed = false;
    const plan = equipmentPricingPlan(record, settings);
    expect(plan.items[0].baselineEstimate).toMatchObject({ kind: "ring", amount: null });
  });

  it("失效默认价不计入金额，保留原始证据并提示重新分析", () => {
    const { record, settings } = scenario();
    const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), settings);
    const plan = equipmentPricingPlan(record, settings);
    plan.items[0].baselineEstimate!.amount = 12345;
    const result = combineEquipmentPricing(
      calculateValuation(record, profile),
      record,
      plan,
      settings,
    );
    expect(result.equipment_pricing!.items[0].baselineInvalidReason).toContain("不一致");
    expect(result.items.find((item) => item.name.startsWith("装备：测试普通长剑"))).toMatchObject({
      amount: null,
      confirmed: false,
      formula: expect.stringContaining("默认参考价已失效"),
    });
    expect(result.missing_fields).toContainEqual(expect.stringContaining("不一致"));
    expect(result.next_action).toContain("重新分析");
    expect(result.known_subtotal).toBe(result.bare_role_value);
    expect(plan.items[0].baselineInvalidReason).toBeUndefined();
    expect(plan.items[0].baselineEstimate!.amount).toBe(12345);
  });

  it("实际提示词与AI输出验证都采用冻结默认价，完整参考价可比较挂牌差额", () => {
    const { record, settings } = scenario();
    record.detail!.tabs.at(-1)!.items = [record.detail!.tabs.at(-1)!.items![0]];
    const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), settings, true, false);
    const plan = equipmentPricingPlan(record, settings);
    const document = buildProductDocument(record);
    const prompt = valuationPrompt(document, record, profile, plan);
    expect(prompt).toContain('"estimated_sources":["baseline"]');
    const result = validateValuation(
      JSON.stringify({ decision: "NEED_INFO", reason: "模拟核对默认参考价", extracted_facts: [] }),
      document,
      record,
      profile,
      plan,
    ).valuation!;
    expect(result.estimated_value_range).toBeDefined();
    expect(result.estimated_sources).toEqual(["baseline"]);
    expect(result.estimated_price_difference!.min).toBeCloseTo(
      result.bare_role_value! + 0.77 - result.asking_price!,
    );
    expect(result.equipment_pricing!.items[0].baselineInvalidReason).toBeUndefined();
    expect(result.model_value).toBeNull();
    expect(result.known_subtotal).toBe(result.bare_role_value);
  });
});

describe("普通装备默认价格的批次冻结", () => {
  it("默认60/90/100留空；更改价格更新profile哈希，不改变裸号公式兼容性", () => {
    const template = readFileSync(PROMPT_FILE, "utf8");
    const base = createProfile(template);
    for (const level of ["60", "90", "100"] as const)
      expect(base.settings.equipmentBaselinePrices![level]).toEqual({ weapon: null, armor: null });
    const prices = structuredClone(base.settings.equipmentBaselinePrices!);
    prices["90"].weapon = 100000;
    const changed = createProfile(template, { ...base.settings, equipmentBaselinePrices: prices });
    expect(changed.calculationCompatible).toBe(true);
    expect(changed.calculationVersion).toBe("price-comparison-v9");
    expect(changed.settingsHash).not.toBe(base.settingsHash);
    expect(changed.hash).not.toBe(base.hash);
    expect(base.settings.equipmentBaselinePrices!["90"].weapon).toBeNull();
  });

  it("拒绝零、负数、小数、字符串、无限值和缺少档位，null不变成零", () => {
    for (const price of [0, -1, 0.5, "100000", Infinity, NaN, undefined]) {
      const prices = structuredClone(DEFAULT_SETTINGS.equipmentBaselinePrices!);
      Object.assign(prices["60"], { weapon: price });
      expect(() => normalizeSettings({ equipmentBaselinePrices: prices })).toThrow("正整数");
    }
    expect(() => normalizeSettings({ equipmentBaselinePrices: {} })).toThrow("缺少等级");
    expect(normalizeSettings({}).equipmentBaselinePrices!["60"].weapon).toBeNull();
  });
});
