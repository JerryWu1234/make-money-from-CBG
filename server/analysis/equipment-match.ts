import { compareEquipmentAttributes, type EquipmentAttributes } from "./equip-attributes";

const smallNumericDifferences = new Set([
  "命中",
  "伤害",
  "防御",
  "灵力",
  "力量",
  "体质",
  "魔力",
  "耐力",
  "敏捷",
  "气血",
  "魔法",
  "速度",
  "法术伤害",
  "法术防御",
  "法术防御等级",
  "法术暴击等级",
  "物理暴击等级",
  "封印命中等级",
  "抗封印等级",
  "抵抗封印等级",
  "治疗能力",
  "格挡值",
  "固定伤害",
  "狂暴等级",
  "穿刺等级",
  "抗物理暴击等级",
  "抗法术暴击等级",
  "气血回复效果",
  "法术伤害结果",
]);
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
        if (index < 0 && smallNumericDifferences.has(name)) {
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
    if (!smallNumericDifferences.has(name)) return reject("关键属性“" + name + "”不匹配");
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
