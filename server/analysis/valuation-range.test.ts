import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import {
  equipmentInventory,
  equipmentPricingPlan,
  combineEquipmentPricing,
  type EquipmentCandidate,
  type EquipmentPricingSnapshot,
} from "./equipment-pricing";
import { petInventory, combinePetPricing, type PetPricingSnapshot } from "./pet-pricing";
import { buildSimilarEstimate } from "./pricing-estimate";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import { applyValuationRange } from "./valuation-range";
import { buildProductDocument } from "./product-document";
import { validateValuation, valuationPrompt } from "./valuation-contract";

const candidates = (prices = [100, 120, 140]): EquipmentCandidate[] =>
  prices.map((price, index) => ({
    url: "https://xyq.cbg.163.com/equip?s=1&eid=sample-" + index,
    title: "测试腰带",
    price,
    priceType: "listing",
    quote: "挂牌价：" + price,
    verified: true,
    matchType: "similar",
    differences: ["防御：当前50，样本49"],
    reason: "主商品身份与当前在售价格已核对，配置相近",
    fetchedAt: new Date().toISOString(),
    sourceHash: "sample-sha-" + index,
  }));
function fixture() {
  const record = valuationRecord();
  record.detail!.equipmentCapture = {
    version: 1,
    collectedAt: record.detail!.collectedAt,
    complete: true,
    issues: [],
  };
  record.detail!.petCapture = {
    version: 1,
    collectedAt: record.detail!.collectedAt,
    complete: true,
    issues: [],
  };
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
        kind: "equipment",
        name: "测试腰带",
        category: "腰带",
        description: "等级：100\n防御：50\n气血：250\n耐久：100\n修理失败：0",
      },
    ],
  });
  record.detail!.tabs.push({
    name: "召唤兽/孩子",
    text: "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    petCount: 0,
    pets: [],
  });
  const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), {
    ...DEFAULT_SETTINGS,
    servers: [
      {
        serverId: record.listing.serverId,
        age: "three",
        rank: 10,
        goldPrice: null,
        goldUnit: null,
      },
    ],
  });
  const gear = equipmentInventory(record),
    pets = petInventory(record);
  const sourceCandidates = candidates();
  const equipment: EquipmentPricingSnapshot = {
    version: 1,
    inputHash: gear.inputHash,
    searchedAt: new Date().toISOString(),
    provider: "browser",
    model: "browser",
    queries: ["query"],
    rawResponse: null,
    captureComplete: true,
    total: null,
    knownTotal: 0,
    issues: [],
    items: gear.items.map((item) => ({
      ...item,
      candidates: sourceCandidates,
      similarEstimate: buildSimilarEstimate(sourceCandidates),
    })),
  };
  const pet: PetPricingSnapshot = { ...equipment, inputHash: pets.inputHash, total: 0, items: [] };
  const bare = calculateValuation(record, profile);
  const combine = () =>
    applyValuationRange(
      combinePetPricing(combineEquipmentPricing(bare, record, equipment), record, pet),
      bare,
      record,
      profile,
    );
  return { record, profile, bare, equipment, pet, combine };
}
function baselineFixture(level = 70, withGold = true) {
  const value = fixture();
  const tab = value.record.detail!.tabs.find((row) => row.name === "道具/法宝")!;
  tab.items = [
    {
      index: 0,
      kind: "equipment",
      name: "环装测试武器",
      category: "武器",
      description:
        "等级 " +
        level +
        (level === 0 ? "\n命中 +10 伤害 +5" : "\n命中 +200 伤害 +180") +
        "\n耐久度 100\n修理失败 0次",
    },
  ];
  const profile = createProfile(readFileSync(PROMPT_FILE, "utf8"), {
    ...DEFAULT_SETTINGS,
    servers: [
      {
        serverId: value.record.listing.serverId,
        age: withGold ? "older" : "three",
        rank: withGold ? 70 : 10,
        goldPrice: withGold ? 210 : null,
        goldUnit: withGold ? 10_000_000 : null,
        baselineUnitConfirmed: true,
      },
    ],
  });
  const equipment = equipmentPricingPlan(value.record, profile.settings);
  const bare = calculateValuation(value.record, profile);
  const combine = () =>
    applyValuationRange(
      combinePetPricing(
        combineEquipmentPricing(bare, value.record, equipment, profile.settings),
        value.record,
        value.pet,
      ),
      bare,
      value.record,
      profile,
    );
  return { ...value, equipment, profile, bare, combine };
}

