import { createHash } from "node:crypto";
import type { DetailItem, SavedRoleRecord } from "../crawler/types";
import { cleanDescription } from "../crawler/compact";
import { petInventory } from "./pet-pricing";
import { buildEquipmentEstimate } from "./pricing-estimate";
import type {
  EquipmentCandidate,
  EquipmentPricingItem,
  EquipmentPricingSnapshot,
} from "./equipment-pricing";
import {
  GLOBAL_MARKET_SCOPE_VERSION,
  MARKET_SEARCH_UI_VERSION,
  type GlobalMarketRequest,
} from "./market-scope";
import {
  candidateQuoteMatchesPrice,
  officialSourceIdentity,
  priceAverage,
  EQUIPMENT_QUOTE_LIMIT,
  EQUIPMENT_QUOTE_POLICY,
  pricingTimestampFresh,
} from "./pricing-integrity";

export const PET_GEAR_ACCOUNTING = "宝宝挂牌已包含穿戴装备；装备单独查价只作交叉核对，不重复相加";

export type PetGearPricingItem = EquipmentPricingItem & {
  petKey: string;
  petName: string;
  accessory: boolean;
  rawItem?: Pick<DetailItem, "index" | "modelId" | "kindId" | "location" | "attributes">;
  reason?: string;
  queriedAt?: string;
  searchStatus?:
    | "pending"
    | "completed"
    | "read_failed"
    | "unsupported"
    | "incomplete"
    | "untradable";
  scopeEvidence?: GlobalMarketRequest[];
};

export type PetGearPricingSnapshot = Omit<EquipmentPricingSnapshot, "items"> & {
  items: PetGearPricingItem[];
  accounting: string;
};

export type PetGearAttributes = {
  level: number | null;
  stats: Record<string, number>;
  suit: string | null;
  stone: { level: number; stat: string; value: number } | null;
  durability: number | null;
  repairFailed: number | null;
  restricted: boolean;
  issues: string[];
};

const stats = [
  "命中率",
  "气血",
  "防御",
  "速度",
  "魔法",
  "伤害",
  "灵力",
  "力量",
  "体质",
  "魔力",
  "耐力",
  "敏捷",
  "躲避",
];
const statPattern = new RegExp("(" + stats.join("|") + ")[：:]?\\s*([+＋−-]?\\d+)(?:%|％)?", "g");

/** Keep base and inlaid stats separate; a missing field is never filled with zero. */
export function parsePetGearAttributes(description: string): PetGearAttributes {
  const value: PetGearAttributes = {
    level: null,
    stats: {},
    suit: null,
    stone: null,
    durability: null,
    repairFailed: null,
    restricted: /绑定|专用|不可交易|无法交易/.test(description),
    issues: [],
  };
  let inlaid = false;
  for (const line of cleanDescription(description)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)) {
    const level = line.match(/^等级\s*[：:]?\s*(\d+)$/);
    if (level) {
      value.level = Number(level[1]);
      continue;
    }
    if (
      /^(?:【)?装备对象[：:】\s]+召唤兽$/.test(line) ||
      /^(?:【)?装备条件[：:】\s]+等级\s*\d+$/.test(line)
    )
      continue;
    if (/^镶嵌效果\s*$/.test(line)) {
      inlaid = true;
      continue;
    }
    const stone = line.match(
      /^([+＋−-]?\d+)\s*(灵力|速度|伤害|防御|气血|躲避)\s+镶嵌等级\s*[：:]?\s*(\d+)$/,
    );
    if (stone && inlaid) {
      if (value.stone) value.issues.push("镶嵌属性重复");
      value.stone = {
        value: Number(stone[1].replace("＋", "+").replace("−", "-")),
        stat: stone[2],
        level: Number(stone[3]),
      };
      continue;
    }
    const suit = line.match(/^套装效果\s*[：:]\s*(.+)$/);
    if (suit) {
      if (value.suit) value.issues.push("套装效果重复");
      value.suit = suit[1].trim();
      continue;
    }
    const durability = line.match(
      /^耐久(?:度)?\s*[：:]?\s*(\d+)(?:\s+修理失败\s*[：:]?\s*(\d+)次?)?$/,
    );
    if (durability) {
      value.durability = Number(durability[1]);
      if (durability[2] !== undefined) value.repairFailed = Number(durability[2]);
      continue;
    }
    const repair = line.match(/^修理失败\s*[：:]?\s*(\d+)次?$/);
    if (repair) {
      value.repairFailed = Number(repair[1]);
      continue;
    }
    const entries = [...line.matchAll(statPattern)];
    const rest = line.replace(statPattern, "").replace(/[\s,，;；]/g, "");
    if (entries.length && !rest && !inlaid) {
      for (const entry of entries) {
        if (Object.hasOwn(value.stats, entry[1]))
          value.issues.push(entry[1] + "重复，无法区分属性段");
        value.stats[entry[1]] = Number(entry[2].replace("＋", "+").replace("−", "-"));
      }
    } else value.issues.push("未支持的宝宝装备属性：" + line);
  }
  if (value.level === null) value.issues.push("宝宝装备等级缺失");
  if (!Object.keys(value.stats).length) value.issues.push("宝宝装备基础属性缺失");
  if (value.durability === null) value.issues.push("宝宝装备耐久资料缺失");
  return value;
}

