import { createHash } from "node:crypto";
import type { SavedRoleRecord } from "../crawler/types";
import type { ValuationResult } from "./valuation-types";
import { compareListingPrice } from "./valuation-calculator";
import { compareEquipmentAttributes, parseEquipmentAttributes } from "./equip-attributes";
import { observedEquipmentCategory } from "../crawler/compact";

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
};
export type EquipmentPricingItem = {
  key: string;
  name: string;
  level: number | null;
  category: string;
  kindId?: string;
  description: string;
  query: string;
  status: "priced" | "no_match" | "incomplete" | "untradable";
  referencePrice: number | null;
  candidates: EquipmentCandidate[];
  issues: string[];
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
};
export type EquipmentSource = {
  findCandidates: (
    items: EquipmentPricingItem[],
    signal: AbortSignal,
  ) => Promise<{
    queries: string[];
    items: Array<{ key: string; candidates: EquipmentCandidate[]; note?: string; query?: string }>;
    searchItems?: unknown[];
  }>;
  readSource: (url: string, signal: AbortSignal) => Promise<string>;
};
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const round = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const normalize = (s: string) => s.replace(/\s|[：:，,]/g, "").toLowerCase();
const levelOf = (description: string, attributes?: Record<string, string>) => {
  const level = description.match(/等级\s*[：:]?\s*(\d{1,3})/)?.[1] || attributes?.等级;
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
        .filter(([key]) => !Object.hasOwn(observed.fields, key))
        .map(([key, value]) => key + "：" + value);
      const description = [details, ...restrictions].filter(Boolean).join("\n");
      const category = observedEquipmentCategory(item.category, item.location) || "";
      if (item.kind === "skill" || item.kind === "innerSkill") continue;
      if (/法宝|灵宝|神器|道具|材料|消耗品|召唤兽装备/.test(category)) continue;
      const level = levelOf(description, item.attributes);
      const equipment =
        /人物装备|灵饰|武器|头盔|衣服|项链|腰带|鞋/.test(category) ||
        (level !== null &&
          level >= 1 &&
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
      if (level === null) issues.push("装备等级缺失");
      if (!description.trim()) issues.push("装备属性未采齐");
      if (/(?:耐久(?:度)?\s*[：:]?\s*0(?:\D|$)|无法修复|不能修理|不可修理)/.test(description))
        issues.push("耐久为0或无法修复，需要单独核价");
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
        description,
        query,
        status: dedicated ? "untradable" : issues.length ? "incomplete" : "no_match",
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
  const captureComplete =
    !!capture?.complete && tabs.some((tab) => tab.name === "道具/法宝") && !issues.length;
  const inputHash = hash(
    JSON.stringify({
      serverId: record.listing.serverId,
      collectedAt: capture?.collectedAt,
      captureComplete,
      issues,
      items: items.map(({ key, name, level, category, kindId, description }) => ({
        key,
        name,
        level,
        category,
        ...(kindId ? { kindId } : {}),
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

/** Verify current price and exact price-sensitive attributes against fetched source. */
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
  if (
    !normalized.includes(normalize(item.name)) ||
    item.level === null ||
    sourceAttributes.level !== item.level
  )
    return reject("名称或等级不匹配");
  const durability = (text: string) => text.match(/耐久(?:度)?\s*[：:]?\s*(\d+)/)?.[1];
  const targetDurability = durability(item.description),
    sourceDurability = durability(text);
  if (
    targetDurability !== undefined &&
    (sourceDurability === undefined || Number(sourceDurability) === 0)
  )
    return reject("报价耐久缺失或为0，不能按正常可修装备比较");
  const attributeIssue = compareEquipmentAttributes(targetAttributes, sourceAttributes);
  if (attributeIssue) return reject(attributeIssue);
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
    reason: "网页价格与关键属性已核对",
    fetchedAt,
    sourceHash: hash(text),
    differences:
      targetDurability !== sourceDurability && targetDurability !== undefined
        ? ["耐久不同：当前" + targetDurability + "，报价" + sourceDurability + "；未推测折扣"]
        : [],
  };
}

export type Search = (
  prompt: string,
  schema: unknown,
  signal: AbortSignal,
) => Promise<{ text: string; queries: string[]; searchItems?: unknown[]; usage?: unknown }>;
export async function searchEquipmentPrices(
  record: SavedRoleRecord,
  signal: AbortSignal,
  source: EquipmentSource,
): Promise<EquipmentPricingSnapshot> {
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
  signal.throwIfAborted();
  if (!inventory.captureComplete) return snapshot;
  const searchable = snapshot.items.filter((item) => item.status === "no_match");
  if (!searchable.length) {
    snapshot.total = snapshot.items.length ? null : 0;
    return snapshot;
  }
  const lookupItems = searchable.map((item) => ({
    ...item,
    candidates: [],
    issues: [...item.issues],
  }));
  snapshot.requestText = JSON.stringify(lookupItems);
  snapshot.requestHash = hash(snapshot.requestText);
  const response = await source.findCandidates(lookupItems, signal);
  signal.throwIfAborted();
  snapshot.rawResponse = JSON.stringify(response);
  snapshot.searchItems = response.searchItems;
  snapshot.queries = [...new Set(response.queries.filter((query) => query.trim()))];
  if (!snapshot.queries.length) {
    snapshot.issues.push("本次检索没有实际查询记录，返回价格未采纳");
    return snapshot;
  }
  if (!Array.isArray(response.items) || response.items.length > 100) {
    snapshot.issues.push("查价结果格式错误");
    return snapshot;
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
      return snapshot;
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
    item.query = typeof result.query === "string" ? result.query : "";
    if (typeof result.note === "string" && result.note.trim())
      item.issues.push(result.note.slice(0, 500));
    const urls = new Set<string>();
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
      }
      item.candidates.push(candidate);
    }
    const verified = item.candidates.filter((candidate) => candidate.verified);
    if (verified.length >= 1) {
      const prices = verified.map((candidate) => candidate.price!).sort((a, b) => a - b);
      const mid = Math.floor(prices.length / 2);
      item.referencePrice = round(
        prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2,
      );
      item.status = "priced";
      if (verified.length === 1) item.issues.push("仅1条挂牌样本，参考范围有限");
    } else item.issues.push("没有已核对的同配置挂牌报价，暂不自动定价");
  }
  snapshot.knownTotal = round(
    snapshot.items.reduce((sum, item) => sum + (item.referencePrice ?? 0), 0),
  );
  snapshot.total = snapshot.items.every((item) => item.status === "priced")
    ? snapshot.knownTotal
    : null;
  return snapshot;
}

export function combineEquipmentPricing(
  bare: ValuationResult,
  record: SavedRoleRecord,
  pricing?: EquipmentPricingSnapshot,
): ValuationResult {
  const inventory = equipmentInventory(record);
  const valid = pricing?.inputHash === inventory.inputHash;
  const snapshot = valid ? pricing : undefined;
  const age = snapshot ? Date.now() - Date.parse(snapshot.searchedAt) : Infinity;
  const fresh = age >= -60_000 && age < 24 * 60 * 60 * 1000;
  const complete =
    inventory.captureComplete && !!snapshot?.captureComplete && snapshot.total !== null && fresh;
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
        item.status === "priced" ? [] : [item.name + "：" + item.issues.join("；")],
      ),
    );
  if (snapshot && !fresh) missing.push("装备行情已过期，需要开始新批次重新联网查价");
  const suggestions = [...(bare.suggestions || [])];
  if (snapshot && !fresh)
    suggestions.unshift("开始新批次重新联网查价；继续旧批次会保留当时的搜索快照。");
  if (!inventory.captureComplete)
    suggestions.unshift("先在采集页补齐当前装备资料，再开始联网分析。");
  else if (!complete)
    suggestions.unshift("查看装备查价模块的候选与匹配原因；可靠同类报价不足时继续保留未定价。");
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
      (bare.model_value ?? bare.known_subtotal) + (fresh ? (snapshot?.knownTotal ?? 0) : 0),
    ),
    items: [
      ...bare.items,
      ...(snapshot?.items || []).map((item, index) => ({
        name: "装备：" + item.name + "（" + item.key + "）",
        input: item.description,
        formula:
          "已核对同配置装备挂牌价的中位数（" +
          item.candidates.filter((candidate) => candidate.verified).length +
          "条样本）",
        amount: fresh ? item.referencePrice : null,
        confirmed: fresh && item.status === "priced",
        evidence: item.candidates
          .filter((candidate) => candidate.verified)
          .map((candidate) => ({
            path: "/equipment_pricing/items/" + index + "/candidates",
            value: candidate.quote,
            reason: candidate.url + " · " + candidate.fetchedAt,
          })),
      })),
    ],
    missing_fields: [...new Set(missing)],
    suggestions: [...new Set(suggestions)],
    reason,
    next_action: value === null ? suggestions[0] || "" : "",
  };
}
