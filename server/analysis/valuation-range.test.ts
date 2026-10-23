import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { legacyEquipmentPricing } from "../../tests/fixtures/legacy-equipment-pricing";
import {
  equipmentInventory,
  combineEquipmentPricing,
  type EquipmentCandidate,
  type EquipmentPricingSnapshot,
} from "./equipment-pricing";
import { petInventory, combinePetPricing, type PetPricingSnapshot } from "./pet-pricing";
import { buildEquipmentEstimate, buildSimilarEstimate } from "./pricing-estimate";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import { applyValuationRange } from "./valuation-range";
import { equipmentExclusion } from "./equipment-exclusion";
import { validateExactPricing } from "./pricing-integrity";
import { buildProductDocument } from "./product-document";
import { validateValuation, valuationPrompt } from "./valuation-contract";
import { finishPricingSearch } from "./pricing-progress";

it.each(["equipment", "pet"] as const)("无样本%s跳过后只汇总其余资产，并公开未计价项目", (kind) => {
  const value = petMedianFixture();
  const snapshot = kind === "equipment" ? value.equipment : value.pet;
  const skipped = snapshot.items[0];
  Object.assign(skipped, {
    status: "no_match",
    referencePrice: null,
    candidates: [],
    searchState: "completed",
    similarEstimate: undefined,
  });
  finishPricingSearch(snapshot);
  const result = value.combine();
  expect(skipped.searchState).toBe("skipped");
  expect(result.estimate_missing_count).toBe(0);
  expect(result.estimated_value).toBe(value.bare.model_value! + (kind === "equipment" ? 900 : 100));
  expect(result.excluded_assets).toContainEqual({
    key: skipped.key,
    name: skipped.name,
    reason: "无样本，未计入参考合计",
  });
  expect(result.missing_fields.join(" ")).not.toContain(skipped.name + "：");
  expect(result.items.find((item) => item.name.includes(skipped.key))?.amount).toBeNull();
  expect(result.reason).toContain("市场售价未知");
});

it("专用装备排除后保留裸号参考报价，金额未知且列明排除原因", () => {
  const value = fixture();
  value.record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].description +=
    "\n玩家123专用";
  const inventory = equipmentInventory(value.record);
  value.equipment.inputHash = inventory.inputHash;
  value.equipment.items = inventory.items;
  finishPricingSearch(value.equipment);
  const result = value.combine();
  expect(result.estimate_missing_count).toBe(0);
  expect(result.estimated_value).toBe(value.bare.model_value);
  expect(result.excluded_assets).toContainEqual({
    key: inventory.items[0].key,
    name: inventory.items[0].name,
    reason: "专用或绑定装备，未计入参考合计",
  });
  expect(
    result.items.find((item) => item.name.includes(inventory.items[0].key))?.amount,
  ).toBeNull();
  expect(result.reason).toContain("市场售价未知");
});

