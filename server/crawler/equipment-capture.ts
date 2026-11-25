import type { RoleDetail, TabSnapshot } from "./types";
import {
  equipmentEmptyProof,
  hasUnconfirmedEmptyEquipment,
  observedEquipmentCategory,
  isNonRoleEquipment,
  equipmentNameUnresolved,
} from "./compact";

export function unidentifiedEquipmentLevel(text: string): number | null {
  if (!text.split("\n").some((line) => line.trim() === "未鉴定物品")) return null;
  const levels = [
    ...new Set(
      [...text.matchAll(/(?:^|\n)\s*等级\s*[：:]?\s*(\d{1,3})(?=\s*(?:\n|$))/g)].map((match) =>
        Number(match[1]),
      ),
    ),
  ];
  return levels.length === 1 ? levels[0] : null;
}

export function equipmentCaptureSummary(
  tabs: TabSnapshot[],
  collectedAt: string,
  readIssues: string[] = [],
): NonNullable<RoleDetail["equipmentCapture"]> {
  const issues = [...readIssues];
  const equipmentTabs = tabs.filter((tab) => /^道具\/法宝(?:\s*\/|$)/.test(tab.name));
  if (!equipmentTabs.length) issues.push("没有读取到道具/法宝页");
  for (const tab of equipmentTabs) {
    if (!tab.items?.length && !/现金|存银|道具和法宝|暂无道具|没有装备|无装备/.test(tab.text))
      issues.push(`${tab.name}：物品内容未完整读取，无法确认装备是否为空`);
    for (const item of tab.items || []) {
      const category = observedEquipmentCategory(item.category, item.location, item.modelId);
      if (item.kind !== "equipment" || isNonRoleEquipment(item)) continue;
      if (equipmentNameUnresolved(item.name))
        issues.push(`${tab.name}：型号 ${item.modelId || "未知"} 的装备名称未完整读取`);
      if (
        category === "上古玉魄" &&
        /^\s*\{\s*"minghun"\s*:\s*\{|<json>/i.test(item.description || "")
      ) {
        issues.push(`${tab.name}：${item.name} 的玉魄属性仍为原始JSON，未读取官网展示说明`);
        continue;
      }
      const stats = Object.entries(item.attributes || {}).some(
        ([name, value]) =>
          /^(?:命中|伤害|防御|气血|魔法|魔力|灵力|速度|敏捷|力量|体质|耐力|法术伤害|法术防御|法术暴击|物理暴击|封印命中|抵抗封印|抗物理暴击|抗法术暴击|抗固伤|固伤暴击|穿刺|狂暴|治疗能力|格挡|抵抗)(?:等级|值)?$/.test(
            name,
          ) && /\d/.test(value),
      );
      const describedStats =
        /(?:^|\n|\s)(?:命中|伤害|防御|气血|魔法|魔力|灵力|速度|敏捷|力量|体质|耐力|法术伤害|法术防御|法术暴击|物理暴击|封印命中|抵抗封印|抗物理暴击|抗法术暴击|抗固伤|固伤暴击|穿刺|狂暴|治疗能力|格挡|抵抗)(?:等级|值)?\s*[：:]?\s*[+＋−-]?\d/.test(
          item.description || "",
        );
      const unidentifiedLevel = unidentifiedEquipmentLevel(item.description || "");
      const completeUnidentified =
        unidentifiedLevel !== null &&
        (item.attributes?.等级 === undefined || Number(item.attributes.等级) === unidentifiedLevel);
      if (!describedStats && !stats && !completeUnidentified)
        issues.push(`${tab.name}：${item.name} 的装备属性未完整读取`);
      const level =
        /^\d{1,3}$/.test(item.attributes?.等级 || "") ||
        /(?:^|[\n\s【：:])等级\s*[：:]?\s*\d{1,3}/.test(
          (item.description || "") + "\n" + (item.attributes?.装备条件 || ""),
        );
      if (!level && category !== "上古玉魄")
        issues.push(`${tab.name}：${item.name} 的装备等级未完整读取`);
    }
  }
  const emptyProof = equipmentEmptyProof(equipmentTabs);
  if (hasUnconfirmedEmptyEquipment({ tabs, raw: {}, url: "", collectedAt }))
    issues.push("人物装备库存是否为空尚未核对，需确认穿戴与随身装备区域后再计价");
  const unique = [...new Set(issues)];
  return {
    version: 1,
    collectedAt,
    complete: unique.length === 0,
    issues: unique,
    ...(emptyProof ? { emptyProof } : {}),
  };
}
