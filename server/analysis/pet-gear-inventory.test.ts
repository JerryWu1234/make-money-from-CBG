import { describe, expect, it } from "vite-plus/test";
import { createHash } from "node:crypto";
import {
  comparePetGear,
  parsePetGearAttributes,
  petGearInventory,
  petGearReference,
  selectPetGearCandidates,
  type PetGearPricingItem,
} from "./pet-gear-inventory";
import type { EquipmentCandidate } from "./equipment-pricing";
import type { SavedRoleRecord } from "../crawler/types";
import { petInventory } from "./pet-pricing";
import { GLOBAL_MARKET_SCOPE_VERSION, MARKET_SEARCH_UI_VERSION } from "./market-scope";

const description =
  "等级 95\n命中率 +13%\n耐久度 113\n耐力 +14 魔力 +13\n套装效果：附加状态高级神佑复生\n镶嵌效果\n+28灵力 镶嵌等级：7";
const target = (text = description): PetGearPricingItem => ({
  key: "pet:1:gear:0",
  petKey: "pet:1",
  petName: "画魂",
  name: "嵌宝金腕",
  level: 95,
  category: "召唤兽装备",
  accessory: false,
  description: text,
  query: "",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
});
const quote = (id: string, price = 200): EquipmentCandidate => ({
  url: "https://xyq.cbg.163.com/equip?s=33&eid=" + id,
  title: "模拟测试宝宝装备",
  price,
  priceType: "listing",
  quote: "【模拟测试】在售\n挂牌价：¥" + price,
  verified: true,
  reason: "模拟测试",
  matchType: "exact",
  fetchedAt: new Date().toISOString(),
  sourceHash: "fixture-hash",
});

