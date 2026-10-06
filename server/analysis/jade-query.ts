import { cleanDescription } from "../crawler/compact";
import type { EquipmentPricingItem } from "./equipment-pricing";

export const JADE_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=show_overall_search_yupo";

export type JadeSearchConfig = {
  minghun_attr: Record<string, string>;
  minghun_attr_yin?: Record<string, string>;
  minghun_attr_yang?: Record<string, string>;
  minghun_effect?: Record<string, string>;
  minghun_teji?: Record<string, string>;
  minghun_daoju?: Record<string, string>;
};

const types: Record<string, string> = {
  "61718": "上古玉魄·阳",
  "61717": "上古玉魄·阴",
};
const normalized = (name: string) => {
  const aliases: Record<string, string> = {
    法术防御: "法防",
    抗物理暴击: "抗物理",
    抗法术暴击: "抗法术",
    抵抗封印: "抗封印",
    格挡值: "格挡",
    气血回复效果: "气血回复",
    抗固定伤害暴击: "抗固伤",
    固定伤害暴击: "固伤暴击",
    法术伤害结果: "法伤结果",
  };
  const value = name.trim().replace(/等级$/, "");
  return aliases[value] || value;
};
const idFor = (name: string, choices: Record<string, string> = {}) => {
  const matches = Object.entries(choices).filter(
    ([id, label]) => /^\d+$/.test(id) && normalized(label) === normalized(name),
  );
  return matches.length === 1 ? matches[0][0] : undefined;
};
const attribute = (line: string) => {
  const match = line.match(/^(.+?)\s*[：:]?\s*[+＋]\s*(\d+)(?:\s*\[[+＋]?\d+\])?$/);
  if (!match) return undefined;
  const value = Number(match[2]);
  return value >= 1 && value <= 999 ? { name: match[1].trim(), value: match[2] } : undefined;
};

/** Official yupo search inputs are lower bounds; only independently verified listings set prices. */
export function jadeQuery(item: EquipmentPricingItem, config: JadeSearchConfig) {
  if (item.category !== "上古玉魄") throw new Error("玉魄查询不能用于普通装备");
  const modelId = item.modelId || Object.keys(types).find((id) => types[id] === item.name);
  if (!modelId || types[modelId] !== item.name)
    throw new Error("玉魄阴阳类型与官方型号不一致，不能构造查价条件");
  const lines = cleanDescription(item.description)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error("玉魄属性尚未采齐");
  const choices =
    (modelId === "61718" ? config.minghun_attr_yang : config.minghun_attr_yin) ||
    config.minghun_attr;
  const args: Record<string, string | number> = { equip_type: modelId, pass_fair_show: "1" };
  const addAttribute = (key: string, line: string) => {
    const parsed = attribute(line);
    const id = parsed && idFor(parsed.name, choices);
    if (id) args[key] = JSON.stringify({ [id]: parsed!.value });
  };
  // parse_yupo_json renders the initial attribute first, then the two ordered base attributes.
  // Do not promote a later recognized line to the initial slot when the first line is unknown.
  addAttribute("init_attrs", lines[0]);
  const baseLines = lines.slice(1).filter((line) => {
    const parsed = attribute(line);
    return parsed && idFor(parsed.name, choices);
  });
  for (const [index, line] of baseLines.slice(0, 2).entries())
    addAttribute("base_attrs" + (index + 1), line);
  for (const line of lines) {
    const level = line.match(/^灵尘等级\s*[：:]?\s*(\d+)$/)?.[1];
    if (level && Number.isSafeInteger(Number(level)) && Number(level) > 0)
      args.minghun_level_min = level;
    const effect = line.match(/^(.+?)\s*[：:]?\s*[+＋]\s*(\d+(?:\.\d+)?)%$/);
    const effectId = effect && idFor(effect[1], config.minghun_effect);
    if (effectId && Number(effect![2]) > 0)
      args.minghun_effect = JSON.stringify({ [effectId]: Number(effect![2]) * 10 });
  }
  for (const [label, key, options] of [
    ["奇袭特技", "special_teji", config.minghun_teji],
    ["奇袭道具", "special_daoju", config.minghun_daoju],
  ] as const) {
    const ids = lines.flatMap((line) => {
      const name = line.match(new RegExp("^" + label + "[：:]\\s*(.+)$"))?.[1];
      const id = name && idFor(name, options);
      return id ? [id] : [];
    });
    if (ids.length) args[key] = [...new Set(ids)].join(",");
  }
  return { act: "yupo_search" as const, args };
}
