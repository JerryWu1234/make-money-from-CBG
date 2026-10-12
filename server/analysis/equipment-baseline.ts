import { cleanDescription } from "../crawler/compact";
import { parseEquipmentAttributes } from "./equip-attributes";
import type { EquipmentPricingItem } from "./equipment-pricing";
import type { ValuationSettings } from "./valuation-types";

export const EQUIPMENT_BASELINE_POLICY_VERSION = "equipment-baseline-v1";
export type EquipmentBaselineKind = "ring" | "white" | "ignored";
export type EquipmentBaselinePrices = Record<
  "60" | "70" | "80" | "90" | "100",
  { weapon: number | null; armor: number | null }
>;
export const DEFAULT_EQUIPMENT_BASELINE_PRICES: EquipmentBaselinePrices = {
  "60": { weapon: null, armor: null },
  "70": { weapon: 110_000, armor: 80_000 },
  "80": { weapon: 480_000, armor: 400_000 },
  "90": { weapon: null, armor: null },
  "100": { weapon: null, armor: null },
};
export type BaselineEstimate = {
  policyVersion: string;
  kind: EquipmentBaselineKind;
  gameCurrency: number | null;
  amount: number | null;
  serverId: string;
  goldPrice: number | null;
  goldUnit: number | null;
  source: {
    label: string;
    url?: string;
    publishedAt?: string;
    basis: "historical" | "preset" | "excluded";
  };
  note: string;
};
export type EquipmentBaselineSettings = {
  servers: ValuationSettings["servers"];
  equipmentBaselinePrices?: EquipmentBaselinePrices;
};
type BaselineItem = Pick<
  EquipmentPricingItem,
  | "name"
  | "level"
  | "category"
  | "kindId"
  | "modelId"
  | "description"
  | "status"
  | "referencePrice"
  | "candidates"
> & { baselineEstimate?: unknown };
type Slot = "weapon" | "body" | "head" | "neck" | "belt" | "shoe";
const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
const scalar = (values?: string[]): number | null => {
  if (values?.length !== 1) return null;
  const value = values[0].trim().match(/^[+＋]?(\d+(?:\.\d+)?)(?:点|级|次)?$/)?.[1];
  return value === undefined ? null : Number(value);
};
const slotFromCategory = (category: string): Slot | null => {
  if (/腰带/.test(category)) return "belt";
  if (/鞋|靴/.test(category)) return "shoe";
  if (/项链|饰品/.test(category)) return "neck";
  if (/头盔|头饰|发冠|发钗|帽|男头|女头/.test(category)) return "head";
  if (/衣服|铠甲|男衣|女衣|铠|袍|裙/.test(category)) return "body";
  if (/武器|剑|刀|枪|斧|扇|锤|鞭|爪|弓|杖|宝珠|飘带|环圈|灯笼/.test(category)) return "weapon";
  return null;
};
const mainFields: Record<Slot, string[]> = {
  weapon: ["伤害", "命中"],
  body: ["防御"],
  head: ["防御", "魔法"],
  neck: ["灵力"],
  belt: ["防御", "气血"],
  shoe: ["防御", "敏捷"],
};
const commonFields = new Set(["等级", "五行", "耐久", "修理失败", "装备角色", "装备条件"]);