describe("通用宝宝装备属性与估值证据", () => {
  it.each([
    [[300, 100, 200], 100],
    [[100, 200, 900], 100],
    [[100.01, 200.04], 100.01],
    [[1050.01, 1050.02], 1050.01],
    [[245.5], 245.5],
  ])("同配置有效挂牌按最低值取值 %j", (prices, expected) => {
    expect(
      petGearReference(prices.map((price, index) => quote("exact-" + index, price))).referencePrice,
    ).toBe(expected);
  });
  it("同商品重复记录只占一个样本，避免偏移同配置最低值", () => {
    expect(
      petGearReference([
        quote("first", 100),
        quote("first", 100),
        quote("second", 200),
        quote("third", 300),
      ]).referencePrice,
    ).toBe(100);
  });
  it.each([
    "pet-gear-trimmed-suit-v2",
    "pet-gear-trimmed-suit-median-v3",
    "pet-gear-trimmed-suit-cent-median-v4",
  ])("五件均价策略不复用旧算法 %s 的输入hash", (comparisonVersion) => {
    const record = { detail: null } as SavedRoleRecord;
    const pets = petInventory(record);
    const gear = petGearInventory(record);
    const previousHash = createHash("sha256")
      .update(
        JSON.stringify({
          marketScope: GLOBAL_MARKET_SCOPE_VERSION,
          searchUI: MARKET_SEARCH_UI_VERSION,
          comparisonVersion,
          inputHash: pets.inputHash,
          items: gear.items,
        }),
      )
      .digest("hex");
    expect(gear.inputHash).not.toBe(previousHash);
  });
  it("区分基础、附加和镶嵌，百分比按实际值读取，未知修理次数不填零", () => {
    expect(parsePetGearAttributes(description)).toMatchObject({
      level: 95,
      stats: { 命中率: 13, 耐力: 14, 魔力: 13 },
      stone: { level: 7, stat: "灵力", value: 28 },
      repairFailed: null,
      issues: [],
    });
    expect(parsePetGearAttributes("等级 25\n速度 +20\n耐久 120")).toMatchObject({
      level: 25,
      stats: { 速度: 20 },
      stone: null,
      issues: [],
    });
    expect(
      parsePetGearAttributes("等级 115\n气血 +150 防御 +110\n耐久度 0\n修理失败 3次"),
    ).toMatchObject({
      level: 115,
      stats: { 气血: 150, 防御: 110 },
      durability: 0,
      repairFailed: 3,
      issues: [],
    });
  });
  it("允许有界属性和相邻一段镶嵌，记录实际差异但不预测折价", () => {
    const source = description
      .replace("+14 魔力 +13", "+12 魔力 +12")
      .replace("+28灵力 镶嵌等级：7", "+24灵力 镶嵌等级：6");
    expect(comparePetGear(target(), "嵌宝金腕", source)).toMatchObject({
      matchType: "similar",
      reason: null,
      differences: expect.arrayContaining([
        expect.stringContaining("耐力"),
        expect.stringContaining("镶嵌"),
      ]),
    });
  });
  it("以配置差异评分排序，数值不变为零，属性与灵石差异均可区分", () => {
    expect(comparePetGear(target(), "嵌宝金腕", description)).toMatchObject({
      matchType: "exact",
      similarityScore: 0,
    });
    const changed = description
      .replace("+14 魔力 +13", "+12 魔力 +12")
      .replace("+28灵力 镶嵌等级：7", "+24灵力 镶嵌等级：6");
    expect(comparePetGear(target(), "嵌宝金腕", changed).similarityScore).toBeCloseTo(31.978, 3);
    const sameLevel = comparePetGear(
      target(),
      "嵌宝金腕",
      description.replace("+28灵力", "+27灵力"),
    );
    expect(sameLevel.similarityScore).toBeCloseTo(3.571, 3);
    expect(sameLevel.differences.join("；")).toContain("+27/7级");
  });
  it.each([
    ["嵌宝金甲", description, "模型"],
    ["嵌宝金腕", description.replace("等级 95", "等级 85"), "等级"],
    ["嵌宝金腕", description.replace("高级神佑复生", "高级魔之心"), "套装"],
    ["嵌宝金腕", description.replace("+14 魔力", "+20 魔力"), "20%"],
    ["嵌宝金腕", description.replace("镶嵌等级：7", "镶嵌等级：5"), "1级"],
    ["嵌宝金腕", description.replace("耐久度 113", "耐久度 0"), "零耐久"],
    ["嵌宝金腕", description + "\n特效：未支持新特效", "未支持"],
  ])("拒绝不同模型或不可确认价格属性 %s", (name, text, reason) => {
    expect(comparePetGear(target(), name, text).reason).toContain(reason);
  });
  it("缺少等级/耐久不转成零，拒绝加入引用价", () => {
    expect(parsePetGearAttributes("速度 +10")).toMatchObject({
      level: null,
      durability: null,
      issues: expect.arrayContaining([
        expect.stringContaining("等级"),
        expect.stringContaining("耐久"),
      ]),
    });
    expect(
      petGearReference([
        { ...quote("old"), fetchedAt: "2000-01-01T00:00:00Z" },
        { ...quote("bad"), verified: false },
        { ...quote("price"), price: 0 },
      ]).referencePrice,
    ).toBeNull();
  });
  it("同商品冲突不取更低价；实际有效样本取最低值", () => {
    expect(petGearReference([quote("same", 200), quote("same", 300)]).referencePrice).toBeNull();
    const similar = { ...quote("similar", 200), matchType: "similar" as const };
    expect(petGearReference([similar])).toMatchObject({
      referencePrice: 200,
      similarEstimate: {
        status: "range",
        observedRange: { min: 200, max: 200 },
        sampleCount: 1,
      },
    });
    expect(
      petGearReference([
        similar,
        { ...quote("second", 220), matchType: "similar" },
        { ...quote("third", 240), matchType: "similar" },
      ]),
    ).toMatchObject({ referencePrice: 200, similarEstimate: { status: "range", sampleCount: 3 } });
  });
  it("相近报价保留官网顺序，不按价格或属性距离删样本", () => {
    const candidates = [
      { ...quote("far", 500), matchType: "similar" as const, similarityScore: 30 },
      { ...quote("close-a", 100), matchType: "similar" as const, similarityScore: 1 },
      { ...quote("close-b", 110), matchType: "similar" as const, similarityScore: 2 },
      { ...quote("close-c", 120), matchType: "similar" as const, similarityScore: 3 },
    ];
    expect(petGearReference(candidates)).toMatchObject({
      referencePrice: 100,
      similarEstimate: { status: "range", sampleCount: 4, range: { min: 100, max: 500 } },
    });
  });
  it("同一商品在不同匹配类别出现冲突也拒绝，不能优先exact抹掉冲突", () => {
    expect(
      petGearReference([quote("same", 200), { ...quote("same", 220), matchType: "similar" }]),
    ).toMatchObject({
      referencePrice: null,
      similarEstimate: { status: "insufficient", range: null },
    });
  });
  it("持久候选保留各组前五件独立商品，始终按官网顺序", () => {
    const exact = [100, 300, 200, 400].map((price, index) => quote("exact-" + index, price));
    const similar = [5, 1, 3, 2, 4].map((score) => ({
      ...quote("similar-" + score, 200 + score * 10),
      matchType: "similar" as const,
      similarityScore: score,
    }));
    const repeated = { ...exact[0], url: "https://xyq.cbg.163.com/equip/33/exact-0?track=alias" };
    expect(
      selectPetGearCandidates([...exact, repeated, ...similar]).map((value) => value.url),
    ).toEqual([...exact, ...similar].map((value) => value.url));
    const legacy = [200, 220, 240, 260, 280].map((price, index) => ({
      ...quote("legacy-" + index, price),
      matchType: "similar" as const,
    }));
    expect(selectPetGearCandidates(legacy)).toEqual(legacy);
    expect(petGearReference(legacy).referencePrice).toBe(200);
  });
  it("最近候选同样逐条核验时效、官方身份、来源、挂牌金额，坏证据不挤掉有效样本", () => {
    const good = [100, 110, 120].map((price, index) => ({
      ...quote("good-" + index, price),
      matchType: "similar" as const,
      similarityScore: index + 20,
    }));
    const invalid = [
      { verified: false },
      { fetchedAt: new Date(Date.now() - 24 * 3600_000).toISOString() },
      { fetchedAt: new Date(Date.now() + 61_000).toISOString() },
      { url: "https://example.com/equip/33/not-official" },
      { sourceHash: null },
      { quote: "挂牌价：¥999" },
      { price: 0 },
      { price: 1e9 + 1, quote: "挂牌价：¥1000000001" },
      { priceType: "unknown" as const },
    ].map((change, index) => ({
      ...quote("invalid-" + index, 100),
      matchType: "similar" as const,
      similarityScore: 0,
      ...change,
    }));
    expect(selectPetGearCandidates([...invalid, ...good])).toEqual(good);
    expect(petGearReference([...invalid, ...good]).referencePrice).toBe(100);
  });
  it("报价冲突保留证据，价格分散也不重选更便宜的样本", () => {
    const closest = [100, 110, 120].map((price, index) => ({
      ...quote("closest-" + index, price),
      matchType: "similar" as const,
      similarityScore: index,
    }));
    const conflict = [500, 501].map((price) => ({
      ...quote("far-conflict", price),
      matchType: "similar" as const,
      similarityScore: 50,
    }));
    const retained = selectPetGearCandidates([...closest, ...conflict]);
    expect(retained).toEqual([...closest, ...conflict]);
    expect(petGearReference([...closest, ...conflict])).toMatchObject({
      referencePrice: null,
      similarEstimate: { status: "insufficient", range: null },
    });
    expect(petGearReference([...retained.slice(0, 3), conflict[1]]).referencePrice).toBe(100);
    const dispersed = [100, 200, 401].map((price, index) => ({
      ...quote("dispersed-" + index, price),
      matchType: "similar" as const,
      similarityScore: index,
    }));
    expect(
      petGearReference([
        ...dispersed,
        { ...quote("cheap-far", 110), matchType: "similar", similarityScore: 50 },
      ]),
    ).toMatchObject({
      referencePrice: 100,
      similarEstimate: { status: "range", sampleCount: 4 },
    });
  });
  it("报价冲突仍保留正常六件证据和第一组冲突，续轮刷新不丢已扫描候选", () => {
    const exact = [100, 200, 300].map((price, index) => quote("keep-exact-" + index, price));
    const similar = [100, 110, 120].map((price, index) => ({
      ...quote("keep-similar-" + index, price),
      matchType: "similar" as const,
      similarityScore: index,
    }));
    const conflict = [500, 501].map((price) => ({
      ...quote("keep-conflict", price),
      matchType: "similar" as const,
      similarityScore: 50,
    }));
    const laterConflict = [600, 601].map((price) => ({
      ...quote("later-conflict", price),
      matchType: "similar" as const,
      similarityScore: 60,
    }));
    const retained = selectPetGearCandidates([...exact, ...similar, ...conflict, ...laterConflict]);
    expect(retained).toEqual([...exact, ...similar, conflict[0], laterConflict[0], conflict[1]]);
    expect(petGearReference(retained).referencePrice).toBeNull();
    expect(petGearReference([...exact, ...similar, conflict[1]]).referencePrice).toBe(100);
    expect(
      selectPetGearCandidates([
        ...exact,
        { ...exact[0], price: 101, quote: "挂牌价：¥101" },
        ...similar,
      ]),
    ).toHaveLength(7);
  });
  it("相似挂牌价分散时取最低值并保留范围", () => {
    expect(
      petGearReference(
        [200, 300, 401].map((price, index) => ({
          ...quote("similar-" + index, price),
          matchType: "similar" as const,
        })),
      ),
    ).toMatchObject({
      referencePrice: 200,
      similarEstimate: { status: "range", sampleCount: 3, range: { min: 200, max: 401 } },
    });
  });
});
