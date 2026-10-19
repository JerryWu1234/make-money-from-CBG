import type { SavedRoleRecord } from "../crawler/types";
import type { CapturedAssetCounts } from "./types";
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
