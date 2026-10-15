import { createHash } from "node:crypto";
import type { Page } from "playwright-core";
import { createHiddenPage, getBrowser } from "../session";
import { assertAvailable, pace } from "../crawler/page";
import { hoverForInspection } from "../viewport";
import { buildPageState } from "../page-state";
import { readStableSnapshot } from "../workflow";
import {
  cleanDescription,
  jewelryDescriptionSections,
  observedEquipmentCategory,
} from "../crawler/compact";
import { equipmentInitialAttribute, parseEquipmentAttributes } from "./equip-attributes";
import {
  equipmentAttributeLowerBound,
  equipmentEnhancementMismatch,
  matchComparableEquipmentAttributes,
} from "./equipment-match";
import { buildEquipmentEstimate } from "./pricing-estimate";
import {
  resetPricingCursor,
  rememberPricingPage,
  validPricingPageHistory,
} from "./pricing-progress";
import {
  EQUIPMENT_QUOTE_LIMIT,
  EQUIPMENT_QUOTE_POLICY,
  PRICING_RESUME_POLICY,
} from "./pricing-integrity";
import { createMarketScopeAudit, type GlobalMarketRequest } from "./market-scope";
import { jadeQuery, JADE_SEARCH_URL, type JadeSearchConfig } from "./jade-query";
import {
  equipmentIdentity,
  equipmentLevelUnsupportedReason,
  isJewelryEquipment,
  safeEquipmentUrl,
  verifyEquipmentCandidate,
  type EquipmentCandidate,
  type EquipmentPricingItem,
  type EquipmentSearchCursor,
  type EquipmentSource,
  type PricingSearchProgress,
} from "./equipment-pricing";

export const EQUIPMENT_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_equip";
export const JEWELRY_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=show_overall_search_lingshi";
export const YUANSHEN_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=show_overall_search_yuanshen";
const MAX_PAGES = 10,
  MAX_ROWS = 150,
  MAX_DETAILS = 100;
type Choices = Array<[string | number, string]>;
type SuitType = "added_status" | "append_skill" | "transform_skill" | "transform_charm";
export type EquipmentSearchConfig = {
  kinds: Choices;
  effects: Choices;
  skills: Choices;
  gems: Choices;
  namedKinds?: Choices;
  addedAttrs?: Choices;
  suits?: Choices;
  jewelrySuitEffects?: string[];
  jewelrySuitChoices?: Choices;
  suitTypes?: Partial<Record<SuitType, Choices>>;
};
type Query = Record<string, string | number>;

/** Verify every submitted public filter, including filters restored by the website. */
export function assertEquipmentUIArguments(expected: Query, actual: Query) {
  const normalized = (value: string | number | undefined) => {
    if (typeof value === "string" && value.startsWith("{")) {
      try {
        return JSON.stringify(
          Object.entries(JSON.parse(value) as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, val]) => [key, String(val)]),
        );
      } catch {
        return value;
      }
    }
    return value === undefined
      ? ""
      : String(value)
          .split(",")
          .map((part) => part.trim())
          .sort()
          .join(",");
  };
  const different = Object.keys(expected).filter(
    (key) => actual[key] === undefined || normalized(actual[key]) !== normalized(expected[key]),
  );
  if (different.length) throw new Error("官网 UI 查询字段未生效：" + different.join(","));
  const extra = Object.keys(actual).filter(
    (key) =>
      expected[key] === undefined &&
      !(key === "sum_attr_without_melt" && String(actual[key]) === "1") &&
      key !== "cross_buy_serverid" &&
      String(actual[key]) !== "",
  );
  if (extra.length) throw new Error("官网 UI 保留了未计划的筛选条件：" + extra.join(","));
}

const isJewelry = isJewelryEquipment;
const isYuanshen = (item: EquipmentPricingItem) =>
  /(?:^|[·/\s])元身(?:$|[·/\s])/.test(observedEquipmentCategory(item.category, "", item.modelId));
/** Values come from the live public menus/select, never guessed query parameter codes. */
export function yuanshenQuery(
  item: EquipmentPricingItem,
  config: EquipmentSearchConfig,
  similar = false,
) {
  const kind = [...config.kinds]
    .sort((a, b) => b[1].length - a[1].length)
    .find(([, name]) => item.name.includes(name));
  if (!kind) throw new Error("元身名称不能对应官网类型控件");
  const fields = parseEquipmentAttributes(item.description).fields;
  const attr = Object.keys(fields).flatMap((name) =>
    (config.namedKinds || []).filter(
      ([, label]) =>
        label === name && fields[name]?.length === 1 && /^\+?\d+$/.test(fields[name][0]),
    ),
  )[0];
  if (!attr) throw new Error("元身基础属性尚不能对应官网属性控件");
  const args: Query = {
    server_type: "3",
    type_choice: String(kind[0]),
    attr_type: String(attr[0]),
    txt_attr_value: similar
      ? Math.ceil(
          equipmentAttributeLowerBound(attr[1], Number(fields[attr[1]][0])) ??
            Number(fields[attr[1]][0]),
        )
      : Number(fields[attr[1]][0]),
  };
  const added = config.addedAttrs?.filter(([, name]) =>
    new RegExp("附加属性[^\\n]*" + name).test(item.description),
  );
  if (added?.length) args.addon_choices = added.map(([value]) => value).join(",");
  for (const [label, control] of [
    ["特技", "txt_addon_skill_chance"],
    ["特效", "txt_addon_effect_chance"],
  ] as const) {
    const match = item.description.match(
      new RegExp("附加" + label + "(?:概率)?[：:\\s]*(\\d+(?:\\.\\d+)?)%"),
    );
    if (match) args[control] = match[1];
  }
  return args;
}

function suitFilter(values: string[], config: EquipmentSearchConfig) {
  const normalize = (value: string) => value.replace(/\s|[：:]/g, "");
  const descriptions = [...new Set(values.map(normalize))];
  if (descriptions.length !== 1) return undefined;
  const value = descriptions[0];
  const prefixes: Array<[string, SuitType]> = [
    ["附加状态", "added_status"],
    ["追加法术", "append_skill"],
    ["追加技能", "append_skill"],
    ["变身术之", "transform_skill"],
    ["变化咒之", "transform_charm"],
  ];
  const explicit = prefixes.find(([prefix]) => value.startsWith(prefix));
  const choices = explicit ? config.suitTypes?.[explicit[1]] || [] : config.suits || [];
  const name = explicit ? value.slice(explicit[0].length) : value;
  const matching = choices.filter(([, label]) => normalize(label) === name);
  // The official chooser supports typed maps; an unqualified duplicate name is ambiguous.
  if (
    !explicit &&
    Object.values(config.suitTypes || {})
      .flat()
      .some(
        ([id, label]) =>
          normalize(label) === name &&
          !matching.some(([matchId]) => String(matchId) === String(id)),
      )
  )
    return undefined;
  const ids = [
    ...new Set(
      matching.map(([id]) => String(id)).filter((id) => /^\d+$/.test(id) && Number(id) > 0),
    ),
  ];
  return ids.length === 1 ? ids[0] : undefined;
}

/** Official page fields are coarse filters; only detail verification establishes a match. */
export function equipmentQuery(
  item: EquipmentPricingItem,
  config: EquipmentSearchConfig,
  mode: "exact" | "similar" = "exact",
) {
  if (item.level === null) throw new Error("装备等级缺失，不能查询");
  const unsupported = equipmentLevelUnsupportedReason(item);
  if (unsupported) throw new Error(unsupported);
  const jewelry = isJewelry(item);
  const fields = parseEquipmentAttributes(item.description).fields;
  const args: Query = jewelry
    ? {
        equip_level_min: item.level,
        equip_level_max: item.level,
        pass_fair_show: "1",
        server_type: "3",
      }
    : {
        level_min: item.level,
        level_max: item.level,
        front_status: "pass_fair_show",
        server_type: "3",
      };
  let category = item.category.replace("配饰", "佩饰");
  const wearers = fields.装备角色?.join("、").trim();
  if (wearers === "男" || wearers === "女") {
    if (/头盔|头饰/.test(category)) category = wearers + "头";
    else if (/衣服/.test(category)) category = wearers + "衣";
  }
  let kind =
    config.kinds.find(([id]) => item.kindId !== undefined && Number(id) === Number(item.kindId)) ||
    [...config.kinds]
      .sort((a, b) => b[1].length - a[1].length)
      .find(([, label]) => category.includes(label)) ||
    (config.namedKinds?.length === 1 ? config.namedKinds[0] : undefined);
  if (kind) args.kindid = String(kind[0]);
  const integer = (field: string, parameter: string) => {
    const values = fields[field];
    const match =
      values?.length === 1
        ? values[0].match(field === "修理失败" ? /^\+?(\d+)\s*次?$/ : /^\+?(\d+)$/)
        : null;
    if (match) args[parameter] = Number(match[1]);
  };
  integer("修理失败", "repair_fail");
  if (jewelry) {
    const effects = fields.特效 || [];
    if (effects.includes("简易")) args.special_effect = 1;
    const coreEffects = effects.filter((value) => value !== "简易");
    const effect =
      coreEffects.length === 1 ? coreEffects[0].match(/^(.+?)[（(](\d+)级[）)]$/) : null;
    if (effect) {
      const choices =
        config.jewelrySuitChoices ||
        (config.jewelrySuitEffects || []).map((name, index): [number, string] => [index + 1, name]);
      const matching = choices.filter(([, name]) => name === effect[1]);
      if (matching.length === 1) {
        args.suit_effect = String(matching[0][0]);
        args.suit_effect_level = Number(effect[2]);
      }
    }
    integer("精炼等级", "jinglian_level");
    if (Number(args.jinglian_level) > 16) delete args.jinglian_level;
    const sections = jewelryDescriptionSections(item.description);
    if (sections) {
      const primary = parseEquipmentAttributes(sections.main).fields;
      const primaryParameters: Record<string, Array<[string, string]>> = {
        戒指: [
          ["伤害", "damage"],
          ["防御", "defense"],
        ],
        耳饰: [
          ["法术伤害", "magic_damage"],
          ["法术防御", "magic_defense"],
        ],
        手镯: [
          ["封印命中等级", "fengyin"],
          ["抵抗封印等级", "anti_fengyin"],
          ["抗封印等级", "anti_fengyin"],
        ],
        佩饰: [["速度", "speed"]],
      };
      if (!kind) {
        for (const [kLabel, params] of Object.entries(primaryParameters)) {
          if (
            params.some(([field]) => {
              const v = primary[field];
              return v?.length === 1 && /^\+?\d+$/.test(v[0]);
            })
          ) {
            kind = config.kinds.find(([, label]) => label === kLabel);
            if (kind) {
              args.kindid = String(kind[0]);
              break;
            }
          }
        }
      }
      for (const [field, parameter] of primaryParameters[kind?.[1] || ""] || []) {
        const values = primary[field];
        if (values?.length === 1 && /^\+?\d+$/.test(values[0])) {
          const value = Number(values[0]);
          if (value > 0 && value <= 10000) args[parameter] = value;
        }
      }
      const aliases: Record<string, string> = {
        固定伤害: "固伤",
        法术伤害: "法伤",
        法术伤害结果: "法伤结果",
        法术防御: "法防",
        封印命中: "封印",
        抵抗封印: "抗封",
        抗封印: "抗封",
        治疗能力: "治疗",
        格挡值: "格挡",
        气血回复效果: "回复",
      };
      const added = sections.added.map((line) => {
        const name = line.match(/^(.+?)[：:\s]*[+＋]?\d/)?.[1]?.replace(/等级$/, "");
        return config.addedAttrs?.find(([, label]) => label === (aliases[name || ""] || name));
      });
      if (added.every((choice) => choice !== undefined)) {
        args.added_attr_logic = "detail";
        args.added_attr_num = String(added.length);
        for (const choice of added) {
          const key = "added_attr." + choice![0];
          args[key] = Number(args[key] || 0) + 1;
        }
      }
    }
  } else {
    const suit = suitFilter(fields.套装 || [], config);
    if (suit) args.suit_effect = suit;

    integer("锻炼等级", "gem_level");
    const holes =
      fields.开运孔数?.length === 1
        ? fields.开运孔数[0]
            .replace(/\s/g, "")
            .match(/^(\d+)(?:孔)?(?:\/(\d+)(?:孔)?)?(?:[（(]双\d+孔[）)])?$/)
        : null;
    if (
      holes &&
      Number(holes[1]) <= 5 &&
      (holes[2] === undefined || (Number(holes[2]) <= 5 && Number(holes[1]) <= Number(holes[2])))
    )
      args.hole_num = Number(holes[1]);
    const attributes = parseEquipmentAttributes(item.description);
    for (const [field, parameter] of [
      ["伤害", "init_damage_raw"],
      ["灵力", "init_wakan"],
      ["气血", "init_hp"],
      ["敏捷", "init_dex"],
      ["防御", "init_defense"],
    ] as const) {
      if (field === "敏捷" && kind?.[1] !== "鞋子") continue;
      const value = equipmentInitialAttribute(attributes, field);
      if (value !== null) {
        args[parameter] = value;
        args.attr_without_melt = 1;
      }
    }
    for (const [field, key, choices] of [
      ["特效", "special_effect", config.effects],
      ["特技", "special_skill", config.skills],
      ["宝石", "gem_value", config.gems],
    ] as const) {
      const values = (fields[field] || []).flatMap((value) =>
        value.split(/[、，,；;\s]+/).map((part) => part.trim()),
      );
      const matched = values.flatMap((value) => choices.filter(([, label]) => value === label));
      if (matched.length) args[key] = matched.map(([id]) => String(id)).join(",");
    }
    if (args.special_effect) args.special_mode = "and";
  }
  if (mode === "similar") {
    // Keep level, type and core skills/effects; rank optional configuration differences in details.
    for (const key of ["gem_level", "gem_value", "jinglian_level", "repair_fail", "hole_num"])
      delete args[key];
    // Jewelry suit_effect describes the core single-item effect; ordinary gear suits are optional.
    if (!jewelry) delete args.suit_effect;
    for (const [key, field] of [
      ["init_defense", "防御"],
      ["init_damage_raw", "伤害"],
      ["init_wakan", "灵力"],
      ["init_hp", "气血"],
      ["init_dex", "敏捷"],
      ["all_wakan", "灵力"],
      ["damage", "伤害"],
      ["defense", "防御"],
      ["magic_damage", "法术伤害"],
      ["magic_defense", "法术防御"],
      ["fengyin", "封印命中等级"],
      ["anti_fengyin", "抵抗封印等级"],
      ["speed", "速度"],
    ]) {
      const value = args[key];
      if (typeof value === "number" && value > 0) {
        const lower = equipmentAttributeLowerBound(field, value);
        if (lower !== null) args[key] = Math.ceil(lower);
      }
    }
  }
  return { jewelry, args };
}