/** Gear references do not add to the parent pet's already inclusive listing price. */
export function petGearInventory(record: SavedRoleRecord) {
  const inventory = petInventory(record);
  const items: PetGearPricingItem[] = inventory.items.flatMap((pet) =>
    pet.equipment.map((gear, index) => {
      const rawPet = record.detail?.tabs
        .find((tab) => pet.key.startsWith(tab.name + ":"))
        ?.pets?.find((value) => pet.key === "召唤兽/孩子:" + value.index);
      const raw = rawPet?.equipment[index];
      const attributes = parsePetGearAttributes(gear.description);
      const issues = gear.accessory
        ? ["宝宝饰品不属于召唤兽装备搜索，保留未定价"]
        : attributes.issues;
      return {
        key: pet.key + ":gear:" + index,
        petKey: pet.key,
        petName: pet.name,
        name: gear.name,
        description: gear.description,
        level: attributes.level,
        category: "召唤兽装备",
        priceMethod: EQUIPMENT_QUOTE_POLICY,
        accessory: !!gear.accessory,
        ...(raw
          ? {
              rawItem: {
                index: raw.index,
                modelId: raw.modelId,
                kindId: raw.kindId,
                location: raw.location,
                attributes: raw.attributes,
              },
            }
          : {}),
        status: attributes.restricted ? "untradable" : issues.length ? "unsupported" : "no_match",
        issues: attributes.restricted ? [...issues, "绑定或专用宝宝装备不能套用交易价格"] : issues,
        query: "",
        referencePrice: null,
        candidates: [],
      };
    }),
  );
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify({
        marketScope: GLOBAL_MARKET_SCOPE_VERSION,
        searchUI: MARKET_SEARCH_UI_VERSION,
        comparisonVersion: "pet-gear-official-order-average-v6",
        priceMethod: EQUIPMENT_QUOTE_POLICY,
        inputHash: inventory.inputHash,
        items,
      }),
    )
    .digest("hex");
  return { inputHash, captureComplete: inventory.captureComplete, issues: inventory.issues, items };
}

