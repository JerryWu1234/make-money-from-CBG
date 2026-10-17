import { createHash } from "node:crypto";
import type { SavedRoleRecord } from "../crawler/types";
import type { ValuationResult } from "./valuation-types";
import { compareListingPrice } from "./valuation-calculator";
import {
  inventoryMatchesSnapshot,
  priceMinimum,
  validateExactPricing,
  EQUIPMENT_QUOTE_LIMIT,
  EQUIPMENT_QUOTE_POLICY,
  PRICING_RESUME_POLICY,
  skippedPricingItem,
} from "./pricing-integrity";
import {
  equipmentInitialAttribute,
  equipmentWeaponTotalDamage,
  parseEquipmentAttributes,
} from "./equip-attributes";
import { hasUnconfirmedEmptyEquipment, observedEquipmentCategory } from "../crawler/compact";
import {
  matchComparableEquipmentAttributes,
  matchInitialSearchEquipmentAttributes,
} from "./equipment-match";
import { matchSpecialAsset, SPECIAL_ASSET_MATCH_POLICY } from "./special-asset-match";
import {
  equipmentExclusion,
  validEquipmentExclusion,
  EQUIPMENT_EXCLUSION_POLICY,
  type EquipmentExclusion,
} from "./equipment-exclusion";
import { buildEquipmentEstimate, type SimilarEstimate } from "./pricing-estimate";
import { GLOBAL_MARKET_SCOPE_VERSION, MARKET_SEARCH_UI_VERSION } from "./market-scope";
import {
  slotFromCategory,
  validateEquipmentBaseline,
  type BaselineEstimate,
} from "./equipment-baseline";
import type { ValuationSettings } from "./valuation-types";
import {
  finishPricingSearch,
  reconcilePricingCompletion,
  resumePricingItems,
  saveSearchAttempt,
  type PricingSearchAttempt,
  type PricingSearchState,
} from "./pricing-progress";

