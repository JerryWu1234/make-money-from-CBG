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
export const petSkillState = (name: string, item?: Pick<PetPricingItem, "skillObservations">) =>
  item?.skillObservations?.find((skill) => skill.rawName === name)?.state ||
  (/[（(]进化后获得[）)]/.test(name.replace(/\s/g, "")) ? "future" : "current");
export const currentPetSkills = (item: Pick<PetPricingItem, "skills" | "skillObservations">) =>
  item.skills.filter((name) => petSkillState(name, item) === "current");
export const protectedPetSkills = (skills: string[]) =>
  skills.filter((name) => !variableSkills.has(name));
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