export type EquipmentQueryMode = "exact" | "same-gems" | "near-gems" | "similar";
type EquipmentQueryStep = { mode: EquipmentQueryMode; args: Query };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Progressively widen optional configuration; each detail must still pass core matching. */
export function equipmentQueryPlan(
  item: EquipmentPricingItem,
  config: EquipmentSearchConfig,
): EquipmentQueryStep[] {
  const exact = equipmentQuery(item, config).args;
  const similar = equipmentQuery(item, config, "similar").args;
  const sameGems = { ...similar };
  for (const key of ["gem_level", "gem_value", "jinglian_level"])
    if (exact[key] !== undefined) sameGems[key] = exact[key];
  const nearGems = { ...sameGems };
  for (const key of ["gem_level", "jinglian_level"])
    if (typeof nearGems[key] === "number") nearGems[key] = Math.max(0, Number(nearGems[key]) - 1);
  const hasEnhancement = ["gem_level", "gem_value", "jinglian_level"].some(
    (key) => exact[key] !== undefined,
  );
  const steps: EquipmentQueryStep[] = [
    { mode: "exact", args: exact },
    ...(hasEnhancement
      ? [
          { mode: "same-gems" as const, args: sameGems },
          { mode: "near-gems" as const, args: nearGems },
        ]
      : []),
    { mode: "similar", args: similar },
  ];
  const seen = new Set<string>();
  return steps.filter(({ args }) => {
    const hash = digest(args);
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });
}

export function equipmentCursorMatches(
  cursor: EquipmentSearchCursor | undefined,
  planHash: string,
  modes: number,
) {
  return (
    !!cursor &&
    cursor.version === 1 &&
    cursor.planHash === planHash &&
    Number.isInteger(cursor.modeIndex) &&
    cursor.modeIndex >= 0 &&
    cursor.modeIndex < modes &&
    Number.isInteger(cursor.pageNumber) &&
    cursor.pageNumber > 0 &&
    Number.isInteger(cursor.rowIndex) &&
    cursor.rowIndex >= 0 &&
    typeof cursor.pageRowsHash === "string" &&
    validPricingPageHistory(cursor) &&
    (cursor.restartCount === undefined ||
      (Number.isInteger(cursor.restartCount) && cursor.restartCount >= 0)) &&
    Array.isArray(cursor.seen) &&
    cursor.seen.every((value) => typeof value === "string") &&
    Array.isArray(cursor.failed) &&
    cursor.failed.every(
      (value) =>
        typeof value.url === "string" &&
        Number.isInteger(value.modeIndex) &&
        value.modeIndex >= 0 &&
        value.modeIndex < modes,
    )
  );
}

/** A partial list description may rule an item out, but never establishes a valid quotation. */
export function equipmentListingMismatch(
  item: EquipmentPricingItem,
  row: { kindId?: string; level?: string; description?: string },
  args: Query,
) {
  if (args.kindid && /^\d+$/.test(row.kindId || "") && Number(row.kindId) !== Number(args.kindid))
    return "装备分类不匹配";
  if (
    item.category !== "上古玉魄" &&
    !isYuanshen(item) &&
    /^\d+$/.test(row.level || "") &&
    Number(row.level) !== item.level
  )
    return "装备等级不匹配";
  if (!row.description?.trim()) return null;
  if (isYuanshen(item) || item.category === "上古玉魄") return null; // Dedicated full-description verification preserves special slots and restrictions.
  const target = parseEquipmentAttributes(item.description);
  const source = parseEquipmentAttributes(
    row.description.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, ""),
  );
  return matchComparableEquipmentAttributes(target, source, true).reason;
}

/** Read only the principal equipment description and price, never recommendations. */
export async function equipmentPageSource(
  page: Page,
  signal: AbortSignal,
  expectedKind: "equipment" | "pet-gear" = "equipment",
) {
  try {
    return await readMainEquipment(page, signal, expectedKind);
  } catch (error) {
    signal.throwIfAborted();
    await assertAvailable(page);
    const diagnostics = await page
      .evaluate(() => {
        const globals = window as unknown as {
          equip?: Record<string, unknown>;
          EquipInfo?: Record<string, unknown>;
        };
        const raw = globals.equip || globals.EquipInfo;
        const describe = (selector: string) =>
          Array.from(document.querySelectorAll<HTMLElement>(selector))
            .slice(0, 4)
            .map((node) => {
              const ancestors = [];
              for (
                let parent = node.parentElement, count = 0;
                parent && count < 4;
                parent = parent.parentElement, count++
              )
                ancestors.push({ tag: parent.tagName, id: parent.id, className: parent.className });
              return { id: node.id, visible: node.checkVisibility(), ancestors };
            });
        return {
          panels: describe("#equip_desc_panel"),
          info: describe("#info_panel"),
          product: raw
            ? {
                id: raw.eid,
                server: raw.serverid ?? raw.server_id,
                name: raw.equip_name,
                price: raw.price,
                selling: raw.is_selling,
              }
            : null,
          mainPrices: Array.from(
            document.querySelectorAll<HTMLElement>(
              "#info_panel .price, #info_panel [data_price], #info_panel [data-price]",
            ),
          )
            .filter((node) => node.checkVisibility() && !node.closest("#equip_price_addon_info"))
            .slice(0, 4)
            .map((node) => node.innerText.slice(0, 80)),
        };
      })
      .catch(() => null);
    const failure =
      error instanceof Error && error.name !== "TimeoutError"
        ? error
        : new Error("主商品属性或价格区域未加载完成");
    throw Object.assign(failure, { equipmentDiagnostics: diagnostics });
  }
}