describe("默认装备参考价与挂牌比较", () => {
  it("普通环装默认价只形成注明来源的参考总价，不冒充同配报价或已核实小计", () => {
    const { equipment, bare, combine } = baselineFixture();
    const baseline = equipment.items[0].baselineEstimate!;
    expect(baseline.kind).toBe("ring");
    expect(baseline.source.basis).toBe("historical");
    expect(baseline.amount).toBeGreaterThan(0);
    const result = combine();
    expect(result.estimated_value_range).toEqual({
      min: bare.model_value! + baseline.amount!,
      max: bare.model_value! + baseline.amount!,
    });
    expect(result.estimated_price_difference?.min).toBeCloseTo(
      bare.model_value! + baseline.amount! - result.asking_price!,
    );
    expect(result.estimated_sources).toEqual(["baseline"]);
    expect(result.model_value).toBeNull();
    expect(result.known_subtotal).toBe(bare.model_value);
    expect(result.reason).toContain("历史参考价");
    expect(result.reason).toContain("不是同配置挂牌报价");
    expect(result.reason).not.toContain("包含相近配置挂牌样本");
    expect(equipment.items[0].candidates).toEqual([]);
    expect(equipment.items[0].referencePrice).toBeNull();
    expect(equipment.total).toBeNull();
  });

  it("默认价可以与精确报价、相近区间相加，只有精确报价进入knownSubtotal", () => {
    const value = baselineFixture();
    const tab = value.record.detail!.tabs.find((row) => row.name === "道具/法宝")!;
    tab.items!.push(
      {
        index: 1,
        kind: "equipment",
        name: "特技测试腰带",
        category: "腰带",
        description: "等级 120\n气血 +500 防御 +80\n耐久度 100\n特技：罗汉金钟",
      },
      {
        index: 2,
        kind: "equipment",
        name: "特技测试鞋",
        category: "人物装备 · 鞋子",
        description: "等级 120\n敏捷 +50 防御 +80\n耐久度 100\n特技：晶清诀",
      },
    );
    const updated = equipmentPricingPlan(value.record, value.profile.settings);
    Object.assign(value.equipment, updated);
    const amount = value.equipment.items[0].baselineEstimate!.amount!;
    const exact = value.equipment.items[1];
    expect(exact.baselineEstimate).toBeUndefined();
    exact.status = "priced";
    exact.referencePrice = 100;
    exact.candidates = [{ ...candidates()[0], matchType: "exact" }];
    const similar = value.equipment.items[2];
    expect(similar.baselineEstimate).toBeUndefined();
    similar.candidates = candidates();
    similar.similarEstimate = buildSimilarEstimate(similar.candidates);
    value.equipment.knownTotal = 100;
    const result = value.combine();
    expect(result.estimated_value_range).toEqual({
      min: value.bare.model_value! + amount + 200,
      max: value.bare.model_value! + amount + 240,
    });
    expect(result.known_subtotal).toBe(value.bare.model_value! + 100);
    expect(result.estimated_sources).toEqual(["similar", "baseline"]);
    expect(result.model_value).toBeNull();
    similar.candidates = [];
    similar.similarEstimate = undefined;
    const partial = value.combine();
    expect(partial.estimated_value_range).toBeUndefined();
    expect(partial.estimated_subtotal_range).toEqual({
      min: value.bare.model_value! + amount + 100,
      max: value.bare.model_value! + amount + 100,
    });
    expect(partial.estimate_missing_count).toBe(1);
  });

  it("明确忽略的0级普通装备可按0元参考比较，未知60/90/100级价格仍是缺项", () => {
    const { equipment, bare, combine } = baselineFixture(0, false);
    expect(equipment.items[0].status).toBe("unsupported");
    expect(equipment.items[0].baselineEstimate?.kind).toBe("ignored");
    expect(equipment.items[0].baselineEstimate?.amount).toBe(0);
    const result = combine();
    expect(result.estimated_value_range).toEqual({ min: bare.model_value, max: bare.model_value });
    expect(result.estimated_price_difference).toBeDefined();
    expect(result.reason).toContain("低值未计入");
    expect(result.reason).toContain("不代表其市场售价为0");
    expect(result.known_subtotal).toBe(bare.model_value);
    for (const level of [60, 90, 100]) {
      const value = baselineFixture(level);
      expect(value.equipment.items[0].baselineEstimate?.amount).toBeNull();
      const missing = value.combine();
      expect(missing.estimated_value_range).toBeUndefined();
      expect(missing.estimated_price_difference).toBeUndefined();
      expect(missing.model_value).toBeNull();
    }
  });

  it("默认价设置、区服单位和快照金额均须吻合，过期/缺年代/错库存不得采纳", () => {
    for (const change of [
      "settings",
      "unit",
      "amount",
      "server",
      "policy",
      "age",
      "old",
      "capture",
      "inventory",
    ]) {
      const value = baselineFixture();
      const baseline = value.equipment.items[0].baselineEstimate!;
      if (change === "settings")
        value.profile.settings.equipmentBaselinePrices![70].weapon! += 10_000;
      if (change === "unit") baseline.goldUnit! *= 10;
      if (change === "amount") baseline.amount! += 1;
      if (change === "server") baseline.serverId = "999";
      if (change === "policy") baseline.policyVersion = "forged-policy";
      if (change === "age") value.profile.settings.servers[0].age = null;
      if (change === "old")
        value.equipment.searchedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
      if (change === "capture") value.equipment.captureComplete = false;
      if (change === "inventory") value.equipment.items[0].description += "\n伤害 +999";
      const result = value.combine();
      expect(result.estimated_value_range).toBeUndefined();
      expect(result.estimated_price_difference).toBeUndefined();
      expect(result.known_subtotal).toBe(value.bare.model_value);
      expect(result.model_value).toBeNull();
    }
  });

  it("默认价缺金价或报价单位时保留未定，人工修改后的来源明确标为预设", () => {
    for (const field of ["goldPrice", "goldUnit"] as const) {
      const value = baselineFixture();
      value.profile.settings.servers[0][field] = null;
      expect(value.combine().estimated_value_range).toBeUndefined();
    }
    const value = baselineFixture();
    value.profile.settings.equipmentBaselinePrices![70].weapon! += 10_000;
    Object.assign(value.equipment, equipmentPricingPlan(value.record, value.profile.settings));
    expect(value.equipment.items[0].baselineEstimate?.source.basis).toBe("preset");
    expect(value.combine().reason).toContain("人工预设价");
  });
});