export type EquipmentCandidate = {
  url: string;
  title: string;
  price: number | null;
  priceType: "listing" | "unknown";
  quote: string;
  verified: boolean;
  reason: string;
  fetchedAt: string | null;
  sourceHash: string | null;
  differences?: string[];
  matchType?: "exact" | "similar";
  similarityScore?: number;
};
export type EquipmentSearchCursor = {
  version: 1;
  planHash: string;
  modeIndex: number;
  pageNumber: number;
  rowIndex: number;
  pageRowsHash: string;
  restartCount?: number;
  pageHistory?: Array<{ modeIndex: number; pageNumber: number; rowsHash: string }>;
  historyIndex?: number;
  seen: string[];
  failed: Array<{ url: string; modeIndex: number }>;
  emptyFirstPageModes?: number[];
};
export type EquipmentPricingItem = {
  exclusion?: EquipmentExclusion;
  key: string;
  name: string;
  level: number | null;
  category: string;
  kindId?: string;
  modelId?: string;
  description: string;
  query: string;
  status: "priced" | "no_match" | "incomplete" | "untradable" | "unsupported";
  referencePrice: number | null;
  priceMethod?: typeof EQUIPMENT_QUOTE_POLICY | "first-five-average-v3";
  comparisonPolicy?: "base-upper-bound-v1" | "core-initial-first-five-v3";
  candidates: EquipmentCandidate[];
  issues: string[];
  similarEstimate?: SimilarEstimate;
  baselineEstimate?: BaselineEstimate;
  baselineInvalidReason?: string;
  searchState?: PricingSearchState;
  searchCursor?: EquipmentSearchCursor;
  searchFailureCount?: number;
  samplingStopped?: boolean;
  skipReason?: string;
};
export type EquipmentPricingSnapshot = {
  version: 1;
  inputHash: string;
  searchedAt: string;
  provider: "browser" | "codex";
  model: string;
  queries: string[];
  rawResponse: string | null;
  requestText?: string;
  requestHash?: string;
  searchItems?: unknown[];
  usage?: unknown;
  captureComplete: boolean;
  total: number | null;
  knownTotal: number;
  items: EquipmentPricingItem[];
  issues: string[];
  searchComplete?: boolean;
  searchAttempts?: PricingSearchAttempt[];
};
export type EquipmentSource = {
  findCandidates: (
    items: EquipmentPricingItem[],
    signal: AbortSignal,
  ) => Promise<{
    queries: string[];
    items: Array<{
      key: string;
      kindId?: string;
      kindName?: string;
      candidates: EquipmentCandidate[];
      note?: string;
      query?: string;
      searchState?: PricingSearchState;
      searchCursor?: EquipmentSearchCursor;
      skipped?: boolean;
      samplingStopped?: boolean;
      skipReason?: string;
    }>;
    searchItems?: unknown[];
  }>;
  readSource: (url: string, signal: AbortSignal) => Promise<string>;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const normalize = (s: string) => s.replace(/\s|[：:，,]/g, "").toLowerCase();
const levelOf = (description: string, attributes?: Record<string, string>) => {
  const level =
    description.match(/(?:^|[\n\s【：:])等级\s*[：:]?\s*(\d{1,3})/)?.[1] || attributes?.等级;
  return level && /^\d+$/.test(level) ? Number(level) : null;
};

export const isJewelryEquipment = (
  item: Pick<EquipmentPricingItem, "category" | "description" | "kindId">,
) =>
  /灵饰|戒指|耳饰|手镯|佩饰|配饰/.test(item.category) ||
  /精炼等级/.test(item.description) ||
  [61, 62, 63, 64].includes(Number(item.kindId));

export const EQUIPMENT_CORE_INITIAL_POLICY = "required-slot-initial-hit4-first-five-tolerance2-v4";
export const EQUIPMENT_WEAPON_QUERY_POLICY = "raw-initial-and-total-damage-fields-v1";
export const EQUIPMENT_CORE_INITIAL_TOLERANCE = 2;
/** The core field validates form/detail values; the label selects the confirmed public sort header. */
export function equipmentCoreInitial(
  item: Pick<EquipmentPricingItem, "category" | "description" | "kindId">,
  category = item.category,
) {
  if (isJewelryEquipment(item) || /元身|上古玉魄/.test(category)) return null;
  const slot = slotFromCategory(category) || (/双环|魔棒|伞|棍/.test(category) ? "weapon" : null);
  if (!slot) return null;
  const [field, control, label] = {
    weapon: ["伤害", "init_damage_raw", "初伤"],
    body: ["防御", "init_defense", "初防"],
    head: ["防御", "init_defense", "初防"],
    shoe: ["敏捷", "init_dex", "初敏"],
    neck: ["灵力", "init_wakan", "初灵"],
    belt: ["气血", "init_hp", "初血"],
  }[slot];
  const attributes = parseEquipmentAttributes(item.description);
  const value = equipmentInitialAttribute(attributes, field);
  const combinedValue = slot === "weapon" ? equipmentWeaponTotalDamage(attributes) : null;
  return value === null
    ? null
    : { field, control, label, value, ...(combinedValue === null ? {} : { combinedValue }) };
}

export function equipmentCoreMismatch(
  item: EquipmentPricingItem,
  source: ReturnType<typeof parseEquipmentAttributes>,
  partial = false,
) {
  if (item.comparisonPolicy !== "core-initial-first-five-v3") return null;
  const core = equipmentCoreInitial(item);
  if (!core) return "目标核心初始属性未确认";
  const value = equipmentInitialAttribute(source, core.field, partial);
  if (value === null && partial) return null;
  if (value === null || value < core.value || value > core.value + EQUIPMENT_CORE_INITIAL_TOLERANCE)
    return `报价${core.label}${value ?? "未知"}不在目标${core.value}至${core.value + EQUIPMENT_CORE_INITIAL_TOLERANCE}范围内`;
  if (core.combinedValue !== undefined) {
    const combined = equipmentWeaponTotalDamage(source, partial);
    if (combined === null && partial) return null;
    if (
      combined === null ||
      combined < core.combinedValue ||
      combined > core.combinedValue + EQUIPMENT_CORE_INITIAL_TOLERANCE
    )
      return `报价总伤（初伤+命中÷4）${combined ?? "未知"}不在目标${core.combinedValue}至${core.combinedValue + EQUIPMENT_CORE_INITIAL_TOLERANCE}范围内`;
  }
  return null;
}
const unidentifiedEquipmentDescription = (description: string) =>
  description.split("\n").some((line) => line.trim() === "未鉴定物品");

/** Unknown inventory categories defer to the observed official search kind. */
export function equipmentCoreSkipReason(
  item: Pick<EquipmentPricingItem, "category" | "description" | "kindId">,
  category = item.category,
): string | null {
  if (isJewelryEquipment(item) || /元身|上古玉魄/.test(category)) return null;
  const unidentified = unidentifiedEquipmentDescription(item.description);
  const slot = slotFromCategory(category) || (/双环|魔棒|伞|棍/.test(category) ? "weapon" : null);
  if (!slot)
    return unidentified ? "未鉴定装备核心初始属性未知，未计入参考合计；市场售价未知" : null;
  const field = {
    weapon: "伤害",
    body: "防御",
    head: "防御",
    shoe: "敏捷",
    neck: "灵力",
    belt: "气血",
  }[slot];
  return unidentified ||
    equipmentInitialAttribute(parseEquipmentAttributes(item.description), field) === null
    ? "核心初始" + field + "无法可靠还原，未计入参考合计；市场售价未知"
    : null;
}

/** The two observed public sliders have independent steps; jade has no equipment level. */
export function equipmentLevelUnsupportedReason(
  item: Pick<EquipmentPricingItem, "category" | "description" | "kindId" | "level">,
) {
  if (item.category === "上古玉魄" || item.category === "元身" || item.level === null) return null;
  const jewelry = isJewelryEquipment(item),
    minimum = 60,
    maximum = 160,
    step = jewelry ? 20 : 10;
  if (
    Number.isInteger(item.level) &&
    item.level >= minimum &&
    item.level <= maximum &&
    (item.level - minimum) % step === 0
  )
    return null;
  return (
    "官网" +
    (jewelry ? "灵饰" : "装备") +
    "检索范围为" +
    minimum +
    "至" +
    maximum +
    "级、步长" +
    step +
    "级，" +
    item.level +
    "级" +
    (jewelry ? "灵饰" : "装备") +
    "尚缺可用查询入口和可靠报价"
  );
}

/** Only owned role equipment, not skills, artifacts, consumables or pet gear. */
export function equipmentInventory(record: SavedRoleRecord, settings?: ValuationSettings) {
  const tabs = record.detail?.tabs.filter((tab) => /^道具\/法宝(?:\s*\/|$)/.test(tab.name)) || [];
  const items: EquipmentPricingItem[] = [];
  const locations = new Map<string, string>();
  const unidentified = new Map<string, string>();
  const inventoryIssues: string[] = [];
  for (const tab of tabs)
    for (const item of tab.items || []) {
      const details =
        [...new Set([item.description, item.tooltip].filter(Boolean))].join("\n") ||
        Object.entries(item.attributes || {})
          .filter(([key]) => key !== "装备")
          .map(([key, value]) => key + "：" + value)
          .join("\n");
      const observed = parseEquipmentAttributes(details);
      const restrictions = Object.entries(item.attributes || {})
        .filter(([key]) => /^(?:装备角色|装备对象|装备条件|使用条件|门派条件|部位条件)$/.test(key))
        .filter(
          ([key, value]) =>
            !Object.hasOwn(observed.fields, key) &&
            !(observed.fields.符石组合 || []).some(
              (line) => normalize(line) === normalize(key + "：" + value),
            ),
        )
        .map(([key, value]) => key + "：" + value);
      const description = [details, ...restrictions].filter(Boolean).join("\n");
      const observedCategory =
        observedEquipmentCategory(item.category, item.location, item.modelId) || "";
      const yuanshen = /(?:^|[·/\s])元身(?:$|[·/\s])/.test(observedCategory);
      const category = yuanshen ? "元身" : observedCategory;
      if (item.kind === "skill" || item.kind === "innerSkill") continue;
      if (/法宝|灵宝|神器|道具|材料|消耗品|召唤兽装备/.test(category)) continue;
      const level = category === "上古玉魄" ? null : levelOf(description, item.attributes);
      const equipment =
        yuanshen ||
        /人物装备|灵饰|武器|头盔|衣服|项链|腰带|鞋|上古玉魄/.test(category) ||
        (level !== null &&
          level >= 0 &&
          (/伤害|防御|灵力|敏捷|速度|气血|封印|治疗/.test(description) ||
            (item.kind === "equipment" && unidentifiedEquipmentDescription(description))));
      if (/装备对象[：:]?\s*召唤兽|【?携带/.test(description)) continue;
      if (!equipment) {
        if (item.kind === "equipment")
          inventoryIssues.push(item.name + "的物品类别或装备属性未识别，不能当作没有装备");
        continue;
      }
      const signature = hash(JSON.stringify({ name: item.name, description, category }));
      if (item.location) {
        const location = item.location + ":" + signature;
        const firstTab = locations.get(location);
        if (firstTab && firstTab !== tab.name) {
          if (
            /槽位|slot|position|装备位/i.test(item.location) ||
            /^role_using_equip_(?:[1-6]|18[7-9]|190)$/.test(item.location)
          )
            continue;
          inventoryIssues.push(item.name + "在多页同一容器重复显示，需核对实际件数");
        }
        locations.set(location, tab.name);
      } else {
        const firstTab = unidentified.get(signature);
        if (firstTab && firstTab !== tab.name)
          inventoryIssues.push(item.name + "在多页重复显示且缺来源位置，需要核对是否同一件");
        unidentified.set(signature, tab.name);
      }
      const key = tab.name + ":" + item.index;
      const issues: string[] = [];
      if (!yuanshen && category !== "上古玉魄" && level === null) issues.push("装备等级缺失");
      if (!description.trim()) issues.push("装备属性未采齐");
      for (const issue of record.detail?.equipmentCapture?.issues || [])
        if (issue.startsWith(tab.name + "：" + item.name + " ") && /属性|等级|JSON/.test(issue))
          issues.push(issue);
      const inferred = category || (/精炼等级/.test(description) ? "灵饰" : "人物装备");
      const levelUnsupported = equipmentLevelUnsupportedReason({
        category: inferred,
        description,
        level,
        kindId: item.kindId,
      });
      const coreSkipReason = issues.length
        ? null
        : equipmentCoreSkipReason({
            category: inferred,
            description,
            kindId: item.kindId,
          });
      const unsupported = !!levelUnsupported || !!coreSkipReason;
      if (levelUnsupported) issues.push(levelUnsupported);
      const query =
        "梦幻西游 藏宝阁 " +
        item.name +
        " " +
        (level ?? "") +
        "级 " +
        description.replace(/\n/g, " ").slice(0, 320);
      const dedicated = /玩家\s*\d+\s*专用|专用|不可交易|不能交易|绑定/.test(description);
      items.push({
        key,
        priceMethod: EQUIPMENT_QUOTE_POLICY,
        name: item.name,
        level,
        category: inferred,
        ...(failureBudgetApplies({ category: inferred })
          ? {
              comparisonPolicy: equipmentCoreInitial({
                category: inferred,
                description,
                kindId: item.kindId,
              })
                ? ("core-initial-first-five-v3" as const)
                : ("base-upper-bound-v1" as const),
            }
          : {}),
        ...(item.kindId ? { kindId: item.kindId } : {}),
        ...(item.modelId ? { modelId: item.modelId } : {}),
        description,
        query,
        status: dedicated
          ? "untradable"
          : unsupported
            ? "unsupported"
            : issues.length
              ? "incomplete"
              : "no_match",
        referencePrice: null,
        ...(dedicated || unsupported
          ? {
              searchState: "skipped" as const,
              skipReason: dedicated
                ? "专用或绑定装备，未计入参考合计"
                : levelUnsupported
                  ? "官网检索不支持的等级装备，未计入参考合计"
                  : coreSkipReason!,
            }
          : {}),
        candidates: [],
        issues: dedicated ? ["专用或绑定装备不能套用可交易装备价格"] : issues,
      });
    }
  const capture = record.detail?.equipmentCapture;
  const issues = [...(capture?.issues || []), ...inventoryIssues];
  if (!capture || capture.version !== 1)
    issues.push("需要重新补采当前装备，旧详情不证明装备已采齐");
  if (!tabs.some((tab) => tab.name === "道具/法宝")) issues.push("缺少道具/法宝页");
  if (!items.length && hasUnconfirmedEmptyEquipment(record.detail))
    issues.push("人物装备库存是否为空尚未核对，需要自动补采装备区域");
  const captureComplete =
    !!capture?.complete && tabs.some((tab) => tab.name === "道具/法宝") && !issues.length;
  if (settings?.pricingScope === "equipment")
    for (const item of items)
      if (isJewelryEquipment(item) && item.status !== "incomplete") {
        item.searchState = "skipped";
        item.skipReason = "本轮先分析人物装备；灵饰待查，未计入参考合计，市场售价未知";
      }
  if (settings?.deferJade)
    for (const item of items)
      if (item.category === "上古玉魄") {
        item.searchState = "skipped";
        item.skipReason = "用户确认本轮上古玉魄待查，未计入参考合计，市场售价未知";
      }
  const inputHash = hash(
    JSON.stringify({
      pricingScope: settings?.pricingScope || "all",
      ...(settings?.deferJade && items.some((item) => item.category === "上古玉魄")
        ? { deferJade: true }
        : {}),
      scopeVersion: GLOBAL_MARKET_SCOPE_VERSION,
      searchUI: MARKET_SEARCH_UI_VERSION,
      comparisonVersion: "core-initial-sorted-first-five-tolerance2-v9",
      coreInitialPolicy: EQUIPMENT_CORE_INITIAL_POLICY,
      ...(items.some(
        (item) =>
          !isJewelryEquipment(item) &&
          equipmentWeaponTotalDamage(parseEquipmentAttributes(item.description)) !== null,
      )
        ? { weaponQueryPolicy: EQUIPMENT_WEAPON_QUERY_POLICY }
        : {}),
      specialAssetPolicy: SPECIAL_ASSET_MATCH_POLICY,
      exclusionPolicy: EQUIPMENT_EXCLUSION_POLICY,
      queryPolicy: EQUIPMENT_QUOTE_POLICY,
      resumePolicy: PRICING_RESUME_POLICY,
      serverId: record.listing.serverId,
      collectedAt: capture?.collectedAt,
      captureComplete,
      issues,
      items: items.map(
        ({ key, name, level, category, kindId, modelId, description, comparisonPolicy }) => ({
          key,
          name,
          level,
          category,
          ...(kindId ? { kindId } : {}),
          ...(modelId ? { modelId } : {}),
          description,
          ...(comparisonPolicy ? { comparisonPolicy } : {}),
        }),
      ),
    }),
  );
  return { items, issues, captureComplete, inputHash };
}

export const EQUIPMENT_SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "candidates", "note"],
        properties: {
          key: { type: "string" },
          note: { type: "string" },
          candidates: {
            type: "array",
            maxItems: EQUIPMENT_QUOTE_LIMIT,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["url", "title", "price", "priceType", "quote"],
              properties: {
                url: { type: "string" },
                title: { type: "string" },
                price: { type: ["number", "null"] },
                priceType: { type: "string", enum: ["listing", "unknown"] },
                quote: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
};
export function safeEquipmentUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    !["xyq.cbg.163.com", "xyq-m.cbg.163.com"].includes(url.hostname) ||
    !(/\/equip(?:\/|$)/.test(url.pathname) || /\/(?:equipquery|query)\.py$/.test(url.pathname))
  )
    throw new Error("仅核对官方藏宝阁独立商品链接");
  if (
    !url.searchParams.has("eid") &&
    !url.searchParams.has("equip_id") &&
    !url.searchParams.has("ordersn") &&
    !/\/equip\/[^/]+\/[^/]+/.test(url.pathname)
  )
    throw new Error("查价链接缺少具体商品ID");
  return url.href;
}
export function equipmentIdentity(value: string) {
  const url = new URL(value);
  const path = url.pathname.match(/\/equip\/([^/]+)\/([^/]+)\/?$/);
  if (path) return decodeURIComponent(path[1]) + ":" + decodeURIComponent(path[2]);
  const id =
    url.searchParams.get("eid") ||
    url.searchParams.get("equip_id") ||
    url.searchParams.get("ordersn");
  const server =
    url.searchParams.get("s") ||
    url.searchParams.get("serverid") ||
    url.searchParams.get("server_id") ||
    "";
  return id ? `${server}:${id}` : url.pathname;
}
export function pageText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\b[^>]*>|<\/(?:p|div|li|tr|pre|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}
export function productSource(html: string) {
  // Prefer a single product region; unrelated recommendations cannot supply its price.
  const primary = html.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i)?.[2];
  return primary || html.replace(/<(aside|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
}
export function listingPrices(text: string) {
  return [
    ...text.matchAll(
      /(?:[¥￥]\s*|(?:价格|售价|挂牌价)\s*[：:]?\s*[¥￥]?\s*)([\d,]+(?:\.\d{1,2})?)/g,
    ),
  ].map((match) => Number(match[1].replace(/,/g, "")));
}
export async function readEquipmentSource(url: string, signal: AbortSignal) {
  const response = await fetch(safeEquipmentUrl(url), {
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    redirect: "error",
    credentials: "omit",
  });
  if (!response.ok) throw new Error("来源网页读取失败：" + response.status);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 2 * 1024 * 1024) throw new Error("来源页面过大");
  return new TextDecoder("utf-8").decode(bytes);
}

