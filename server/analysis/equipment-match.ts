import {
  compareEquipmentAttributes,
  equipmentInitialAttribute,
  equipmentGemOnlyAttributeMatchesAbsent,
  equipmentWithoutGemAbsorption,
  separateJewelryAttributes,
  type EquipmentAttributes,
} from "./equip-attributes";

// Absolute floors keep a two-point jewelry roll difference from failing only because its base is low.
// The 20% bound still applies to larger values; these are matching limits, never price adjustments.
export const EQUIPMENT_ATTRIBUTE_ABSOLUTE_TOLERANCES: Readonly<Record<string, number>> = {
  命中: 5,
  伤害: 3,
  防御: 3,
  初始防御: 3,
  灵力: 3,
  力量: 2,
  体质: 2,
  魔力: 2,
  耐力: 2,
  敏捷: 2,
  气血: 10,
  魔法: 5,
  速度: 2,
  法术伤害: 2,
  法术防御: 2,
  法术防御等级: 2,
  法术暴击等级: 2,
  物理暴击等级: 2,
  封印命中等级: 2,
  抗封印等级: 2,
  抵抗封印等级: 2,
  治疗能力: 2,
  格挡值: 2,
  固定伤害: 2,
  狂暴等级: 2,
  穿刺等级: 2,
  抗物理暴击等级: 2,
  抗法术暴击等级: 2,
  气血回复效果: 10,
  法术伤害结果: 2,
};
const smallNumericDifferences = new Set(Object.keys(EQUIPMENT_ATTRIBUTE_ABSOLUTE_TOLERANCES));
export function equipmentAttributeTolerance(field: string, targetValue: number): number | null {
  const name = field.replace(/^(?:主属性|附加属性)·/, "");
  if (!smallNumericDifferences.has(name) || !Number.isFinite(targetValue)) return null;
  if (targetValue === 0) return 0;
  return Math.max(Math.abs(targetValue) * 0.2, EQUIPMENT_ATTRIBUTE_ABSOLUTE_TOLERANCES[name]);
}

/** Public numeric search bounds and detail matching share the same lower limit. */
export function equipmentAttributeLowerBound(field: string, targetValue: number): number | null {
  const tolerance = equipmentAttributeTolerance(field, targetValue);
  return tolerance === null ? null : Math.max(0, targetValue - tolerance);
}
type Match = {
  matchType: "exact" | "similar" | null;
  similarityScore: number;
  differences: string[];
  reason: string | null;
};
const empty = { level: null, fields: {}, restrictions: [], unknownLines: [] };
const sameField = (name: string, left: string[], right: string[]) =>
  !compareEquipmentAttributes(
    { ...empty, fields: { [name]: left } },
    { ...empty, fields: { [name]: right } },
  );
const numbers = (values: string[]) =>
  values.every((value) => /^[+＋−-]?\d+(?:\.\d+)?$/.test(value.trim()))
    ? values
        .map((value) => Number(value.replace("＋", "+").replace("−", "-")))
        .sort((a, b) => a - b)
    : null;

