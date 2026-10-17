import { expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { equipmentQuery } from "./browser-equipment-source";
import {
  equipmentCoreInitial,
  equipmentInventory,
  searchEquipmentPrices,
  verifyEquipmentCandidate,
} from "./equipment-pricing";
import { createProfile, DEFAULT_SETTINGS } from "./profile";
import { validateExactPricing } from "./pricing-integrity";
import { equipmentWeaponTotalDamage, parseEquipmentAttributes } from "./equip-attributes";
import { matchInitialSearchEquipmentAttributes } from "./equipment-match";

it("前五条口径不额外排除未搜索的套装或较高防御，已填写套装仍须匹配", () => {
  const target = parseEquipmentAttributes("等级70\n气血140\n防御38");
  const quoted = parseEquipmentAttributes("等级70\n气血140\n防御55\n套装效果：变身术之如意仙子");
  expect(matchInitialSearchEquipmentAttributes(target, quoted).reason).toBeNull();
  const suited = parseEquipmentAttributes("等级70\n气血140\n套装效果：变身术之如意仙子");
  expect(matchInitialSearchEquipmentAttributes(suited, quoted).reason).toBeNull();
  expect(matchInitialSearchEquipmentAttributes(suited, target).reason).toContain("套装");
  expect(
    matchInitialSearchEquipmentAttributes(
      parseEquipmentAttributes("等级70\n气血140\n特效：简易"),
      parseEquipmentAttributes("等级70\n气血140\n特效：精致 简易"),
    ).reason,
  ).toBeNull();
});

function record() {
  const value = valuationRecord("initial-search");
  value.listing.serverId = "1";
  value.detail!.equipmentCapture = {
    version: 1,
    complete: true,
    issues: [],
    collectedAt: value.detail!.collectedAt,
  };
  value.detail!.tabs.push({
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
        name: "测试剑",
        category: "人物装备 · 剑",
        kindId: "6",
        description: "等级100\n伤害632\n宝石：太阳石\n锻炼等级5",
      },
      {
        index: 1,
        kind: "equipment",
        name: "测试灵饰",
        category: "灵饰 · 戒指",
        kindId: "61",
        description: "等级100\n防御20\n精炼等级0\n附加属性：\n速度8",
      },
    ],
  });
  return value;
}

it("用户选择玉魄待查后不调用玉魄查询；不含玉魄的装备报价身份保持不变", async () => {
  const value = record();
  const settings = { ...DEFAULT_SETTINGS, pricingScope: "equipment" as const };
  const before = equipmentInventory(value, settings).inputHash;
  expect(equipmentInventory(value, { ...settings, deferJade: true }).inputHash).toBe(before);
  value.detail!.tabs.at(-1)!.items!.push({
    index: 2,
    kind: "equipment",
    name: "上古玉魄·阳",
    modelId: "61717",
    category: "上古玉魄",
    description: "上古玉魄·阳\n效形：伤害",
  });
  const deferred = { ...settings, deferJade: true };
  expect(createProfile("scope", deferred).settings.deferJade).toBe(true);
  expect(equipmentInventory(value, deferred).inputHash).not.toBe(
    equipmentInventory(value, settings).inputHash,
  );
  const findCandidates = vi.fn(async (items: ReturnType<typeof equipmentInventory>["items"]) => ({
    queries: ["本地测试"],
    items: items.map((item) => ({
      key: item.key,
      candidates: [],
      searchState: "completed" as const,
    })),
    searchItems: items.map((item) => ({ key: item.key, mode: "base-attributes", exhausted: true })),
  }));
  const snapshot = await searchEquipmentPrices(
    value,
    new AbortController().signal,
    { findCandidates, readSource: vi.fn() },
    deferred,
  );
  expect(findCandidates.mock.calls.flatMap(([items]) => items.map((item) => item.name))).toEqual([
    "测试剑",
  ]);
  expect(snapshot.items.find((item) => item.name === "上古玉魄·阳")).toMatchObject({
    referencePrice: null,
    searchState: "skipped",
    skipReason: expect.stringContaining("用户确认本轮上古玉魄待查"),
  });
});