/** Deliberately narrow program limits, not an official complete crafting-stat table. */
export function ordinarySlot(item: BaselineItem): Slot | null {
  const level = item.level;
  if (level === null || !Number.isInteger(level) || level < 0 || level > 100 || level % 10 !== 0)
    return null;
  if (
    !["no_match", "unsupported"].includes(item.status) ||
    (item.status === "unsupported" && level >= 60) ||
    item.referencePrice !== null ||
    item.candidates.length
  )
    return null;
  if (
    /灵饰|戒指|耳饰|手镯|佩饰|配饰|上古玉魄|法宝|灵宝|神器|召唤兽|道具|材料/.test(item.category) ||
    [61, 62, 63, 64].includes(Number(item.kindId)) ||
    /^(?:270|271|272|273)\d{2}$/.test(item.modelId || "")
  )
    return null;
  const text = cleanDescription(item.description);
  if (
    /特技|特效|套装|点化|附加|精炼|锻炼|宝石|符石|熔炼|开运|开孔|星位|星相|专用|绑定|不可交易|不能交易|无法修复|不能修理|不可修理|强化打造|未鉴定|未识别|省略|截断|\.{2,}|…/.test(
      text,
    )
  )
    return null;
  const parsed = parseEquipmentAttributes(text);
  if (parsed.unknownLines.length || parsed.restrictions.length) return null;
  if (
    parsed.level !== level &&
    !(level === 0 && !parsed.fields.等级 && parsed.fields.装备条件?.join("") === "等级0")
  )
    return null;
  const fields = parsed.fields;
  const stats = Object.keys(fields).filter((field) => !commonFields.has(field));
  let slot = slotFromCategory(item.category);
  // Explicit paired main stats identify generic captured equipment; defense alone is ambiguous.
  if (!slot && /人物装备|装备|武器/.test(item.category))
    slot =
      (["weapon", "head", "neck", "belt", "shoe"] as Slot[]).find(
        (candidate) =>
          stats.length === mainFields[candidate].length &&
          mainFields[candidate].every((key) => stats.includes(key)),
      ) || null;
  if (!slot) return null;
  if (
    Object.keys(fields).some(
      (field) => !commonFields.has(field) && !mainFields[slot!].includes(field),
    )
  )
    return null;
  if (positive(scalar(fields.耐久)) === null) return null;
  if (fields.修理失败 && scalar(fields.修理失败) !== 0) return null;
  if (fields.五行 && !fields.五行.every((value) => /^[金木水火土]$/.test(value.trim())))
    return null;
  if (
    fields.装备条件 &&
    !fields.装备条件.every((value) => value.replace(/\s/g, "") === "等级" + level)
  )
    return null;
  // Reject unread fragments and arbitrary text rather than assuming an absent special attribute.
  for (const line of text
    .split(/\n/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (line === item.name || /^制造者[：:\s]+[^\n]+$/.test(line)) continue;
    const content = line.replace(/【([^】]+)】/g, "$1：");
    if (/^装备角色[：:\s]+[^\n]+$/.test(content) || /^装备条件[：:\s]+等级\s*\d+$/.test(content))
      continue;
    const residual = content
      .replace(/五行[：:\s]*[金木水火土]/g, "")
      .replace(
        /(?:修理失败|耐久度|耐久|等级|命中|伤害|防御|魔法|灵力|气血|敏捷)[：:\s]*[+＋]?\d+(?:\.\d+)?(?:点|级|次)?/g,
        "",
      )
      .replace(/[\s，,；;]/g, "");
    if (residual) return null;
  }
  const step = (level - 60) / 10;
  const ceilings: Record<Slot, Record<string, number>> = {
    weapon: { 伤害: Math.max(15, 190 + 30 * step), 命中: Math.max(20, 220 + 35 * step) },
    body: { 防御: 100 + 15 * step },
    head: { 防御: 35 + 5 * step, 魔法: 65 + 10 * step },
    neck: { 灵力: Math.max(1, 77 + 12 * step) },
    belt: { 防御: 35 + 5 * step, 气血: 140 + 20 * step },
    shoe: { 防御: 35 + 5 * step, 敏捷: 22 + 3 * step },
  };
  if (
    !mainFields[slot].every((field) => {
      const value = scalar(fields[field]);
      return value !== null && value > 0 && value <= ceilings[slot][field];
    })
  )
    return null;
  return slot;
}

export function classifyOrdinaryEquipment(item: BaselineItem): EquipmentBaselineKind | null {
  if (!ordinarySlot(item)) return null;
  return item.level! < 60 ? "ignored" : item.level! <= 80 ? "ring" : "white";
}

export function makeEquipmentBaseline(
  item: BaselineItem,
  serverId: string,
  settings: EquipmentBaselineSettings,
): BaselineEstimate | null {
  const slot = ordinarySlot(item);
  if (!slot) return null;
  const kind = item.level! < 60 ? "ignored" : item.level! <= 80 ? "ring" : "white";
  if (kind === "ignored")
    return {
      policyVersion: EQUIPMENT_BASELINE_POLICY_VERSION,
      kind,
      gameCurrency: 0,
      amount: 0,
      serverId,
      goldPrice: null,
      goldUnit: null,
      source: { label: "普通低等级装备排除策略", basis: "excluded" },
      note: "普通60级以下装备按低值排除策略暂不计价，保留记录；不表示其市场售价为0。",
    };
  const level = String(item.level) as keyof EquipmentBaselinePrices;
  const group = slot === "weapon" ? "weapon" : "armor";
  const configured =
    settings.equipmentBaselinePrices === undefined
      ? DEFAULT_EQUIPMENT_BASELINE_PRICES[level][group]
      : settings.equipmentBaselinePrices[level]?.[group];
  let gameCurrency = positive(configured);
  const historical =
    (level === "70" || level === "80") &&
    gameCurrency !== null &&
    gameCurrency === DEFAULT_EQUIPMENT_BASELINE_PRICES[level][group];
  const source: BaselineEstimate["source"] = historical
    ? {
        label: "2025-11三年外环装历史样本（DVG转载叶子猪）",
        basis: "historical",
        url: "https://www.dvg.cn/wygl/90894.html",
        publishedAt: "2025-11-22",
      }
    : { label: "用户预设/人工参考（非实时行情）", basis: "preset" };
  const matchingServers = settings.servers.filter((server) => server.serverId === serverId);
  const server = matchingServers.length === 1 ? matchingServers[0] : undefined;
  const goldPrice = positive(server?.goldPrice),
    goldUnit = positive(server?.goldUnit);
  const reasons: string[] = [];
  if (gameCurrency === null) reasons.push("缺少此等级普通装备的默认价，可在分析设置中填写");
  if (historical && server?.age !== "older") {
    gameCurrency = null;
    reasons.push("三年外历史样本不适用于当前区服年代；需填写本服人工参考价");
  }
  if (!server) reasons.push("缺少唯一匹配的区服金价配置");
  if (goldPrice === null || goldUnit === null) reasons.push("缺少有效金价或金价单位");
  if (server?.baselineUnitConfirmed !== true) reasons.push("金价单位尚未确认");
  let amount: number | null = null;
  if (gameCurrency !== null && !reasons.length && goldPrice !== null && goldUnit !== null) {
    const converted = (gameCurrency / goldUnit) * goldPrice;
    if (Number.isFinite(converted)) amount = Math.round((converted + Number.EPSILON) * 100) / 100;
    else reasons.push("金价换算结果无效");
  }
  return {
    policyVersion: EQUIPMENT_BASELINE_POLICY_VERSION,
    kind,
    gameCurrency,
    amount,
    serverId,
    goldPrice,
    goldUnit,
    source,
    note:
      "程序保守识别规则，非官方完整打造属性表。" +
      (historical ? "采用历史样本，非当前行情。" : "采用人工参考，非成交报价。") +
      reasons.join("；"),
  };
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]))
  );
}

export function validateEquipmentBaseline(
  item: BaselineItem,
  serverId: string,
  settings: EquipmentBaselineSettings,
): boolean {
  const recomputed = makeEquipmentBaseline(item, serverId, settings);
  return recomputed !== null && deepEqual(item.baselineEstimate, recomputed);
}
