import type { Page } from "playwright-core";
import { createHiddenPage, getBrowser } from "../session";
import { assertAvailable, pace } from "../crawler/page";
import { hoverForInspection } from "../viewport";
import { buildPageState } from "../page-state";
import { readStableSnapshot } from "../workflow";
import { cleanDescription, jewelryDescriptionSections } from "../crawler/compact";
import { parseEquipmentAttributes } from "./equip-attributes";
import { matchComparableEquipmentAttributes, matchEquipmentAttributes } from "./equipment-match";
import { jadeQuery, JADE_SEARCH_URL, type JadeSearchConfig } from "./jade-query";
import {
  equipmentIdentity,
  safeEquipmentUrl,
  verifyEquipmentCandidate,
  type EquipmentCandidate,
  type EquipmentPricingItem,
  type EquipmentSource,
} from "./equipment-pricing";

export const EQUIPMENT_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_equip";
export const JEWELRY_SEARCH_URL =
  "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=show_overall_search_lingshi";
const MAX_PAGES = 3,
  MAX_ROWS = 60,
  MAX_DETAILS = 20;
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
  suitTypes?: Partial<Record<SuitType, Choices>>;
};
type Query = Record<string, string | number>;
const isJewelry = (item: EquipmentPricingItem) =>
  /灵饰|戒指|耳饰|手镯|佩饰|配饰/.test(item.category) ||
  /精炼等级/.test(item.description) ||
  [61, 62, 63, 64].includes(Number(item.kindId));

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
  const category = item.category.replace("配饰", "佩饰");
  const kind =
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
    integer("伤害", "damage");
    integer("灵力", "all_wakan");
    integer("锻炼等级", "gem_level");
    const gemLevels = fields.锻炼等级;
    const noGems =
      !(fields.宝石 || []).some((value) => value.trim()) &&
      (!gemLevels ||
        (gemLevels.length === 1 && /^\+?\d+$/.test(gemLevels[0]) && Number(gemLevels[0]) === 0));
    if (noGems) {
      // The official init_* inputs are lower bounds. Only ungemmed, separately observed
      // base values are usable here; do not convert total values or add melting effects.
      for (const [field, parameter] of [
        ["防御", "init_defense"],
        ["气血", "init_hp"],
        ["敏捷", "init_dex"],
      ] as const) {
        if (field === "敏捷" && kind?.[1] !== "鞋子") continue;
        const values = fields[field];
        if (values?.length !== 1 || !/^\+?\d+$/.test(values[0])) continue;
        const value = Number(values[0]);
        if (value > 10000) continue;
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
    for (const key of ["suit_effect", "gem_level", "gem_value", "jinglian_level", "repair_fail"])
      delete args[key];
    for (const key of [
      "init_defense",
      "init_hp",
      "init_dex",
      "all_wakan",
      "damage",
      "defense",
      "magic_damage",
      "magic_defense",
      "fengyin",
      "anti_fengyin",
      "speed",
    ])
      if (typeof args[key] === "number" && args[key] > 0) args[key] = Math.ceil(args[key] * 0.8);
  }
  return { jewelry, args };
}

/** A partial list description may rule an item out, but never establishes a valid quotation. */
export function equipmentListingMismatch(
  item: EquipmentPricingItem,
  row: { kindId?: string; level?: string; description?: string },
  args: Query,
) {
  if (args.kindid && /^\d+$/.test(row.kindId || "") && Number(row.kindId) !== Number(args.kindid))
    return "装备分类不匹配";
  if (/^\d+$/.test(row.level || "") && Number(row.level) !== item.level) return "装备等级不匹配";
  if (!row.description?.trim()) return null;
  const target = parseEquipmentAttributes(item.description);
  const source = parseEquipmentAttributes(
    row.description.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, ""),
  );
  return (
    item.category === "上古玉魄" ? matchEquipmentAttributes : matchComparableEquipmentAttributes
  )(target, source, true).reason;
}

