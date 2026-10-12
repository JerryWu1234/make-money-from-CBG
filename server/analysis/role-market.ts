import { createHash } from "node:crypto";
import type { SavedRoleRecord } from "../crawler/types";
import { equipmentInventory } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";
import { parseEquipmentAttributes } from "./equip-attributes";
import { canonicalPetStar, currentPetSkills, petSkillState, similarPetSkills } from "./pet-match";
import { matchSpecialAsset } from "./special-asset-match";
import { matchComparableEquipmentAttributes } from "./equipment-match";
import { officialSourceIdentity } from "./pricing-integrity";

export const ROLE_MARKET_POLICY = "whole-role-core-star-label-v4";
const ROLE_MARKET_SCOPE =
  "整体角色在售挂牌参考；包括装备、宝宝与完整角色配置，不与资产小计相加，不代表成交价";
export type RoleMarketCandidate = {
  key: string;
  url: string;
  title: string;
  price: number | null;
  active: boolean;
  serverAge: "older";
  fetchedAt: string;
  sourceHash: string;
  verified: boolean;
  reasons: string[];
  differences: string[];
  record: SavedRoleRecord;
};
const clean = (v: string) => v.replace(/\s+/g, "").replace(/[：:]/g, "");
const numeric = (value?: string) => {
  const match = value?.trim().match(/^([+＋-]?\d+(?:\.\d+)?)(?:\s*\/\s*\d+)?$/);
  return match ? Number(match[1].replace("＋", "+")) : null;
};
function field(record: SavedRoleRecord, name: string, tab = "人物/修炼") {
  const snapshot = record.detail?.tabs.find((value) => value.name === tab);
  const result = snapshot?.fields.find((value) => clean(value.name) === clean(name))?.value;
  if (result !== undefined) return result;
  for (const table of snapshot?.tables || [])
    for (const row of table)
      for (let index = 0; index < row.length - 1; index++)
        if (clean(row[index]) === clean(name)) return row[index + 1];
  return record.detail?.valuation?.fields.find((value) => value.name === name && value.tab === tab)
    ?.value;
}
export function roleCore(record: SavedRoleRecord) {
  const skills = record.detail?.tabs.find((tab) => tab.name === "技能")?.items || [];
  return {
    level: numeric(field(record, "级别")),
    school: field(record, "门派") || null,
    state: field(record, "飞升/渡劫/化圣") || null,
    training: Object.fromEntries(
      [
        "攻击修炼",
        "法术修炼",
        "防御修炼",
        "抗法修炼",
        "攻击控制力",
        "防御控制力",
        "法术控制力",
        "抗法控制力",
      ].map((name) => [name, numeric(field(record, name))]),
    ),
    skills: Object.fromEntries(
      ["强壮", "神速", "强身术"].map((name) => [
        name,
        numeric(skills.find((item) => item.name === name)?.level || field(record, name, "技能")),
      ]),
    ),
  };
}
const values = (fields: Record<string, string[]>, name: string) => fields[name]?.join("、") || "";
const comparableFields = ["特技", "特效", "套装", "宝石", "符石组合"];

