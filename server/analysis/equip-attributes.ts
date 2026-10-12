import { cleanDescription, jewelryDescriptionSections } from "../crawler/compact";

export type EquipmentAttributes = {
  level: number | null;
  fields: Record<string, string[]>;
  restrictions: string[];
  unknownLines: string[];
  jewelrySections?: { main: Record<string, string[]>; added: Record<string, string[]> };
};

const aliases: Record<string, string> = {
  耐久度: "耐久",
  镶嵌宝石: "宝石",
  宝石等级: "锻炼等级",
  熔炼效果: "熔炼",
  套装效果: "套装",
  点化特效: "点化",
};
const labels = [
  "等级",
  "五行",
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
  "法术伤害结果",
  "法术伤害",
  "法术防御等级",
  "法术防御",
  "法术暴击等级",
  "法术暴击伤害",
  "法术暴击",
  "物理暴击等级",
  "物理暴击伤害",
  "物理暴击",
  "封印命中等级",
  "封印命中",
  "抗封印等级",
  "治疗能力",
  "格挡值",
  "固定伤害",
  "狂暴等级",
  "穿刺等级",
  "抗物理暴击等级",
  "抗法术暴击等级",
  "气血回复效果",
  "抵抗封印等级",
  "抵抗封印",
  "抵抗控制",
  "特技",
  "特效",
  "套装",
  "套装效果",
  "宝石",
  "镶嵌宝石",
  "锻炼等级",
  "宝石等级",
  "精炼等级",
  "熔炼效果",
  "熔炼",
  "符石组合",
  "符石",
  "星位",
  "星相",
  "点化特效",
  "点化",
  "开运孔数",
  "开运",
  "修理失败",
  "耐久度",
  "耐久",
  "附加属性",
  "装备角色",
  "装备对象",
  "装备条件",
  "使用条件",
  "门派条件",
  "部位条件",
].sort((a, b) => b.length - a.length);
const fieldPattern = new RegExp(
  "(?:^|[\\n\\r\\t\\s，,；;【\\[]|(?<=[\\d%％]))(" +
    labels.join("|") +
    ")(?=[：:】\\]]|\\s|[+＋−-]?\\d)",
  "g",
);
const conditionPattern =
  /(?:^|[\s【[])(装备角色|装备对象|装备条件|使用条件|门派条件|部位条件)(?=[：:】\]]|\s)/g;
const normalize = (value: string) => value.replace(/[\s：:，,；;【】[\]]/g, "").toLowerCase();
function canonical(value: string) {
  const normalized = normalize(value).replace(/＋/g, "+").replace(/−/g, "-");
  const number = normalized.match(/^([+-]?\d+(?:\.\d+)?)(?:点|级|次|锻)?$/)?.[1];
  return number === undefined ? normalized : String(Number(number));
}
const statLabels = [
  "法术伤害",
  "法术防御",
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
  "固定伤害",
  "狂暴等级",
  "穿刺等级",
  "抗物理暴击等级",
  "抗法术暴击等级",
  "气血回复效果",
  "抵抗封印等级",
];
function canonicalValues(value: string): string[] {
  const text = value.replace(/＋/g, "+").replace(/−/g, "-");
  const reversed = text.replace(
    new RegExp("(^|[\\s、，,；;])([+-]?\\d+(?:\\.\\d+)?)(" + statLabels.join("|") + ")", "g"),
    "$1$3:$2",
  );
  const pattern = new RegExp(
    "(" + statLabels.join("|") + ")[：:]?\\s*([+-]?\\d+(?:\\.\\d+)?)",
    "g",
  );
  const stats = [...reversed.matchAll(pattern)];
  if (stats.length && !reversed.replace(pattern, "").replace(/[\s、，,；;]/g, ""))
    return stats.map((entry) => entry[1] + ":" + canonical(entry[2]));
  return /^[+-]?\d+(?:\.\d+)?$/.test(canonical(text))
    ? [canonical(text)]
    : text
        .split(/[、，,；;]/)
        .filter(Boolean)
        .map(canonical);
}

