import type { SavedRoleRecord } from "../crawler/types";
import type { AnalysisItem, CapturedAssetCounts } from "./types";
import { currentPetSkills, petSkillState, prioritizePetSkills } from "./pet-match";
import { equipmentInventory, isJewelryEquipment } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";
import { parseEquipmentAttributes } from "./equip-attributes";
import { observedEquipmentCategory } from "../crawler/compact";

/** Count collected inventory, independent of whether its market value will be analyzed. */
export function capturedAssetCounts(record: SavedRoleRecord): CapturedAssetCounts | null {
  if (!record.detail || record.detail.captureMode === "body") return null;
  const equipment = equipmentInventory(record),
    pets = petInventory(record);
  if (!equipment.captureComplete || !pets.captureComplete) return null;
  const originalItems = new Map(
    record.detail.tabs.flatMap((tab) =>
      (tab.items || []).map((item) => [tab.name + ":" + item.index, item] as const),
    ),
  );
  const wearable = equipment.items.filter((item) => !/上古玉魄|元身/.test(item.category));
  const unknown = wearable.filter((item) => {
    const original = originalItems.get(item.key);
    return (
      !isJewelryEquipment(item) &&
      !observedEquipmentCategory(original?.category, original?.location, original?.modelId)
    );
  });
  const characterEquipment = wearable.filter(
    (item) => !isJewelryEquipment(item) && !unknown.includes(item),
  );
  return {
    equipment: unknown.length ? null : characterEquipment.length,
    jewelry: unknown.length ? null : wearable.filter(isJewelryEquipment).length,
    pets: pets.items.length,
    ...(unknown.length ? { equipmentTotal: wearable.length } : {}),
    equipmentItems: characterEquipment.map((item) => {
      const { fields } = parseEquipmentAttributes(item.description);
      const gem = fields["锻炼等级"]?.[0];
      return {
        name: item.name,
        level: item.level,
        gemLevel: gem !== undefined && /^\d+$/.test(gem) ? Number(gem) : null,
        specialSkills: fields["特技"] || [],
        specialEffects: fields["特效"] || [],
        sets: fields["套装"] || [],
      };
    }),
  };
}

/** Compact observed inventory for ranking cards; never an asset price estimate. */
export function capturedAssetSummary(record: SavedRoleRecord): AnalysisItem["assetSummary"] {
  const counts = capturedAssetCounts(record);
  if (!counts) return null;
  const grade = (values?: string[]) =>
    values?.length === 1 && /^\d+$/.test(values[0]) ? Number(values[0]) : null;
  const gear = equipmentInventory(record)
    .items.filter((item) => !/上古玉魄|元身/.test(item.category))
    .map((item) => {
      const { fields } = parseEquipmentAttributes(item.description);
      const gem = grade(fields.锻炼等级),
        refined = grade(fields.精炼等级);
      const traits = [
        ...(fields.特技 || []).map((value) => `特技：${value}`),
        ...(fields.特效 || []).map((value) => `特效：${value}`),
        ...(fields.套装 || []).map((value) => `套装：${value}`),
      ];
      return {
        gemmed: (gem ?? 0) > 0 || (refined ?? 0) > 0,
        featured: traits.length > 0,
        text: [
          item.name,
          item.level === null ? "等级未读取" : `${item.level}级`,
          gem === null ? "" : `宝石${gem}段`,
          refined === null ? "" : `星辉石${refined}段`,
          ...traits,
          item.status === "untradable" ? "专用/绑定" : "",
          fields.修理失败?.some((value) => /^3\s*次?$/.test(value)) ? "修理失败3次" : "",
        ]
          .filter(Boolean)
          .join(" / "),
      };
    });
  const equipment =
    counts.equipment === null || counts.jewelry === null
      ? `装备/灵饰 ${counts.equipmentTotal}件（分类待核实）`
      : `装备 ${counts.equipment}件 · 灵饰 ${counts.jewelry}件`;
  const previews = [...gear].sort((a, b) => Number(b.featured) - Number(a.featured)).slice(0, 3);
  const pets = petInventory(record).items;
  const wild = pets.filter((pet) =>
    pet.fields.some(
      (field) => ["是否宝宝", "宝宝"].includes(field.name) && /^(?:否|0|野生)$/.test(field.value),
    ),
  );
  const nonWild = pets.filter((pet) => !wild.includes(pet));
  const zero = nonWild.filter((pet) => pet.level === 0);
  const babies = nonWild.filter(
    (pet) =>
      pet.level !== 0 &&
      pet.fields.some(
        (field) => ["是否宝宝", "宝宝"].includes(field.name) && /^(?:是|1)$/.test(field.value),
      ),
  );
  const unknown = nonWild.length - zero.length - babies.length;
  const petPreviews = babies.slice(0, 2).map((pet) => {
    const skills = prioritizePetSkills(currentPetSkills(pet));
    const pendingSkills = pet.skills.some((name) =>
      ["unknown", "conditional"].includes(petSkillState(name, pet)),
    );
    const skillSummary = `${skills.length}技能${skills.length ? `：${skills.slice(0, 3).join("、")}${skills.length > 3 ? "等" : ""}` : ""}`;
    return [
      pet.name,
      pet.level === null ? "等级未读取" : `${pet.level}级`,
      pendingSkills ? `当前已确认${skillSummary}，另有技能待核实` : skillSummary,
      pet.status === "untradable" ? "专用/绑定" : "",
    ]
      .filter(Boolean)
      .join(" / ");
  });
  return {
    equipment: [
      `${equipment} · 带宝石/星辉石 ${gear.filter((item) => item.gemmed).length}件`,
      ...previews.map((item) => item.text),
      gear.length > previews.length ? `另有${gear.length - previews.length}件，详情可查看` : "",
    ]
      .filter(Boolean)
      .join("；"),
    pets: [
      `非野生宝宝 ${babies.length}只`,
      ...petPreviews,
      babies.length > petPreviews.length ? `另有${babies.length - petPreviews.length}只` : "",
      wild.length ? `野生${wild.length}只（不计入）` : "",
      zero.length ? `0级${zero.length}只（不计入）` : "",
      unknown ? `类型未核实${unknown}只` : "",
    ]
      .filter(Boolean)
      .join("；"),
  };
}