async function readMainEquipment(
  page: Page,
  signal: AbortSignal,
  expectedKind: "equipment" | "pet-gear",
) {
  signal.throwIfAborted();
  await assertAvailable(page);
  const excluded =
    '#search_result, #recommd_list, #recommend, .recommend, .recommd, #bottomRecommands, .recommandWrp, .goodsRemmds, [id$="TipsBox"]';
  await page.waitForFunction(
    (excluded) =>
      Array.from(
        document.querySelectorAll("#equip_desc_panel, img[data_equip_name], img[data-equip-name]"),
      ).some((node) => node.checkVisibility() && !node.closest(excluded)),
    excluded,
    { timeout: 5000 },
  );
  signal.throwIfAborted();
  await assertAvailable(page);
  const directPanel = await page
    .locator("#equip_desc_panel")
    .evaluateAll(
      (nodes, excluded) => nodes.some((node) => node.checkVisibility() && !node.closest(excluded)),
      excluded,
    );
  if (directPanel) {
    const supported = await page.evaluate((excluded) => {
      const panels = Array.from(document.querySelectorAll<HTMLElement>("#equip_desc_panel")).filter(
        (node) => node.checkVisibility() && !node.closest(excluded),
      );
      return (
        panels.length === 1 &&
        !!(
          panels[0].closest(".goodsInfo, .independent-product, #equip_detail") ||
          Array.from(document.querySelectorAll("#info_panel")).find(
            (node) => node.checkVisibility() && !node.closest(excluded),
          )
        )
      );
    }, excluded);
    if (!supported) throw new Error("商品页结构不支持：无法定位主商品容器，已保留待补齐项");
    await page.waitForFunction(
      (excluded) => {
        const panels = Array.from(
          document.querySelectorAll<HTMLElement>("#equip_desc_panel"),
        ).filter((node) => node.checkVisibility() && !node.closest(excluded));
        const info = Array.from(document.querySelectorAll<HTMLElement>("#info_panel")).filter(
          (node) => node.checkVisibility() && !node.closest(excluded),
        );
        const region =
          info.length === 1
            ? info[0]
            : info.length === 0 && panels.length === 1
              ? panels[0].closest<HTMLElement>(".goodsInfo, .independent-product, #equip_detail")
              : null;
        return (
          panels.length === 1 &&
          region?.checkVisibility() &&
          !region.closest(excluded) &&
          panels[0].innerText.trim() &&
          region.innerText.trim() &&
          Array.from(
            region.querySelectorAll<HTMLElement>(".price, [data_price], [data-price]"),
          ).some(
            (node) =>
              node.checkVisibility() &&
              !node.closest("#equip_price_addon_info") &&
              (node.innerText.trim() ||
                node.getAttribute("data_price") ||
                node.getAttribute("data-price")),
          )
        );
      },
      excluded,
      { timeout: 10000 },
    );
    signal.throwIfAborted();
  }
  if (!directPanel) {
    const icons = page.locator("img[data_equip_name], img[data-equip-name]");
    const index = await icons.evaluateAll((nodes, excluded) => {
      const candidates = nodes.filter((node) => node.checkVisibility() && !node.closest(excluded));
      return candidates.length === 1 ? nodes.indexOf(candidates[0]) : -1;
    }, excluded);
    if (index < 0) throw new Error("未能确认独立装备的主商品图标，不能采用推荐商品价格");
    const principal = icons.nth(index);
    await principal.evaluate((el) => el.setAttribute("data-cbg-main-equipment", "true"));
    await hoverForInspection(page, principal);
    await page.waitForFunction(
      () => {
        const main = document.querySelector('[data-cbg-main-equipment="true"]');
        if (!main) return false;
        const description =
          main.getAttribute("data_equip_desc") || main.getAttribute("data-equip-desc") || "";
        const name =
          main.getAttribute("data_equip_name") || main.getAttribute("data-equip-name") || "";
        const id = main.getAttribute("data_tip_box") || main.getAttribute("data-tip-box");
        const raw = window as unknown as {
          equip?: Record<string, unknown>;
          EquipInfo?: Record<string, unknown>;
        };
        const type = (raw.equip || raw.EquipInfo)?.equip_type;
        const model = typeof type === "string" || typeof type === "number" ? String(type) : "";
        const complete = (value: string) =>
          /等级\s*[：:]?\s*\d/.test(value) ||
          (name.endsWith("元身") && /伤害|防御|气血|魔法|灵力|敏捷|命中/.test(value)) ||
          (["61717", "61718"].includes(model) && /耐久(?:度)?\s*[：:]?\s*\d/.test(value));
        if (!id && complete(description)) return true;
        const tips = id
          ? [document.getElementById(id)]
          : Array.from(
              document.querySelectorAll<HTMLElement>(
                '[id$="TipsBox"], [role="tooltip"], .equip_tips',
              ),
            );
        return tips.some(
          (tip) =>
            tip?.checkVisibility() && tip.innerText.includes(name) && complete(tip.innerText),
        );
      },
      undefined,
      { timeout: 5000 },
    );
  }
  signal.throwIfAborted();
  const observed = await page.evaluate(
    ({ directPanel, excluded }) => {
      const globals = window as unknown as {
        equip?: Record<string, unknown>;
        EquipInfo?: Record<string, unknown>;
        CBG_GAME_CONFIG?: { equip_info?: Record<string, { name?: unknown; desc?: unknown }> };
      };
      const raw = globals.equip || globals.EquipInfo;
      const visible = (selector: string) =>
        Array.from(document.querySelectorAll<HTMLElement>(selector)).filter(
          (node) => node.checkVisibility() && !node.closest(excluded),
        );
      const panels = directPanel ? visible("#equip_desc_panel") : [];
      const infos = directPanel ? visible("#info_panel") : [];
      const panel = panels.length === 1 ? panels[0] : null;
      const info =
        infos.length === 1
          ? infos[0]
          : infos.length === 0
            ? panel?.closest<HTMLElement>(".goodsInfo, .independent-product, #equip_detail")
            : null;
      let root = panel?.parentElement;
      while (root && root !== document.body && info && !root.contains(info))
        root = root.parentElement;
      if (
        directPanel &&
        (!panel?.checkVisibility() ||
          !info?.checkVisibility() ||
          !root ||
          root === document.body ||
          root === document.documentElement ||
          !root.contains(info) ||
          root.closest(excluded))
      )
        throw new Error("无法确认独立装备的主商品属性与价格区域");
      const main = document.querySelector<HTMLImageElement>('[data-cbg-main-equipment="true"]');
      if (!directPanel && !main) throw new Error("装备主商品图标已改变");
      const name = directPanel
        ? info!.innerText
            .match(/(?:^|\s)ID\s*[：:]\s*(.+?)(?=\s+等级\s*[：:]|\r?\n|$)/i)?.[1]
            ?.trim() ||
          (typeof raw?.equip_name === "string" && info!.innerText.includes(raw.equip_name)
            ? raw.equip_name
            : "")
        : main!.getAttribute("data_equip_name") || main!.getAttribute("data-equip-name") || "";
      const tipId = main?.getAttribute("data_tip_box") || main?.getAttribute("data-tip-box");
      const tips = tipId
        ? [document.getElementById(tipId)]
        : Array.from(
            document.querySelectorAll<HTMLElement>(
              '[id$="TipsBox"], [role="tooltip"], .equip_tips',
            ),
          );
      const tooltip = tips.find(
        (node) => !directPanel && node?.checkVisibility() && node.textContent?.includes(name),
      );
      const prices = Array.from(
        (info || document).querySelectorAll<HTMLElement>("[data_price], [data-price], .price"),
      )
        .filter(
          (node) =>
            node.checkVisibility() &&
            !node.closest(excluded) &&
            !node.closest("#equip_price_addon_info"),
        )
        .map(
          (node) =>
            node.getAttribute("data_price") || node.getAttribute("data-price") || node.innerText,
        );
      const rawPrice =
        raw &&
        (typeof raw.price === "number" ||
          (typeof raw.price === "string" && /^\d+(?:\.\d+)?$/.test(raw.price.trim())))
          ? Number(raw.price)
          : null;
      const model =
        directPanel && (typeof raw?.equip_type === "string" || typeof raw?.equip_type === "number")
          ? globals.CBG_GAME_CONFIG?.equip_info?.[String(raw.equip_type)]
          : undefined;
      if (model && model.name !== raw?.equip_name)
        throw new Error("主商品模型目录名称与当前商品不一致");
      const body = (root || document.body).cloneNode(true) as HTMLElement;
      body
        .querySelectorAll(
          excluded + ", #equip_price_addon_info, script, style, nav, header, footer",
        )
        .forEach((el) => el.remove());
      return {
        name,
        tooltip: tooltip?.innerText?.trim() || "",
        description: directPanel
          ? panel!.innerText.trim()
          : main!.getAttribute("data_equip_desc") || main!.getAttribute("data-equip-desc") || "",
        typeDescription: directPanel
          ? typeof model?.desc === "string"
            ? model.desc
            : ""
          : main?.getAttribute("data_equip_type_desc") ||
            main?.getAttribute("data-equip-type-desc") ||
            "",
        prices,
        rawPrice,
        body: body.textContent || "",
        selling: raw?.is_selling,
        productName: raw?.equip_name,
        productId: raw?.eid,
        serverId: raw?.serverid ?? raw?.server_id,
        modelId: raw?.equip_type,
        kindId: raw?.kindid,
      };
    },
    { directPanel, excluded },
  );
  const productId =
    typeof observed.productId === "string" || typeof observed.productId === "number"
      ? String(observed.productId)
      : "";
  const serverId =
    typeof observed.serverId === "string" || typeof observed.serverId === "number"
      ? String(observed.serverId)
      : "";
  if (
    !observed.name ||
    !productId ||
    !serverId ||
    observed.productName !== observed.name ||
    equipmentIdentity(page.url()) !== serverId + ":" + productId
  )
    throw new Error("无法把主商品属性绑定到当前商品ID，报价未采用");
  const rawAttributes = parseEquipmentAttributes(observed.description);
  const tipAttributes = parseEquipmentAttributes(observed.tooltip);
  const size = (attributes: typeof rawAttributes) =>
    Object.values(attributes.fields).reduce((total, values) => total + values.length, 0);
  if (rawAttributes.level && tipAttributes.level && rawAttributes.level !== tipAttributes.level)
    throw new Error("主商品数据与提示框等级不一致");
  const jade = ["61717", "61718"].includes(String(observed.modelId));
  const yuanshen = observed.name.endsWith("元身");
  const description = cleanDescription(
    (tipAttributes.level !== null || jade || yuanshen) &&
      size(tipAttributes) >= size(rawAttributes) &&
      observed.tooltip
      ? observed.tooltip
      : observed.description,
  );
  if (
    expectedKind === "pet-gear" &&
    (Number(observed.kindId) !== 29 ||
      !/装备对象[：:】\s]*召唤兽/.test(
        cleanDescription(observed.typeDescription + "\n" + description),
      ))
  )
    throw new Error("主商品目录与类型未确认是召唤兽装备，报价未采用");
  if (!jade && !yuanshen && parseEquipmentAttributes(description).level === null)
    throw new Error("主商品装备属性尚未读取完整");
  if (yuanshen && !/伤害|防御|气血|魔法|灵力|敏捷|命中/.test(description))
    throw new Error("主商品元身属性尚未读取完整");
  if (jade && (!description.trim() || !/耐久(?:度)?\s*[：:]?\s*\d/.test(description)))
    throw new Error("主商品玉魄属性尚未读取完整");
  const visiblePrices = [
    ...new Set(
      observed.prices.flatMap((value) => {
        const match = value.replace(/,/g, "").match(/(?:[¥￥]\s*)?(\d+(?:\.\d{1,2})?)/);
        return match ? [Number(match[1])] : [];
      }),
    ),
  ];
  const price = visiblePrices.length === 1 ? visiblePrices[0] : null;
  if (price === null || !Number.isFinite(price) || price <= 0)
    throw new Error("无法确认主商品人民币挂牌价");
  if (
    (directPanel && observed.rawPrice === null) ||
    (observed.rawPrice !== null && observed.rawPrice !== price)
  )
    throw new Error("主商品数据价格与可见价格不一致");
  const status = observed.body.match(
    /(?:是否上架|状态)\s*[：:]?\s*(已上架|上架中|未上架|已下架|已售出)/,
  )?.[1];
  const offShelf =
    status === "未上架" ||
    status === "已下架" ||
    status === "已售出" ||
    observed.selling === false ||
    observed.selling === 0 ||
    /商品已下架|商品已售出|商品不存在/.test(observed.body);
  const selling =
    !offShelf &&
    (status === "已上架" ||
      status === "上架中" ||
      observed.selling === true ||
      observed.selling === 1);
  if (
    !selling &&
    observed.selling !== false &&
    observed.selling !== 0 &&
    !/商品已下架|商品已售出|商品不存在/.test(observed.body)
  )
    throw new Error("无法确认独立装备当前在售状态");
  const restrictions = cleanDescription(observed.typeDescription)
    .split(/\n/)
    .filter((line) => /装备角色|装备对象|装备条件/.test(line) && !description.includes(line));
  const text = [
    observed.name,
    description,
    ...restrictions,
    selling ? "在售" : "商品已下架",
    "挂牌价：¥" + price,
  ].join("\n");
  const escape = (value: string) =>
    value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const metadata = [
    ["model-id", observed.modelId],
    ["kind-id", observed.kindId],
  ]
    .flatMap(([key, value]) => {
      const id = typeof value === "string" || typeof value === "number" ? String(value) : "";
      return /^\d+$/.test(id) ? [" data-cbg-" + String(key) + '="' + id + '"'] : [];
    })
    .join("");
  return {
    text,
    price,
    html: `<main${metadata}><p>${escape(observed.name)}</p><pre data-cbg-equipment-description>${escape([description, ...restrictions].join("\n"))}</pre><p>${selling ? "在售" : "商品已下架"}\n挂牌价：¥${price}</p></main>`,
  };
}

