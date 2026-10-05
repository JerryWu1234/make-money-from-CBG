import type { DetailItem, Listing, RoleDetail } from "./types";

export const CAPTURE_VERSION = 6;
export function cleanDescription(value: string) {
  return value
    .replace(/#r/g, "\n")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/#[RGBYWKnbu]|#c[0-9a-f]{6}/gi, "")
    .trim();
}

/** Only these role slots have been observed with an unambiguous category on the official page. */
export function observedEquipmentCategory(category = "", location = "") {
  if (category.trim() && !/^(?:\d+|人物装备|装备|武器)$/.test(category.trim())) return category;
  const label: Record<string, string> = {
    role_using_equip_3: "鞋子",
    role_using_equip_4: "饰品",
    role_using_equip_5: "腰带",
  };
  return label[location]
    ? "人物装备 · " + label[location]
    : /^\d+$/.test(category.trim())
      ? ""
      : category;
}

const jewelryAttributePattern =
  /^(固定伤害|法术伤害结果|法术伤害|法术防御(?:等级)?|法术暴击(?:等级)?|物理暴击(?:等级)?|抗物理暴击(?:等级)?|抗法术暴击(?:等级)?|抵抗封印(?:等级)?|抗封印等级|封印命中(?:等级)?|狂暴(?:等级)?|穿刺(?:等级)?|治疗能力|格挡值|气血回复效果|回复|气血|防御|速度|伤害|固伤|法伤结果|法伤|法防|封印|抗封|治疗|格挡)[：:\s]*[+＋]?\d+(?:\s*\[[+＋]?\d+\])?$/;

/** Preserve the distinction the official LingshiDescParser makes before removing color codes. */
function markJewelryAddedAttributes(value: string) {
  if (!value.includes("#r") || !/精炼等级/.test(value)) return value;
  const lines = value
    .split("#r")
    .map((line) => line.trim())
    .filter(Boolean);
  const indexes = lines.flatMap((line, index) =>
    index > 1 && line.startsWith("#G") ? [index] : [],
  );
  if (
    ![2, 3].includes(indexes.length) ||
    indexes.some((index) => !jewelryAttributePattern.test(cleanDescription(lines[index])))
  )
    return value;
  lines.splice(indexes[0], 0, "附加属性：");
  return lines.join("#r");
}

/** Missing color/section evidence is not enough to distinguish a repeated primary stat. */
export function jewelryDescriptionSections(value: string) {
  const lines = cleanDescription(markJewelryAddedAttributes(value))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const marker = lines.findIndex((line) => /^附加属性[：:]?$/.test(line));
  if (marker < 0 || lines.filter((line) => /^附加属性[：:]?$/.test(line)).length !== 1) return null;
  const added: string[] = [];
  for (const line of lines.slice(marker + 1)) {
    if (jewelryAttributePattern.test(line)) added.push(line);
    else {
      if (
        /^[^：:]*[+＋]?\d/.test(line) &&
        !/^(?:等级|耐久|精炼|修理失败|锻炼|开运|特效|套装|点化|装备)/.test(line)
      )
        return null;
      break;
    }
  }
  if (![2, 3].includes(added.length)) return null;
  return { main: lines.slice(0, marker).join("\n"), added };
}
// 只保留可用于比较价格的数值、名称及装备限制，不保存故事和通用功效。
export function coreEquipmentDescription(value: string) {
  return cleanDescription(markJewelryAddedAttributes(value))
    .split(/\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        (jewelryAttributePattern.test(line) ||
          /^(?:等级|五行|命中|伤害|防御|气血|魔法|魔力|灵力|速度|敏捷|力量|体质|耐力|法术|物理|封印|抗封|治疗|格挡|抵抗|耐久|修理失败|锻炼|镶嵌|宝石|特技|特效|套装|附加|熔炼|开运|符石|星位|星相|精炼|灵性|成长|修炼|境界|灵气|经验|携带|装备条件|使用条件|门派条件|部位条件|专用|玩家\s*\d+\s*专用|不可交易|不能交易|绑定|[+−-]\d)/.test(
            line,
          )) &&
        !/^(?:物理攻击时|物理攻击有|法术攻击时|使用后|效果|功效|功能|简介)/.test(line),
    )
    .join("\n");
}
export function itemFromAttributes(attrs: Record<string, string>, index: number): DetailItem {
  const skillType = attrs.data_skill_type || attrs["data-skill-type"] || "";
  const skill = !!skillType;
  const name =
    attrs.data_equip_name || attrs["data-equip-name"] || attrs.alt || `图标 ${index + 1}`;
  const level = attrs.data_equip_level || attrs.data_visible_level;
  if (skill)
    return {
      index,
      name,
      kind: skillType === "neidan" ? "innerSkill" : "skill",
      category:
        (
          {
            riderSkill: "坐骑技能",
            school_skill: "师门技能",
            cifu: "召唤兽技能",
            neidan: "内丹",
          } as Record<string, string>
        )[skillType] || "技能",
      ...(level ? { level } : {}),
    };
  const attributes: Record<string, string> = {};
  const labels: Record<string, string> = {
    data_equip_level: "等级",
    data_damage: "伤害",
    data_defense: "防御",
    data_speed: "速度",
    data_hp: "气血",
    data_gem_level: "宝石等级",
  };
  for (const [key, label] of Object.entries(labels)) if (attrs[key]) attributes[label] = attrs[key];
  const restrictions = cleanDescription(attrs.data_equip_type_desc || "");
  for (const match of restrictions.matchAll(/【(装备角色|装备对象|装备条件)】([^\n]+)/g))
    attributes[match[1]] = match[2].trim();
  const description = coreEquipmentDescription(
    attrs.data_equip_desc || attrs["data-equip-desc"] || attrs.title || "",
  );
  const location =
    attrs.data_equip_location || attrs.data_equip_position || attrs.data_item_position;
  const declaredCategory = [
    attrs.data_equip_category,
    attrs.data_equip_type_name,
    attrs.data_item_type_name,
    attrs.data_equip_type,
  ].find((value) => value?.trim() && !/^\d+$/.test(value.trim()));
  // model/type 的数字编号不是装备分类；以官网容器和法宝属性等明确证据识别。
  const storage = [attrs.data_storage_type, location].filter(Boolean).join(" ");
  const category = /lingbao|灵宝/i.test(storage)
    ? "灵宝"
    : /shenqi|神器/i.test(storage)
      ? "神器"
      : /(?:^|\n)\s*(?:灵气|修炼境界)[：:\s]/.test(description) || /fabao|法宝/i.test(storage)
        ? "法宝"
        : observedEquipmentCategory(declaredCategory, location);
  // 官方图标明确给出的分类 ID；不从名字、data_type 或 data_equip_type 推算。
  const kindId = attrs.data_kindid || attrs["data-kindid"];
  return {
    index,
    name,
    kind: "equipment",
    ...(category ? { category } : {}),
    ...(kindId ? { kindId } : {}),
    ...(location ? { location } : {}),
    ...(description ? { description } : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
  };
}
export function compactListing(listing: Listing): Listing {
  let highlights = listing.highlights || [];
  if (!highlights.length && listing.attrs.data_highlights) {
    try {
      const values: unknown = JSON.parse(listing.attrs.data_highlights);
      if (Array.isArray(values))
        highlights = values.flatMap((value) =>
          Array.isArray(value) && typeof value[0] === "string" ? [value[0]] : [],
        );
    } catch {
      /* 缺少亮点时仍保留原有核心摘要。 */
    }
  }
  const attrs = Object.fromEntries(
    Object.entries(listing.attrs).filter(
      ([key, value]) =>
        value &&
        !/(?:reco|recommd|mouse_over|highlights|dynamic_tags|equip_img)/.test(key) &&
        ![
          "data_serverid",
          "data_ordersn",
          "data_game_ordersn",
          "data_equipid",
          "data_equip_name",
          "data_price",
          "data_selling_time",
          "data_create_time",
        ].includes(key),
    ),
  );
  return { ...listing, attrs, highlights };
}
export function compactDetail(detail: RoleDetail): RoleDetail {
  if (detail.formatVersion === 3) return detail;
  return {
    ...detail,
    formatVersion: 3,
    raw: {},
    tabs: detail.tabs.map((tab) => {
      const header = tab.text.lastIndexOf("玩家之家\n");
      const items =
        tab.items ||
        tab.elements
          .filter((el) => el.tag !== "TEXTAREA")
          .map(itemFromAttributes)
          .filter((item) => item.description || item.attributes || !item.name.startsWith("图标 "));
      return {
        ...tab,
        text: (header >= 0 ? tab.text.slice(header + "玩家之家\n".length) : tab.text)
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
        elements: [],
        items,
        tooltips: [...new Set(tab.tooltips)],
      };
    }),
  };
}