/** Verify the primary-product price and exact or comparable attributes against the read page. */
export function verifyEquipmentCandidate(
  item: EquipmentPricingItem,
  candidate: EquipmentCandidate,
  html: string,
  fetchedAt: string,
): EquipmentCandidate {
  const primary = productSource(html);
  const text = pageText(primary),
    normalized = normalize(text);
  const reject = (reason: string) => ({
    ...candidate,
    verified: false,
    reason,
    fetchedAt,
    sourceHash: hash(text),
  });
  if (
    candidate.priceType !== "listing" ||
    candidate.price === null ||
    !Number.isFinite(candidate.price) ||
    candidate.price <= 0 ||
    candidate.price > 1e9
  )
    return reject("不是可核对的挂牌人民币价格");
  if (/商品已下架|商品已售出|商品不存在|安全验证|请先登录/.test(text))
    return reject("来源不可用、需要登录或已下架");
  if (/角色编号|人物修炼|召唤兽修炼|角色等级/.test(text))
    return reject("这是角色总价页面，不能充当单件装备报价");
  const targetAttributes = parseEquipmentAttributes(item.description);
  const sourceAttributes = parseEquipmentAttributes(text);
  const sourceModel = html.match(/data-cbg-model-id=["'](\d+)["']/)?.[1];
  const sourceKind = html.match(/data-cbg-kind-id=["'](\d+)["']/)?.[1];
  const jade = item.category === "上古玉魄";
  const yuanshen = item.category === "元身";
  const sameOrdinaryKind =
    failureBudgetApplies(item) &&
    /^[1-9]\d*$/.test(item.kindId || "") &&
    item.kindId === sourceKind;
  const sourceName = pageText(primary.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "").trim();
  if (
    failureBudgetApplies(item) &&
    sourceName &&
    normalize(sourceName) !== normalize(item.name) &&
    !sameOrdinaryKind
  )
    return reject("主商品名称不同且缺少相同官方种类证据");
  const targetModel =
    item.modelId || (jade ? { 上古玉魄·阴: "61717", 上古玉魄·阳: "61718" }[item.name] : undefined);
  if (
    (!sameOrdinaryKind &&
      targetModel &&
      sourceModel &&
      Number(targetModel) !== Number(sourceModel)) ||
    (item.kindId && sourceKind && Number(item.kindId) !== Number(sourceKind))
  )
    return reject("官方装备类型或型号不匹配");
  if (
    (!sameOrdinaryKind && !normalized.includes(normalize(item.name))) ||
    (!jade && !yuanshen && (item.level === null || sourceAttributes.level !== item.level)) ||
    (jade && (!targetModel || sourceModel !== targetModel))
  )
    return reject("名称、等级或玉魄类型不匹配");
  const durability = (text: string) => text.match(/耐久(?:度)?\s*[：:]?\s*(\d+)/)?.[1];
  const targetDurability = durability(item.description),
    sourceDurability = durability(text);
  if (
    targetDurability !== undefined &&
    (sourceDurability === undefined ||
      (Number(targetDurability) === 0) !== (Number(sourceDurability) === 0))
  )
    return reject("耐久破损状态不匹配，0耐久只能采用同为0耐久的独立报价");
  if (!jade && targetDurability !== undefined && Number(targetDurability) === 0) {
    const targetFailures = targetAttributes.fields.修理失败,
      sourceFailures = sourceAttributes.fields.修理失败;
    if (
      targetFailures?.length !== 1 ||
      sourceFailures?.length !== 1 ||
      !/^\d+\s*次?$/.test(targetFailures[0]) ||
      !/^\d+\s*次?$/.test(sourceFailures[0])
    )
      return reject("0耐久装备需要双方明确的修理失败次数，不能推断破损程度");
    if (parseInt(targetFailures[0], 10) !== parseInt(sourceFailures[0], 10))
      return reject("0耐久装备的修理失败次数不一致，不能作为相近参考");
  }
  const specialDescription = html.match(
    /<pre\b[^>]*data-cbg-equipment-description[^>]*>([\s\S]*?)<\/pre>/i,
  )?.[1];
  if ((jade || yuanshen) && !specialDescription) return reject("玉魄/元身完整属性描述尚未读取");
  const coreMismatch = equipmentCoreMismatch(item, sourceAttributes);
  if (coreMismatch) return reject(coreMismatch);
  const match =
    jade || yuanshen
      ? matchSpecialAsset(item, pageText(specialDescription!))
      : item.comparisonPolicy === "core-initial-first-five-v3"
        ? matchInitialSearchEquipmentAttributes(targetAttributes, sourceAttributes)
        : matchComparableEquipmentAttributes(targetAttributes, sourceAttributes);
  if (match.reason) return reject(match.reason);
  if (
    match.matchType === "similar" &&
    !(targetModel && sourceModel && Number(targetModel) === Number(sourceModel)) &&
    !(item.kindId && sourceKind && Number(item.kindId) === Number(sourceKind))
  )
    return reject("相近报价缺少可核对的官方装备类型证据");
  if (!candidate.quote || !normalize(text).includes(normalize(candidate.quote)))
    return reject("候选引用不能在读取的网页逐字核对");
  const prices = [...new Set(listingPrices(text))];
  if (!listingPrices(candidate.quote).includes(candidate.price))
    return reject("引用缺少与该装备对应的挂牌价格");
  if (prices.length !== 1) return reject("来源出现多件商品价格，无法确认主商品挂牌价");
  if (!prices.includes(candidate.price)) return reject("网页价格与候选价格不一致");
  if (!/上架中|在售|公示中|公示期/.test(text)) return reject("无法确认当前在售状态");
  return {
    ...candidate,
    ...(sourceName ? { title: sourceName.slice(0, 300) } : {}),
    verified: true,
    matchType: match.matchType || "exact",
    similarityScore: match.similarityScore,
    reason:
      match.matchType === "similar"
        ? "网页价格已核对；配置相近，差异已列出"
        : "网页价格与关键属性已核对",
    fetchedAt,
    sourceHash: hash(text),
    differences: [
      ...match.differences,
      ...(targetDurability !== sourceDurability && targetDurability !== undefined
        ? ["耐久不同：当前" + targetDurability + "，报价" + sourceDurability + "；未推测折扣"]
        : []),
    ],
  };
}

export type Search = (
  prompt: string,
  schema: unknown,
  signal: AbortSignal,
) => Promise<{ text: string; queries: string[]; searchItems?: unknown[]; usage?: unknown }>;
/** Each tradable equipment item uses current market quotations; presets do not skip search. */
export function equipmentPricingPlan(
  record: SavedRoleRecord,
  settings?: ValuationSettings,
): EquipmentPricingSnapshot {
  const inventory = equipmentInventory(record, settings);
  const snapshot: EquipmentPricingSnapshot = {
    version: 1,
    inputHash: inventory.inputHash,
    searchedAt: new Date().toISOString(),
    provider: "browser",
    model: "browser",
    queries: [],
    rawResponse: null,
    captureComplete: inventory.captureComplete,
    total: null,
    knownTotal: 0,
    items: inventory.items.map((item) => ({ ...item, query: "" })),
    issues: inventory.issues,
  };
  return snapshot;
}
/** Partial captures may price complete items, but ambiguous inventory must be recaptured. */
export function equipmentCaptureSearchable(
  record: SavedRoleRecord,
  snapshot: EquipmentPricingSnapshot,
) {
  const capture = record.detail?.equipmentCapture;
  return (
    capture?.version === 1 &&
    (snapshot.captureComplete || snapshot.issues.length > 0) &&
    !snapshot.issues.some((issue) => /重复显示|实际件数|核对是否同一件/.test(issue))
  );
}

export type PricingSearchProgress = {
  assetName: string;
  page: number;
  validSamples: number;
  retryCount: number;
};

const accessFailure = (message: string) =>
  /登录|验证码|安全验证|人机验证|权限|禁止|频繁|网站繁忙|系统繁忙|未采用报价|报价未采用|三年以上服|unauthorized|unauthenticated|forbidden|permission denied|security|policy|captcha\b/i.test(
    message,
  );
const failureBudgetApplies = (item: Pick<EquipmentPricingItem, "category">) =>
  !/上古玉魄|元身|精魄/.test(item.category);

const quoteCandidates = (item: EquipmentPricingItem) =>
  item.candidates.filter(
    (candidate) =>
      candidate.verified &&
      (item.comparisonPolicy === "base-upper-bound-v1" ||
        item.comparisonPolicy === "core-initial-first-five-v3" ||
        candidate.matchType !== "similar"),
  );

function skipFailedEquipment(item: EquipmentPricingItem, reason: string) {
  Object.assign(item, {
    searchState: "skipped",
    status: "no_match",
    referencePrice: null,
    candidates: [],
    skipReason: reason,
  });
  for (const key of [
    "similarEstimate",
    "baselineEstimate",
    "baselineInvalidReason",
    "exclusion",
    "searchCursor",
    "samplingStopped",
  ] as const)
    delete item[key];
}

export async function searchEquipmentPrices(
  record: SavedRoleRecord,
  signal: AbortSignal,
  source: EquipmentSource,
  settings?: ValuationSettings,
  previous?: EquipmentPricingSnapshot,
  onCheckpoint?: (snapshot: EquipmentPricingSnapshot) => void,
): Promise<EquipmentPricingSnapshot> {
  const snapshot = resumePricingItems(equipmentPricingPlan(record, settings), previous, true);
  signal.throwIfAborted();
  if (previous?.inputHash === snapshot.inputHash) {
    for (const item of snapshot.items) {
      const saved = previous.items.find((value) => value.key === item.key);
      if (!saved?.searchFailureCount || !failureBudgetApplies(item)) continue;
      item.searchFailureCount = saved.searchFailureCount;
      if (saved.searchFailureCount >= 2 && item.searchState !== "skipped")
        skipFailedEquipment(
          item,
          saved.skipReason || "装备查价累计失败2次，已跳过，未计入参考合计；市场售价未知",
        );
      snapshot.searchItems ||= structuredClone(previous.searchItems || []);
      snapshot.searchAttempts ||= structuredClone(previous.searchAttempts || []);
    }
  }
  if (!equipmentCaptureSearchable(record, snapshot)) {
    for (const item of snapshot.items) {
      item.searchState = undefined;
      item.searchCursor = undefined;
    }
    return finishPricingSearch(snapshot);
  }
  const searchable = snapshot.items.filter((item) => item.searchState === "pending");
  if (!searchable.length) return finishPricingSearch(snapshot);
  const lookupItems = searchable.map((item) => ({
    ...item,
    candidates: item.candidates.filter((candidate) => candidate.verified),
    issues: [...item.issues],
  }));
  snapshot.requestText = snapshot.requestText
    ? JSON.stringify({ ...JSON.parse(snapshot.requestText), lookupItems })
    : JSON.stringify(lookupItems);
  snapshot.requestHash = hash(snapshot.requestText);
  const batches = onCheckpoint ? searchable.map((item) => [item]) : [searchable];
  for (const batch of batches) {
    const response = await source.findCandidates(
      lookupItems.filter((item) => batch.some((entry) => entry.key === item.key)),
      signal,
    );
    signal.throwIfAborted();
    await applyEquipmentSearchResponse(
      snapshot,
      batch,
      response,
      source,
      signal,
      record.listing.serverId,
    );
    let retryAfterFailure = false;
    for (const item of batch) {
      const result = response.items?.find((value) => value.key === item.key);
      if (result?.skipped || item.searchState !== "read_failed") continue;
      const reason =
        [
          result?.note?.split("；")[0],
          ...item.candidates
            .filter((candidate) => !candidate.verified)
            .map((candidate) => candidate.reason),
        ]
          .filter(Boolean)
          .join("；") || "装备查询或详情读取失败";
      if (accessFailure(reason)) throw new Error(reason);
      if (!failureBudgetApplies(item)) continue;
      item.searchFailureCount = (item.searchFailureCount || 0) + 1;
      item.referencePrice = null;
      item.status = "no_match";
      if (item.searchFailureCount >= 2)
        skipFailedEquipment(
          item,
          "装备查价累计失败2次，已跳过，未计入参考合计；市场售价未知：" + reason,
        );
      else {
        item.searchState = "pending";
        retryAfterFailure = true;
      }
    }
    finishPricingSearch(snapshot);
    onCheckpoint?.(snapshot);
    if (retryAfterFailure || batch.some((item) => item.searchState === "read_failed")) break;
  }
  return finishPricingSearch(snapshot);
}

async function applyEquipmentSearchResponse(
  snapshot: EquipmentPricingSnapshot,
  searchable: EquipmentPricingItem[],
  response: Awaited<ReturnType<EquipmentSource["findCandidates"]>>,
  source: EquipmentSource,
  signal: AbortSignal,
  serverId: string,
) {
  snapshot.rawResponse = JSON.stringify(response);
  saveSearchAttempt(snapshot, response);
  // A local exclusion needs no market request and must never adopt returned candidates.
  for (const item of searchable) {
    const result = Array.isArray(response.items)
      ? response.items.find((entry) => entry?.key === item.key)
      : undefined;
    if (
      result?.searchState !== "skipped" ||
      typeof result.skipReason !== "string" ||
      !result.skipReason.trim()
    )
      continue;
    Object.assign(item, {
      searchState: "skipped",
      status: "unsupported",
      skipReason: result.skipReason,
      referencePrice: null,
      candidates: [],
    });
    for (const key of [
      "similarEstimate",
      "baselineEstimate",
      "baselineInvalidReason",
      "exclusion",
      "searchCursor",
      "samplingStopped",
    ] as const)
      delete item[key];
  }
  if (searchable.every((item) => item.searchState === "skipped"))
    return finishPricingSearch(snapshot);
  if (!response.queries.some((query) => query.trim())) {
    if (
      Array.isArray(response.items) &&
      response.items.length &&
      response.items.every((item) => item.skipped === true)
    )
      return finishPricingSearch(snapshot);
    for (const item of searchable) {
      const result = Array.isArray(response.items)
        ? response.items.find((entry) => entry?.key === item.key)
        : undefined;
      if (!result || result.skipped === true) continue;
      if (result.searchState === "unsupported") {
        item.searchState = "unsupported";
        item.status = "unsupported";
        item.issues.push(result.note || "查询入口不支持此装备");
      } else if (result.searchState === "read_failed") {
        item.searchState = "read_failed";
        if (typeof result.note === "string" && result.note.trim())
          item.issues.push(result.note.slice(0, 500));
      }
    }
    if (
      !Array.isArray(response.items) ||
      !response.items.length ||
      response.items.some(
        (item) => item.searchState !== "read_failed" || item.candidates.length > 0,
      )
    )
      snapshot.issues.push("本次检索没有实际查询记录，返回价格未采纳");
    return finishPricingSearch(snapshot);
  }
  if (!Array.isArray(response.items) || response.items.length > 100) {
    snapshot.issues.push("查价结果格式错误");
    return finishPricingSearch(snapshot);
  }
  const results = new Map<string, Record<string, unknown>>();
  for (const entry of response.items) {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.key !== "string" ||
      !searchable.some((item) => item.key === entry.key) ||
      results.has(entry.key)
    ) {
      snapshot.issues.push("查价结果有未知或重复的装备ID");
      return finishPricingSearch(snapshot);
    }
    results.set(entry.key, entry);
  }
  const pages = new Map<string, Promise<string>>();
  for (const item of searchable) {
    const result = results.get(item.key);
    if (
      !result ||
      !Array.isArray(result.candidates) ||
      result.candidates.length > EQUIPMENT_QUOTE_LIMIT
    ) {
      item.issues.push("未返回该装备的有效候选");
      continue;
    }
    // Untouched items keep their earlier cursor/quotations; they were not re-read this round.
    if (result.skipped === true || item.searchState === "skipped") continue;
    if (
      result.kindId !== undefined &&
      (typeof result.kindId !== "string" || !/^[1-9]\d*$/.test(result.kindId))
    )
      throw new Error("官网查询装备种类无效，未采用报价");
    if (item.kindId && result.kindId && Number(item.kindId) !== Number(result.kindId))
      throw new Error("官网查询装备种类与库存不一致，未采用报价");
    let target =
      !item.kindId && result.kindId ? { ...item, kindId: result.kindId as string } : item;
    if (result.kindName !== undefined) {
      if (
        typeof result.kindName !== "string" ||
        !result.kindName.trim() ||
        result.kindName.length > 80 ||
        !result.kindId
      )
        throw new Error("官网查询装备类型名称无效，未采用报价");
      const resolved = { ...target, category: result.kindName };
      if (!isJewelryEquipment(item) && equipmentCoreInitial(resolved))
        target = { ...resolved, comparisonPolicy: "core-initial-first-five-v3" };
    }
    item.query = typeof result.query === "string" ? result.query : "";
    item.searchCursor = result.searchCursor as EquipmentSearchCursor | undefined;
    item.samplingStopped = result.samplingStopped === true;
    item.candidates = [];
    item.searchState = ["pending", "read_failed", "unsupported"].includes(
      String(result.searchState),
    )
      ? (result.searchState as PricingSearchState)
      : "completed";
    if (item.searchState === "unsupported") item.status = "unsupported";
    if (typeof result.note === "string" && result.note.trim())
      item.issues.push(result.note.slice(0, 500));
    const urls = new Map<string, number | null>();
    let readFailed = false;
    for (const raw of result.candidates) {
      if (
        !raw ||
        typeof raw !== "object" ||
        typeof raw.url !== "string" ||
        typeof raw.title !== "string" ||
        typeof raw.quote !== "string" ||
        raw.quote.length > 2000 ||
        raw.url.length > 2000
      )
        continue;
      let candidate: EquipmentCandidate = {
        url: raw.url,
        title: raw.title.slice(0, 300),
        price: typeof raw.price === "number" && Number.isFinite(raw.price) ? raw.price : null,
        priceType: raw.priceType === "listing" ? "listing" : "unknown",
        quote: raw.quote,
        verified: false,
        reason: "",
        fetchedAt: null,
        sourceHash: null,
      };
      let readingSource = false;
      try {
        const url = safeEquipmentUrl(candidate.url);
        const identity = equipmentIdentity(url);
        if (identity.split(":")[0] !== String(serverId))
          throw new Error("候选所属服务器与角色服务器不一致，未采用报价");
        if (urls.has(identity)) {
          if (urls.get(identity) !== candidate.price) {
            readFailed = true;
            item.candidates.push({ ...candidate, reason: "同一商品的报价冲突，需要重新读取" });
          }
          continue;
        }
        urls.set(identity, candidate.price);
        candidate.url = url;
        readingSource = true;
        if (!pages.has(identity)) pages.set(identity, source.readSource(url, signal));
        candidate = verifyEquipmentCandidate(
          target,
          candidate,
          await pages.get(identity)!,
          new Date().toISOString(),
        );
      } catch (error) {
        signal.throwIfAborted();
        candidate.reason = error instanceof Error ? error.message : "无法核对来源";
        if (accessFailure(candidate.reason)) throw error;
        readFailed ||= readingSource;
      }
      item.candidates.push(candidate);
    }
    if (readFailed) item.searchState = "read_failed";
    const unified =
      item.comparisonPolicy === "base-upper-bound-v1" ||
      item.comparisonPolicy === "core-initial-first-five-v3";
    if (!unified) {
      const closest = item.candidates
        .filter((candidate) => candidate.verified && candidate.matchType === "similar")
        .slice(0, EQUIPMENT_QUOTE_LIMIT);
      // Legacy comparable estimates retain their separate cohort.
      item.candidates = [
        ...closest,
        ...item.candidates.filter(
          (candidate) => !candidate.verified || candidate.matchType !== "similar",
        ),
      ];
    } else delete item.similarEstimate;
    const verified = quoteCandidates(item);
    reconcilePricingCompletion(item, snapshot.searchItems);
    if (verified.length >= 1 && item.searchState === "completed") {
      item.referencePrice = priceMinimum(
        verified.slice(0, EQUIPMENT_QUOTE_LIMIT).map((candidate) => candidate.price!),
      );
      item.status = "priced";
      item.searchState = "completed";
      if (verified.length === 1) item.issues.push("仅1条挂牌样本，参考范围有限");
      if (verified.length < EQUIPMENT_QUOTE_LIMIT)
        item.issues.push(
          `已核实${verified.length}件${item.comparisonPolicy === "core-initial-first-five-v3" ? "前5条中核心初始值在目标至目标+2范围内的" : unified ? "基础属性≤目标的合格" : "同配置"}在售商品，最多${EQUIPMENT_QUOTE_LIMIT}件，参考价取有效样本最低挂牌价`,
        );
    } else {
      if (!unified) item.similarEstimate = buildEquipmentEstimate(item.candidates);
      if (verified.length)
        item.issues.push(
          `已核实${verified.length}件${item.comparisonPolicy === "core-initial-first-five-v3" ? "前5条中核心初始值在目标至目标+2范围内的" : unified ? "基础属性≤目标的合格" : "同配置"}商品，继续完成排序后前${EQUIPMENT_QUOTE_LIMIT}条的核验`,
        );
      item.issues.push(
        item.similarEstimate?.status === "range"
          ? "暂无完全同配置报价，采用已核验相近装备样本最低挂牌价作为参考价，并保留报价范围和配置差异"
          : item.comparisonPolicy === "core-initial-first-five-v3"
            ? "核心初始值在目标至目标+2范围内的可靠样品尚未补齐，暂不自动定价"
            : unified
              ? "可靠的基础属性≤目标样本不足，暂不自动定价"
              : "可靠的同配或相近样本不足，暂不自动定价",
      );
    }
  }
  snapshot.knownTotal = round(
    snapshot.items.reduce((sum, item) => sum + (item.referencePrice ?? 0), 0),
  );
  if (snapshot.provider === "browser")
    for (const item of snapshot.items) {
      item.exclusion = equipmentExclusion(item, snapshot.searchItems || []);
      if (item.exclusion)
        item.issues.push(
          item.exclusion.label + "；基础普通装备已完成当前查询范围核验，市场售价仍未知。",
        );
    }
  snapshot.total = snapshot.items.every((item) => item.status === "priced")
    ? snapshot.knownTotal
    : null;
  return finishPricingSearch(snapshot);
}

export function combineEquipmentPricing(
  bare: ValuationResult,
  record: SavedRoleRecord,
  pricing?: EquipmentPricingSnapshot,
  settings?: ValuationSettings,
): ValuationResult {
  const inventory = equipmentInventory(record, settings);
  const valid =
    pricing?.inputHash === inventory.inputHash &&
    inventoryMatchesSnapshot(pricing, inventory.items);
  let snapshot = valid ? pricing : undefined;
  const age = snapshot ? Date.now() - Date.parse(snapshot.searchedAt) : Infinity;
  const fresh = age >= -60_000 && age < 24 * 60 * 60 * 1000;
  const verified = validateExactPricing(snapshot, inventory.items);
  const baselineFor = (item: EquipmentPricingItem) =>
    inventory.captureComplete &&
    snapshot?.captureComplete &&
    fresh &&
    verified &&
    settings &&
    validateEquipmentBaseline(item, String(record.listing.serverId), settings)
      ? item.baselineEstimate
      : undefined;
  const excluded = (item: EquipmentPricingItem) =>
    fresh &&
    verified &&
    snapshot?.provider === "browser" &&
    (skippedPricingItem(item) || validEquipmentExclusion(item, snapshot.searchItems));
  if (snapshot)
    snapshot = {
      ...snapshot,
      items: snapshot.items.map((item) => {
        if (!item.baselineEstimate) return item;
        const { baselineInvalidReason: _invalidReason, ...original } = item;
        return baselineFor(item)
          ? original
          : {
              ...original,
              baselineInvalidReason: !fresh
                ? "默认参考价记录已过期，请开始新批次重新分析。"
                : "默认参考价与本批设置或装备资料不一致，请开始新批次重新分析。",
            };
      }),
    };
  const complete =
    inventory.captureComplete &&
    !!snapshot?.captureComplete &&
    snapshot.total !== null &&
    fresh &&
    verified;
  const equipment = complete ? snapshot!.total : null;
  const value =
    bare.model_value !== null && equipment !== null ? round(bare.model_value + equipment) : null;
  const comparison = compareListingPrice(value, bare.asking_price);
  const missing = [...bare.missing_fields];
  if (!snapshot) missing.push("需要核对装备资料并实际联网查价");
  else if (!complete)
    missing.push(
      ...snapshot.issues,
      ...snapshot.items.flatMap((item) =>
        item.status === "priced" || baselineFor(item)?.amount != null || excluded(item)
          ? []
          : [item.name + "：" + (item.baselineInvalidReason || item.issues.join("；"))],
      ),
    );
  if (snapshot && !fresh) missing.push("装备行情已过期，需要开始新批次重新联网查价");
  if (snapshot && fresh && !verified) missing.push("装备报价快照与样本金额不一致，需要重新查价");
  const suggestions = [...(bare.suggestions || [])];
  if (snapshot && !fresh)
    suggestions.unshift("开始新批次重新联网查价；继续旧批次会保留当时的搜索快照。");
  if (!inventory.captureComplete)
    suggestions.unshift("先在采集页补齐当前装备资料，再开始联网分析。");
  else if (!complete) {
    if (snapshot?.items.some((item) => baselineFor(item)?.amount === null))
      suggestions.unshift("在分析设置补充普通装备默认价及本服金价；留空的默认价仍保留待补。");
    if (
      !snapshot ||
      snapshot.items.some((item) => item.status !== "priced" && !item.baselineEstimate)
    )
      suggestions.unshift("查看装备查价模块的候选与匹配原因；可靠同类报价不足时继续保留未定价。");
    if (snapshot?.items.some((item) => item.baselineInvalidReason))
      suggestions.unshift("默认参考价已失效，请开始新批次按当前资料和设置重新分析。");
  }
  const reason =
    bare.decision === "OUT_OF_SCOPE"
      ? bare.reason
      : value === null
        ? "装备报价或裸号计价尚未完整，先展示已算部分，暂无法给出完整挂牌差额。"
        : comparison.price_difference === null
          ? "参考估值¥" + value.toFixed(2) + "；缺少有效挂牌价，暂无法比较价差。"
          : "参考估值¥" +
            value.toFixed(2) +
            "，挂牌价¥" +
            bare.asking_price?.toFixed(2) +
            "；估值比挂牌" +
            (comparison.price_difference! >= 0 ? "高" : "低") +
            "¥" +
            Math.abs(comparison.price_difference!).toFixed(2) +
            "。";
  return {
    ...bare,
    ...comparison,
    decision: bare.decision === "OUT_OF_SCOPE" ? "OUT_OF_SCOPE" : comparison.decision,
    model_value: value,
    bare_role_value: bare.model_value,
    equipment_value: equipment,
    equipment_pricing: snapshot,
    price_comparison_scope: "裸号本体与人物装备/灵饰；召唤兽个体、锦衣和其他道具未计价",
    known_subtotal: round(
      (bare.model_value ?? bare.known_subtotal) +
        (fresh && verified ? (snapshot?.knownTotal ?? 0) : 0),
    ),
    items: [
      ...bare.items,
      ...(snapshot?.items || []).map((item, index) => {
        const baseline = baselineFor(item);
        return {
          ...(baseline
            ? {
                referenceBasis:
                  baseline.kind === "ignored" ? ("excluded" as const) : ("baseline" as const),
              }
            : {}),
          ...(excluded(item) ? { referenceBasis: "excluded" as const } : {}),
          name: "装备：" + item.name + "（" + item.key + "）",
          input: item.description,
          formula: excluded(item)
            ? skippedPricingItem(item)
              ? (item.skipReason || "无样本，未计入参考合计") + "；市场售价未知，不记作0元。"
              : "无匹配，未计入参考合计；当前查询范围已读完。市场售价未知，不记作0元。"
            : item.status === "untradable"
              ? "专用或绑定装备无法独立挂牌查价，分项金额未知。"
              : baseline
                ? baseline.kind === "ignored"
                  ? "普通低值装备按明确排除策略未计入，保留记录；不表示市场售价为0。"
                  : "普通装备默认参考价（非实时行情）：" +
                    (baseline.gameCurrency === null
                      ? "默认价待补"
                      : baseline.amount === null
                        ? baseline.gameCurrency + "梦幻币，人民币换算待补"
                        : baseline.gameCurrency +
                          "梦幻币 ÷ " +
                          baseline.goldUnit +
                          " × ¥" +
                          baseline.goldPrice) +
                    "；" +
                    baseline.source.label
                : item.baselineInvalidReason
                  ? "默认参考价已失效：" + item.baselineInvalidReason
                  : (item.comparisonPolicy === "core-initial-first-five-v3"
                      ? "已核对排序后前五条中核心初始值在目标至目标+2范围内的样品的最低挂牌价（"
                      : item.comparisonPolicy === "base-upper-bound-v1"
                        ? "已核对基础属性≤目标的装备前五条合格挂牌价的最低值（"
                        : item.priceMethod === EQUIPMENT_QUOTE_POLICY
                          ? "已核对同配置装备前五件有效挂牌价的最低值（"
                          : "已核对同配置装备挂牌价的中位数（") +
                    quoteCandidates(item).length +
                    "条样本）",
          amount: baseline ? baseline.amount : fresh && verified ? item.referencePrice : null,
          confirmed: fresh && verified && item.status === "priced",
          evidence: baseline
            ? [
                {
                  path: "/equipment_pricing/items/" + index + "/baselineEstimate",
                  value: JSON.stringify(baseline),
                  reason:
                    baseline.source.label +
                    (baseline.source.publishedAt ? " · " + baseline.source.publishedAt : ""),
                },
              ]
            : quoteCandidates(item).map((candidate) => ({
                path: "/equipment_pricing/items/" + index + "/candidates",
                value: candidate.quote,
                reason: candidate.url + " · " + candidate.fetchedAt,
              })),
        };
      }),
    ],
    missing_fields: [...new Set(missing)],
    suggestions: [...new Set(suggestions)],
    reason,
    next_action: value === null ? suggestions[0] || "" : "",
  };
}
