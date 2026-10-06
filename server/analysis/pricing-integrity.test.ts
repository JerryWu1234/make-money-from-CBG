import { describe, expect, it } from "vite-plus/test";
import type {
  EquipmentCandidate,
  EquipmentPricingItem,
  EquipmentPricingSnapshot,
} from "./equipment-pricing";
import type { PetPricingItem } from "./pet-pricing";
import { inventoryMatchesSnapshot, validateExactPricing } from "./pricing-integrity";

const now = Date.parse("2026-10-05T12:00:00.000Z");
const item = (key = "gear:0"): EquipmentPricingItem => ({
  key,
  name: "测试腰带",
  level: 100,
  category: "腰带",
  modelId: "10001",
  description: "等级：100\n防御：50\n气血：250",
  query: "",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
});
const candidate = (price: number, eid: string): EquipmentCandidate => ({
  url: "https://xyq.cbg.163.com/equip?s=1&eid=" + eid,
  title: "测试腰带",
  price,
  priceType: "listing",
  quote: "挂牌价：" + price,
  verified: true,
  matchType: "exact",
  reason: "已核实主商品",
  sourceHash: "source-" + eid,
  fetchedAt: new Date(now).toISOString(),
});
const snapshot = (items: EquipmentPricingItem[] = []): EquipmentPricingSnapshot => ({
  version: 1,
  inputHash: "input",
  searchedAt: new Date(now).toISOString(),
  provider: "browser",
  model: "browser",
  queries: [],
  rawResponse: null,
  captureComplete: true,
  total: 0,
  knownTotal: 0,
  items,
  issues: [],
});
const priced = (key = "gear:0") => ({
  ...item(key),
  status: "priced" as const,
  referencePrice: 120,
  candidates: [candidate(100, "one"), candidate(120, "two"), candidate(140, "three")],
});
const complete = () => ({ ...snapshot([priced()]), knownTotal: 120, total: 120 });

