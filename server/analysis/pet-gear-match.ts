import { cleanDescription } from "../crawler/compact";
import type { PetGearPricingItem } from "./pet-gear-inventory";

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

export function comparePetGear(
  target: Pick<PetGearPricingItem, "name" | "description">,
  name: string,
  description: string,
) {
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