describe("相近配置报价与完整区间", () => {
  it("同一商品路径的伪造查询别名不能凑足3件，非商品URL不能提供完整区间", () => {
    const source = candidates([100, 100, 100]);
    const duplicates = source.map((value, index) => ({
      ...value,
      url: "https://xyq.cbg.163.com/equip/1/same?track=" + index,
    }));
    expect(buildSimilarEstimate(duplicates).sampleCount).toBe(1);
    expect(buildSimilarEstimate(duplicates).range).toBeNull();
    const formats = [
      (index: number) => "https://xyq.cbg.163.com/equip/1/same?s=1&eid=alias-" + index,
      (index: number) => "https://xyq.cbg.163.com/recommend?s=1&eid=alias-" + index,
      (index: number) => "https://xyq.cbg.163.com:8443/equip?s=1&eid=alias-" + index,
      (index: number) => "https://user:pass@xyq.cbg.163.com/equip?s=1&eid=alias-" + index,
    ];
    for (const url of formats) {
      const invalid = source.map((value, index) => ({ ...value, url: url(index) }));
      expect(buildSimilarEstimate(invalid).sampleCount).toBe(0);
      const { equipment, combine } = fixture();
      equipment.items[0].candidates = invalid;
      equipment.items[0].similarEstimate!.range = { min: 100, max: 100 };
      expect(combine().estimated_value_range).toBeUndefined();
    }
  });

  it("装备原始资料缺级别、0级未支持或专用时，篡改查价状态也不能补出完整金额", () => {
    for (const status of ["incomplete", "unsupported", "untradable"] as const)
      for (const mode of ["exact", "similar"] as const) {
        const { record, equipment, bare, combine } = fixture();
        const original = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
        if (status === "incomplete")
          original.description = original.description!.replace("等级：100\n", "");
        if (status === "unsupported")
          original.description = original.description!.replace("等级：100", "等级：0");
        if (status === "untradable") original.description += "\n专用装备";
        const inventory = equipmentInventory(record);
        expect(inventory.captureComplete).toBe(true);
        expect(inventory.items[0].status).toBe(status);
        equipment.inputHash = inventory.inputHash;
        equipment.items = inventory.items.map((item) => ({
          ...item,
          status: mode === "exact" ? "priced" : "no_match",
          candidates: candidates().map((value) => ({ ...value, matchType: mode })),
          referencePrice: mode === "exact" ? 120 : null,
          similarEstimate: mode === "similar" ? buildSimilarEstimate(candidates()) : undefined,
        }));
        equipment.total = mode === "exact" ? 120 : null;
        equipment.knownTotal = mode === "exact" ? 120 : 0;
        const result = combine();
        expect(result.model_value).toBeNull();
        expect(result.price_difference).toBeNull();
        expect(result.estimated_value_range).toBeUndefined();
        expect(result.estimated_price_difference).toBeUndefined();
        expect(result.known_subtotal).toBe(bare.model_value);
      }
  });

  it("宝宝缺少成长时即使总数采齐，相近快照也不能绕过单只资料缺项", () => {
    const { record, pet, combine } = fixture();
    const tab = record.detail!.tabs.find((row) => row.name === "召唤兽/孩子")!;
    const fields = {
      类型: "泡泡",
      等级: "0",
      攻击资质: "1200",
      防御资质: "1200",
      体力资质: "3000",
      法力资质: "1500",
      速度资质: "1000",
      躲闪资质: "1000",
    };
    tab.petCount = 1;
    tab.pets = [
      {
        index: 0,
        name: "泡泡",
        fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
        skills: [],
        innerSkills: [],
        equipment: [],
      },
    ];
    const inventory = petInventory(record);
    expect(inventory.captureComplete).toBe(true);
    expect(inventory.items[0].status).toBe("incomplete");
    expect(inventory.items[0].issues).toContain("缺少成长");
    pet.inputHash = inventory.inputHash;
    pet.total = null;
    pet.items = inventory.items.map((item) => ({
      ...item,
      status: "no_match",
      candidates: candidates(),
      similarEstimate: buildSimilarEstimate(candidates()),
    }));
    const result = combine();
    expect(result.model_value).toBeNull();
    expect(result.estimated_value_range).toBeUndefined();
    expect(result.estimated_price_difference).toBeUndefined();
    expect(result.estimated_subtotal_range).toBeDefined();
    expect(result.estimate_missing_count).toBeGreaterThan(0);
  });

  it("至少3个独立在售来源，重复链接或未核实样本不能凑数", () => {
    expect(buildSimilarEstimate(candidates()).range).toEqual({ min: 100, max: 140 });
    const source = candidates();
    expect(
      buildSimilarEstimate([
        source[0],
        { ...source[0], url: source[0].url + "&track=a" },
        source[1],
      ]).status,
    ).toBe("insufficient");
    expect(buildSimilarEstimate(source.map((x) => ({ ...x, verified: false }))).sampleCount).toBe(
      0,
    );
    expect(
      buildSimilarEstimate(source.map((x) => ({ ...x, matchType: "exact" }))).sampleCount,
    ).toBe(0);
    for (const fetchedAt of [
      "bad-date",
      new Date(Date.now() - 25 * 3600_000).toISOString(),
      new Date(Date.now() + 120_000).toISOString(),
    ])
      expect(buildSimilarEstimate(source.map((x) => ({ ...x, fetchedAt }))).sampleCount).toBe(0);
    expect(buildSimilarEstimate(candidates([100, 120, 151])).status).toBe("dispersed");
    expect(buildSimilarEstimate(candidates([100, 120, 150])).status).toBe("range");
  });
  it("相近报价必须与保存的页面价格一致，缺失证据或超大金额不能形成区间", () => {
    for (const source of [
      candidates().map((value) => ({ ...value, quote: "挂牌价：1" })),
      candidates().map((value) => ({ ...value, quote: "" })),
      candidates([1.1e9, 1.2e9, 1.4e9]),
    ]) {
      expect(buildSimilarEstimate(source).sampleCount).toBe(0);
      const { equipment, combine } = fixture();
      equipment.items[0].candidates = source;
      equipment.items[0].similarEstimate!.range = { min: source[0].price!, max: source[2].price! };
      expect(combine().estimated_value_range).toBeUndefined();
    }
  });
  it("全部资产有依据才形成完整区间，精确单值和knownSubtotal不混入估算", () => {
    const { combine, bare, equipment } = fixture();
    const result = combine();
    expect(result.estimated_value_range).toEqual({
      min: bare.model_value! + 100,
      max: bare.model_value! + 140,
    });
    expect(result.estimated_price_difference!.min).toBeCloseTo(
      bare.model_value! + 100 - result.asking_price!,
    );
    expect(result.estimated_comparison).toBe("below");
    expect(result.model_value).toBeNull();
    expect(result.decision).toBe("NEED_INFO");
    expect(result.known_subtotal).toBe(bare.model_value);
    expect(equipment.total).toBeNull();
  });
  it("缺一项、报价过期、裸号缺值或区间被改动时只保留部分金额", () => {
    for (const change of [
      "missing",
      "omitted",
      "duplicate",
      "wrong-asset",
      "expired",
      "bare",
      "tampered",
      "fake-total",
      "similar-as-priced",
    ]) {
      const { equipment, pet, bare, combine } = fixture();
      if (change === "missing")
        equipment.items.push({
          ...equipment.items[0],
          key: "missing",
          candidates: [],
          similarEstimate: undefined,
        });
      if (change === "omitted") equipment.items = [];
      if (change === "duplicate") equipment.items.push(equipment.items[0]);
      if (change === "wrong-asset") equipment.items[0].description += "\n气血：999";
      if (change === "expired") pet.searchedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
      if (change === "bare") bare.model_value = null;
      if (change === "tampered") equipment.items[0].similarEstimate!.range!.max = 1;
      if (change === "fake-total") equipment.total = equipment.knownTotal = 100;
      if (change === "similar-as-priced") {
        equipment.items[0].status = "priced";
        equipment.items[0].referencePrice = 120;
        equipment.total = equipment.knownTotal = 120;
      }
      const result = combine();
      expect(result.estimated_value_range).toBeUndefined();
      expect(result.estimated_price_difference).toBeUndefined();
      expect(result.price_difference).toBeNull();
    }
  });
  it("AI只解释保存的区间，不能把区间冒充精确价或修改结论", () => {
    const { record, profile, equipment, pet } = fixture();
    const doc = buildProductDocument(record);
    expect(valuationPrompt(doc, record, profile, equipment, pet)).toContain(
      '"estimated_value_range"',
    );
    const raw = JSON.stringify({
      decision: "NEED_INFO",
      reason: "挂牌低于相近配置参考区间，需核对样本差异。",
      extracted_facts: [],
    });
    const result = validateValuation(raw, doc, record, profile, equipment, pet).valuation!;
    expect(result.estimated_value_range).toBeDefined();
    expect(result.model_value).toBeNull();
    expect(() =>
      validateValuation(raw.replace("NEED_INFO", "BUY"), doc, record, profile, equipment, pet),
    ).toThrow("结论不一致");
  });
});