describe("精确查价快照完整性", () => {
  it("路径与查询身份冲突、非商品路径或带端口/凭据的链接不能支撑精确中位数", () => {
    for (const url of [
      (index: number) => "https://xyq.cbg.163.com/equip/1/same?s=1&eid=alias-" + index,
      (index: number) => "https://xyq.cbg.163.com/recommend?s=1&eid=alias-" + index,
      (index: number) => "https://xyq.cbg.163.com:8443/equip?s=1&eid=alias-" + index,
      (index: number) => "https://user:pass@xyq.cbg.163.com/equip?s=1&eid=alias-" + index,
    ]) {
      const source = complete();
      source.items[0].candidates = source.items[0].candidates.map((value, index) => ({
        ...value,
        url: url(index),
      }));
      expect(validateExactPricing(source, [item()], now)).toBe(false);
    }
    const conflict = complete();
    conflict.items[0].candidates = conflict.items[0].candidates.map((value, index) => ({
      ...value,
      url: "https://xyq.cbg.163.com/equip/1/same?track=" + index,
    }));
    expect(validateExactPricing(conflict, [item()], now)).toBe(false);
    const duplicate = complete();
    duplicate.items[0].candidates.push({
      ...candidate(100, "one"),
      url: "https://xyq.cbg.163.com/equip/1/one?s=1&eid=one&track=same-product",
    });
    expect(validateExactPricing(duplicate, [item()], now)).toBe(true);
  });

  it("当前资料不完整、不支持或不可交易的资产不能被快照改成可定价", () => {
    for (const status of ["incomplete", "unsupported", "untradable"] as const) {
      const inventory = [{ ...item(), status, issues: ["当前资产仍不可查价"] }];
      const unchanged = { ...snapshot(inventory), total: null };
      expect(validateExactPricing(unchanged, inventory, now)).toBe(true);
      expect(validateExactPricing({ ...unchanged, total: 0 }, inventory, now)).toBe(false);
      expect(validateExactPricing(complete(), inventory, now)).toBe(false);
      const similar = {
        ...snapshot([
          {
            ...item(),
            candidates: priced().candidates.map((value) => ({
              ...value,
              matchType: "similar" as const,
            })),
          },
        ]),
        total: null,
      };
      expect(validateExactPricing(similar, inventory, now)).toBe(false);
    }
  });

  it("按有效精确报价复算中位数、小计与总计，完整空库存计0", () => {
    expect(validateExactPricing(complete(), [item()], now)).toBe(true);
    expect(validateExactPricing(snapshot(), [], now)).toBe(true);
    const even = complete();
    even.items[0].candidates = [candidate(100, "one"), candidate(141.11, "two")];
    even.items[0].referencePrice = even.total = even.knownTotal = 120.56;
    expect(validateExactPricing(even, [item()], now)).toBe(true);
  });

  it("允许合法部分小计，但缺价或相近报价不能伪装成精确总价", () => {
    const partial = snapshot([priced(), item("gear:1")]);
    partial.knownTotal = 120;
    partial.total = null;
    expect(validateExactPricing(partial, [item(), item("gear:1")], now)).toBe(true);
    partial.total = 120;
    expect(validateExactPricing(partial, [item(), item("gear:1")], now)).toBe(false);
    const similar = complete();
    similar.items[0].candidates = similar.items[0].candidates.map((value) => ({
      ...value,
      matchType: "similar",
    }));
    expect(validateExactPricing(similar, [item()], now)).toBe(false);
    const legacy = complete();
    legacy.items[0].candidates = legacy.items[0].candidates.map((value) => ({
      ...value,
      matchType: undefined,
    }));
    expect(validateExactPricing(legacy, [item()], now)).toBe(true);
  });

  it("删除、复制、错配资产或改动宠物技能/随身装备均不能冒充完整库存", () => {
    const source = snapshot([item(), item("gear:1")]);
    const inventory = [item(), item("gear:1")];
    expect(inventoryMatchesSnapshot(source, inventory)).toBe(true);
    for (const items of [
      [],
      [item()],
      [item(), item()],
      [item(), item("other")],
      [item(), { ...item("gear:1"), description: "气血：999" }],
    ])
      expect(inventoryMatchesSnapshot({ ...source, items }, inventory)).toBe(false);
    expect(inventoryMatchesSnapshot(snapshot([item(), item()]), [item(), item()])).toBe(false);
    const pet: PetPricingItem = {
      ...item("pet:0"),
      fields: [{ name: "成长", value: "1.2" }],
      skills: ["连击"],
      innerSkills: [{ name: "阴伤", level: "3" }],
      equipment: [{ name: "项圈", description: "速度+20" }],
    };
    expect(inventoryMatchesSnapshot(snapshot([pet]), [pet])).toBe(true);
    for (const changed of [
      { ...pet, skills: ["吸血"] },
      { ...pet, fields: [{ name: "成长", value: "1.3" }] },
      { ...pet, innerSkills: [] },
      { ...pet, equipment: [] },
    ])
      expect(inventoryMatchesSnapshot(snapshot([changed]), [pet])).toBe(false);
  });

  it("金额改动、未定价项残留金额或不完整采集总计都会被拒绝", () => {
    for (const change of ["reference", "known", "total", "capture"]) {
      const source = complete();
      if (change === "reference") source.items[0].referencePrice = 121;
      if (change === "known") source.knownTotal = 121;
      if (change === "total") source.total = 121;
      if (change === "capture") source.captureComplete = false;
      expect(validateExactPricing(source, [item()], now)).toBe(false);
    }
    expect(
      validateExactPricing(
        { ...snapshot([{ ...item(), referencePrice: 20 }]), total: null },
        [item()],
        now,
      ),
    ).toBe(false);
  });

  it("逐条核对日期和官方独立商品来源，重复链接不改变中位数", () => {
    for (const fetchedAt of [
      null,
      "invalid",
      new Date(now - 24 * 3600_000).toISOString(),
      new Date(now + 60_001).toISOString(),
    ]) {
      const source = complete();
      source.items[0].candidates = source.items[0].candidates.map((value) => ({
        ...value,
        fetchedAt,
      }));
      expect(validateExactPricing(source, [item()], now)).toBe(false);
    }
    const duplicate = complete();
    duplicate.items[0].candidates.push({
      ...candidate(100, "one"),
      url: "https://xyq.cbg.163.com/equip/1/one?track=dup",
    });
    expect(validateExactPricing(duplicate, [item()], now)).toBe(true);
    duplicate.items[0].candidates.push(candidate(101, "one"));
    expect(validateExactPricing(duplicate, [item()], now)).toBe(false);
    for (const change of [
      { verified: false },
      { sourceHash: null },
      { quote: "" },
      { quote: "挂牌价：999" },
      { priceType: "unknown" as const },
      { price: NaN },
      { price: Infinity },
      { price: 0 },
      { url: "https://example.com/equip?s=1&eid=one" },
    ]) {
      const source = complete();
      source.items[0].candidates = source.items[0].candidates.map((value) => ({
        ...value,
        ...change,
      }));
      expect(validateExactPricing(source, [item()], now)).toBe(false);
    }
    const expired = complete();
    expired.searchedAt = new Date(now - 24 * 3600_000).toISOString();
    expect(validateExactPricing(expired, [item()], now)).toBe(false);
  });
});