export function comparePetGear(target: PetGearPricingItem, name: string, description: string) {
  const left = parsePetGearAttributes(target.description),
    right = parsePetGearAttributes(description);
  const reject = (reason: string) =>
    ({ matchType: null, differences: [], similarityScore: Infinity, reason }) as const;
  // The official query may include all three slots. Names bind a same-level item to its model.
  if (name !== target.name) return reject("宝宝装备名称/模型与目标不同");
  if (left.issues.length || right.issues.length)
    return reject([...left.issues, ...right.issues].join("；"));
  if (left.restricted || right.restricted) return reject("专用或绑定宝宝装备不能直接交易比价");
  if (left.level !== right.level) return reject("宝宝装备等级不同");
  if (left.suit !== right.suit) return reject("套装效果不同");
  if (left.repairFailed !== right.repairFailed) return reject("修理失败状态不同");
  if ((left.durability === 0) !== (right.durability === 0)) return reject("零耐久状态不同");
  if (
    JSON.stringify(Object.keys(left.stats).sort()) !==
    JSON.stringify(Object.keys(right.stats).sort())
  )
    return reject("基础/附加属性种类不同");
  const differences: string[] = [];
  let similarityScore = 0;
  for (const [stat, expected] of Object.entries(left.stats)) {
    const observed = right.stats[stat];
    if (expected === observed) continue;
    if (expected === 0 || Math.abs(observed - expected) / Math.abs(expected) > 0.2 + 1e-10)
      return reject(stat + "差异超过20%");
    similarityScore += (Math.abs(observed - expected) / Math.abs(expected)) * 100;
    differences.push(stat + "：" + expected + " → " + observed);
  }
  if (!!left.stone !== !!right.stone || left.stone?.stat !== right.stone?.stat)
    return reject("镶嵌属性类型不同");
  if (left.stone && right.stone) {
    const levelDifference = Math.abs(left.stone.level - right.stone.level);
    if (levelDifference > 1) return reject("灵石等级差异超过1级");
    similarityScore += levelDifference * 10;
    if (!levelDifference)
      similarityScore +=
        (Math.abs(left.stone.value - right.stone.value) / Math.max(1, Math.abs(left.stone.value))) *
        100;
    if (left.stone.level !== right.stone.level || left.stone.value !== right.stone.value) {
      differences.push(
        "镶嵌：" +
          left.stone.stat +
          "+" +
          left.stone.value +
          "/" +
          left.stone.level +
          "级 → " +
          right.stone.stat +
          "+" +
          right.stone.value +
          "/" +
          right.stone.level +
          "级",
      );
    }
  }
  if (left.durability !== right.durability)
    differences.push("耐久：" + left.durability + " → " + right.durability);
  return {
    matchType: differences.length ? ("similar" as const) : ("exact" as const),
    similarityScore,
    differences,
    reason: null,
  };
}

/** Keep fresh independent evidence; closest configuration scores never imply a price adjustment. */
export function selectPetGearCandidates(candidates: EquipmentCandidate[]): EquipmentCandidate[] {
  const now = Date.now();
  const fresh = candidates.filter((candidate) => {
    return (
      candidate.verified === true &&
      ["exact", "similar"].includes(candidate.matchType || "") &&
      candidate.priceType === "listing" &&
      candidate.price !== null &&
      Number.isFinite(candidate.price) &&
      candidate.price > 0 &&
      candidate.price <= 1e9 &&
      !!candidate.sourceHash &&
      candidateQuoteMatchesPrice(candidate) &&
      !!officialSourceIdentity(candidate.url) &&
      pricingTimestampFresh(candidate.fetchedAt, now)
    );
  });
  const distinct = new Map<string, EquipmentCandidate>();
  let conflict: EquipmentCandidate[] = [];
  for (const candidate of fresh) {
    const identity = officialSourceIdentity(candidate.url)!;
    const previous = distinct.get(identity);
    if (previous && previous.price !== candidate.price && !conflict.length)
      conflict = [previous, candidate];
    if (!previous) distinct.set(identity, candidate);
  }
  // Keep the order returned by the official search; prices and distance do not reorder it.
  const selected = [
    ...[...distinct.values()]
      .filter((candidate) => candidate.matchType === "exact")
      .slice(0, EQUIPMENT_QUOTE_LIMIT),
    ...[...distinct.values()]
      .filter((candidate) => candidate.matchType === "similar")
      .slice(0, EQUIPMENT_QUOTE_LIMIT),
  ];
  // Retain normal evidence alongside the conflict; a resumed cursor may skip these seen products.
  return [...selected, ...conflict.filter((candidate) => !selected.includes(candidate))];
}

export function petGearReference(candidates: EquipmentCandidate[]) {
  const selected = selectPetGearCandidates(candidates);
  const estimate = buildEquipmentEstimate(selected);
  const distinct = new Map<string, number>();
  for (const candidate of selected) {
    const identity = officialSourceIdentity(candidate.url)!;
    if (distinct.has(identity) && distinct.get(identity) !== candidate.price)
      return {
        referencePrice: null,
        similarEstimate: {
          ...estimate,
          status: "insufficient" as const,
          range: null,
          issues: ["同一宝宝装备的报价冲突，需重新读取"],
        },
      };
    distinct.set(identity, candidate.price!);
  }
  const average = priceAverage(
    selected
      .filter((candidate) => candidate.matchType === "exact")
      .map((candidate) => candidate.price!),
  );
  return {
    referencePrice:
      average !== null ? average : estimate.status === "range" ? estimate.average! : null,
    similarEstimate: estimate,
  };
}