/** Parse observed fields only. Repeated jewelry lines remain separate values. */
export function parseEquipmentAttributes(description: string): EquipmentAttributes {
  const text = cleanDescription(description);
  const fields: Record<string, string[]> = {};
  const unknownLines: string[] = [];
  let refining = false;
  let runeCombination = false;
  // Jewelry set bonuses follow its named effect, not its primary/added stat rows.
  const jewelry = /精炼等级/.test(text);
  let effectBonus = false;
  for (const line of text
    .split(/\n/)
    .map((value) => value.trim())
    .filter(Boolean)) {
    if (
      runeCombination &&
      /^(?:门派条件[：:]|部位条件[：:]|物理攻击时|物理攻击有|法术攻击时|遭受法术攻击时|提升自身|增加门派技能)/.test(
        line,
      )
    ) {
      fields.符石组合.push(line);
      continue;
    }
    runeCombination = false;
    const conditions = [...line.matchAll(conditionPattern)];
    if (conditions[0]?.index === 0) {
      for (let index = 0; index < conditions.length; index++) {
        const match = conditions[index];
        const value = line
          .slice(match.index! + match[0].length, conditions[index + 1]?.index ?? line.length)
          .replace(/^[\s：:】\]]+|[\s，,；;【[]+$/g, "")
          .trim();
        if (value) (fields[match[1]] ||= []).push(value);
      }
      refining = false;
      effectBonus = false;
      continue;
    }
    const melt = line.match(/^(?:【)?熔炼(?:效果)?[：:】\s]*(.*)$/);
    if (melt) {
      refining = true;
      effectBonus = false;
      if (melt[1]) (fields.熔炼 ||= []).push(melt[1]);
      continue;
    }
    if (refining && /^[+＋−-]\d/.test(line)) {
      (fields.熔炼 ||= []).push(line);
      continue;
    }
    refining = false;
    const enhancement = line.match(/^(符石组合|符石|星位|星相互合|星相)[：:]\s*(.+)$/);
    if (enhancement) {
      (fields[enhancement[1]] ||= []).push(enhancement[2]);
      runeCombination = enhancement[1] === "符石组合";
      continue;
    }
    const content = line
      .replace(/^(?:【)?附加属性[：:】\s]*/, "")
      .replace(
        new RegExp("(^|[\\s、，,；;])([+＋−-]\\d+(?:\\.\\d+)?)(" + statLabels.join("|") + ")", "g"),
        "$1$3:$2 ",
      );
    const matches = [...content.matchAll(fieldPattern)];
    if (!content.trim()) continue;
    if (!matches.length) {
      if (
        /^(?:法术|物理|封印|抗|治疗|格挡|抵抗|固定|狂暴|穿刺|气血|附加|熔炼|星位|星相|[+＋−-]\d)/.test(
          line,
        )
      )
        unknownLines.push(line);
      continue;
    }
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      const value = content
        .slice(match.index! + match[0].length, matches[index + 1]?.index ?? content.length)
        .replace(/^[\s：:】\]]+|[\s，,；;【[]+$/g, "")
        .trim();
      // Headers such as “附加属性：力量+20 敏捷+20” contain no separate value.
      if (!value) continue;
      const name = aliases[match[1]] || match[1];
      if (jewelry && effectBonus && statLabels.includes(name)) {
        const active = /[（(]已生效[）)]$/.test(value);
        const bonus = active ? value.replace(/[（(]已生效[）)]$/, "").trim() : value;
        (fields[active ? "已生效套装加成" : "特效加成"] ||= []).push(name + ":" + bonus);
      } else {
        (fields[name] ||= []).push(value);
      }
      if (jewelry && name === "特效") effectBonus = true;
    }
  }
  const restrictions = [
    ...text.matchAll(
      /玩家\s*\d+\s*专用|专用(?:装备)?|不可交易|不能交易|绑定|无法修复|不能修理|不可修理/g,
    ),
  ].map((match) => normalize(match[0]));
  const levels = fields.等级?.map((value) => canonical(value));
  const level = levels?.length === 1 && /^\d+$/.test(levels[0]) ? Number(levels[0]) : null;
  let sections = jewelry ? jewelryDescriptionSections(description) : null;
  if (jewelry && !sections) {
    // Independent listings often omit the color-derived header in innerText. The observed
    // bracketed refinement bonuses identify their contiguous two/three added stat rows.
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const indexes = lines.flatMap((line, index) =>
      /^[\u4e00-\u9fff]+\s*[+＋−-]?\d+(?:\.\d+)?\s*\[[+＋−-]?\d+(?:\.\d+)?\]$/.test(line)
        ? [index]
        : [],
    );
    if (
      [2, 3].includes(indexes.length) &&
      indexes.every((index, offset) => index === indexes[0] + offset)
    )
      sections = {
        main: lines.slice(0, indexes[0]).join("\n"),
        added: indexes.map((index) => lines[index]),
      };
  }
  return {
    level,
    fields,
    restrictions,
    unknownLines,
    ...(sections
      ? {
          jewelrySections: {
            main: parseEquipmentAttributes(sections.main).fields,
            added: parseEquipmentAttributes(sections.added.join("\n")).fields,
          },
        }
      : {}),
  };
}