it("官网不支持等级的装备排除后保留参考报价并公开原因", () => {
  const value = fixture();
  const original = value.record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0];
  original.description = original.description!.replace("等级：100", "等级：50");
  const inventory = equipmentInventory(value.record);
  value.equipment.inputHash = inventory.inputHash;
  value.equipment.items = inventory.items;
  finishPricingSearch(value.equipment);
  const result = value.combine();
  expect(result.estimate_missing_count).toBe(0);
  expect(result.estimated_value).toBe(value.bare.model_value);
  expect(result.excluded_assets).toContainEqual({
    key: inventory.items[0].key,
    name: inventory.items[0].name,
    reason: "官网检索不支持的等级装备，未计入参考合计",
  });
  expect(inventory.items[0].referencePrice).toBeNull();
});

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
function fixture(serverRank = 10) {
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
    analyzeEquipment: true,
    servers: [
      {
        serverId: record.listing.serverId,
        age: "three",
        rank: serverRank,
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
    analyzeEquipment: true,
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
  const equipment = legacyEquipmentPricing(value.record, profile.settings);
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
it("排除项单价保留未知，合计与剩余缺价分开披露，伪造排除证据拒绝", () => {
  const value = baselineFixture(60);
  const inventory = equipmentInventory(value.record);
  const current = { ...inventory.items[0], searchState: "completed" as const };
  const records = [
    {
      key: current.key,
      searchUrl: "https://xyq.cbg.163.com/cgi-bin/equipquery.py",
      serverAge: "3年以上服",
      modes: ["exact", "similar"].map((mode) => ({
        mode,
        args: { server_type: "3" },
        exhausted: true,
      })),
      scopeEvidence: ["exact", "similar"].map((mode) => ({
        mode,
        request: { serverType: "3", restrictions: {} },
      })),
    },
  ];
  current.exclusion = equipmentExclusion(current, records);
  Object.assign(value.equipment, {
    inputHash: inventory.inputHash,
    items: [current],
    provider: "browser",
    searchItems: records,
    total: null,
    knownTotal: 0,
  });
  const result = value.combine();
  expect(current.referencePrice).toBeNull();
  expect(result.excluded_assets).toEqual([
    { key: current.key, name: current.name, reason: "无匹配，未计入参考合计" },
  ]);
  expect(result.estimate_missing_count).toBe(0);
  expect(result.estimated_value).toBe(value.bare.model_value);
  expect(result.model_value).toBeNull();
  expect(result.items.at(-1)?.amount).toBeNull();
  expect(result.items.at(-1)?.referenceBasis).toBe("excluded");
  records[0].modes[1].exhausted = false;
  expect(validateExactPricing(value.equipment, inventory.items)).toBe(false);
});

function petMedianFixture() {
  const value = fixture();
  const equipment = value.equipment.items[0];
  equipment.status = "priced";
  equipment.referencePrice = 100;
  equipment.candidates = [{ ...candidates()[0], matchType: "exact" }];
  equipment.similarEstimate = undefined;
  value.equipment.total = value.equipment.knownTotal = 100;
  const tab = value.record.detail!.tabs.find((row) => row.name === "召唤兽/孩子")!;
  tab.petCount = 1;
  tab.pets = [
    {
      index: 0,
      name: "泡泡",
      fields: Object.entries({
        类型: "泡泡",
        等级: "1",
        成长: "1.2",
        攻击资质: "1200",
        防御资质: "1200",
        体力资质: "3000",
        法力资质: "1500",
        速度资质: "1000",
        躲闪资质: "1000",
      }).map(([name, value]) => ({ name, value })),
      skills: [],
      innerSkills: [],
      equipment: [
        { index: 0, kind: "equipment", name: "宝宝项圈", description: "等级：85\n速度：30" },
      ],
    },
  ];
  const inventory = petInventory(value.record);
  const sourceCandidates = candidates([900, 1000, 1100]);
  Object.assign(value.pet, {
    inputHash: inventory.inputHash,
    total: null,
    items: inventory.items.map((item) => ({
      ...item,
      candidates: sourceCandidates,
      similarEstimate: buildSimilarEstimate(sourceCandidates),
    })),
    gearPricing: {
      ...value.equipment,
      inputHash: "separate-gear-cross-check",
      accounting: "宝宝挂牌已包含穿戴装备；装备单独查价只作交叉核对，不重复相加",
      total: 500,
      knownTotal: 500,
      items: [
        {
          ...equipment,
          key: "召唤兽/孩子:0:gear:0",
          petKey: "召唤兽/孩子:0",
          petName: "泡泡",
          accessory: false,
          referencePrice: 500,
          candidates: [{ ...candidates([500])[0], matchType: "exact" }],
        },
      ],
    },
  });
  return value;
}
describe("已知小计保留完整裸号的区服调整", () => {
  it.each(["pending", "exact-pending", "similar-pending", "similar"])(
    "%s 使用完整裸号估值，再组合已核验资产与参考区间",
    (mode) => {
      const value = fixture(2);
      expect(value.bare.model_value).not.toBeNull();
      expect(value.bare.model_value).not.toBe(value.bare.known_subtotal);
      const first = value.equipment.items[0];
      if (mode.endsWith("-pending")) {
        const tab = value.record.detail!.tabs.find((row) => row.name === "道具/法宝")!;
        tab.items!.push({ ...tab.items![0], index: 1 });
        const inventory = equipmentInventory(value.record);
        value.equipment.inputHash = inventory.inputHash;
        value.equipment.items.push(inventory.items[1]);
      }
      if (mode === "pending") {
        first.candidates = [];
        first.similarEstimate = undefined;
      } else if (mode === "exact-pending") {
        first.status = "priced";
        first.referencePrice = 100;
        first.candidates = [{ ...candidates()[0], matchType: "exact" }];
        first.similarEstimate = undefined;
        value.equipment.knownTotal = 100;
      } else first.similarEstimate = buildEquipmentEstimate(first.candidates);
      const result = value.combine();
      const knownAssets = mode === "exact-pending" ? 100 : 0;
      expect(result.known_subtotal).toBeCloseTo(value.bare.model_value! + knownAssets);
      expect(result.estimate_missing_count).toBe(mode === "similar" ? 0 : 1);
      if (mode.startsWith("similar")) {
        expect(result.estimated_subtotal_range).toEqual({
          min: value.bare.model_value! + 100,
          max: value.bare.model_value! + 140,
        });
        expect(result.estimated_subtotal_value).toBe(value.bare.model_value! + 100);
      }
      if (mode !== "similar") expect(result.estimated_value_range).toBeUndefined();
    },
  );

  it.each([false, true])("裸号未完整时保留已确认分项小计（有参考价：%s）", (similar) => {
    const value = fixture(2);
    const knownBare = value.bare.known_subtotal;
    value.bare.model_value = null;
    if (!similar) {
      value.equipment.items[0].candidates = [];
      value.equipment.items[0].similarEstimate = undefined;
    }
    const result = value.combine();
    expect(result.known_subtotal).toBe(knownBare);
    expect(result.estimated_value_range).toBeUndefined();
    if (similar)
      expect(result.estimated_subtotal_range).toEqual({
        min: knownBare + 100,
        max: knownBare + 140,
      });
  });
});
it("采用参考区间后按最终资产身份重建缺项，同名另一件仍保留", () => {
  const value = fixture();
  const tab = value.record.detail!.tabs.find((row) => row.name === "道具/法宝")!;
  tab.items!.push({ ...tab.items![0], index: 1 });
  const inventory = equipmentInventory(value.record);
  value.equipment.inputHash = inventory.inputHash;
  value.equipment.items.push(inventory.items[1]);
  const partial = value.combine();
  expect(partial.estimate_missing_count).toBe(1);
  expect(partial.missing_fields).toHaveLength(1);
  expect(partial.missing_fields[0]).toContain("测试腰带（道具/法宝:1）");
  expect(partial.missing_fields[0]).not.toContain("道具/法宝:0");
  const output = validateValuation(
    JSON.stringify({ decision: "NEED_INFO", reason: "只剩第二件缺价", extracted_facts: [] }),
    buildProductDocument(value.record),
    value.record,
    value.profile,
    value.equipment,
    value.pet,
  );
  expect(output.missingData).toEqual(partial.missing_fields);
  value.equipment.items[1].candidates = candidates();
  value.equipment.items[1].similarEstimate = buildSimilarEstimate(candidates());
  const complete = value.combine();
  expect(complete.estimate_missing_count).toBe(0);
  expect(complete.missing_fields).toEqual(value.bare.missing_fields);
  expect(complete.next_action).not.toContain("剩余未定价");
  expect(complete.suggestions).not.toContain(
    "查看装备查价模块的候选与匹配原因；可靠同类报价不足时继续保留未定价。",
  );
});

describe("最终缺项的恢复建议与数量", () => {
  it.each(["equipment-expired", "equipment-capture", "pet-expired", "pet-capture"])(
    "保留查价层可执行的恢复建议：%s",
    (change) => {
      const value = fixture();
      let action: string;
      if (change === "equipment-expired") {
        value.equipment.searchedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
        action = "开始新批次重新联网查价；继续旧批次会保留当时的搜索快照。";
      } else if (change === "equipment-capture") {
        value.record.detail!.equipmentCapture!.complete = false;
        action = "先在采集页补齐当前装备资料，再开始联网分析。";
      } else if (change === "pet-expired") {
        value.pet.searchedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
        action = "开始新批次重新查宝宝价格；旧批次保留当时快照。";
      } else {
        value.record.detail!.petCapture!.complete = false;
        action = "先补采完整宝宝数量、技能、资质、内丹及随身装备，再开始分析。";
      }
      const result = value.combine();
      expect(result.suggestions).toContain(action);
      expect(result.next_action).toContain(action);
      expect(result.estimate_missing_count).toBeGreaterThan(0);
      if (change.startsWith("pet-")) {
        expect(result.estimated_subtotal_range).toBeDefined();
        expect(result.suggestions).not.toContain(
          "查看装备查价模块的候选与匹配原因；可靠同类报价不足时继续保留未定价。",
        );
      } else expect(result.estimated_subtotal_range).toBeUndefined();
    },
  );

  it("宝宝参考价已全部采用时，只移除宝宝缺价提示，装备仍提示查价", () => {
    const value = fixture();
    value.equipment.items[0].candidates = [];
    value.equipment.items[0].similarEstimate = undefined;
    const tab = value.record.detail!.tabs.find((row) => row.name === "召唤兽/孩子")!;
    tab.petCount = 1;
    tab.pets = [
      {
        index: 0,
        name: "泡泡",
        fields: Object.entries({
          类型: "泡泡",
          等级: "1",
          成长: "1.2",
          攻击资质: "1200",
          防御资质: "1200",
          体力资质: "3000",
          法力资质: "1500",
          速度资质: "1000",
          躲闪资质: "1000",
        }).map(([name, value]) => ({ name, value })),
        skills: [],
        innerSkills: [],
        equipment: [],
      },
    ];
    const inventory = petInventory(value.record);
    Object.assign(value.pet, {
      inputHash: inventory.inputHash,
      total: null,
      items: inventory.items.map((item) => ({
        ...item,
        candidates: candidates(),
        similarEstimate: buildSimilarEstimate(candidates()),
      })),
    });
    const result = value.combine();
    expect(result.estimated_subtotal_range).toBeDefined();
    expect(result.estimate_missing_count).toBe(1);
    expect(result.suggestions).not.toContain(
      "查看宝宝查价的匹配原因；未找到可靠同类报价的宝宝保留未定价。",
    );
    expect(result.suggestions).toContain(
      "查看装备查价模块的候选与匹配原因；可靠同类报价不足时继续保留未定价。",
    );
  });

  it("默认参考价失效仍提示重新建批次", () => {
    const value = baselineFixture();
    value.profile.settings.equipmentBaselinePrices![70].weapon! += 10_000;
    const result = value.combine();
    const action = "默认参考价已失效，请开始新批次按当前资料和设置重新分析。";
    expect(result.suggestions).toContain(action);
    expect(result.next_action).toContain(action);
    expect(result.estimate_missing_count).toBe(1);
    expect(result.estimated_value_range).toBeUndefined();
  });

  it("只有精确报价和未定价资产时，剩余数量与最终缺项一致", () => {
    const value = fixture();
    const tab = value.record.detail!.tabs.find((row) => row.name === "道具/法宝")!;
    tab.items!.push({ ...tab.items![0], index: 1 });
    const inventory = equipmentInventory(value.record);
    value.equipment.inputHash = inventory.inputHash;
    Object.assign(value.equipment.items[0], {
      status: "priced",
      referencePrice: 100,
      candidates: [{ ...candidates()[0], matchType: "exact" }],
      similarEstimate: undefined,
    });
    value.equipment.items.push(inventory.items[1]);
    value.equipment.knownTotal = 100;
    const result = value.combine();
    expect(result.model_value).toBeNull();
    expect(result.estimated_subtotal_range).toBeUndefined();
    expect(result.known_subtotal).toBe(value.bare.model_value! + 100);
    expect(result.missing_fields).toEqual(["测试腰带（道具/法宝:1）：缺少可核验价格"]);
    expect(result.estimate_missing_count).toBe(1);
    expect(result.suggestions).toContain(
      "查看装备查价模块的候选与匹配原因；可靠同类报价不足时继续保留未定价。",
    );
  });
});

describe("旧报告默认装备参考价与挂牌比较", () => {
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
    const updated = legacyEquipmentPricing(value.record, value.profile.settings);
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

  it("新等级跳过规则不采用旧0元默认价，未知60/90/100级价格仍是缺项", () => {
    const { equipment, bare, combine } = baselineFixture(0, false);
    expect(equipment.items[0].status).toBe("unsupported");
    expect(equipment.items[0].baselineEstimate?.kind).toBe("ignored");
    expect(equipment.items[0].baselineEstimate?.amount).toBe(0);
    const result = combine();
    expect(result.estimated_value_range).toBeUndefined();
    expect(result.estimated_price_difference).toBeUndefined();
    expect(result.missing_fields.join(" ")).toContain("快照");
    expect(result.model_value).toBeNull();
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
    Object.assign(value.equipment, legacyEquipmentPricing(value.record, value.profile.settings));
    expect(value.equipment.items[0].baselineEstimate?.source.basis).toBe("preset");
    expect(value.combine().reason).toContain("人工预设价");
  });
});

describe("相近配置报价与完整区间", () => {
  it("相近装备的五件最低价进入完整参考金额，不能取均价或采纳中断样本", () => {
    const value = fixture();
    const item = value.equipment.items[0];
    item.candidates = candidates([100, 110, 120, 130, 145]);
    item.similarEstimate = buildEquipmentEstimate(item.candidates);
    item.searchState = "completed";
    const result = value.combine();
    expect(result.estimated_value).toBe(value.bare.model_value! + 100);
    expect(result.estimated_value_range).toEqual({
      min: value.bare.model_value! + 100,
      max: value.bare.model_value! + 145,
    });
    expect(result.estimate_missing_count).toBe(0);
    item.searchState = "pending";
    const pending = value.combine();
    expect(pending.estimated_value).toBeUndefined();
    expect(pending.estimated_value_range).toBeUndefined();
    expect(pending.estimate_missing_count).toBe(1);
    item.searchState = "completed";
    item.similarEstimate.average = 120;
    expect(value.combine().estimated_value).toBeUndefined();
  });
  it.each([false, true])(
    "宝宝最低价与装备参考汇总一次，穿戴装备交叉价不另加（装备相近：%s）",
    (similarEquipment) => {
      const value = petMedianFixture();
      if (similarEquipment) {
        const item = value.equipment.items[0];
        item.status = "no_match";
        item.referencePrice = null;
        item.candidates = candidates();
        item.similarEstimate = buildEquipmentEstimate(item.candidates);
        value.equipment.total = null;
        value.equipment.knownTotal = 0;
      }
      const result = value.combine();
      expect(result.estimated_value).toBe(value.bare.model_value! + 100 + 900);
      expect(result.estimated_pet_range).toEqual({ min: 900, max: 1100 });
      expect(result.estimated_value_range).toEqual({
        min: value.bare.model_value! + 1000,
        max: value.bare.model_value! + (similarEquipment ? 1240 : 1200),
      });
      expect(result.known_subtotal).toBe(value.bare.model_value! + (similarEquipment ? 0 : 100));
      expect(result.model_value).toBeNull();
      expect(result.pet_value).toBeNull();
      expect(result.estimate_missing_count).toBe(0);
      expect(result.pet_pricing!.gearPricing!.total).toBe(500);
      expect(result.pet_pricing!.items[0].candidates[0].differences).toEqual(
        candidates()[0].differences,
      );
    },
  );

  it.each(["pending-pet", "bare"])(
    "宝宝参考最低价可进部分小计，但 %s 不补齐完整整号价格",
    (change) => {
      const value = petMedianFixture();
      if (change === "pending-pet") {
        const tab = value.record.detail!.tabs.find((row) => row.name === "召唤兽/孩子")!;
        tab.pets!.push({ ...structuredClone(tab.pets![0]), index: 1 });
        tab.petCount = 2;
        const inventory = petInventory(value.record);
        value.pet.inputHash = inventory.inputHash;
        value.pet.items.push(inventory.items[1]);
      } else value.bare.model_value = null;
      const result = value.combine();
      const knownBare = value.bare.model_value ?? value.bare.known_subtotal;
      expect(result.estimated_subtotal_value).toBe(knownBare + 1000);
      expect(result.estimated_subtotal_range).toEqual({
        min: knownBare + 1000,
        max: knownBare + 1200,
      });
      expect(result.estimate_missing_count).toBe(1);
      expect(result.estimated_value).toBeUndefined();
      expect(result.estimated_value_range).toBeUndefined();
      expect(result.estimated_price_difference).toBeUndefined();
      expect(result.reason).toContain("不能作为完整估值");
    },
  );

  it.each(["expired", "old-policy", "tampered", "pending", "read_failed"])(
    "宝宝 %s 样本不能形成完整参考金额",
    (change) => {
      const value = petMedianFixture();
      const item = value.pet.items[0];
      if (change === "pending" || change === "read_failed") item.searchState = change;
      if (change === "expired")
        item.candidates[2].fetchedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
      if (change === "old-policy")
        item.similarEstimate!.policyVersion = "partial-current-skills-v2";
      if (change === "tampered") item.similarEstimate!.median = 999999;
      const result = value.combine();
      expect(result.known_subtotal).toBe(value.bare.model_value! + 100);
      expect(result.estimated_subtotal_value).toBeUndefined();
      expect(result.estimated_value).toBeUndefined();
      expect(result.estimated_value_range).toBeUndefined();
      expect(result.estimate_missing_count).toBe(1);
    },
  );

  it("已完成查询的少样本和分散样本采用实际平均值，重复商品不凑数", () => {
    expect(buildEquipmentEstimate(candidates([350]))).toMatchObject({
      status: "range",
      sampleCount: 1,
      average: 350,
    });
    expect(buildEquipmentEstimate(candidates([350, 371]))).toMatchObject({
      average: 360.5,
      sampleCount: 2,
    });
    expect(buildEquipmentEstimate(candidates([350, 370, 568.1]))).toMatchObject({
      status: "range",
      average: 429.37,
    });
    const duplicate = candidates([100, 120, 120]);
    duplicate[2].url = duplicate[1].url;
    expect(buildEquipmentEstimate(duplicate)).toMatchObject({
      status: "range",
      sampleCount: 2,
      average: 110,
    });
    expect(
      buildEquipmentEstimate(candidates().map((row) => ({ ...row, verified: false }))).average,
    ).toBeUndefined();
  });

  it("新装备参考最低价进入参考总值，保持精确金额和挂牌范围分开", () => {
    const { equipment, combine, bare } = fixture();
    equipment.items[0].similarEstimate = buildEquipmentEstimate(equipment.items[0].candidates);
    const result = combine();
    expect(result.estimated_value).toBe(bare.model_value! + 100);
    expect(result.estimated_value_range).toEqual({
      min: bare.model_value! + 100,
      max: bare.model_value! + 140,
    });
    expect(result.known_subtotal).toBe(bare.model_value);
    expect(result.model_value).toBeNull();
    equipment.items[0].similarEstimate.median = 999;
    expect(combine().estimated_value).toBeUndefined();
  });
  it("有装备参考价但宝宝未查到时只给小计，缺项不按零元补总价", () => {
    const { equipment, pet, combine, bare } = fixture();
    equipment.items[0].similarEstimate = buildEquipmentEstimate(equipment.items[0].candidates);
    pet.captureComplete = false;
    const result = combine();
    expect(result.estimated_subtotal_value).toBe(bare.model_value! + 100);
    expect(result.estimated_value).toBeUndefined();
    expect(result.estimated_value_range).toBeUndefined();
    expect(result.estimate_missing_count).toBeGreaterThan(0);
    expect(result.reason).toContain("不能作为完整估值");
  });
  it("同商品别名只算一次，非法商品URL不能提供完整区间", () => {
    const source = candidates([100, 100, 100]);
    const duplicates = source.map((value, index) => ({
      ...value,
      url: "https://xyq.cbg.163.com/equip/1/same?track=" + index,
    }));
    expect(buildSimilarEstimate(duplicates).sampleCount).toBe(1);
    expect(buildSimilarEstimate(duplicates).average).toBe(100);
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
      等级: "1",
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

  it("仅独立在售来源计价，重复或未经核实样本不能凑数", () => {
    expect(buildSimilarEstimate(candidates()).range).toEqual({ min: 100, max: 140 });
    const source = candidates();
    expect(
      buildSimilarEstimate([
        source[0],
        { ...source[0], url: source[0].url + "&track=a" },
        source[1],
      ]).status,
    ).toBe("range");
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
    expect(buildSimilarEstimate(candidates([100, 120, 151])).status).toBe("range");
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

it("一件未采齐不抹掉另一件核实相近装备价格，仍不形成完整整号估值", () => {
  const value = fixture();
  const tab = value.record.detail!.tabs.find((row) => row.name === "道具/法宝")!;
  tab.items!.push({
    index: 1,
    kind: "equipment",
    name: "鬼牙攫魂",
    category: "武器",
    description: "等级70",
  });
  value.record.detail!.equipmentCapture!.complete = false;
  value.record.detail!.equipmentCapture!.issues = ["鬼牙攫魂资料未完整读取"];
  const inventory = equipmentInventory(value.record);
  value.equipment.inputHash = inventory.inputHash;
  value.equipment.captureComplete = false;
  value.equipment.items.push(inventory.items[1]);
  value.equipment.items[0].similarEstimate = buildEquipmentEstimate(
    value.equipment.items[0].candidates,
  );
  const result = value.combine();
  expect(result.estimated_equipment_range).toEqual({ min: 100, max: 140 });
  expect(result.estimated_subtotal_range).toEqual({
    min: value.bare.known_subtotal + 100,
    max: value.bare.known_subtotal + 140,
  });
  expect(result.estimated_value_range).toBeUndefined();
  expect(result.model_value).toBeNull();
  expect(result.estimate_missing_count).toBeGreaterThan(0);
  expect(result.missing_fields.join(" ")).toContain("鬼牙攫魂");
});