/** Whole-role relevance is evaluated separately from independent tradable-asset pricing. */
export function compareRoleConfiguration(target: SavedRoleRecord, source: SavedRoleRecord) {
  const reasons: string[] = [],
    differences: string[] = [];
  const a = roleCore(target),
    b = roleCore(source);
  for (const name of ["level", "school", "state"] as const)
    if (a[name] === null || b[name] === null || a[name] !== b[name])
      reasons.push("等级、门派或飞升状态不一致/缺失：" + name);
  const bounded = (name: string, left: number | null, right: number | null, tolerance: number) => {
    if (left === null || right === null) reasons.push(name + "缺少完整数值证据");
    else if (Math.abs(left - right) > tolerance) reasons.push(name + "超出相近配置范围");
    else if (left !== right) differences.push(name + "：" + left + " → " + right);
  };
  for (const name of Object.keys(a.training)) bounded(name, a.training[name], b.training[name], 3);
  for (const name of Object.keys(a.skills))
    bounded(name, a.skills[name], b.skills[name], name === "强身术" ? 20 : 10);
  const targetEquipment = equipmentInventory(target),
    sourceEquipment = equipmentInventory(source);
  const targetPets = petInventory(target),
    sourcePets = petInventory(source);
  if (!targetEquipment.captureComplete || !sourceEquipment.captureComplete)
    reasons.push("装备库存尚未确认采齐");
  if (!targetPets.captureComplete || !sourcePets.captureComplete)
    reasons.push("宝宝库存尚未确认采齐");
  if (
    [
      ...targetEquipment.items,
      ...sourceEquipment.items,
      ...targetPets.items,
      ...sourcePets.items,
    ].some((item) => item.status === "incomplete")
  )
    reasons.push("存在未读完整的装备或宝宝");
  if (targetEquipment.items.length !== sourceEquipment.items.length) reasons.push("装备总件数不同");
  const remaining = [...sourceEquipment.items];
  for (const item of targetEquipment.items) {
    const index = remaining.findIndex(
      (value) =>
        value.category === item.category &&
        (item.category !== "上古玉魄" || value.name === item.name),
    );
    if (index < 0) {
      reasons.push(item.name + "缺少同类别装备");
      continue;
    }
    const other = remaining.splice(index, 1)[0];
    const left = parseEquipmentAttributes(item.description),
      right = parseEquipmentAttributes(other.description);
    const restrictions = (values: string[]) =>
      JSON.stringify(
        values.map((value) => clean(value).replace(/玩家\d+专用/g, "玩家专用")).sort(),
      );
    if (restrictions(left.restrictions) !== restrictions(right.restrictions))
      reasons.push(item.category + "专用、绑定或交易限制不同");
    if (
      (item.level === null && !["上古玉魄", "元身"].includes(item.category)) ||
      (other.level === null && !["上古玉魄", "元身"].includes(other.category))
    )
      reasons.push(item.category + "装备等级未采齐");
    if (/戒指|耳饰|手镯|佩饰|灵饰/.test(item.category)) {
      const matching = matchComparableEquipmentAttributes(left, right);
      if (matching.reason) reasons.push(item.category + "：" + matching.reason);
      else differences.push(...matching.differences.map((value) => item.category + "：" + value));
    }
    if (["上古玉魄", "元身"].includes(item.category)) {
      const matching = matchSpecialAsset(item, other.description);
      if (matching.reason) reasons.push(item.name + "：" + matching.reason);
      else differences.push(...matching.differences);
    } else bounded(item.category + "等级", item.level, other.level, 10);
    for (const grade of ["锻炼等级", "精炼等级"])
      if (left.fields[grade]?.length || right.fields[grade]?.length)
        bounded(
          item.category + grade,
          numeric(values(left.fields, grade)),
          numeric(values(right.fields, grade)),
          2,
        );
    for (const name of comparableFields) {
      const x = values(left.fields, name),
        y = values(right.fields, name);
      if (x !== y) {
        differences.push(item.category + name + "：" + (x || "无") + " → " + (y || "无"));
        if (["特技", "特效", "套装", "宝石"].includes(name))
          reasons.push(item.category + name + "不一致");
      }
    }
    if (item.description !== other.description)
      differences.push(
        item.name +
          " → " +
          other.name +
          "：装备完整属性见对应来源 record，专用/耐久/玉魄差异未据此推测折价",
      );
    const combat = /武器/.test(item.category)
      ? ["伤害", "命中"]
      : ["防御", "灵力", "法术伤害", "气血"];
    for (const name of combat) {
      const x = left.fields[name]?.[0]?.match(/^([+＋-]?\d+(?:\.\d+)?)/)?.[1],
        y = right.fields[name]?.[0]?.match(/^([+＋-]?\d+(?:\.\d+)?)/)?.[1];
      if (!x && !y) continue;
      if (!x || !y || Math.abs(Number(y) - Number(x)) > Math.abs(Number(x)) * 0.25)
        reasons.push(item.category + name + "缺失或差异超过25%");
      else if (x !== y) differences.push(item.category + name + "：" + x + " → " + y);
    }
  }
  if (targetPets.items.length !== sourcePets.items.length) reasons.push("宝宝只数不同");
  const pets = [...sourcePets.items];
  for (const pet of targetPets.items) {
    const index = pets.findIndex((other) => other.name === pet.name);
    if (index < 0) {
      reasons.push(pet.name + "缺少同类型宝宝");
      continue;
    }
    const other = pets.splice(index, 1)[0];
    if ((pet.status === "untradable") !== (other.status === "untradable"))
      reasons.push(pet.name + "宝宝绑定或交易限制不同");
    bounded(pet.name + "等级", pet.level, other.level, 5);
    const left = new Map(pet.fields.map((value) => [value.name, value.value])),
      right = new Map(other.fields.map((value) => [value.name, value.value]));
    bounded(pet.name + "成长", numeric(left.get("成长")), numeric(right.get("成长")), 0.03);
    for (const name of ["攻击资质", "防御资质", "体力资质", "法力资质", "速度资质"]) {
      const x = numeric(left.get(name)?.split("+")[0]),
        y = numeric(right.get(name)?.split("+")[0]);
      bounded(pet.name + name, x, y, x === null ? 0 : x * 0.15);
    }
    const sensitive =
      /绑定|交易|专用|携带等级|参战等级|是否宝宝|^宝宝$|变异|进阶|灵性|特性|认证|赐福|超技能|超级技能|成品状态|转生|神兽类型|神兽星级/;
    for (const name of new Set([...left.keys(), ...right.keys()])) {
      const matches =
        name === "神兽星级"
          ? canonicalPetStar(left.get(name)) !== undefined &&
            canonicalPetStar(left.get(name)) === canonicalPetStar(right.get(name))
          : left.get(name) === right.get(name);
      if (sensitive.test(name) && !matches) reasons.push(pet.name + name + "缺失或不同");
    }
    for (const item of [pet, other])
      if (
        item.skills.some((name) => ["conditional", "unknown"].includes(petSkillState(name, item)))
      )
        reasons.push(pet.name + "技能当前状态未确认");
    const future = (item: typeof pet) =>
      item.skills.filter((name) => petSkillState(name, item) === "future").sort();
    if (JSON.stringify(future(pet)) !== JSON.stringify(future(other)))
      reasons.push(pet.name + "未来赐福技能配置不同");
    const skills = similarPetSkills(currentPetSkills(pet), currentPetSkills(other));
    if (!skills.accepted) reasons.push(pet.name + "：" + skills.reason);
    else differences.push(...(skills.differences || []).map((value) => pet.name + "：" + value));
    if (pet.equipment.length !== other.equipment.length)
      reasons.push(pet.name + "宝宝装备件数不同");
    if (
      JSON.stringify(pet.innerSkills.map((value) => value.name + ":" + value.level).sort()) !==
      JSON.stringify(other.innerSkills.map((value) => value.name + ":" + value.level).sort())
    )
      reasons.push(pet.name + "内丹名称或层数不同");
    const carried = [...other.equipment];
    for (const gear of pet.equipment) {
      const index = carried.findIndex(
        (value) => value.name === gear.name && Boolean(value.accessory) === Boolean(gear.accessory),
      );
      if (index < 0) {
        reasons.push(pet.name + "宝宝装备名称/饰品身份不同");
        continue;
      }
      const candidate = carried.splice(index, 1)[0];
      const match = matchComparableEquipmentAttributes(
        parseEquipmentAttributes(gear.description),
        parseEquipmentAttributes(candidate.description),
      );
      if (match.reason) reasons.push(pet.name + gear.name + "：" + match.reason);
      else
        differences.push(...match.differences.map((value) => pet.name + gear.name + "：" + value));
    }
    if (JSON.stringify(pet) !== JSON.stringify(other))
      differences.push(
        pet.name + "宝宝属性、赐福、内丹和装备完整差异保留于来源 record，未据此推测折价",
      );
  }
  for (const name of ["坐骑", "锦衣/外观", "玩家之家"]) {
    const left = target.detail?.tabs.find((tab) => tab.name === name),
      right = source.detail?.tabs.find((tab) => tab.name === name);
    if (!left || !right) reasons.push(name + "资料缺失");
    else if (left.text !== right.text)
      differences.push(name + "资料不同，完整列表保留于来源 record；整体挂牌参考包含这些配置差异");
  }
  return {
    verified: !reasons.length,
    reasons: [...new Set(reasons)],
    differences: [...new Set(differences)],
    targetCore: a,
    sourceCore: b,
  };
}
export function roleSourceHash(record: SavedRoleRecord) {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
export function buildRoleMarketReference(
  candidates: RoleMarketCandidate[],
  targetKey: string,
  now = Date.now(),
) {
  const distinct = new Map<string, RoleMarketCandidate>();
  for (const candidate of candidates) {
    const age = now - Date.parse(candidate.fetchedAt);
    const identity = officialSourceIdentity(candidate.url);
    if (
      candidate.key === targetKey ||
      !candidate.verified ||
      !candidate.active ||
      candidate.serverAge !== "older" ||
      !identity ||
      !candidate.sourceHash ||
      candidate.sourceHash !== roleSourceHash(candidate.record) ||
      candidate.key !== candidate.record.listing.key ||
      identity !== candidate.record.listing.key ||
      candidate.price !== Number(candidate.record.listing.price) ||
      !Number.isFinite(age) ||
      age < -60_000 ||
      age >= 86_400_000 ||
      candidate.price === null ||
      !Number.isFinite(candidate.price) ||
      candidate.price <= 0 ||
      candidate.price > 1e9
    )
      continue;
    if (distinct.has(identity) && distinct.get(identity)!.price !== candidate.price)
      return {
        policyVersion: ROLE_MARKET_POLICY,
        status: "insufficient",
        range: null,
        sampleCount: distinct.size,
        issues: ["同一整号在售报价冲突，需要重读"],
        scope: ROLE_MARKET_SCOPE,
      };
    distinct.set(identity, candidate);
  }
  const prices = [...distinct.values()].map((value) => value.price!).sort((a, b) => a - b);
  const base = {
    policyVersion: ROLE_MARKET_POLICY,
    sampleCount: prices.length,
    scope: ROLE_MARKET_SCOPE,
  };
  if (prices.length < 3)
    return {
      ...base,
      status: "insufficient",
      range: null,
      issues: ["相关且鲜活的整号在售样本不足3条"],
    };
  if (prices[prices.length - 1] / prices[0] > 1.5)
    return {
      ...base,
      status: "dispersed",
      range: null,
      observedRange: { min: prices[0], max: prices[prices.length - 1] },
      issues: ["整号挂牌最高价超过最低价1.5倍，暂不生成整体参考"],
    };
  return {
    ...base,
    status: "range",
    range: { min: prices[0], max: prices[prices.length - 1] },
    median:
      prices.length % 2
        ? prices[Math.floor(prices.length / 2)]
        : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2,
    issues: ["样本为相近核心配置的整号挂牌区间；配置差异均保留，未对未知资产补零或推测折价"],
  };
}