/** Same-named primary and added jewelry stats must never trade places in a comparison. */
export function separateJewelryAttributes(
  target: EquipmentAttributes,
  source: EquipmentAttributes,
  partial = false,
) {
  const overlap = [
    ...new Set(
      [target, source].flatMap((value) =>
        value.jewelrySections
          ? Object.keys(value.jewelrySections.main).filter(
              (name) =>
                Object.hasOwn(value.jewelrySections!.added, name) &&
                (Object.hasOwn(target.fields, name) || Object.hasOwn(source.fields, name)),
            )
          : [],
      ),
    ),
  ];
  if (!overlap.length || (partial && !source.jewelrySections))
    return { target, source, reason: null };
  if (!target.jewelrySections || !source.jewelrySections)
    return { target, source, reason: "灵饰主属性与附加属性缺少分段证据，不能混合比较" };
  const separate = (value: EquipmentAttributes) => {
    const fields = { ...value.fields };
    for (const name of overlap) {
      delete fields[name];
      for (const [section, prefix] of [
        ["main", "主属性"],
        ["added", "附加属性"],
      ] as const) {
        const values = value.jewelrySections![section][name];
        if (values?.length) fields[prefix + "·" + name] = values;
      }
    }
    return { ...value, fields };
  };
  return { target: separate(target), source: separate(source), reason: null };
}

/** Strict matching does not infer premiums, discounts or substitute superior items. */
export function compareEquipmentAttributes(
  target: EquipmentAttributes,
  source: EquipmentAttributes,
) {
  const separated = separateJewelryAttributes(target, source);
  if (separated.reason) return separated.reason;
  target = separated.target;
  source = separated.source;
  const sorted = (values: string[]) => values.flatMap(canonicalValues).sort();
  const same = (left: string[], right: string[]) =>
    JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
  if (!same(target.restrictions, source.restrictions)) return "专用、绑定或修理限制不匹配";
  for (const [name, values] of Object.entries(target.fields)) {
    if (name === "耐久") continue;
    if (!same(values, source.fields[name] || [])) return "关键属性“" + name + "”不匹配";
  }
  for (const name of Object.keys(source.fields))
    if (name !== "耐久" && !Object.hasOwn(target.fields, name))
      return "报价多出价格相关属性“" + name + "”，不能套用到当前装备";
  if (!same(target.unknownLines, source.unknownLines)) return "未识别的价格相关属性不匹配";
  return null;
}
