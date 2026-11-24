import { equipmentCaptureSummary } from "./equipment-capture";
import { equipmentNameUnresolved, isNonRoleEquipment } from "./compact";
import type { DetailItem, TabSnapshot } from "./types";

export function tooltipSkillLevel(text: string): string | undefined {
  const levels = [
    ...new Set(
      [...text.matchAll(/(?:^|\n)\s*等级\s*[：:]?\s*(\d{1,3})(?=\s*(?:\n|$))/g)].map(
        (match) => match[1],
      ),
    ),
  ];
  return levels.length === 1 ? levels[0] : undefined;
}

/** Existing attributes replace a tooltip only when they prove this exact item's required fields. */
export function itemNeedsTooltip(
  item: DetailItem,
  attrs: Record<string, string>,
  tab: TabSnapshot,
  pet = false,
): boolean {
  if (equipmentNameUnresolved(item.name)) return true;
  if (attrs.data_skill_type)
    return attrs.data_skill_type !== "cifu" && !/^\d{1,3}$/.test(item.level || "");
  // A level and one stat cannot prove that the existing description contains every
  // tooltip field. Keep role/pet equipment on the demand-read path until that is proven.
  if (item.kind === "equipment" && (pet || !isNonRoleEquipment(item))) return true;
  if (
    item.category === "上古玉魄" &&
    /^\s*\{\s*"minghun"\s*:\s*\{|<json>/i.test(attrs.data_equip_desc || "")
  )
    return true;
  return itemNeedsEquipmentStats(item, tab, pet) || !attrs.data_equip_desc?.trim();
}

export function itemNeedsEquipmentStats(item: DetailItem, tab: TabSnapshot, pet = false): boolean {
  if (item.kind === "equipment") {
    if (
      pet &&
      item.location !== "RolePetShipin" &&
      !/(?:命中(?:率)?|伤害|防御|气血|魔法|速度|敏捷|力量|体质|耐力|灵力|魔力|镶嵌)\s*[：:]?\s*[+＋−-]?\d/.test(
        (item.description || "") +
          "\n" +
          Object.entries(item.attributes || {})
            .map(([key, value]) => key + " " + value)
            .join("\n"),
      )
    )
      return true;
    if (
      !pet &&
      !isNonRoleEquipment(item) &&
      /^道具\/法宝(?:\s*\/|$)/.test(tab.name) &&
      !equipmentCaptureSummary([{ ...tab, items: [item] }], tab.collectedAt || "").complete
    )
      return true;
  }
  return false;
}