/** Public form discovery is never quotation evidence and does not expose account fields. */
export async function readEquipmentSearchForm(page: Page) {
  if (page.isClosed()) throw new Error("装备查询工作页已关闭");
  return page.evaluate(function readPublicEquipmentSearchForm() {
    const g = window as unknown as Record<string, any>;
    const visible = (el: Element) =>
      el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    const visibleAny = (selector: string) =>
      Array.from(document.querySelectorAll(selector)).some(visible);
    if (
      g.CaptchaCheck?.need_captcha ||
      visibleAny(".yidun_popup,.geetest_panel,#captcha_container")
    )
      throw new Error("网站要求安全验证，已暂停读取装备字段");
    if (/系统繁忙|访问过于频繁|请求过于频繁/.test(document.body.innerText))
      throw new Error("网站繁忙或要求降低频率，已暂停读取装备字段");
    if (
      /\/(?:show_login|login)\.py$/.test(location.pathname) ||
      visibleAny("#qrcode,#loginContainer,input[type=password]")
    )
      throw new Error("装备入口显示登录面板，尚未读取字段");
    if (location.origin !== "https://xyq.cbg.163.com") throw new Error("装备表单未停留在官方网站");
    const publicName = (value: string) =>
      !/token|cookie|auth|password|passwd|nickname|urs|account|username|fingerprint|safe_code|session/i.test(
        value,
      );
    const text = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const roots = Array.from(
      document.querySelectorAll(
        ".searchForm,.js_search_form,table.searcTb,.searchSbmt,.searchbtCon",
      ),
    );
    const all = <T extends Element>(selector: string): T[] => [
      ...new Set(roots.flatMap((root) => Array.from(root.querySelectorAll<T>(selector)))),
    ];
    const label = (el: Element) =>
      text(
        (el.id &&
          document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`)
            ?.innerText) ||
          el.closest("tr")?.querySelector("th")?.textContent ||
          Array.from(el.parentElement?.childNodes || [])
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent)
            .join(" "),
      ).slice(0, 160);
    const controls = all<HTMLInputElement | HTMLSelectElement>("input[id],select[id]")
      .filter(
        (el) =>
          publicName(el.id + " " + el.name) &&
          (el instanceof HTMLSelectElement ||
            ["text", "number", "checkbox", "radio"].includes(el.type)),
      )
      .map((el) => ({
        id: el.id,
        name: el.name,
        type: el instanceof HTMLSelectElement ? "select" : el.type,
        label: label(el),
        visible: visible(el),
        value: el.value,
        ...(el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type)
          ? { checked: el.checked }
          : {}),
        ...(el instanceof HTMLSelectElement
          ? {
              options: Array.from(el.options).map((option) => ({
                value: option.value,
                label: text(option.text),
                selected: option.selected,
              })),
            }
          : {}),
      }));
    const choiceValue = (choice: HTMLElement) => {
      const stored = (choice as HTMLElement & { retrieve?: (key: string) => unknown }).retrieve?.(
        "value",
      );
      const value =
        choice.getAttribute("data_value") ?? choice.getAttribute("data-value") ?? stored;
      return typeof value === "string" || typeof value === "number" ? String(value) : "";
    };
    const menus = all<HTMLElement>("ul[id],ol[id],div[id]")
      .filter((el) => publicName(el.id) && el.querySelector(":scope > li"))
      .map((el) => ({
        id: el.id,
        label: label(el),
        visible: visible(el),
        choices: Array.from(el.querySelectorAll<HTMLElement>(":scope > li"))
          .filter(
            (choice) => choiceValue(choice) !== "" || /不限|所有|全部/.test(choice.innerText || ""),
          )
          .map((choice) => ({
            value: choiceValue(choice),
            label: text(choice.innerText || choice.textContent),
            visible: visible(choice),
            selected: choice.classList.contains("on"),
          })),
      }))
      .filter((menu) => menu.choices.length);
    const buttons = all<HTMLElement>(
      "a[id],button[id],input[type=button][id],input[type=submit][id]",
    )
      .filter((el) => publicName(el.id) && /search|reset|query|submit|btn/i.test(el.id))
      .map((el) => ({
        id: el.id,
        tag: el.tagName,
        label: text(el.innerText || el.getAttribute("value")),
        visible: visible(el),
      }));
    const sliders = all<HTMLElement>(".levelSlider[id]").map((el) => ({
      id: el.id,
      label: label(el),
      visible: visible(el),
      start: text(el.querySelector(".startPoint .num")?.textContent),
      end: text(el.querySelector(".endPoint .num")?.textContent),
    }));
    const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>("script[src]")).flatMap(
      (el) => {
        try {
          const url = new URL(el.src, location.href);
          return ["https://xyq.cbg.163.com", "https://cbg-xyq.res.netease.com"].includes(
            url.origin,
          ) &&
            /equip|lingshi|yupo|minghun|search|config|slider|checker|common|server/i.test(
              url.pathname,
            )
            ? [url.origin + url.pathname]
            : [];
        } catch {
          return [];
        }
      },
    );
    if (!controls.length && !menus.length) throw new Error("官网装备查询公开控件尚未加载");
    const boolean = (value: unknown) =>
      value === 0 || value === false ? false : value === 1 || value === true ? true : null;
    return {
      publicPath: location.pathname,
      act: new URL(location.href).searchParams.get("act") || "",
      readyState: document.readyState,
      IsLogin: boolean(g.IsLogin),
      login: boolean(g.LoginInfo?.login),
      controls,
      menus,
      buttons,
      sliders,
      scripts: [...new Set(scripts)],
    };
  });
}

/** Only public component state is retained; authentication data and URL queries are excluded. */
async function equipmentSearchDiagnostics(page: Page) {
  try {
    return await page.evaluate(function readEquipmentSearchDiagnostics() {
      const g = window as unknown as Record<string, any>;
      const visible = (selector: string) =>
        Array.from(document.querySelectorAll(selector)).some((node) => node.checkVisibility());
      return {
        publicPath: location.pathname,
        readyState: document.readyState,
        overallSearch: typeof g.overall_search === "function",
        ajaxWithRecommend: typeof g.ajax_with_recommend === "function",
        equipKinds: Array.isArray(g.EquipKinds) ? g.EquipKinds.length : 0,
        jewelryKinds: Array.isArray(g.Kinds) ? g.Kinds.length : 0,
        jadeConfig: !!g.CBG_GAME_CONFIG?.minghun_attr,
        searchArguments: !!g.CurSearchValue,
        loginRequired:
          /show_login\.py/.test(location.pathname) || visible('input[type="password"], #qrcode'),
        serverAuthenticated: g.IsLogin === 1 || g.IsLogin === true || g.LoginInfo?.login === 1,
        captchaRequired:
          !!g.CaptchaCheck?.need_captcha ||
          visible(".yidun_popup, .geetest_panel, #captcha_container"),
        busy: /系统繁忙|访问过于频繁|请求过于频繁/.test(document.body?.innerText || ""),
        resultPresent: !!g.__cbgEquipmentResult,
        resultPage: Number(g.__cbgEquipmentResult?.page) || null,
        resultOk: g.__cbgEquipmentResult?.ok === true,
        loadingVisible: visible("#loading_img"),
      };
    });
  } catch {
    return { unavailable: true };
  }
}
const fatalEquipmentSearchError = (error: unknown) =>
  error instanceof Error &&
  /登录|安全验证|验证码|人机验证|频繁|网站繁忙|系统繁忙|未采用报价|报价未采用|captcha/i.test(
    error.message,
  );
type EquipmentUiAction = { control: string; value: string; method: string };

export async function selectObservedMenu(
  page: Page,
  id: string,
  value: string | number | Array<string | number>,
) {
  const requested = Array.isArray(value) ? value.join(",") : String(value);
  const wanted = new Set(requested.split(","));
  const read = () =>
    page.evaluate(function readEquipmentMenu(panelId) {
      return Array.from(document.querySelectorAll<HTMLElement>("#" + panelId + " > li")).map(
        (el) => {
          const stored = (el as HTMLElement & { retrieve?: (key: string) => unknown }).retrieve?.(
            "value",
          );
          const value = el.getAttribute("data_value") ?? el.getAttribute("data-value") ?? stored;
          return {
            value: typeof value === "string" || typeof value === "number" ? String(value) : "",
            selected: el.classList.contains("on"),
            disabled: el.classList.contains("disable"),
          };
        },
      );
    }, id);
  let choices = await read();
  if (
    id === "special_skill_panel" &&
    [...wanted].some((value) => !choices.some((choice) => choice.value.split(",").includes(value)))
  ) {
    await page.locator("#btn_all_special_skill").click({ timeout: 5000 });
    choices = await read();
  }
  const indexes = choices.flatMap((choice, index) => {
    const values = choice.value.split(",");
    return values.every((value) => wanted.has(value)) ? [index] : [];
  });
  const selectedValues = new Set(indexes.flatMap((index) => choices[index].value.split(",")));
  if (
    [...wanted].some((value) => !selectedValues.has(value)) ||
    indexes.some((index) => choices[index].disabled)
  )
    throw new Error("官网装备菜单无法表达查询条件：" + id);
  for (const [index, choice] of choices.entries()) {
    if (choice.selected !== indexes.includes(index))
      await page
        .locator("#" + id + " > li")
        .nth(index)
        .click({ timeout: 5000 });
  }
  const actual = await read();
  if (actual.some((choice, index) => choice.selected !== indexes.includes(index)))
    throw new Error("官网装备菜单点击未生效：" + id);
  return { control: id, value: requested, method: "menu_click" };
}

export async function moveObservedLevelSlider(
  page: Page,
  id: string,
  minimum: number,
  maximum: number,
) {
  await page.locator("#" + id).scrollIntoViewIfNeeded({ timeout: 5000 });
  const options = await page.evaluate(function readEquipmentSlider(sliderId) {
    const el = document.getElementById(sliderId) as
      | (HTMLElement & { slider?: { options?: { grid: number; step: number; range: number[] } } })
      | null;
    const options = el?.slider?.options;
    return options ? { grid: options.grid, step: options.step, range: options.range } : null;
  }, id);
  if (
    !options ||
    ![minimum, maximum].every(
      (value) =>
        Number.isFinite(value) &&
        value >= options.range[0] &&
        value <= options.range[1] &&
        (value - options.range[0]) % options.step === 0,
    ) ||
    minimum > maximum
  )
    throw new Error("官网等级滑条不支持当前装备等级：" + id);
  // Move the upper handle first, then the lower handle; the official Drag enforces their order.
  for (const [handle, value] of [
    ["endPoint", maximum],
    ["startPoint", minimum],
  ] as const) {
    const element = page.locator("#" + id + " ." + handle);
    const old = Number((await element.locator(".num").innerText()).match(/\d+/)?.[0]);
    if (old === value) continue;
    const box = await element.boundingBox();
    if (!box) throw new Error("官网等级滑条不可见：" + id);
    // Adjacent handles overlap (e.g. 60/70 on the official 46px handles); their outer
    // edges stay reachable when the opposite handle has the higher z-index.
    const x = handle === "startPoint" ? box.x + 2 : box.x + box.width - 2,
      y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    try {
      await page.mouse.move(x + ((value - old) / options.step) * options.grid, y, { steps: 8 });
    } finally {
      await page.mouse.up();
    }
    const actual = Number((await element.locator(".num").innerText()).match(/\d+/)?.[0]);
    if (actual !== value) throw new Error("官网等级滑条未设置为目标等级：" + id);
  }
  return { control: id, value: minimum + "-" + maximum, method: "drag" };
}

/** Fill public official widgets and submit their button; no window search arguments are written. */
export async function applyEquipmentSearchForm(
  page: Page,
  args: Query,
  config: EquipmentSearchConfig,
  type: "equipment" | "jewelry" | "jade" | "yuanshen",
) {
  const actions: EquipmentUiAction[] = [];
  const control = async (id: string) => {
    const element = page.locator("#" + id);
    if ((await element.count()) !== 1 || !(await element.isVisible()))
      throw new Error("官网装备查询控件不可用：" + id);
    return element;
  };
  const fill = async (id: string, value: string | number) => {
    await (await control(id)).fill(String(value), { timeout: 5000 });
    actions.push({ control: id, value: String(value), method: "fill" });
  };
  const select = async (id: string, value: string | number) => {
    await (await control(id)).selectOption(String(value), { timeout: 5000 });
    actions.push({ control: id, value: String(value), method: "select" });
  };
  const click = async (id: string) => {
    await (await control(id)).click({ timeout: 5000 });
    actions.push({ control: id, value: "", method: "click" });
  };
  const menu = async (id: string, value: string | number) => {
    actions.push(await selectObservedMenu(page, id, value));
  };
  const slider = async (id: string, minimum: number, maximum: number) => {
    actions.push(await moveObservedLevelSlider(page, id, minimum, maximum));
  };
  const handled = new Set<string>();
  const use = (key: string) => {
    handled.add(key);
    return args[key];
  };
  await click("reset_all");
  await click("btn_reset_user_server");
  await select("overall_sel_area", "");
  await select("ovarall_sel_server", "");
  await menu("server_type_panel", use("server_type"));
  if (type === "equipment") {
    await slider("level_slider", Number(use("level_min")), Number(use("level_max")));
    await menu("fair_show_panel", use("front_status"));
    for (const [key, id] of [
      ["kindid", "kind_check_panel"],
      ["special_effect", "special_effect_panel"],
      ["special_skill", "special_skill_panel"],
      ["gem_value", "gem_panel"],
    ] as const)
      if (args[key] !== undefined) await menu(id, use(key));
    for (const key of [
      "repair_fail",
      "damage",
      "all_wakan",
      "gem_level",
      "init_defense",
      "init_damage_raw",
      "init_wakan",
      "init_hp",
      "init_dex",
      "hole_num",
    ])
      if (args[key] !== undefined) await fill("txt_" + key, use(key));
    if (args.attr_without_melt !== undefined) {
      await (
        await control("chk_attr_with_melt")
      ).setChecked(!Number(use("attr_without_melt")), { timeout: 5000 });
      actions.push({ control: "chk_attr_with_melt", value: "false", method: "check" });
    }
    if (args.special_mode !== undefined) {
      await page
        .locator('#check_mode_panel input[value="' + String(use("special_mode")) + '"]')
        .check({ timeout: 5000 });
      actions.push({
        control: "check_mode_panel",
        value: String(args.special_mode),
        method: "check",
      });
    }
    if (args.suit_effect !== undefined) {
      const value = String(use("suit_effect"));
      if (config.suits?.some(([id]) => String(id) === value)) {
        await (await control("radio_short_cut")).check({ timeout: 5000 });
        await select("sel_short_cut", value);
      } else {
        const matches = Object.entries(config.suitTypes || {}).flatMap(([type, choices]) =>
          choices.filter(([id]) => String(id) === value).map(([, name]) => ({ type, name })),
        );
        if (matches.length !== 1) throw new Error("官网套装控件无法唯一表达当前效果");
        await (await control("radio_" + matches[0].type)).check({ timeout: 5000 });
        await fill("txt_" + matches[0].type, matches[0].name);
      }
    }
  } else if (type === "jewelry") {
    await slider(
      "equip_level_slider",
      Number(use("equip_level_min")),
      Number(use("equip_level_max")),
    );
    await menu("fair_show_panel", use("pass_fair_show"));
    if (args.kindid !== undefined) await menu("kind_panel", use("kindid"));
    if (args.special_effect !== undefined) {
      if (Number(use("special_effect")) !== 1) throw new Error("官网灵饰特效控件只支持简易");
      await (await control("chk_has_eazy_effect")).setChecked(true, { timeout: 5000 });
      actions.push({ control: "chk_has_eazy_effect", value: "true", method: "check" });
    }
    await fill("txt_repair_fail", args.repair_fail === undefined ? "" : use("repair_fail"));
    for (const key of ["jinglian_level", "suit_effect_level"])
      if (args[key] !== undefined) await fill("txt_" + key, use(key));
    if (args.suit_effect !== undefined) await select("sel_suit_effect", use("suit_effect"));
    const primary = [
      "damage",
      "defense",
      "magic_damage",
      "magic_defense",
      "fengyin",
      "anti_fengyin",
      "speed",
    ].filter((key) => args[key] !== undefined);
    if (primary.length > 1) throw new Error("官网灵饰基础属性不能表达多个主属性");
    if (primary.length) {
      await select("sel_basic_attr_type", primary[0]);
      await fill("txt_basic_attr_value", use(primary[0]));
    }
    if (args.added_attr_num !== undefined)
      await menu("added_attr_num_panel", use("added_attr_num"));
    if (args.added_attr_logic !== undefined) {
      if (use("added_attr_logic") !== "detail")
        throw new Error("官网灵饰附加属性模式无法表达当前条件");
      await (await control("added_attr_logic_detail")).check({ timeout: 5000 });
      const attrs = Object.entries(args)
        .filter(([key]) => key.startsWith("added_attr."))
        .flatMap(([key, count]) => {
          handled.add(key);
          return Array.from({ length: Number(count) }, () => key.slice("added_attr.".length));
        });
      if (attrs.length > 3) throw new Error("官网灵饰附加属性超过三个槽位");
      for (const [index, value] of attrs.entries())
        await select("sel_add_attr" + (index + 1), value);
    }
  } else if (type === "yuanshen") {
    await menu("equip_type_check_panel", use("type_choice"));
    await select("attr_type", use("attr_type"));
    if (args.addon_choices !== undefined)
      await menu("equip_attr_check_panel", use("addon_choices"));
    for (const id of ["txt_attr_value", "txt_addon_skill_chance", "txt_addon_effect_chance"])
      if (args[id] !== undefined) await fill(id, use(id));
  } else {
    await menu("fair_show_panel", use("pass_fair_show"));
    await (await control("chk_include_ext_mh_lv")).setChecked(false, { timeout: 5000 });
    actions.push({ control: "chk_include_ext_mh_lv", value: "false", method: "check" });
    for (const [key, id] of [
      ["equip_type", "yupo_type_panel"],
      ["special_teji", "special_teji"],
      ["special_daoju", "special_daoju"],
    ] as const)
      if (args[key] !== undefined) await menu(id, use(key));
    for (const key of [
      "init_attrs",
      "base_attrs1",
      "base_attrs2",
      "total_attrs",
      "minghun_effect",
    ]) {
      if (args[key] === undefined) continue;
      const entries = Object.entries(
        JSON.parse(String(use(key))) as Record<string, string | number>,
      );
      if (entries.length !== 1) throw new Error("官网玉魄控件不能表达多个属性：" + key);
      await select("sel_" + key, entries[0][0]);
      await fill(
        "txt_" + key,
        key === "minghun_effect" ? Number(entries[0][1]) / 10 : entries[0][1],
      );
    }
    if (args.minghun_level_min !== undefined)
      await fill("txt_minghun_level_min", use("minghun_level_min"));
  }
  const unsupported = Object.keys(args).filter((key) => !handled.has(key));
  if (unsupported.length) throw new Error("官网装备 UI 尚不支持查询字段：" + unsupported.join(","));
  return {
    button:
      type === "yuanshen"
        ? "btn_yuanshen_search"
        : type === "jade"
          ? "btn_yupo_search"
          : type === "jewelry"
            ? "btn_lingshi_search"
            : "btn_equip_search",
    actions,
  };
}

export async function clickEquipmentSearchPage(page: Page, pageNumber: number) {
  const link = page.locator('#pager a[href="javascript:goto(' + pageNumber + ')"]').first();
  if (await link.isVisible()) {
    await link.click({ timeout: 5000 });
    return { control: "pager", value: String(pageNumber), method: "click" };
  }
  const jump = page.locator("#pager_input");
  if ((await jump.count()) === 1 && (await jump.isVisible())) {
    await jump.fill(String(pageNumber), { timeout: 5000 });
    await jump.press("Enter", { timeout: 5000 });
    return { control: "pager_input", value: String(pageNumber), method: "fill_enter" };
  }
  throw new Error("官网分页控件无法到达已保存页码：" + pageNumber);
}

const publicSearchError = (error: unknown) =>
  (error instanceof Error ? error.message.split("\n")[0] : "官网装备查询失败")
    .replace(/https?:\/\/[^\s"']+/g, (value) => {
      try {
        const url = new URL(value);
        return url.origin + url.pathname;
      } catch {
        return "[网址已省略]";
      }
    })
    .slice(0, 180);

/** Separate work pages share the existing login; they never navigate the role list. */
export function equipmentSourceFromPages(
  searchPage: Page,
  detailPage: Page,
  signal: AbortSignal,
  onProgress?: (progress: PricingSearchProgress) => void,
): EquipmentSource & {
  close(): Promise<void>;
  discover(
    item: EquipmentPricingItem,
    signal: AbortSignal,
  ): ReturnType<typeof readEquipmentSearchForm>;
} {
  const cache = new Map<string, string>();
  const deadline = Date.now() + 180_000;
  let progress: PricingSearchProgress = { assetName: "", page: 1, validSamples: 0, retryCount: 0 };
  const report = (patch: Partial<PricingSearchProgress>) => {
    progress = { ...progress, ...patch };
    onProgress?.(progress);
  };
  let closing: Promise<void> | undefined;
  let marketScope: ReturnType<typeof createMarketScopeAudit> | undefined;
  const close = () => {
    if (!closing) {
      signal.removeEventListener("abort", abort);
      marketScope?.close();
      closing = Promise.allSettled([searchPage.close(), detailPage.close()]).then(() => {});
    }
    return closing;
  };
  const abort = () => {
    void close();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) void close();
  const readSource = async (url: string, requestSignal: AbortSignal) => {
    requestSignal = AbortSignal.any([signal, requestSignal]);
    requestSignal.throwIfAborted();
    const safe = safeEquipmentUrl(url);
    if (cache.has(safe)) return cache.get(safe)!;
    for (let attempt = 0; ; attempt++) {
      report({ retryCount: attempt });
      try {
        await pace(requestSignal, 600, 400);
        await detailPage.goto(safe, { waitUntil: "domcontentloaded", timeout: 15000 });
        requestSignal.throwIfAborted();
        if (equipmentIdentity(detailPage.url()) !== equipmentIdentity(safe))
          throw new Error("装备详情跳转到另一商品，报价未采用");
        const value = await equipmentPageSource(detailPage, requestSignal);
        cache.set(safe, value.html);
        return value.html;
      } catch (error) {
        requestSignal.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        if (
          attempt >= 2 ||
          Date.now() >= deadline ||
          !/Timeout|timeout|net::ERR_|未加载完成|interrupted by another navigation/.test(message) ||
          /登录|验证码|安全验证|频繁|繁忙|结构不支持/.test(message)
        )
          throw error;
      }
    }
  };
  return {
    close,
    readSource,
    async discover(item, requestSignal) {
      requestSignal = AbortSignal.any([signal, requestSignal]);
      requestSignal.throwIfAborted();
      const unsupported = equipmentLevelUnsupportedReason(item);
      if (unsupported) throw new Error(unsupported);
      await searchPage.goto(
        isYuanshen(item)
          ? YUANSHEN_SEARCH_URL
          : item.category === "上古玉魄"
            ? JADE_SEARCH_URL
            : isJewelry(item)
              ? JEWELRY_SEARCH_URL
              : EQUIPMENT_SEARCH_URL,
        { waitUntil: "domcontentloaded", timeout: 15000 },
      );
      requestSignal.throwIfAborted();
      await searchPage.waitForFunction(
        ({ jewelry, jade, yuanshen }) => {
          const g = window as unknown as Record<string, any>;
          const visible = (selector: string) =>
            Array.from(document.querySelectorAll(selector)).some((node) => node.checkVisibility());
          if (
            g.CaptchaCheck?.need_captcha ||
            visible(
              "#qrcode,#loginContainer,#captcha_container,.yidun_popup,.geetest_panel,input[type=password]",
            )
          )
            return true;
          const panel = yuanshen
            ? "#equip_type_check_panel"
            : jade
              ? "#yupo_type_panel"
              : jewelry
                ? "#kind_panel"
                : "#kind_check_panel";
          return (
            document.readyState !== "loading" &&
            !!document.querySelector(panel + " li") &&
            !!document.querySelector("#server_type_panel li") &&
            (jade ||
              yuanshen ||
              !!document.querySelector(
                (jewelry ? "#equip_level_slider" : "#level_slider") + " .startPoint .num",
              ))
          );
        },
        {
          jewelry: isJewelry(item),
          jade: item.category === "上古玉魄",
          yuanshen: isYuanshen(item),
        },
        { timeout: 15000 },
      );
      requestSignal.throwIfAborted();
      const form = await readEquipmentSearchForm(searchPage);
      requestSignal.throwIfAborted();
      return form;
    },
    async findCandidates(items, requestSignal) {
      requestSignal = AbortSignal.any([signal, requestSignal]);
      const queries: string[] = [],
        records: unknown[] = [];
      const results: Awaited<ReturnType<EquipmentSource["findCandidates"]>>["items"] = [];
      equipmentItems: for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
        const item = items[itemIndex];
        report({
          assetName: item.name,
          page: item.searchCursor?.pageNumber || 1,
          validSamples: 0,
          retryCount: 0,
        });
        requestSignal.throwIfAborted();
        const unsupported = equipmentLevelUnsupportedReason(item);
        if (unsupported) {
          records.push({
            key: item.key,
            reason: "unsupported_level",
            note: unsupported,
          });
          results.push({
            key: item.key,
            candidates: [],
            searchState: "unsupported",
            note: unsupported,
          });
          continue;
        }
        if (Date.now() >= deadline) {
          results.push({
            key: item.key,
            candidates: item.candidates.filter((candidate) => candidate.verified),
            searchState: "pending",
            ...(item.searchCursor ? { searchCursor: item.searchCursor } : {}),
            skipped: true,
            note: "达到本件商品查价时间上限，尚未开始此装备，已保留上轮查询进度",
          });
          continue;
        }
        let stage = "navigate";
        let currentQueries: string[] = [];
        let currentCursor = () => item.searchCursor;
        let currentCandidates = () => item.candidates.filter((candidate) => candidate.verified);
        let currentCounts = () => ({ pages: 0, rows: 0, details: 0 });
        let currentRecord: Record<string, unknown> = { key: item.key };
        try {
          const jewelry = isJewelry(item),
            jade = item.category === "上古玉魄",
            yuanshen = isYuanshen(item);
          await searchPage.goto(
            yuanshen
              ? YUANSHEN_SEARCH_URL
              : jade
                ? JADE_SEARCH_URL
                : jewelry
                  ? JEWELRY_SEARCH_URL
                  : EQUIPMENT_SEARCH_URL,
            {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            },
          );
          requestSignal.throwIfAborted();
          stage = "login_check";
          await assertAvailable(searchPage);
          if (!buildPageState(await readStableSnapshot(searchPage)).isLoggedIn)
            throw new Error("藏宝阁登录已失效，请在采集页扫码登录后继续装备查价");
          stage = "bootstrap";
          await searchPage.waitForFunction(
            ({ jewelry, jade, yuanshen }) => {
              const globals = window as unknown as {
                overall_search?: unknown;
                ajax_with_recommend?: unknown;
                EquipKinds?: unknown[];
                Kinds?: unknown[];
                CBG_GAME_CONFIG?: { minghun_attr?: unknown };
              };
              return (
                typeof globals.overall_search === "function" &&
                typeof globals.ajax_with_recommend === "function" &&
                (yuanshen ||
                  (jade
                    ? !!globals.CBG_GAME_CONFIG?.minghun_attr
                    : !!(jewelry ? globals.Kinds : globals.EquipKinds)?.length)) &&
                !!document.querySelector(
                  (yuanshen
                    ? "#equip_type_check_panel"
                    : jade
                      ? "#yupo_type_panel"
                      : jewelry
                        ? "#kind_panel"
                        : "#kind_check_panel") + " li",
                ) &&
                !!document.querySelector("#server_type_panel li")
              );
            },
            { jewelry, jade, yuanshen },
            { timeout: 15000 },
          );
          stage = "configuration";
          const config = await searchPage.evaluate(
            ({ jewelry, name, level }) => {
              const g = window as unknown as {
                EquipKinds?: Choices;
                Kinds?: Choices;
                SpecialEffects?: Choices;
                SpecialSkills?: Choices;
                Gems?: Choices;
                AddedAttr1?: Choices;
                AddedAttr2?: Choices;
                SuitEffects?: Choices | string[];
                SuitAddedStatus?: Record<string, string | number>;
                SuitAppendSkills?: Record<string, string | number>;
                SuitTransformSkills?: Record<string, string | number>;
                SuitTransformCharms?: Record<string, string | number>;
                AUTO_SEARCH_CONFIG?: {
                  wjd_equip_equip_type?: Record<string, Array<{ label: string }>>;
                };
              };
              const namedIds = new Set<string>();
              if (!jewelry) {
                for (const [key, models] of Object.entries(
                  g.AUTO_SEARCH_CONFIG?.wjd_equip_equip_type || {},
                )) {
                  const parts = key.match(/^(\d+)_(\d+)$/);
                  if (
                    parts &&
                    Number(parts[1]) === level &&
                    models.some((model) => model.label === name)
                  )
                    namedIds.add(parts[2]);
                }
              }
              const typedSuits = (values: Record<string, string | number> = {}): Choices =>
                Object.entries(values || {}).map(([name, id]) => [id, name]);
              return {
                kinds: (jewelry ? g.Kinds : g.EquipKinds) || [],
                effects: g.SpecialEffects || [],
                skills: g.SpecialSkills || [],
                gems: g.Gems || [],
                namedKinds:
                  namedIds.size === 1
                    ? (g.EquipKinds || []).filter(([id]) => namedIds.has(String(id)))
                    : [],
                addedAttrs: [...(g.AddedAttr1 || []), ...(g.AddedAttr2 || [])],
                suits:
                  !jewelry && Array.isArray(g.SuitEffects) && g.SuitEffects.every(Array.isArray)
                    ? (g.SuitEffects as Choices)
                    : [],
                jewelrySuitEffects:
                  jewelry && Array.isArray(g.SuitEffects)
                    ? g.SuitEffects.map((name) => (typeof name === "string" ? name : ""))
                    : [],
                jewelrySuitChoices: jewelry
                  ? Array.from(
                      document.querySelectorAll<HTMLOptionElement>("#sel_suit_effect option"),
                    )
                      .map((option): [string, string] => [
                        option.value,
                        option.textContent?.trim() || "",
                      ])
                      .filter(([value]) => value !== "" && value !== "0")
                  : [],
                suitTypes: {
                  added_status: typedSuits(g.SuitAddedStatus),
                  append_skill: typedSuits(g.SuitAppendSkills),
                  transform_skill: typedSuits(g.SuitTransformSkills),
                  transform_charm: typedSuits(g.SuitTransformCharms),
                },
              };
            },
            { jewelry, name: item.name, level: item.level },
          );
          if (yuanshen) {
            const form = await readEquipmentSearchForm(searchPage);
            config.kinds = (
              form.menus.find((menu) => menu.id === "equip_type_check_panel")?.choices || []
            ).map((choice) => [choice.value, choice.label]);
            config.namedKinds = (
              form.controls.find((control) => control.id === "attr_type")?.options || []
            ).map((option) => [option.value, option.label]);
            config.addedAttrs = (
              form.menus.find((menu) => menu.id === "equip_attr_check_panel")?.choices || []
            ).map((choice) => [choice.value, choice.label]);
            if (config.kinds.some(([value]) => String(value) === ""))
              throw new Error("元身类型控件尚未初始化公开编号");
          }
          const jadeConfig = jade
            ? await searchPage.evaluate(() => {
                const config = (window as unknown as { CBG_GAME_CONFIG: JadeSearchConfig })
                  .CBG_GAME_CONFIG;
                return {
                  minghun_attr: config.minghun_attr,
                  minghun_attr_yin: config.minghun_attr_yin,
                  minghun_attr_yang: config.minghun_attr_yang,
                  minghun_effect: config.minghun_effect,
                  minghun_teji: config.minghun_teji,
                  minghun_daoju: config.minghun_daoju,
                };
              })
            : null;
          const exactArgs: Query = {
            ...(yuanshen
              ? yuanshenQuery(item, config)
              : jade
                ? jadeQuery(item, jadeConfig!).args
                : equipmentQuery(item, config).args),
            server_type: "3",
          };
          if (
            !jewelry &&
            !jade &&
            !yuanshen &&
            !Object.keys(exactArgs).some((key) => key.startsWith("init_"))
          )
            throw new Error("装备初始属性无法可靠还原，请核对基础属性、宝石种类及段数后再查询");
          const act = yuanshen
            ? await searchPage.evaluate(() => {
                const globals = window as unknown as {
                  OverallSearchType?: string;
                  OverallSearchAct?: string;
                };
                if (
                  globals.OverallSearchType !== "yuanshen" ||
                  !/^(?!show_)[a-z_]*yuanshen[a-z_]*$/.test(globals.OverallSearchAct || "")
                )
                  throw new Error("元身官网查询脚本未提供可核验的实际动作，未猜测接口");
                return globals.OverallSearchAct!;
              })
            : jade
              ? "yupo_search"
              : jewelry
                ? "overall_search_lingshi"
                : "overall_search_equip";
          const queryModes: EquipmentQueryStep[] =
            jade || yuanshen
              ? [
                  { mode: "exact", args: exactArgs },
                  {
                    mode: "similar",
                    args: {
                      ...(jade
                        ? jadeQuery(item, jadeConfig!, true).args
                        : yuanshenQuery(item, config, true)),
                      server_type: "3",
                    },
                  },
                ]
              : equipmentQueryPlan(item, config);
          marketScope?.close();
          marketScope = createMarketScopeAudit(searchPage, yuanshen ? [act] : []);
          const planHash = digest({
            resumePolicy: PRICING_RESUME_POLICY,
            firstPagePolicy: "first-five-per-condition-v2",
            name: item.name,
            level: item.level,
            category: item.category,
            kindId: item.kindId,
            modelId: item.modelId,
            description: item.description,
            queryModes,
            searchMethod: EQUIPMENT_QUOTE_POLICY,
          });
          const savedCursor = equipmentCursorMatches(item.searchCursor, planHash, queryModes.length)
            ? item.searchCursor
            : undefined;
          const next: EquipmentSearchCursor = savedCursor
            ? structuredClone(savedCursor)
            : {
                version: 1,
                planHash,
                modeIndex: 0,
                pageNumber: 1,
                rowIndex: 0,
                pageRowsHash: "",
                seen: [],
                failed: [],
              };
          const actualModes: Array<{
            mode: string;
            args: Query;
            pages: number;
            exhausted: boolean;
            sampleLimit: number;
            sampled: number;
            samplingComplete: boolean;
            detailFailures: unknown[];
          }> = [];
          const itemQueries: string[] = [];
          const scopeEvidence: Array<{
            mode: EquipmentQueryMode;
            request: GlobalMarketRequest;
            rowCount: number;
            candidateServers: Record<string, number>;
            replay?: boolean;
          }> = [];
          const savedCandidates = savedCursor
            ? item.candidates.filter((value) => value.verified)
            : [];
          const candidates: EquipmentCandidate[] = [],
            similar: EquipmentCandidate[] = [],
            rejected: EquipmentCandidate[] = [];
          const detailFailures: Array<{
            url: string;
            modeIndex: number;
            reason: string;
            diagnostics: unknown;
          }> = [];
          const seen = new Set(next.seen);
          const failed = new Map(next.failed.map((value) => [value.url, value.modeIndex]));
          const attemptedDetails = new Set<string>();
          const enhancementMode = (mode: EquipmentQueryMode) =>
            mode === "same-gems" || mode === "near-gems"
              ? mode
              : mode === "exact" &&
                  ["gem_level", "gem_value", "jinglian_level"].some(
                    (key) => exactArgs[key] !== undefined,
                  )
                ? "same-gems"
                : null;
          // Preserve official result order; each independently verified listing counts once.
          const closestSimilar = () => similar.slice(0, EQUIPMENT_QUOTE_LIMIT);
          const enoughSamples = () =>
            candidates.length >= EQUIPMENT_QUOTE_LIMIT ||
            (!candidates.length &&
              closestSimilar().length >= EQUIPMENT_QUOTE_LIMIT &&
              buildEquipmentEstimate(closestSimilar()).status === "range");
          const returnedCandidates = () =>
            [
              ...(candidates.length ? candidates : closestSimilar()),
              // Stage-rejected details remain audit evidence, not a second pricing cohort.
              ...(!candidates.length && !enoughSamples() && next.modeIndex < queryModes.length
                ? rejected
                : []),
            ].slice(0, EQUIPMENT_QUOTE_LIMIT);
          const listingRejected: Array<{
            url: string;
            reason: string;
            name: string;
            level: string;
            kindId: string;
            modelId: string;
            description: string;
          }> = [];
          const listingSkipCounts: Record<string, number> = {};
          const skipListing = (
            row: {
              url: string;
              name: string;
              level: string;
              kindId: string;
              modelId: string;
              description: string;
            },
            reason: string,
          ) => {
            listingSkipCounts[reason] = (listingSkipCounts[reason] || 0) + 1;
            if (listingRejected.length < 25)
              listingRejected.push({
                ...row,
                description: (row.description || "").slice(0, 2000),
                reason,
              });
          };
          let count = 0,
            details = 0,
            roundPages = 0,
            exhausted = false;
          currentQueries = itemQueries;
          currentCursor = () => {
            next.seen = [...seen];
            next.failed = [...failed].map(([url, modeIndex]) => ({ url, modeIndex }));
            return next;
          };
          currentCandidates = returnedCandidates;
          currentCounts = () => ({ pages: roundPages, rows: count, details });
          currentRecord = {
            key: item.key,
            searchUrl: yuanshen
              ? YUANSHEN_SEARCH_URL
              : jade
                ? JADE_SEARCH_URL
                : jewelry
                  ? JEWELRY_SEARCH_URL
                  : EQUIPMENT_SEARCH_URL,
            act,
            serverAge: "3年以上服",
            args: exactArgs,
            modes: actualModes,
            scopeEvidence,
            listingRejected,
            listingSkipCounts,
            detailFailures,
          };
          stage = "query_component";
          await searchPage.evaluate(() => {
            const g = window as unknown as Record<string, any>;
            const original = g.ajax_with_recommend;
            if (typeof original !== "function") throw new Error("官网装备查询组件发生变化");
            g.ajax_with_recommend = function (options: Record<string, any>, ...rest: unknown[]) {
              const success = options.onSuccess,
                failure = options.onFailure;
              return original.call(
                this,
                {
                  ...options,
                  onSuccess(result: Record<string, any>) {
                    g.__cbgEquipmentResult = {
                      page: Number(options.data?.page),
                      serverType: String(options.data?.server_type || ""),
                      ok: result.status === 0 && Array.isArray(result.msg),
                      count: Array.isArray(result.msg) ? result.msg.length : -1,
                      error: typeof result.msg === "string" ? result.msg.slice(0, 200) : "",
                    };
                    success?.(result);
                  },
                  onFailure(...values: unknown[]) {
                    failure?.(...values);
                    g.__cbgEquipmentResult = {
                      page: Number(options.data?.page),
                      ok: false,
                      error: "官网查询请求失败",
                    };
                  },
                },
                ...rest,
              );
            };
          });
          const readCandidate = async (url: string, modeIndex: number) => {
            attemptedDetails.add(url);
            details++;
            let candidate: EquipmentCandidate = {
              url,
              title: item.name,
              price: null,
              priceType: "unknown",
              quote: "",
              verified: false,
              reason: "",
              fetchedAt: null,
              sourceHash: null,
            };
            try {
              const html = await readSource(url, requestSignal);
              const text = html
                .replace(/<\/(?:p|pre|main|div)>|<br\s*\/?\s*>/gi, "\n")
                .replace(/<[^>]+>/g, "")
                .replace(/&amp;/g, "&")
                .replace(/&lt;/g, "<")
                .replace(/&gt;/g, ">");
              const price = text.match(/挂牌价：¥(\d+(?:\.\d+)?)/)?.[1];
              candidate = verifyEquipmentCandidate(
                item,
                {
                  ...candidate,
                  price: price ? Number(price) : null,
                  priceType: "listing",
                  quote: text,
                },
                html,
                new Date().toISOString(),
              );
              const restrictedMode = enhancementMode(queryModes[modeIndex].mode);
              const mismatch = restrictedMode
                ? equipmentEnhancementMismatch(
                    parseEquipmentAttributes(item.description),
                    parseEquipmentAttributes(text),
                    restrictedMode,
                  )
                : null;
              if (candidate.verified && mismatch)
                candidate = { ...candidate, verified: false, reason: mismatch };
              if (
                (jade || yuanshen) &&
                queryModes[modeIndex].mode === "exact" &&
                candidate.matchType === "similar"
              )
                return false; // Retry this identity under the explicit similar stage.
              if (candidate.verified && candidate.matchType === "similar") similar.push(candidate);
              else if (candidate.verified) candidates.push(candidate);
              else rejected.push(candidate);
              report({ validSamples: candidates.length + similar.length });
              failed.delete(url);
              return !mismatch;
            } catch (error) {
              requestSignal.throwIfAborted();
              if (error instanceof Error && /登录|安全验证|频繁|网站繁忙/.test(error.message))
                throw error;
              rejected.push({
                ...candidate,
                reason: error instanceof Error ? error.message : "无法读取装备详情",
              });
              failed.set(url, modeIndex);
              detailFailures.push({
                url,
                modeIndex,
                reason: error instanceof Error ? error.message.split("\n")[0] : "无法读取装备详情",
                diagnostics:
                  error && typeof error === "object" && "equipmentDiagnostics" in error
                    ? error.equipmentDiagnostics
                    : null,
              });
              return true;
            }
          };
          // Re-read saved quotations once so verification after this call uses the same page cache.
          stage = "saved_quotes";
          if (savedCandidates.length) {
            const query = "继续核验已保存的3年以上服相近报价 / " + item.name;
            queries.push(query);
            itemQueries.push(query);
            const broadMode = queryModes.findIndex(({ mode }) => mode === "similar");
            let refreshed = 0;
            for (const candidate of savedCandidates) {
              if (details >= MAX_DETAILS || Date.now() >= deadline) break;
              await readCandidate(safeEquipmentUrl(candidate.url), broadMode < 0 ? 0 : broadMode);
              refreshed++;
            }
            if (refreshed < savedCandidates.length) {
              records.push({
                key: item.key,
                reason: "candidate_refresh_budget",
                details,
                refreshed,
                detailFailures,
              });
              results.push({
                key: item.key,
                candidates: savedCandidates,
                searchState: "pending",
                ...(item.searchCursor ? { searchCursor: item.searchCursor } : {}),
                skipped: true,
                note: "保存报价尚未全部重新核验，已保留上轮候选和查询位置，继续时重新核验",
              });
              continue equipmentItems;
            }
          }
          // Failed detail URLs are retried once in this round; successful/ruled-out rows stay read.
          if (failed.size) {
            const retryQuery = "按已保存的3年以上服筛选条件重试装备详情 / " + item.name;
            queries.push(retryQuery);
            itemQueries.push(retryQuery);
            for (const [url, modeIndex] of failed) {
              if (attemptedDetails.has(url)) continue;
              if (details >= MAX_DETAILS || Date.now() >= deadline) break;
              await readCandidate(safeEquipmentUrl(url), modeIndex);
            }
          }
          let orderChanged = false;
          let historyValidated = !savedCursor?.pageHistory?.length;
          queryStages: for (let modeIndex = 0; modeIndex < queryModes.length; modeIndex++) {
            const { mode, args } = queryModes[modeIndex];
            const sampleLimit = EQUIPMENT_QUOTE_LIMIT;
            let inspected = [...seen].filter((key) => key.startsWith(modeIndex + "|")).length;
            let samplingComplete = false;
            if (failed.size) break;
            if (
              count >= MAX_ROWS ||
              details >= MAX_DETAILS ||
              roundPages >= MAX_PAGES ||
              Date.now() >= deadline
            )
              break;
            const query =
              "全服 / 3年以上服 / 综合排序 / " +
              item.name +
              " / " +
              mode +
              " / " +
              JSON.stringify(args);
            let queryRecorded = false;
            exhausted = false;
            let modePages = 0;
            let uiPage = 0;
            let cachedListing:
              | {
                  rows: Array<{
                    url: string;
                    name: string;
                    kindId: string;
                    modelId: string;
                    level: string;
                    description: string;
                  }>;
                  empty: boolean;
                  hasNext: boolean;
                }
              | undefined;
            const uiActions: Array<{ page: number; actions: EquipmentUiAction[] }> = [];
            const recordedUi = (currentRecord.uiQueries ||= []) as Array<{
              mode: EquipmentQueryMode;
              page: number;
              actions: EquipmentUiAction[];
              submittedArgs?: Query;
            }>;
            const loadPage = async (pageNumber: number, first: boolean, replay = false) => {
              report({
                page: pageNumber,
                validSamples: candidates.length + similar.length,
                retryCount: 0,
              });
              await pace(requestSignal);
              let form: Awaited<ReturnType<typeof applyEquipmentSearchForm>> | undefined;
              if (first) {
                stage = "ui_controls";
                form = await applyEquipmentSearchForm(
                  searchPage,
                  args,
                  config,
                  yuanshen ? "yuanshen" : jade ? "jade" : jewelry ? "jewelry" : "equipment",
                );
              }
              marketScope ||= createMarketScopeAudit(searchPage);
              marketScope.begin(act, pageNumber);
              stage = "query_submit";
              await searchPage.evaluate(function prepareEquipmentUiResult(wantedAct) {
                const g = window as unknown as Record<string, any>;
                if (g.OverallSearchAct !== wantedAct) throw new Error("装备查询类别与预期不符");
                g.__cbgEquipmentResult = null;
              }, act);
              if (form) {
                await searchPage.locator("#" + form.button).click({ timeout: 5000 });
                uiActions.push({
                  page: pageNumber,
                  actions: [...form.actions, { control: form.button, value: "", method: "click" }],
                });
              } else
                uiActions.push({
                  page: pageNumber,
                  actions: [await clickEquipmentSearchPage(searchPage, pageNumber)],
                });
              if (!queryRecorded) {
                queries.push(query);
                itemQueries.push(query);
                queryRecorded = true;
              }
              recordedUi.push({ mode, ...uiActions[uiActions.length - 1] });
              stage = "query_wait";
              await searchPage.waitForFunction(
                (wanted) => {
                  const globals = window as unknown as Record<string, any>;
                  if (
                    globals.CaptchaCheck?.need_captcha ||
                    globals.IsLogin === 0 ||
                    globals.LoginInfo?.login === 0 ||
                    /show_login\.py/.test(location.pathname) ||
                    Array.from(
                      document.querySelectorAll(".yidun_popup, .geetest_panel, #captcha_container"),
                    ).some((el) => el.checkVisibility()) ||
                    /系统繁忙|访问过于频繁|请求过于频繁/.test(document.body.innerText)
                  )
                    return true;
                  const result = globals.__cbgEquipmentResult;
                  const loading = document.querySelector("#loading_img");
                  return result?.page === wanted && (!loading || !loading.checkVisibility());
                },
                pageNumber,
                { timeout: 20000, polling: 200 },
              );
              requestSignal.throwIfAborted();
              await assertAvailable(searchPage);
              stage = "scope_confirm";
              const request = marketScope.confirm();
              stage = "ui_condition_verify";
              const submitted = await searchPage.evaluate(function readEquipmentSubmittedFilters() {
                const args = (
                  window as unknown as { CurSearchValue?: { arg?: Record<string, unknown> } }
                ).CurSearchValue?.arg;
                if (!args || typeof args !== "object")
                  throw new Error("官网装备表单未保存实际查询条件");
                const filters: Record<string, string | number> = {};
                for (const [key, value] of Object.entries(args)) {
                  if (
                    /token|cookie|auth|password|nickname|urs|account|fingerprint|safe_code|session/i.test(
                      key,
                    ) ||
                    (typeof value !== "string" && typeof value !== "number")
                  )
                    throw new Error("装备查询条件含非公开字段，已停止");
                  filters[key] = value;
                }
                return filters;
              });
              recordedUi[recordedUi.length - 1].submittedArgs = submitted;
              if (yuanshen) {
                // The saved HTML does not expose the external script's API field names.
                // Verify public widgets directly and keep the actual submitted args for audit.
                const form = await readEquipmentSearchForm(searchPage);
                for (const [id, value] of Object.entries(args)) {
                  if (id === "type_choice" || id === "server_type" || id === "addon_choices") {
                    const panel =
                      id === "type_choice"
                        ? "equip_type_check_panel"
                        : id === "addon_choices"
                          ? "equip_attr_check_panel"
                          : "server_type_panel";
                    const selected =
                      form.menus
                        .find((menu) => menu.id === panel)
                        ?.choices.filter((choice) => choice.selected)
                        .map((choice) => choice.value) || [];
                    if (selected.sort().join(",") !== String(value).split(",").sort().join(","))
                      throw new Error("元身筛选未生效：" + panel);
                  } else if (
                    form.controls.find((control) => control.id === id)?.value !== String(value)
                  )
                    throw new Error("元身筛选未生效：" + id);
                }
              } else assertEquipmentUIArguments(args, submitted);
              stage = "listing_read";
              const listing = await searchPage.evaluate((currentPage) => {
                const canonicalEquipmentUrl = (href: string) => {
                  const url = new URL(href, location.href);
                  const identityFields = new Set([
                    "s",
                    "serverid",
                    "server_id",
                    "eid",
                    "equip_id",
                    "ordersn",
                  ]);
                  const canonical = new URL(url.origin + url.pathname);
                  for (const key of identityFields) {
                    const value = url.searchParams.get(key);
                    if (value !== null) canonical.searchParams.set(key, value);
                  }
                  return canonical.href;
                };
                const result = (window as unknown as Record<string, any>).__cbgEquipmentResult;
                if (!result?.ok) throw new Error(result?.error || "官网装备查询未成功");
                if (result.serverType !== "3")
                  throw new Error("装备查询未确认3年以上服条件，报价未采用");
                const root = document.querySelector<HTMLElement>("#search_result");
                if (!root?.checkVisibility()) throw new Error("装备列表尚未加载");
                const rows = Array.from(root.querySelectorAll<HTMLAnchorElement>("a.soldImg[href]"))
                  .filter((a) => a.checkVisibility())
                  .map((a) => {
                    const image = a.querySelector("img");
                    const row = a.closest("tr");
                    const ordersn = image?.getAttribute("data_equipid");
                    const descriptions = Array.from(
                      row?.querySelectorAll<HTMLTextAreaElement>('textarea[id^="equip_desc_"]') ||
                        [],
                    );
                    const description =
                      descriptions.find((node) => ordersn && node.id === "equip_desc_" + ordersn) ||
                      (!ordersn && descriptions.length === 1 ? descriptions[0] : undefined);
                    return {
                      url: canonicalEquipmentUrl(a.href),
                      name: image?.getAttribute("data_equip_name") || "",
                      kindId: image?.getAttribute("data_kindid") || "",
                      modelId: image?.getAttribute("data_equip_type") || "",
                      level: image?.getAttribute("data_equip_level") || "",
                      description:
                        description?.value || image?.getAttribute("data_equip_desc") || "",
                    };
                  });
                const empty = result.count === 0 && /没有符合|没有找到|暂无/.test(root.innerText);
                if (!rows.length && !empty) throw new Error("装备列表为空但未确认没有匹配商品");
                const hasNext = Array.from(
                  document.querySelectorAll<HTMLAnchorElement>("#pager a[href]"),
                ).some(
                  (a) =>
                    a.checkVisibility() &&
                    Number(a.getAttribute("href")?.match(/^javascript:goto\((\d+)\)/)?.[1]) ===
                      currentPage + 1,
                );
                return { rows, empty, hasNext };
              }, pageNumber);
              const candidateServers: Record<string, number> = {};
              for (const row of listing.rows) {
                const server = equipmentIdentity(row.url).split(":")[0];
                if (/^\d+$/.test(server))
                  candidateServers[server] = (candidateServers[server] || 0) + 1;
              }
              scopeEvidence.push({
                mode,
                request,
                rowCount: listing.rows.length,
                candidateServers,
                ...(replay ? { replay: true } : {}),
              });
              roundPages++;
              uiPage = pageNumber;
              cachedListing = listing;
              return listing;
            };
            // Validate every saved page, including exhausted earlier stages, before continuing.
            // The replay position survives a three-page budget so long histories can progress.
            const history = savedCursor?.pageHistory || [];
            while (
              (next.historyIndex || 0) < history.length &&
              history[next.historyIndex || 0].modeIndex === modeIndex
            ) {
              if (roundPages >= MAX_PAGES || Date.now() >= deadline) break queryStages;
              const old = history[next.historyIndex || 0];
              if (!uiPage && old.pageNumber > 1) {
                const first = await loadPage(1, true, true);
                const firstSaved = history.find(
                  (page) => page.modeIndex === modeIndex && page.pageNumber === 1,
                );
                if (firstSaved && digest(first.rows) !== firstSaved.rowsHash) {
                  orderChanged = true;
                  break;
                }
                if (roundPages >= MAX_PAGES) break queryStages;
              }
              const replay = await loadPage(old.pageNumber, !uiPage, true);
              if (digest(replay.rows) !== old.rowsHash) {
                orderChanged = true;
                break;
              }
              next.historyIndex = (next.historyIndex || 0) + 1;
            }
            if (orderChanged) {
              records.push({
                key: item.key,
                reason: "result_order_changed",
                previousCursor: structuredClone(next),
                discardedCandidates: [...candidates, ...similar],
              });
              resetPricingCursor(next);
              candidates.length = similar.length = rejected.length = 0;
              seen.clear();
              failed.clear();
              break queryStages;
            }
            if ((next.historyIndex || 0) >= history.length) historyValidated = true;
            if (modeIndex < next.modeIndex) continue;
            if (enoughSamples()) break;
            if (roundPages >= MAX_PAGES) break;
            // A new scan starts a fresh validation cycle for the next continuation.
            next.historyIndex = 0;
            if (inspected >= sampleLimit && !failed.size) {
              samplingComplete = true;
              next.modeIndex =
                candidates.length || similar.length ? queryModes.length : modeIndex + 1;
              next.pageNumber = 1;
              next.rowIndex = 0;
              next.pageRowsHash = "";
            }
            for (
              let pageNumber = next.pageNumber;
              next.modeIndex === modeIndex &&
              roundPages < MAX_PAGES &&
              count < MAX_ROWS &&
              details < MAX_DETAILS &&
              !enoughSamples() &&
              inspected < sampleLimit &&
              Date.now() < deadline;
              pageNumber++
            ) {
              if (!uiPage && pageNumber > 1) {
                const first = await loadPage(1, true, true);
                if (!rememberPricingPage(next, modeIndex, 1, digest(first.rows))) {
                  records.push({
                    key: item.key,
                    reason: "result_order_changed",
                    previousCursor: structuredClone(next),
                    discardedCandidates: [...candidates, ...similar],
                  });
                  resetPricingCursor(next);
                  candidates.length = similar.length = rejected.length = 0;
                  seen.clear();
                  failed.clear();
                  orderChanged = true;
                  break queryStages;
                }
                if (roundPages >= MAX_PAGES || Date.now() >= deadline) break;
              }
              const listing =
                uiPage === pageNumber && cachedListing
                  ? cachedListing
                  : await loadPage(pageNumber, !uiPage);
              modePages++;
              const pageRowsHash = digest(listing.rows);
              if (
                !rememberPricingPage(next, modeIndex, pageNumber, pageRowsHash) ||
                (next.pageRowsHash && next.pageRowsHash !== pageRowsHash)
              ) {
                records.push({
                  key: item.key,
                  reason: "result_order_changed",
                  previousCursor: structuredClone(next),
                  currentPageRowsHash: pageRowsHash,
                  discardedCandidates: [...candidates, ...similar],
                });
                resetPricingCursor(next);
                candidates.length = similar.length = rejected.length = 0;
                seen.clear();
                failed.clear();
                orderChanged = true;
                break queryStages;
              }
              if (listing.empty) {
                exhausted = true;
                next.modeIndex = modeIndex + 1;
                next.pageNumber = 1;
                next.rowIndex = 0;
                next.pageRowsHash = "";
                break;
              }
              let pageFullyRead = true;
              const rankedRows = listing.rows;
              const startRow = next.pageRowsHash === pageRowsHash ? next.rowIndex : 0;
              next.pageNumber = pageNumber;
              next.pageRowsHash = pageRowsHash;
              next.rowIndex = startRow;
              for (let rowIndex = startRow; rowIndex < rankedRows.length; rowIndex++) {
                const row = rankedRows[rowIndex];
                requestSignal.throwIfAborted();
                const identity = equipmentIdentity(safeEquipmentUrl(row.url));
                const seenKey = modeIndex + "|" + identity;
                if (seen.has(seenKey)) {
                  next.rowIndex = rowIndex + 1;
                  continue;
                }
                if (count >= MAX_ROWS || inspected >= sampleLimit || Date.now() >= deadline) {
                  pageFullyRead = false;
                  break;
                }
                count++;
                if (row.name !== item.name) {
                  skipListing(row, "装备名称不匹配");
                  seen.add(seenKey);
                  inspected++;
                  next.rowIndex = rowIndex + 1;
                  if (count >= MAX_ROWS || inspected >= sampleLimit) {
                    pageFullyRead = rowIndex === rankedRows.length - 1;
                    break;
                  }
                  continue;
                }
                const mismatch =
                  item.modelId && row.modelId && Number(item.modelId) !== Number(row.modelId)
                    ? "装备型号不匹配"
                    : equipmentListingMismatch(item, row, args) ||
                      (enhancementMode(mode) && row.description
                        ? equipmentEnhancementMismatch(
                            parseEquipmentAttributes(item.description),
                            parseEquipmentAttributes(
                              row.description
                                .replace(/<br\s*\/?\s*>/gi, "\n")
                                .replace(/<[^>]+>/g, ""),
                            ),
                            enhancementMode(mode)!,
                            true,
                          )
                        : null);
                if (mismatch) {
                  seen.add(seenKey);
                  inspected++;
                  next.rowIndex = rowIndex + 1;
                  skipListing(row, mismatch);
                  if (count >= MAX_ROWS || inspected >= sampleLimit) {
                    pageFullyRead = rowIndex === rankedRows.length - 1;
                    break;
                  }
                  continue;
                }
                if (details >= MAX_DETAILS || Date.now() >= deadline) {
                  pageFullyRead = false;
                  break;
                }
                stage = "candidate_read";
                await readCandidate(row.url, modeIndex);
                seen.add(seenKey);
                inspected++;
                stage = "listing_read";
                next.rowIndex = rowIndex + 1;
                if (failed.size) {
                  pageFullyRead = false;
                  break;
                }
                if (count >= MAX_ROWS || enoughSamples() || inspected >= sampleLimit) {
                  pageFullyRead = rowIndex === rankedRows.length - 1;
                  break;
                }
              }
              if (inspected >= sampleLimit && !failed.size && !detailFailures.length) {
                samplingComplete = true;
                next.modeIndex =
                  candidates.length || similar.length ? queryModes.length : modeIndex + 1;
                next.pageNumber = 1;
                next.rowIndex = 0;
                next.pageRowsHash = "";
                break;
              }
              if (!pageFullyRead || failed.size) break;
              if (!listing.hasNext) {
                exhausted = !listing.hasNext;
                // Exhausted same-config results use their actual count without mixing
                // different configurations from the broader fallback searches.
                next.modeIndex =
                  candidates.length || similar.length ? queryModes.length : modeIndex + 1;
                next.pageNumber = 1;
                next.rowIndex = 0;
                next.pageRowsHash = "";
                break;
              }
              next.pageNumber = pageNumber + 1;
              next.rowIndex = 0;
              next.pageRowsHash = "";
            }
            actualModes.push({
              mode,
              args,
              pages: modePages,
              exhausted,
              sampleLimit,
              sampled: inspected,
              samplingComplete,
              detailFailures: detailFailures.filter((failure) => failure.modeIndex === modeIndex),
            });
            if (next.modeIndex >= queryModes.length || next.modeIndex === modeIndex) break;
          }
          const query = itemQueries.join("\n");
          item.query = query;
          const historyPending =
            (next.historyIndex || 0) > 0 &&
            (next.historyIndex || 0) < (next.pageHistory?.length || 0);
          const completed =
            !orderChanged &&
            historyValidated &&
            !historyPending &&
            (enoughSamples() || next.modeIndex >= queryModes.length);
          next.seen = [...seen];
          next.failed = [...failed].map(([url, modeIndex]) => ({ url, modeIndex }));
          const note = orderChanged
            ? "官网结果身份或顺序已变化，旧候选和已读位置已清除，将从第一阶段第一页重新取样。"
            : `本轮查询${roundPages}页、${count}个列表候选、${details}个详情；` +
              (Object.keys(listingSkipCounts).length
                ? `列表已排除${Object.values(listingSkipCounts).reduce((sum, n) => sum + n, 0)}个不匹配商品；`
                : "") +
              (completed && exhausted
                ? "本次筛选结果已读完"
                : completed
                  ? "每个筛选条件仅核验前5条不同候选，搜索范围有限，未遍历全部在售商品；有样本按实际数量报价，无样本则跳过，市场售价未知"
                  : "未遍历全部在售商品，本轮预算已用完，已保存筛选阶段、页码和行位置；继续查询剩余商品") +
              "。";
          records.push({
            key: item.key,
            searchUrl: currentRecord.searchUrl,
            act,
            serverAge: "3年以上服",
            args: exactArgs,
            modes: actualModes,
            scopeEvidence,
            uiQueries: currentRecord.uiQueries,
            pages: roundPages,
            rows: count,
            details,
            exhausted,
            listingRejected,
            listingSkipCounts,
            comparableCandidates: similar,
            rejectedCandidates: rejected,
            detailFailures,
            ...(next.emptyFirstPageModes?.length
              ? { emptyFirstPageModes: next.emptyFirstPageModes }
              : {}),
            ...(!completed || failed.size ? { cursor: next } : {}),
          });
          const itemSearchState = failed.size ? "read_failed" : completed ? "completed" : "pending";
          results.push({
            key: item.key,
            query,
            searchState: itemSearchState,
            ...(!completed || failed.size ? { searchCursor: next } : {}),
            candidates: returnedCandidates(),
            note,
          });
        } catch (error) {
          requestSignal.throwIfAborted();
          if (stage === "scope_confirm" || fatalEquipmentSearchError(error)) throw error;
          // A structural failure on one item must not discard earlier verified items.
          try {
            await assertAvailable(searchPage);
          } catch (availabilityError) {
            if (fatalEquipmentSearchError(availabilityError)) throw availabilityError;
          }
          const diagnostics = await equipmentSearchDiagnostics(searchPage);
          if ("captchaRequired" in diagnostics && diagnostics.captchaRequired)
            throw new Error("藏宝阁要求安全验证，请完成验证后继续装备查价", { cause: error });
          if ("loginRequired" in diagnostics && diagnostics.loginRequired)
            throw new Error("藏宝阁登录已失效，请在采集页扫码登录后继续装备查价", { cause: error });
          if ("busy" in diagnostics && diagnostics.busy)
            throw new Error("藏宝阁系统繁忙或访问过于频繁，请稍后继续装备查价", { cause: error });
          const failure = { stage, message: publicSearchError(error), diagnostics };
          const cursor = currentCursor();
          const note = `装备${item.name}查询失败（${stage}）：${failure.message}；${JSON.stringify(diagnostics)}`;
          records.push({
            ...currentRecord,
            ...currentCounts(),
            failure,
            ...(cursor ? { cursor } : {}),
          });
          results.push({
            key: item.key,
            query: currentQueries.join("\n"),
            searchState: "read_failed",
            candidates: currentCandidates(),
            note,
            ...(cursor ? { searchCursor: cursor } : {}),
          });
          for (const later of items.slice(itemIndex + 1))
            results.push({
              key: later.key,
              candidates: later.candidates.filter((candidate) => candidate.verified),
              searchState: "pending",
              skipped: true,
              ...(later.searchCursor ? { searchCursor: later.searchCursor } : {}),
              note: "前一件装备查询失败，尚未开始此装备，已保留查询进度",
            });
          break equipmentItems;
        }
      }
      return { queries, items: results, searchItems: records };
    },
  };
}

export async function createEquipmentSource(
  signal: AbortSignal,
  onProgress?: (progress: PricingSearchProgress) => void,
) {
  signal.throwIfAborted();
  let searchPage: Page | undefined, detailPage: Page | undefined;
  try {
    const browser = await getBrowser(true);
    signal.throwIfAborted();
    searchPage = await createHiddenPage(browser);
    signal.throwIfAborted();
    detailPage = await createHiddenPage(browser);
    signal.throwIfAborted();
    return equipmentSourceFromPages(searchPage, detailPage, signal, onProgress);
  } catch (error) {
    await Promise.allSettled([searchPage?.close(), detailPage?.close()]);
    throw error;
  }
}