/** Read only the principal equipment description and price, never recommendations. */
export async function equipmentPageSource(page: Page, signal: AbortSignal) {
  try {
    return await readMainEquipment(page, signal);
  } catch (error) {
    signal.throwIfAborted();
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

async function readMainEquipment(page: Page, signal: AbortSignal) {
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
    await page.waitForFunction(
      (excluded) => {
        const panels = Array.from(
          document.querySelectorAll<HTMLElement>("#equip_desc_panel"),
        ).filter((node) => node.checkVisibility() && !node.closest(excluded));
        const info = Array.from(document.querySelectorAll<HTMLElement>("#info_panel")).filter(
          (node) => node.checkVisibility() && !node.closest(excluded),
        );
        return (
          panels.length === 1 &&
          info.length === 1 &&
          panels[0].innerText.trim() &&
          info[0].innerText.trim() &&
          Array.from(
            info[0].querySelectorAll<HTMLElement>(".price, [data_price], [data-price]"),
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
      { timeout: 5000 },
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
      const info = infos.length === 1 ? infos[0] : null;
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
            ?.trim() || ""
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
  const description = cleanDescription(
    (tipAttributes.level !== null || jade) &&
      size(tipAttributes) >= size(rawAttributes) &&
      observed.tooltip
      ? observed.tooltip
      : observed.description,
  );
  if (!jade && parseEquipmentAttributes(description).level === null)
    throw new Error("主商品装备属性尚未读取完整");
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

/** Separate work pages share the existing login; they never navigate the role list. */
export function equipmentSourceFromPages(
  searchPage: Page,
  detailPage: Page,
  signal: AbortSignal,
): EquipmentSource & { close(): Promise<void> } {
  const cache = new Map<string, string>();
  const deadline = Date.now() + 240_000;
  let closing: Promise<void> | undefined;
  const close = () => {
    if (!closing) {
      signal.removeEventListener("abort", abort);
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
    await pace(requestSignal, 600, 400);
    await detailPage.goto(safe, { waitUntil: "domcontentloaded", timeout: 15000 });
    requestSignal.throwIfAborted();
    if (equipmentIdentity(detailPage.url()) !== equipmentIdentity(safe))
      throw new Error("装备详情跳转到另一商品，报价未采用");
    const value = await equipmentPageSource(detailPage, requestSignal);
    cache.set(safe, value.html);
    return value.html;
  };
  return {
    close,
    readSource,
    async findCandidates(items, requestSignal) {
      requestSignal = AbortSignal.any([signal, requestSignal]);
      const queries: string[] = [],
        records: unknown[] = [];
      const results: Awaited<ReturnType<EquipmentSource["findCandidates"]>>["items"] = [];
      for (const item of items) {
        requestSignal.throwIfAborted();
        if (Date.now() >= deadline) {
          results.push({
            key: item.key,
            candidates: [],
            searchState: "pending",
            note: "达到本件商品查价时间上限，未完成所有装备查询",
          });
          continue;
        }
        const jewelry = isJewelry(item),
          jade = item.category === "上古玉魄";
        await searchPage.goto(
          jade ? JADE_SEARCH_URL : jewelry ? JEWELRY_SEARCH_URL : EQUIPMENT_SEARCH_URL,
          {
            waitUntil: "domcontentloaded",
            timeout: 15000,
          },
        );
        requestSignal.throwIfAborted();
        await assertAvailable(searchPage);
        if (!buildPageState(await readStableSnapshot(searchPage)).isLoggedIn)
          throw new Error("藏宝阁登录已失效，请在采集页扫码登录后继续装备查价");
        await searchPage.waitForFunction(
          ({ jewelry, jade }) => {
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
              (jade
                ? !!globals.CBG_GAME_CONFIG?.minghun_attr
                : !!(jewelry ? globals.Kinds : globals.EquipKinds)?.length)
            );
          },
          { jewelry, jade },
          { timeout: 15000 },
        );
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
              SuitEffects?: Choices;
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
              suits: g.SuitEffects || [],
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
          ...(jade ? jadeQuery(item, jadeConfig!).args : equipmentQuery(item, config).args),
          server_type: "3",
        };
        const act = jade
          ? "yupo_search"
          : jewelry
            ? "overall_search_lingshi"
            : "overall_search_equip";
        const similarArgs = jade ? exactArgs : equipmentQuery(item, config, "similar").args;
        const queryModes = [
          { mode: "exact", args: exactArgs },
          ...(JSON.stringify(similarArgs) !== JSON.stringify(exactArgs)
            ? [{ mode: "similar", args: similarArgs }]
            : []),
        ];
        const actualModes: Array<{ mode: string; args: Query; pages: number; exhausted: boolean }> =
          [];
        const itemQueries: string[] = [];
        const candidates: EquipmentCandidate[] = [],
          similar: EquipmentCandidate[] = [],
          rejected: EquipmentCandidate[] = [];
        const detailFailures: Array<{ url: string; reason: string; diagnostics: unknown }> = [];
        const seen = new Set<string>();
        const listingRejected: Array<{ url: string; reason: string }> = [];
        let count = 0,
          details = 0,
          lastPage = 0,
          exhausted = false;
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
        for (const { mode, args } of queryModes) {
          if (
            mode === "similar" &&
            (candidates.length ||
              similar.length >= 3 ||
              JSON.stringify(args) === JSON.stringify(exactArgs))
          )
            break;
          if (count >= MAX_ROWS || details >= MAX_DETAILS || Date.now() >= deadline) break;
          const query =
            "全服 / 3年以上服 / 综合排序 / " +
            item.name +
            " / " +
            mode +
            " / " +
            JSON.stringify(args);
          queries.push(query);
          itemQueries.push(query);
          exhausted = false;
          lastPage = 0;
          for (
            let pageNumber = 1;
            pageNumber <=
              (mode === "exact" && queryModes.length > 1
                ? 1
                : MAX_PAGES - actualModes.reduce((sum, entry) => sum + entry.pages, 0)) &&
            count < MAX_ROWS &&
            details < MAX_DETAILS &&
            candidates.length + similar.length < 3 &&
            Date.now() < deadline;
            pageNumber++
          ) {
            await pace(requestSignal);
            await searchPage.evaluate(
              ({ args, pageNumber, act }) => {
                const g = window as unknown as Record<string, any>;
                if (g.OverallSearchAct !== act || typeof g.overall_search !== "function")
                  throw new Error("装备查询类别与预期不符");
                g.__cbgEquipmentResult = null;
                g.CurSearchValue.arg = args;
                g.CurSearchValue.order_by = { key: "", sort: "DESC" };
                // Use the page's actual search component; do not save query history or copy credentials.
                g.overall_search(args, pageNumber, g.CurSearchValue.order_by);
              },
              { args, pageNumber, act },
            );
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
                    row?.querySelectorAll<HTMLTextAreaElement>('textarea[id^="equip_desc_"]') || [],
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
                    description: description?.value || image?.getAttribute("data_equip_desc") || "",
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
            lastPage = pageNumber;
            if (listing.empty) {
              exhausted = true;
              break;
            }
            let added = 0,
              pageFullyRead = true;
            const rankedRows = listing.rows
              .map((row) => {
                if (row.name !== item.name) return { row, score: Infinity };
                if (!row.description) return { row, score: 1000 };
                const target = parseEquipmentAttributes(item.description),
                  source = parseEquipmentAttributes(
                    row.description.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, ""),
                  );
                const match = jade ? matchEquipmentAttributes : matchComparableEquipmentAttributes;
                const full = match(target, source),
                  partial = full.reason ? match(target, source, true) : full;
                return {
                  row,
                  score: full.reason ? 500 + partial.similarityScore : full.similarityScore,
                };
              })
              .sort((a, b) => a.score - b.score)
              .map(({ row }) => row);
            for (const [rowIndex, row] of rankedRows.entries()) {
              requestSignal.throwIfAborted();
              const identity = equipmentIdentity(safeEquipmentUrl(row.url));
              if (seen.has(identity)) continue;
              seen.add(identity);
              added++;
              count++;
              if (row.name !== item.name) {
                if (count >= MAX_ROWS) {
                  pageFullyRead = rowIndex === rankedRows.length - 1;
                  break;
                }
                continue;
              }
              const mismatch =
                item.modelId && row.modelId && Number(item.modelId) !== Number(row.modelId)
                  ? "装备型号不匹配"
                  : equipmentListingMismatch(item, row, args);
              if (mismatch) {
                listingRejected.push({ url: row.url, reason: mismatch });
                if (count >= MAX_ROWS) {
                  pageFullyRead = rowIndex === rankedRows.length - 1;
                  break;
                }
                continue;
              }
              if (details >= MAX_DETAILS || Date.now() >= deadline) {
                pageFullyRead = false;
                break;
              }
              details++;
              let candidate: EquipmentCandidate = {
                url: row.url,
                title: row.name,
                price: null,
                priceType: "unknown",
                quote: "",
                verified: false,
                reason: "",
                fetchedAt: null,
                sourceHash: null,
              };
              try {
                const html = await readSource(row.url, requestSignal);
                const text = html
                  .replace(/<[^>]+>/g, "")
                  .replace(/&amp;/g, "&")
                  .replace(/&lt;/g, "<")
                  .replace(/&gt;/g, ">");
                const price = text.match(/挂牌价：¥(\d+(?:\.\d+)?)/)?.[1];
                candidate = {
                  ...candidate,
                  price: price ? Number(price) : null,
                  priceType: "listing",
                  quote: text,
                };
                candidate = verifyEquipmentCandidate(
                  item,
                  candidate,
                  html,
                  new Date().toISOString(),
                );
                if (candidate.verified && candidate.matchType === "similar")
                  similar.push(candidate);
                else if (candidate.verified) candidates.push(candidate);
                else rejected.push(candidate);
              } catch (error) {
                requestSignal.throwIfAborted();
                if (error instanceof Error && /登录|安全验证|频繁|网站繁忙/.test(error.message))
                  throw error;
                rejected.push({
                  ...candidate,
                  reason: error instanceof Error ? error.message : "无法读取装备详情",
                });
                detailFailures.push({
                  url: row.url,
                  reason:
                    error instanceof Error ? error.message.split("\n")[0] : "无法读取装备详情",
                  diagnostics:
                    error && typeof error === "object" && "equipmentDiagnostics" in error
                      ? error.equipmentDiagnostics
                      : null,
                });
              }
              if (count >= MAX_ROWS || candidates.length + similar.length >= 3) {
                pageFullyRead = rowIndex === rankedRows.length - 1;
                break;
              }
            }
            if (!added && mode === "exact") break;
            if (!listing.hasNext) {
              exhausted = pageFullyRead;
              break;
            }
          }
          actualModes.push({ mode, args, pages: lastPage, exhausted });
        }
        const query = itemQueries.join("\n");
        item.query = query;
        const note =
          `已查询${actualModes.reduce((sum, mode) => sum + mode.pages, 0)}页、${count}个列表候选、${details}个详情；` +
          (listingRejected.length ? `列表已排除${listingRejected.length}个配置不符商品；` : "") +
          (exhausted ? "本次筛选结果已读完" : "有限样本查询，未遍历全部在售商品") +
          "。";
        records.push({
          key: item.key,
          act,
          serverAge: "3年以上服",
          args: exactArgs,
          modes: actualModes,
          pages: actualModes.reduce((sum, mode) => sum + mode.pages, 0),
          rows: count,
          details,
          exhausted,
          listingRejected,
          detailFailures,
        });
        results.push({
          key: item.key,
          query,
          searchState:
            candidates.length || similar.length >= 3
              ? "completed"
              : detailFailures.length
                ? "read_failed"
                : Date.now() >= deadline
                  ? "pending"
                  : "completed",
          candidates: [
            ...candidates,
            ...similar.sort((a, b) => (a.similarityScore || 0) - (b.similarityScore || 0)),
            ...rejected,
          ].slice(0, 5),
          note,
        });
      }
      return { queries, items: results, searchItems: records };
    },
  };
}

export async function createEquipmentSource(signal: AbortSignal) {
  signal.throwIfAborted();
  let searchPage: Page | undefined, detailPage: Page | undefined;
  try {
    const browser = await getBrowser();
    signal.throwIfAborted();
    searchPage = await createHiddenPage(browser);
    signal.throwIfAborted();
    detailPage = await createHiddenPage(browser);
    signal.throwIfAborted();
    return equipmentSourceFromPages(searchPage, detailPage, signal);
  } catch (error) {
    await Promise.allSettled([searchPage?.close(), detailPage?.close()]);
    throw error;
  }
}