it.each([
  ["剑", "伤害632\n宝石：太阳石\n锻炼等级5", "init_damage_raw", "初伤", 592],
  ["衣服", "防御260\n宝石：月亮石\n锻炼等级5", "init_defense", "初防", 200],
  ["头盔", "防御110\n宝石：月亮石\n锻炼等级5", "init_defense", "初防", 50],
  ["项链", "灵力190\n宝石：舍利子\n锻炼等级5", "init_wakan", "初灵", 160],
  ["腰带", "气血500\n宝石：光芒石\n锻炼等级5", "init_hp", "初血", 300],
  ["鞋子", "敏捷40\n速度40\n宝石：黑宝石\n锻炼等级5", "init_dex", "初敏", 40],
] as const)("%s使用扣宝石后的%s作为唯一核心下限", (category, stats, control, label, initial) => {
  const target = {
    ...equipmentInventory(record()).items[0],
    category,
    kindId: "6",
    description: "等级100\n" + stats,
  };
  expect(equipmentCoreInitial(target)).toMatchObject({ control, label, value: initial });
  const query = equipmentQuery(
    target,
    { kinds: [[6, category]], effects: [], skills: [], gems: [] },
    "1",
  );
  expect(query.args[control]).toBe(initial);
  expect(query.args).not.toHaveProperty("gem_level");
});

it.each([591, 592, 593, 594, 595])("下限592只采用至594的详情：初伤%s", (initial) => {
  const item = equipmentInventory(record()).items[0];
  const text = `测试剑\n等级100\n伤害${initial}\n挂牌价：¥100\n在售`;
  const result = verifyEquipmentCandidate(
    item,
    {
      url: "https://xyq.cbg.163.com/equip?s=1&eid=equal-check",
      title: "测试剑",
      price: 100,
      priceType: "listing",
      quote: text,
      verified: false,
      reason: "",
      fetchedAt: null,
      sourceHash: null,
    },
    `<main data-cbg-kind-id="6"><h1>测试剑</h1><pre>${text}</pre></main>`,
    new Date().toISOString(),
  );
  expect(result.verified, result.reason).toBe(initial >= 592 && initial <= 594);
});

it.each([55, 56, 57, 58, 59])("黑魔冠目标初防56，2点差值边界：样品%s", (initial) => {
  const target = {
    ...equipmentInventory(record()).items[0],
    name: "黑魔冠",
    category: "人物装备 · 男头",
    kindId: "17",
    level: 80,
    description: "等级 80\n魔法 +86 防御 +128\n锻炼等级 6 镶嵌宝石 月亮石",
  };
  const text = `黑魔冠\n等级80\n防御${initial}\n挂牌价：¥888\n在售`;
  const result = verifyEquipmentCandidate(
    target,
    {
      url: "https://xyq.cbg.163.com/equip?s=1&eid=black-cap-tolerance",
      title: "黑魔冠",
      price: 888,
      priceType: "listing",
      quote: text,
      verified: false,
      reason: "",
      fetchedAt: null,
      sourceHash: null,
    },
    `<main data-cbg-kind-id="17"><h1>黑魔冠</h1><pre>${text}</pre></main>`,
    new Date().toISOString(),
  );
  expect(result.verified, result.reason).toBe(initial >= 56 && initial <= 58);
});

it.each([
  ["伤害388\n命中451", 388, 500.75],
  ["伤害428\n命中451\n宝石：太阳石\n锻炼等级5", 388, 500.75],
  ["伤害388\n命中576\n宝石：红玛瑙\n锻炼等级5", 388, 500.75],
])("武器先扣宝石，再按4点命中折1伤害；整数查询不改原值：%s", (stats, raw, combined) => {
  const target = { ...equipmentInventory(record()).items[0], description: "等级100\n" + stats };
  expect(equipmentWeaponTotalDamage(parseEquipmentAttributes(target.description))).toBe(combined);
  expect(equipmentCoreInitial(target)).toMatchObject({ value: raw, combinedValue: combined });
  const { args } = equipmentQuery(
    target,
    { kinds: [[6, "剑"]], effects: [], skills: [], gems: [] },
    "1",
  );
  expect(args).toMatchObject({ init_damage_raw: raw, all_damage: 500 });
  expect(args).not.toHaveProperty("damage");
  expect(args).not.toHaveProperty("init_damage");
});

