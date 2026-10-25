import type { SavedRoleRecord } from "../crawler/types";
import type { ValuationResult } from "./valuation-types";
import { equipmentInventory } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";
import { parseEquipmentAttributes } from "./equip-attributes";
import { currentPetSkills } from "./pet-match";
import { slotFromCategory } from "./equipment-baseline";

export type Recommendation = {
  status: "recommended" | "manual" | "excluded";
  basis?: "bare-role-discount";
  gap: number | null;
  factors: string[];
  strongerFactors: string[];
};

// Configuration gates are screening heuristics, never equipment/pet price estimates.
export function recommendationFor(
  record: SavedRoleRecord,
  value?: ValuationResult,
): Recommendation {
  const result: Recommendation = {
    status: "excluded",
    gap: null,
    factors: [],
    strongerFactors: [],
  };
  const asking = Number(record.listing.price),
    bare = value?.bare_role_value;
  if (
    !Number.isFinite(asking) ||
    asking <= 0 ||
    typeof bare !== "number" ||
    !Number.isFinite(bare) ||
    bare < 0 ||
    value?.decision === "NEED_INFO"
  )
    return result;
  const cents = Math.round(asking * 100) - Math.round(bare * 100);
  result.gap = cents / 100;
  const grade = (values?: string[]) =>
    values?.length === 1 && /^\d+$/.test(values[0]) ? Number(values[0]) : 0;
  const inventory = equipmentInventory(record);
  const gear = inventory.captureComplete
    ? inventory.items
        .filter(
          (item) =>
            !/上古玉魄|元身/.test(item.category) &&
            item.level !== null &&
            !["incomplete", "untradable"].includes(item.status) &&
            !parseEquipmentAttributes(item.description).fields.修理失败?.some((v) =>
              /^3\s*次?$/.test(v),
            ),
        )
        .map((item) => ({
          item,
          attributes: parseEquipmentAttributes(item.description, /灵饰/.test(item.category)),
        }))
    : [];
  const gemmed = gear.filter(
    ({ attributes: a }) => grade(a.fields.锻炼等级) > 0 || grade(a.fields.精炼等级) > 0,
  );
  const level = Number((record.listing.summary as { iGrade?: unknown } | null)?.iGrade);
  const pets = petInventory(record);
  const qualifiedPets =
    pets.captureComplete && Number.isSafeInteger(level) && level > 0
      ? pets.items.filter(
          (pet) =>
            pet.level !== null &&
            pet.level > 0 &&
            Math.abs(pet.level - level) <= 10 &&
            pet.status !== "untradable" &&
            pet.fields.some(
              (field) =>
                ["是否宝宝", "宝宝"].includes(field.name) && /^(?:是|1)$/.test(field.value),
            ),
        )
      : [];
  const bareRoleDiscount = cents < 0 && inventory.captureComplete && pets.captureComplete;
  if (!bareRoleDiscount && !qualifiedPets.length && gemmed.length < 3) return result;
  const refined = gear.filter(
    ({ attributes: a }) => !a.jewelrySections && grade(a.fields.锻炼等级) >= 4,
  ).length;
  const highRefined = gear.filter(
    ({ attributes: a }) => !a.jewelrySections && grade(a.fields.锻炼等级) >= 6,
  ).length;
  if (refined >= 3) result.factors.push("3件4段宝石装备");
  if (highRefined >= 3) result.strongerFactors.push("3件6段宝石装备");
  const sets = new Map<string, Set<string>>();
  for (const { item, attributes: a } of gear) {
    if (a.jewelrySections || a.fields.套装?.length !== 1) continue;
    const slot = slotFromCategory(item.category),
      effect = a.fields.套装[0].replace(/\s/g, "");
    if (!slot || !effect || /^(?:无|无套装)$/.test(effect)) continue;
    if (!sets.has(effect)) sets.set(effect, new Set());
    sets.get(effect)!.add(slot);
  }
  if ([...sets.values()].some((slots) => slots.size >= 3)) result.factors.push("同名套装3部位");
  if ([...sets.values()].some((slots) => slots.size >= 5))
    result.strongerFactors.push("同名套装5部位");
  const plan =
    record.detail?.tabs
      .find((tab) => tab.name === "人物/修炼")
      ?.fields.find((field) => field.name === "属性保存方案")?.value || "";
  const useful = [
    "气血",
    "防御",
    "法术防御",
    "法术防御等级",
    "抵抗封印",
    "抵抗封印等级",
    "抗封印等级",
    "速度",
  ];
  if (/力量/.test(plan)) useful.push("伤害", "物理暴击", "物理暴击等级", "狂暴等级", "穿刺等级");
  if (/魔力/.test(plan)) useful.push("法术伤害", "法术暴击", "法术暴击等级", "法术伤害结果");
  if (/敏捷/.test(plan)) useful.push("固定伤害", "封印命中", "封印命中等级");
  const jewelry = gear.filter(
    ({ attributes: a }) =>
      grade(a.fields.精炼等级) >= 4 &&
      Object.entries(a.jewelrySections?.added || {}).reduce(
        (count, [name, values]) =>
          count +
          (useful.includes(name)
            ? values.filter((v) => /^\+?\d+(?:\s*\[\+?\d+\])?$/.test(v) && parseFloat(v) > 0).length
            : 0),
        0,
      ) >= 2,
  ).length;
  if (jewelry >= 1) result.factors.push("1件4段双有效属性灵饰");
  if (jewelry >= 2) result.strongerFactors.push("2件4段双有效属性灵饰");
  // Complete observed data is a screening signal, not proof of combat strength or resale value.
  const completePets = qualifiedPets.filter(
    (pet) => !pet.issues.length && currentPetSkills(pet).length > 0,
  ).length;
  if (completePets >= 1) result.factors.push("1只等级合适且资料完整宝宝");
  if (completePets >= 2) result.strongerFactors.push("2只等级合适且资料完整宝宝");
  if (cents > 100000) {
    result.status = "manual";
    return result;
  }
  const required = cents <= 10000 ? 0 : cents <= 20000 ? 1 : cents <= 30000 ? 2 : 3;
  const strongRequired = cents <= 50000 ? 0 : cents <= 80000 ? 1 : 2;
  if (
    bareRoleDiscount ||
    (result.factors.length >= required && result.strongerFactors.length >= strongRequired)
  ) {
    result.status = "recommended";
    if (bareRoleDiscount) result.basis = "bare-role-discount";
  }
  return result;
}
