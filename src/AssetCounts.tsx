import type { CapturedAssetCounts } from "../server/analysis/types";

export function AssetCounts({ counts }: { counts?: CapturedAssetCounts | null }) {
  return counts ? (
    <span aria-label="已采集资产数量">
      {counts.equipment === null || counts.jewelry === null
        ? `装备/灵饰 ${counts.equipmentTotal}件`
        : `装备 ${counts.equipment}件 · 灵饰 ${counts.jewelry}件`}{" "}
      · 宝宝 {counts.pets}只
    </span>
  ) : null;
}

export function EquipmentSummary({ counts }: { counts?: CapturedAssetCounts | null }) {
  if (!counts?.equipmentItems?.length) return null;
  return (
    <ul className="analysis-equipment-summary" aria-label="装备简要配置">
      {counts.equipmentItems.map((item, index) => (
        <li key={index}>
          {[
            item.name,
            item.level === null ? "" : `${item.level}级`,
            item.gemLevel === null ? "" : `宝石${item.gemLevel}段`,
            item.specialSkills.length ? `特技：${item.specialSkills.join("、")}` : "",
            item.specialEffects.length ? `特效：${item.specialEffects.join("、")}` : "",
            item.sets.length ? `套装：${item.sets.join("、")}` : "",
          ]
            .filter(Boolean)
            .join(" · ")}
        </li>
      ))}
    </ul>
  );
}