/** Similar quotations retain the observed price; a score only orders comparable samples. */
export function matchEquipmentAttributes(
  target: EquipmentAttributes,
  source: EquipmentAttributes,
  partial = false,
): Match {
  const reject = (reason: string): Match => ({
    matchType: null,
    similarityScore: Infinity,
    differences: [],
    reason,
  });
  const separated = separateJewelryAttributes(target, source, partial);
  if (separated.reason) return reject(separated.reason);
  target = separated.target;
  source = separated.source;
  if (!partial) {
    const exact = compareEquipmentAttributes(target, source);
    if (!exact) return { matchType: "exact", similarityScore: 0, differences: [], reason: null };
    const restrictions = compareEquipmentAttributes(
      { ...target, fields: {} },
      { ...source, fields: {} },
    );
    if (restrictions) return reject(restrictions);
  } else if (source.restrictions.some((value) => !target.restrictions.includes(value))) {
    return reject("专用、绑定或修理限制不匹配");
  }
  const differences: string[] = [];
  let score = 0;
  const names = partial
    ? Object.keys(source.fields)
    : [...new Set([...Object.keys(target.fields), ...Object.keys(source.fields)])];
  for (const name of names) {
    if (name === "耐久") continue;
    let left = target.fields[name] || [];
    const right = source.fields[name] || [];
    if (sameField(name, left, right)) continue;
    if (name === "五行") {
      differences.push(
        "五行：" + (left.join("、") || "未标明") + " → " + (right.join("、") || "未标明"),
      );
      score += 0.1;
      continue;
    }
    if (!left.length) return reject("报价多出价格相关属性“" + name + "”，不能套用到当前装备");
    if (!right.length) return reject("关键属性“" + name + "”缺失");
    if ((!partial && left.length !== right.length) || (partial && right.length > left.length))
      return reject("价格相关属性“" + name + "”条目结构不一致");
    if (partial && left.length > right.length) {
      const remaining = [...left],
        selected: string[] = [];
      for (const value of right) {
        let index = remaining.findIndex((expected) => sameField(name, [expected], [value]));
        if (index < 0 && smallNumericDifferences.has(name.replace(/^(?:主属性|附加属性)·/, ""))) {
          const quoted = numbers([value])?.[0];
          const choices = remaining
            .flatMap((expected, index) => {
              const number = numbers([expected])?.[0];
              const delta =
                number === undefined || quoted === undefined || number === 0
                  ? Infinity
                  : Math.abs(quoted - number) / Math.abs(number);
              return delta <= 0.05 + 1e-10 ? [{ index, delta }] : [];
            })
            .sort((a, b) => a.delta - b.delta);
          index = choices[0]?.index ?? -1;
        }
        if (index < 0) return reject("关键属性“" + name + "”不匹配");
        selected.push(remaining.splice(index, 1)[0]);
      }
      left = selected;
      if (sameField(name, left, right)) continue;
    }
    if (!smallNumericDifferences.has(name.replace(/^(?:主属性|附加属性)·/, "")))
      return reject("关键属性“" + name + "”不匹配");
    const a = numbers(left),
      b = numbers(right);
    if (!a || !b || a.length !== b.length) return reject("关键属性“" + name + "”不能可靠比较");
    const deltas = a.map((value, index) =>
      value === b[index]
        ? 0
        : value === 0
          ? Infinity
          : Math.abs(b[index] - value) / Math.abs(value),
    );
    if (deltas.some((difference) => difference > 0.05 + 1e-10))
      return reject("关键属性“" + name + "”差异超过5%");
    differences.push(
      name +
        "：" +
        a.join("、") +
        " → " +
        b.join("、") +
        "（最大差异" +
        (Math.max(...deltas) * 100).toFixed(2) +
        "%）",
    );
    score += deltas.reduce((total, value) => total + value * 100, 0);
  }
  return {
    matchType: differences.length ? "similar" : "exact",
    similarityScore: score,
    differences,
    reason: null,
  };
}

const comparableDifferences = new Set([
  "五行",
  "宝石",
  "锻炼等级",
  "精炼等级",
  "已生效套装加成",
  "熔炼",
  "修理失败",
  "开运孔数",
  "开运",
  "符石",
  "符石组合",
  "星位",
  "星相",
  "星相互合",
  "力量",
  "体质",
  "魔力",
  "耐力",
  "敏捷",
]);
const baseNumbers = (values: string[]) => {
  const matches = values.map((value) =>
    value.trim().match(/^([+＋−-]?\d+(?:\.\d+)?)(?:点|级)?(?:\s*\[[+＋−-]?\d+(?:\.\d+)?\])?$/),
  );
  return matches.every(Boolean)
    ? matches
        .map((match) => Number(match![1].replace("＋", "+").replace("−", "-")))
        .sort((a, b) => a - b)
    : null;
};

