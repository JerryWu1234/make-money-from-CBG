import { createHash } from "node:crypto";
import type { SavedRoleRecord } from "../crawler/types";
import type { ValuationResult } from "./valuation-types";
import { compareListingPrice } from "./valuation-calculator";
import { inventoryMatchesSnapshot, validateExactPricing } from "./pricing-integrity";
import { parseEquipmentAttributes } from "./equip-attributes";
import { hasUnconfirmedEmptyEquipment, observedEquipmentCategory } from "../crawler/compact";
import { matchComparableEquipmentAttributes, matchEquipmentAttributes } from "./equipment-match";
import { buildEquipmentEstimate, type SimilarEstimate } from "./pricing-estimate";
import {
  makeEquipmentBaseline,
  validateEquipmentBaseline,
  type BaselineEstimate,
} from "./equipment-baseline";
import type { ValuationSettings } from "./valuation-types";
import {
  finishPricingSearch,
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
  seen: string[];
  failed: Array<{ url: string; modeIndex: number }>;
};
export type EquipmentPricingItem = {
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
  candidates: EquipmentCandidate[];
  issues: string[];
  similarEstimate?: SimilarEstimate;
  baselineEstimate?: BaselineEstimate;
  baselineInvalidReason?: string;
  searchState?: PricingSearchState;
  searchCursor?: EquipmentSearchCursor;
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
      candidates: EquipmentCandidate[];
      note?: string;
      query?: string;
      searchState?: PricingSearchState;
      searchCursor?: EquipmentSearchCursor;
      skipped?: boolean;
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

/** Only owned role equipment, not skills, artifacts, consumables or pet gear. */
export function equipmentInventory(record: SavedRoleRecord) {
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
      const category = observedEquipmentCategory(item.category, item.location, item.modelId) || "";
      if (item.kind === "skill" || item.kind === "innerSkill") continue;
      if (/法宝|灵宝|神器|道具|材料|消耗品|召唤兽装备/.test(category)) continue;
      const level = category === "上古玉魄" ? null : levelOf(description, item.attributes);
      const equipment =
        /人物装备|灵饰|武器|头盔|衣服|项链|腰带|鞋|上古玉魄/.test(category) ||
        (level !== null &&
          level >= 0 &&
          /伤害|防御|灵力|敏捷|速度|气血|封印|治疗/.test(description));
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
          if (/槽位|slot|position|装备位/i.test(item.location)) continue;
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
      if (category !== "上古玉魄" && level === null) issues.push("装备等级缺失");
      if (!description.trim()) issues.push("装备属性未采齐");
      for (const issue of record.detail?.equipmentCapture?.issues || [])
        if (issue.startsWith(tab.name + "：" + item.name + " ") && /属性|等级|JSON/.test(issue))
          issues.push(issue);
      const unsupported = level === 0;
      if (unsupported)
        issues.push("官网全服装备检索范围为60至160级，0级装备尚缺可用查询入口和可靠报价");
      const inferred = category || (/精炼等级/.test(description) ? "灵饰" : "人物装备");
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
        name: item.name,
        level,
        category: inferred,
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
  const inputHash = hash(
    JSON.stringify({
      serverId: record.listing.serverId,
      collectedAt: capture?.collectedAt,
      captureComplete,
      issues,
      items: items.map(({ key, name, level, category, kindId, modelId, description }) => ({
        key,
        name,
        level,
        category,
        ...(kindId ? { kindId } : {}),
        ...(modelId ? { modelId } : {}),
        description,
      })),
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
            maxItems: 5,
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
  const text = pageText(productSource(html)),
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
  const targetModel =
    item.modelId || (jade ? { 上古玉魄·阴: "61717", 上古玉魄·阳: "61718" }[item.name] : undefined);
  if (
    (targetModel && sourceModel && Number(targetModel) !== Number(sourceModel)) ||
    (item.kindId && sourceKind && Number(item.kindId) !== Number(sourceKind))
  )
    return reject("官方装备类型或型号不匹配");
  if (
    !normalized.includes(normalize(item.name)) ||
    (!jade && (item.level === null || sourceAttributes.level !== item.level)) ||
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
  if (jade) {
    const sourceDescription = html.match(
      /<pre\b[^>]*data-cbg-equipment-description[^>]*>([\s\S]*?)<\/pre>/i,
    )?.[1];
    const comparable = (value: string) =>
      pageText(value)
        .split(/\n/)
        .map((line) => line.trim())
        .filter((line) => line && !/^耐久(?:度)?\s*[：:]?\s*\d/.test(line))
        .map(normalize)
        .filter((line) => line !== normalize(item.name));
    if (
      !sourceDescription ||
      JSON.stringify(comparable(item.description)) !== JSON.stringify(comparable(sourceDescription))
    )
      return reject("玉魄初始/附加属性、灵尘、效形或奇袭/到期条件不完全一致");
  }
  const match = (jade ? matchEquipmentAttributes : matchComparableEquipmentAttributes)(
    targetAttributes,
    sourceAttributes,
  );
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
/** Apply explicit default/exclusion policies before deciding whether a browser is needed. */
export function equipmentPricingPlan(
  record: SavedRoleRecord,
  settings?: ValuationSettings,
): EquipmentPricingSnapshot {
  const inventory = equipmentInventory(record);
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
  if (inventory.captureComplete && settings) {
    for (const item of snapshot.items) {
      const baseline = makeEquipmentBaseline(item, String(record.listing.serverId), settings);
      if (!baseline) continue;
      item.baselineEstimate = baseline;
      item.issues = [baseline.note];
    }
    if (snapshot.items.some((item) => item.baselineEstimate)) {
      snapshot.requestText = JSON.stringify({
        baselineItems: snapshot.items.filter((item) => item.baselineEstimate),
        prices: settings.equipmentBaselinePrices,
        server: settings.servers.find(
          (server) => server.serverId === String(record.listing.serverId),
        ),
      });
      snapshot.requestHash = hash(snapshot.requestText);
    }
  }
  return snapshot;
}
export async function searchEquipmentPrices(
  record: SavedRoleRecord,
  signal: AbortSignal,
  source: EquipmentSource,
  settings?: ValuationSettings,
  previous?: EquipmentPricingSnapshot,
): Promise<EquipmentPricingSnapshot> {
  const snapshot = resumePricingItems(equipmentPricingPlan(record, settings), previous, true);
  signal.throwIfAborted();
  const capture = record.detail?.equipmentCapture;
  if (
    !capture ||
    capture.version !== 1 ||
    (!snapshot.captureComplete && !snapshot.issues.length) ||
    snapshot.issues.some((issue) => /重复显示|实际件数|核对是否同一件/.test(issue))
  ) {
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
  const response = await source.findCandidates(lookupItems, signal);
  signal.throwIfAborted();
  snapshot.rawResponse = JSON.stringify(response);
  saveSearchAttempt(snapshot, response);
  if (!response.queries.some((query) => query.trim())) {
    if (
      Array.isArray(response.items) &&
      response.items.length &&
      response.items.every((item) => item.skipped === true)
    )
      return finishPricingSearch(snapshot);
    for (const item of searchable)
      if (
        Array.isArray(response.items) &&
        response.items.find((entry) => entry?.key === item.key)?.searchState === "unsupported"
      ) {
        item.searchState = "unsupported";
        item.status = "unsupported";
        item.issues.push(
          response.items.find((entry) => entry.key === item.key)?.note || "查询入口不支持此装备",
        );
      }
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
    if (!result || !Array.isArray(result.candidates) || result.candidates.length > 5) {
      item.issues.push("未返回该装备的有效候选");
      continue;
    }
    // Untouched items keep their earlier cursor/quotations; they were not re-read this round.
    if (result.skipped === true) continue;
    item.query = typeof result.query === "string" ? result.query : "";
    item.searchCursor = result.searchCursor as EquipmentSearchCursor | undefined;
    item.candidates = [];
    item.searchState = ["pending", "read_failed", "unsupported"].includes(
      String(result.searchState),
    )
      ? (result.searchState as PricingSearchState)
      : "completed";
    if (item.searchState === "unsupported") item.status = "unsupported";
    if (typeof result.note === "string" && result.note.trim())
      item.issues.push(result.note.slice(0, 500));
    const urls = new Set<string>();
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
      try {
        const url = safeEquipmentUrl(candidate.url);
        const identity = equipmentIdentity(url);
        if (urls.has(identity)) continue;
        urls.add(identity);
        candidate.url = url;
        if (!pages.has(identity)) pages.set(identity, source.readSource(url, signal));
        candidate = verifyEquipmentCandidate(
          item,
          candidate,
          await pages.get(identity)!,
          new Date().toISOString(),
        );
      } catch (error) {
        signal.throwIfAborted();
        candidate.reason = error instanceof Error ? error.message : "无法核对来源";
        readFailed = true;
      }
      item.candidates.push(candidate);
    }
    const verified = item.candidates.filter(
      (candidate) => candidate.verified && candidate.matchType !== "similar",
    );
    if (verified.length >= 1) {
      const prices = verified.map((candidate) => candidate.price!).sort((a, b) => a - b);
      const mid = Math.floor(prices.length / 2);
      item.referencePrice = round(
        prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2,
      );
      item.status = "priced";
      item.searchState = "completed";
      if (verified.length === 1) item.issues.push("仅1条挂牌样本，参考范围有限");
    } else {
      if (readFailed) item.searchState = "read_failed";
      item.similarEstimate = buildEquipmentEstimate(item.candidates);
      item.issues.push(
        item.similarEstimate.status === "range"
          ? "暂无完全同配置报价，采用相近装备挂牌中位数作为参考价，并保留报价范围和配置差异"
          : "可靠的同配或相近样本不足，暂不自动定价",
      );
    }
  }
  snapshot.knownTotal = round(
    snapshot.items.reduce((sum, item) => sum + (item.referencePrice ?? 0), 0),
  );
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
  const inventory = equipmentInventory(record);
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
        item.status === "priced" || baselineFor(item)?.amount != null
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
          name: "装备：" + item.name + "（" + item.key + "）",
          input: item.description,
          formula: baseline
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
              : "已核对同配置装备挂牌价的中位数（" +
                item.candidates.filter(
                  (candidate) => candidate.verified && candidate.matchType !== "similar",
                ).length +
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
            : item.candidates
                .filter((candidate) => candidate.verified && candidate.matchType !== "similar")
                .map((candidate) => ({
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