it("命中未知时不按零计算或编造总伤", () => {
  expect(equipmentWeaponTotalDamage(parseEquipmentAttributes("等级100\n伤害388"))).toBeNull();
});

it("初伤423与总伤519.25含义分开，两个条件同时提交而总伤下限取整", () => {
  const item = {
    ...equipmentInventory(record()).items[0],
    description: "等级100\n伤害503\n命中385\n锻炼等级10\n镶嵌宝石 太阳石",
  };
  expect(equipmentCoreInitial(item)).toMatchObject({ value: 423, combinedValue: 519.25 });
  expect(equipmentWeaponTotalDamage(parseEquipmentAttributes(item.description))).toBe(519.25);
  expect(
    equipmentQuery(item, { kinds: [[6, "剑"]], effects: [], skills: [], gems: [] }, "1").args,
  ).toMatchObject({ init_damage_raw: 423, all_damage: 519 });
});

it.each([450, 451, 459, 460])("武器未取整的总伤也执行2点范围：命中%s", (hit) => {
  const target = {
    ...equipmentInventory(record()).items[0],
    description: "等级100\n伤害388\n命中451",
  };
  const text = `测试剑\n等级100\n伤害388\n命中${hit}\n挂牌价：¥100\n在售`;
  const result = verifyEquipmentCandidate(
    target,
    {
      url: "https://xyq.cbg.163.com/equip?s=1&eid=hit-check",
      title: "测试剑",
      price: 100,
      priceType: "listing",
      quote: text,
      verified: false,
      reason: "",
      fetchedAt: null,
      sourceHash: null,
    },
    `<main data-cbg-kind-id="6"><h1>测试剑</h1><pre>${text}</pre></main>`,
    new Date().toISOString(),
  );
  expect(result.verified, result.reason).toBe(hit >= 451 && hit <= 459);
});

it("人物装备范围冻结配置，灵饰待查且不调用其查询；恢复全范围时重新查询", async () => {
  const value = record();
  const settings = { ...DEFAULT_SETTINGS, pricingScope: "equipment" as const };
  const profile = createProfile("scope", settings);
  expect(profile).toMatchObject({ equipmentSearch: true, petSearch: false, petGearSearch: false });
  expect(profile.hash).not.toBe(createProfile("scope", DEFAULT_SETTINGS).hash);
  const findCandidates = vi.fn(async (items: ReturnType<typeof equipmentInventory>["items"]) => ({
    queries: ["本地测试"],
    items: items.map((item) => ({
      key: item.key,
      candidates: [],
      searchState: "completed" as const,
    })),
    searchItems: items.map((item) => ({ key: item.key, mode: "base-attributes", exhausted: true })),
  }));
  const source = { findCandidates, readSource: vi.fn() };
  const snapshot = await searchEquipmentPrices(
    value,
    new AbortController().signal,
    source,
    settings,
  );
  expect(findCandidates.mock.calls[0][0].map((item) => item.name)).toEqual(["测试剑"]);
  expect(snapshot.items[1]).toMatchObject({
    searchState: "skipped",
    referencePrice: null,
    skipReason: expect.stringContaining("灵饰待查"),
  });
  expect(validateExactPricing(snapshot, equipmentInventory(value, settings).items)).toBe(true);
  await searchEquipmentPrices(
    value,
    new AbortController().signal,
    source,
    DEFAULT_SETTINGS,
    snapshot,
  );
  expect(findCandidates.mock.calls[1][0].map((item) => item.name)).toEqual(["测试剑", "测试灵饰"]);
});