/** Same core equipment may provide a rough reference; differences never become exact prices. */
export function matchComparableEquipmentAttributes(
  target: EquipmentAttributes,
  source: EquipmentAttributes,
  partial = false,
): Match {
  const reject = (reason: string): Match => ({
    matchType: null,
    similarityScore: Infinity,
    differences: [],
    reason,
  });
  const separated = separateJewelryAttributes(target, source, partial);
  target = separated.target;
  source = separated.source;
  if (separated.reason) return reject(separated.reason);
  const displayedDefense = [target.fields.防御?.join("、"), source.fields.防御?.join("、")];
  const initialFields = ["命中", "伤害", "防御", "灵力", "气血", "速度", "法术防御", "躲避"];
  if (!target.jewelrySections && !target.fields.精炼等级) {
    const normalizeInitial = (attributes: EquipmentAttributes, isPartial: boolean) => {
      const fields = { ...attributes.fields };
      for (const name of initialFields) {
        if (!fields[name] && !fields["初始" + name]) continue;
        const value = equipmentInitialAttribute(attributes, name, isPartial);
        if (value === null && !isPartial)
          return { reason: "初始" + name + "未确认，不能以含宝石值代替" };
        delete fields[name];
        delete fields["初始" + name];
        if (value !== null) fields["初始" + name] = [String(value)];
      }
      return { attributes: { ...attributes, fields } };
    };
    const normalizedTarget = normalizeInitial(target, false);
    const normalizedSource = normalizeInitial(source, partial);
    if (normalizedTarget.reason) return reject("目标" + normalizedTarget.reason);
    if (normalizedSource.reason) return reject("报价" + normalizedSource.reason);
    for (const field of ["速度", "伤害"] as const) {
      if (!partial && equipmentGemOnlyAttributeMatchesAbsent(target, source, field))
        delete normalizedTarget.attributes!.fields["初始" + field];
      if (equipmentGemOnlyAttributeMatchesAbsent(source, target, field))
        delete normalizedSource.attributes!.fields["初始" + field];
    }
    target = equipmentWithoutGemAbsorption(normalizedTarget.attributes!);
    source = equipmentWithoutGemAbsorption(normalizedSource.attributes!);
  }
  const numericName = (name: string) =>
    name.replace(/^(?:主属性|附加属性)·/, "").replace(/^初始/, "");
  const comparableNames = partial
    ? Object.keys(source.fields)
    : [...new Set([...Object.keys(target.fields), ...Object.keys(source.fields)])];
  for (const name of comparableNames) {
    if (!smallNumericDifferences.has(numericName(name)) && numericName(name) !== "躲避") continue;
    const a = baseNumbers(target.fields[name] || []),
      b = baseNumbers(source.fields[name] || []);
    if (!a?.length || !b?.length) {
      if (b?.length && !a?.length) return reject("目标基础属性“" + name + "”缺失，不能核验上限");
      continue;
    }
    if (b.length > a.length || (!partial && a.length !== b.length))
      return reject("基础属性“" + name + "”条目结构不一致");
    const upper = partial ? a.slice(-b.length) : a;
    if (b.some((value, index) => value > upper[index]))
      return reject("报价基础属性“" + name + "”高于目标，不作为参考");
  }
  const strict = matchEquipmentAttributes(target, source, partial);
  if (!strict.reason && !separated.reason) return strict;
  const restrictions = compareEquipmentAttributes(
    { ...target, fields: {}, ...(partial ? { unknownLines: [] } : {}) },
    { ...source, fields: {}, ...(partial ? { unknownLines: [] } : {}) },
  );
  if (restrictions) return reject(restrictions);
  const differences: string[] = [];
  if (
    target.fields.初始防御 &&
    displayedDefense.every(Boolean) &&
    displayedDefense[0] !== displayedDefense[1]
  )
    differences.push("防御（含宝石）：" + displayedDefense[0] + " → " + displayedDefense[1]);
  let score = 0;
  const names = partial
    ? Object.keys(source.fields)
    : [...new Set([...Object.keys(target.fields), ...Object.keys(source.fields)])];
  for (const name of names) {
    if (name === "耐久") continue;
    const left = target.fields[name] || [],
      right = source.fields[name] || [];
    if (sameField(name, left, right)) continue;
    if (["特技", "特效"].includes(name)) {
      const tokens = (values: string[]) =>
        values
          .flatMap((value) => value.split(/[、，,；;\s]+/))
          .filter(Boolean)
          .sort();
      if (JSON.stringify(tokens(left)) === JSON.stringify(tokens(right))) continue;
    }
    const unrestricted =
      ["门派条件", "部位条件"].includes(name) &&
      [...left, ...right].every((value) => /^(?:无|不限)$/.test(value.trim()));
    if (unrestricted) continue;
    if (comparableDifferences.has(name)) {
      differences.push(
        name + "：" + (left.join("、") || "未标明") + " → " + (right.join("、") || "未标明"),
      );
      const grades = ["锻炼等级", "精炼等级"].includes(name) ? [numbers(left), numbers(right)] : [];
      score +=
        grades.length && grades[0]?.length === 1 && grades[1]?.length === 1
          ? Math.abs(grades[0][0] - grades[1][0]) * 10
          : name === "宝石"
            ? 30
            : 10;
      continue;
    }
    if (!left.length || !right.length)
      return reject("关键属性“" + name + "”缺失或多出，不能作为相近参考");
    if (!smallNumericDifferences.has(numericName(name)) && numericName(name) !== "躲避")
      return reject("关键属性“" + name + "”不匹配");
    let a = baseNumbers(left);
    const b = baseNumbers(right);
    if (!a || !b || (!partial && a.length !== b.length) || b.length > a.length)
      return reject("价格相关属性“" + name + "”条目结构不一致");
    if (partial && a.length > b.length) {
      const remaining = [...a];
      a = b.map((value) => {
        const choices = remaining
          .map((expected, index) => ({
            index,
            delta:
              expected === value
                ? 0
                : expected === 0
                  ? Infinity
                  : Math.abs(value - expected) / Math.abs(expected),
          }))
          .sort((left, right) => left.delta - right.delta);
        return remaining.splice(choices[0].index, 1)[0];
      });
    }
    const deltas = a.map((value, index) =>
      value === b[index]
        ? 0
        : value === 0
          ? Infinity
          : Math.abs(b[index] - value) / Math.abs(value),
    );
    differences.push(name + "：" + left.join("、") + " → " + right.join("、"));
    score += 1 + deltas.reduce((sum, delta) => sum + delta * 100, 0);
  }
  return { matchType: "similar", similarityScore: score, differences, reason: null };
}
