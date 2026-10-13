import type { PetPricingItem } from "./pet-pricing";

// This is an allowlist of ordinary skills allowed to differ, not an official rarity taxonomy.
// Every unknown or newly introduced skill is protected until deliberately reviewed.
const variableSkills = new Set(
  [
    "地狱烈火",
    "泰山压顶",
    "水漫金山",
    "奔雷咒",
    "雷击",
    "落岩",
    "水攻",
    "烈火",
    "夜战",
    "偷袭",
    "吸血",
    "连击",
    "必杀",
    "反击",
    "反震",
    "飞行",
    "招架",
    "防御",
    "敏捷",
    "再生",
    "慧根",
    "冥思",
    "幸运",
    "感知",
    "驱鬼",
    "鬼魂术",
    "弱点水",
    "弱点土",
    "魔之心",
    "法术连击",
    "法术暴击",
    "法术波动",
    "神佑复生",
    "精神集中",
    "隐身",
  ].flatMap((name) => [name, "高级" + name]),
);
export const PET_APTITUDE_TOLERANCE = 0.15;
export const PET_GROWTH_TOLERANCE = 0.03;
export const PET_LEVEL_TOLERANCE = 5;
export const PET_BLESSING_POLICY_VERSION = "explicit-blessing-and-legacy-preview-v2";
export const PET_COMPARISON_POLICY_VERSION =
  "protected-magic-core-compatible-gear-and-resumable-groups-v2";

/** The template calls ordinary skill icons `cifu`; only explicit fields establish blessing state. */
export function petBlessingState(fields: { name: string; value: string }[]) {
  const relevant = fields.filter((field) => /赐福/.test(field.name));
  const states = relevant.map(({ name, value }) => {
    name = name.replace(/[\s：:]/g, "");
    value = value.replace(/\s/g, "");
    if (/^(?:有效)?赐福技能(?:数|数量)$/.test(name)) {
      if (/^0(?:个)?$/.test(value)) return "absent";
      return /^[1-9]\d*(?:个)?$/.test(value) ? "present" : "unknown";
    }
    if (!/^(?:是否赐福|赐福(?:状态|技能)?)$/.test(name)) return "unknown";
    if (/^(?:无|否|没有|未赐福|无赐福|未获得|0)$/.test(value)) return "absent";
    if (!value || /未知|未采|待补|不明|未确认/.test(value)) return "unknown";
    return "present";
  });
  const state: "absent" | "present" | "unknown" =
    !states.length || states.includes("unknown") || new Set(states).size !== 1
      ? "unknown"
      : states[0] === "absent"
        ? "absent"
        : "present";
  return { state, fields: relevant };
}
/** Only labels and values observed in the official initial/one/two/three-star chooser. */
export function canonicalPetStar(value?: string): string | undefined {
  const text = value?.trim();
  if (text === undefined) return undefined;
  const labels: Record<string, string> = { 初始: "0", 一星: "1", 二星: "2", 三星: "3" };
  return labels[text] ?? text.match(/^([0-3])(?:星)?$/)?.[1];
}
export const petSkillState = (name: string, item?: Pick<PetPricingItem, "skillObservations">) =>
  item?.skillObservations?.find((skill) => skill.rawName === name)?.state ||
  (/[（(]进化后获得[）)]/.test(name.replace(/\s/g, "")) ? "future" : "current");
export const currentPetSkills = (item: Pick<PetPricingItem, "skills" | "skillObservations">) =>
  item.skills.filter((name) => petSkillState(name, item) === "current");
export const protectedPetSkills = (skills: string[]) =>
  skills.filter(
    (name) =>
      !variableSkills.has(name) ||
      (skills.includes("须弥真言") && ["高级法术连击", "高级魔之心"].includes(name)),
  );
export const PET_SEARCH_MAX_SKILLS = 5;

const LOW_PRIORITY_SKILLS = new Set([
  "慧根",
  "冥思",
  "精神集中",
  "迟钝",
  "否定信仰",
  "神迹",
  "再生",
  "招架",
  "防御",
  "敏捷",
  "反震",
  "反击",
  "飞行",
  "弱点水",
  "弱点土",
  "弱点火",
  "弱点雷",
  "落岩",
  "水攻",
  "烈火",
  "雷击",
]);

export function prioritizePetSkills(skills: string[]): string[] {
  const protectedSet = new Set(protectedPetSkills(skills));
  return [...skills].sort((left, right) => {
    const leftProtected = protectedSet.has(left) ? 1 : 0;
    const rightProtected = protectedSet.has(right) ? 1 : 0;
    if (leftProtected !== rightProtected) return rightProtected - leftProtected;

    const leftHigh = /^(?:超级|高级)/.test(left) ? 1 : 0;
    const rightHigh = /^(?:超级|高级)/.test(right) ? 1 : 0;
    if (leftHigh !== rightHigh) return rightHigh - leftHigh;

    const leftLow = LOW_PRIORITY_SKILLS.has(left) ? 1 : 0;
    const rightLow = LOW_PRIORITY_SKILLS.has(right) ? 1 : 0;
    if (leftLow !== rightLow) return leftLow - rightLow;

    return 0;
  });
}
export const petLevelBounds = (level: number) =>
  level === 0
    ? [0, 0]
    : [Math.max(1, level - PET_LEVEL_TOLERANCE), Math.min(180, level + PET_LEVEL_TOLERANCE)];

export function similarPetSkills(target: string[], source: string[]) {
  const equal = (left: string[], right: string[]) =>
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  if (!equal(protectedPetSkills(target), protectedPetSkills(source)))
    return { accepted: false, reason: "受保护或未知技能不同，不能混用相近宝宝报价" };
  if (equal(target, source)) return { accepted: true, differences: [] };
  const common = target.filter((name) => source.includes(name));
  if (common.length < 2 || common.length / Math.max(target.length, source.length) < 0.6)
    return { accepted: false, reason: "相同当前技能不足2个或覆盖双方技能的60%，相似性不足" };
  return {
    accepted: true,
    differences: [
      `当前技能：共有 ${common.join("、")}；目标独有 ${target.filter((name) => !source.includes(name)).join("、") || "无"}；样本独有 ${source.filter((name) => !target.includes(name)).join("、") || "无"}（共有${common.length}项，未据此推测折价）`,
    ],
  };
}
