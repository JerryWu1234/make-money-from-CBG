import type { PetSnapshot, RoleDetail } from "./types";

export function petCaptureSummary(
  count: number | null,
  pets: PetSnapshot[],
  collectedAt: string,
  readIssues: string[] = [],
): NonNullable<RoleDetail["petCapture"]> {
  const issues = [...readIssues];
  if (count === null) issues.push("召唤兽总数未确认，不能按没有宝宝处理");
  else if (count !== pets.length)
    issues.push(`召唤兽数量不一致：确认 ${count} 只，读取 ${pets.length} 只`);
  for (const pet of pets) {
    const field = (name: string) => pet.fields.find((entry) => entry.name === name)?.value;
    const names = pet.fields.map((entry) => entry.name.trim());
    if (new Set(names).size !== names.length)
      issues.push(`第 ${pet.index} 只召唤兽属性重复，需要核对`);
    if (!(field("类型") || field("种类"))) issues.push(`第 ${pet.index} 只召唤兽类型未完整读取`);
    for (const name of [
      "等级",
      "成长",
      "攻击资质",
      "防御资质",
      "体力资质",
      "法力资质",
      "速度资质",
      "躲闪资质",
    ]) {
      const value = field(name)?.trim();
      const numeric = name.endsWith("资质")
        ? /^\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?)?$/
        : /^\d+(?:\.\d+)?$/;
      if (!value || !numeric.test(value) || (name === "成长" && Number(value) <= 0))
        issues.push(`第 ${pet.index} 只召唤兽${name}未完整读取`);
    }
    for (const skill of [...pet.skills, ...pet.innerSkills]) {
      if (!skill.name || skill.name.startsWith("图标 "))
        issues.push(`第 ${pet.index} 只召唤兽技能或内丹名称未完整读取`);
      if (skill.kind === "innerSkill" && !/^\d+$/.test(skill.level || ""))
        issues.push(`第 ${pet.index} 只召唤兽${skill.name}的内丹层数未完整读取`);
    }
    for (const equipment of pet.equipment) {
      const description =
        (equipment.description || equipment.tooltip || "") +
        "\n" +
        Object.entries(equipment.attributes || {})
          .map(([name, value]) => `${name} ${value}`)
          .join("\n");
      // Official RolePetShipin is a cosmetic slot; it has no required combat level or stats.
      if (
        !equipment.name ||
        equipment.name.startsWith("图标 ") ||
        (equipment.location === "RolePetShipin"
          ? !description.trim()
          : !/(?:等级|装备条件)\s*[：:]?\s*\d/.test(description) ||
            !/(?:命中(?:率)?|伤害|防御|气血|魔法|速度|敏捷|力量|体质|耐力|灵力|魔力|法术|抵抗|附加|镶嵌)\s*[：:]?\s*[+＋−-]?\d/.test(
              description,
            ))
      )
        issues.push(`第 ${pet.index} 只召唤兽${equipment.name}的装备属性未完整读取`);
    }
  }
  const unique = [...new Set(issues)];
  return { version: 1, collectedAt, complete: unique.length === 0, issues: unique };
}
