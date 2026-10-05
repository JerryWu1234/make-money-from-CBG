import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import {
  equipmentInventory,
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
