import { cleanDescription } from "../crawler/compact";
import { equipmentAttributeTolerance } from "./equipment-match";

export const SPECIAL_ASSET_MATCH_POLICY = "ordered-special-slots-base-values-v1";
type SpecialAsset = { category: string; name: string; description: string };

/** Keep unknown lines, ordered slots, bonuses, probabilities and restrictions literal. */
function descriptionParts(item: SpecialAsset, description: string) {
  const values: Array<{ name: string; value: number; tolerance: number }> = [];
  const lines = cleanDescription(description)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== item.name && !/^耐久(?:度)?\s*[：:]?\s*\d+$/.test(line));
  const template = lines.map((line) => {
    if (item.category === "上古玉魄") {
      const match = line.match(/^(.+?)\s*[+＋]\s*(\d+)(\s*\[[+＋]?\d+\])?$/);
      if (!match || values.length >= 3) return line.replace(/\s/g, "");
      const name = match[1].trim(),
        value = Number(match[2]);
      const tolerance = equipmentAttributeTolerance(name, value);
      if (tolerance === null) return line.replace(/\s/g, "");
      values.push({ name, value, tolerance });
      return (name + "{base}" + (match[3] || "")).replace(/\s/g, "");
    }
    // Only plain main-stat lines can widen. Added attributes/probabilities remain protected.
    if (!/^(?:伤害|命中|防御|魔法|灵力|气血|敏捷)\s*[：:+＋\d]/.test(line))
      return line.replace(/\s/g, "");
    return line
      .replace(
        /(伤害|命中|防御|魔法|灵力|气血|敏捷)\s*[：:]?\s*[+＋]?(\d+)(?![\d.%])/g,
        (_text, name: string, number: string) => {
          const value = Number(number),
            tolerance = equipmentAttributeTolerance(name, value)!;
          values.push({ name, value, tolerance });
          return name + "{base}";
        },
      )
      .replace(/\s/g, "");
  });
  return { template, values };
}

/** Dedicated comparisons never apply ordinary equipment enhancements to jade or yuanshen. */
export function matchSpecialAsset(item: SpecialAsset, sourceDescription: string) {
  const target = descriptionParts(item, item.description);
  const source = descriptionParts(item, sourceDescription);
  const reject = (reason: string) => ({
    matchType: null,
    reason,
    differences: [] as string[],
    similarityScore: Infinity,
  });
  const label = item.category === "上古玉魄" ? "玉魄" : "元身";
  if (
    JSON.stringify(target.template) !== JSON.stringify(source.template) ||
    target.values.length !== source.values.length
  )
    return reject(label + "属性槽位、加成、概率、效形、奇袭/到期条件或限制不一致");
  const differences: string[] = [];
  let score = 0;
  for (const [index, left] of target.values.entries()) {
    const right = source.values[index];
    const delta = Math.abs(left.value - right.value);
    if (left.name !== right.name || delta > left.tolerance)
      return reject(label + left.name + "基础数值超出相近范围");
    if (delta) {
      differences.push(
        label +
          "第" +
          (index + 1) +
          "项" +
          left.name +
          "：当前" +
          left.value +
          "，报价" +
          right.value,
      );
      score += delta / Math.max(left.tolerance, 1);
    }
  }
  return {
    matchType: differences.length ? ("similar" as const) : ("exact" as const),
    reason: null,
    differences,
    similarityScore: score,
  };
}
