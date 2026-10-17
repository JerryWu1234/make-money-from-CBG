import type {
  EquipmentCandidate,
  EquipmentPricingItem,
  EquipmentPricingSnapshot,
} from "./equipment-pricing";
import type { PetPricingItem, PetPricingSnapshot } from "./pet-pricing";
import { validEquipmentExclusion } from "./equipment-exclusion";

type PricingItem = EquipmentPricingItem | PetPricingItem;
type PricingSnapshot = EquipmentPricingSnapshot | PetPricingSnapshot;

export function skippedPricingItem(item: PricingItem) {
  return (
    item.searchState === "skipped" &&
    (item.status === "no_match" ||
      (["untradable", "unsupported"].includes(item.status) && !!item.skipReason)) &&
    item.referencePrice === null &&
    !item.baselineEstimate &&
    !item.candidates.some((candidate) => candidate.verified)
  );
}
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
export const EQUIPMENT_QUOTE_LIMIT = 5;
export const EQUIPMENT_QUOTE_POLICY = "first-five-minimum-v4";
export const PRICING_RESUME_POLICY = "revalidate-pages-and-completion-evidence-v3";

/** Average validated yuan quotations in integer cents, rounded half up. */
export function priceAverage(prices: readonly number[]): number | null {
  if (!prices.length) return null;
  return (
    Math.round(prices.reduce((sum, price) => sum + Math.round(price * 100), 0) / prices.length) /
    100
  );
}

export function priceMinimum(prices: readonly number[]): number | null {
  return prices.length ? Math.min(...prices) : null;
}

/** Validated listing amounts have at most two decimals; average cents before half-up rounding. */
export function priceMedian(prices: readonly number[]): number | null {
  if (!prices.length) return null;
  const cents = prices.map((price) => Math.round(price * 100)).sort((left, right) => left - right);
  const middle = Math.floor(cents.length / 2);
  return (
    Math.round(cents.length % 2 ? cents[middle] : (cents[middle - 1] + cents[middle]) / 2) / 100
  );
}

export function pricingTimestampFresh(value: string | null | undefined, now = Date.now()) {
  const age = value ? now - Date.parse(value) : Infinity;
  return Number.isFinite(age) && age >= -60_000 && age < 24 * 60 * 60 * 1000;
}

export function pricingCandidatesFresh(
  candidates: readonly EquipmentCandidate[],
  now = Date.now(),
) {
  return candidates.every(
    (candidate) => !candidate.verified || pricingTimestampFresh(candidate.fetchedAt, now),
  );
}

export function pricingSnapshotFresh(snapshot: PricingSnapshot | undefined, now = Date.now()) {
  return (
    !!snapshot &&
    pricingTimestampFresh(snapshot.searchedAt, now) &&
    snapshot.items.every((item) => pricingCandidatesFresh(item.candidates, now))
  );
}

const assetIdentity = (item: PricingItem) =>
  JSON.stringify({
    key: item.key,
    name: item.name,
    level: item.level,
    category: item.category,
    kindId: item.kindId,
    modelId: item.modelId,
    description: item.description,
    ...(item.priceMethod ? { priceMethod: item.priceMethod } : {}),
    ...(item.comparisonPolicy ? { comparisonPolicy: item.comparisonPolicy } : {}),
    ...("fields" in item
      ? {
          fields: item.fields,
          skills: item.skills,
          ...("skillObservations" in item && item.skillObservations
            ? { skillObservations: item.skillObservations }
            : {}),
          innerSkills: item.innerSkills,
          equipment: item.equipment,
        }
      : {}),
  });

/** Frozen pricing must describe every current asset once, including each pet's carried gear. */
export function inventoryMatchesSnapshot(
  snapshot: PricingSnapshot | undefined,
  inventoryItems: readonly PricingItem[],
): boolean {
  if (
    !snapshot ||
    !Array.isArray(snapshot.items) ||
    snapshot.items.length !== inventoryItems.length
  )
    return false;
  const expected = new Map(inventoryItems.map((item) => [item.key, assetIdentity(item)]));
  const keys = snapshot.items.map((item) => item.key);
  return (
    expected.size === inventoryItems.length &&
    keys.every((key) => typeof key === "string" && key.length > 0) &&
    new Set(keys).size === keys.length &&
    snapshot.items.every((item) => expected.get(item.key) === assetIdentity(item))
  );
}

export const officialSourceIdentity = (url: string) => {
  try {
    const source = new URL(url);
    const path = source.pathname.match(/^\/equip\/(\d+)\/([\w-]+)\/?$/);
    const queryServer = source.searchParams.get("s"),
      queryEid = source.searchParams.get("eid");
    const server = path?.[1] || queryServer,
      eid = path?.[2] || queryEid;
    if (
      source.protocol !== "https:" ||
      source.hostname !== "xyq.cbg.163.com" ||
      source.port ||
      source.username ||
      source.password ||
      (!path && !/^\/equip\/?$/.test(source.pathname)) ||
      (path && ((queryServer && queryServer !== server) || (queryEid && queryEid !== eid))) ||
      !/^\d+$/.test(server || "") ||
      !/^[\w-]+$/.test(eid || "")
    )
      return null;
    return server + ":" + eid;
  } catch {
    return null;
  }
};

export const candidateQuoteMatchesPrice = (candidate: EquipmentCandidate) =>
  [
    ...candidate.quote.matchAll(
      /(?:[¥￥]\s*|(?:价格|售价|挂牌价)\s*[：:]?\s*[¥￥]?\s*)([\d,]+(?:\.\d{1,2})?)/g,
    ),
  ].some((match) => Number(match[1].replace(/,/g, "")) === candidate.price);

/** A completion flag cannot override explicit unfinished evidence for the adopted cohort. */
export function unfinishedPricingSearch(item: PricingItem, records: unknown[] = []) {
  const cohorts = new Map<string, Set<string>>();
  for (const candidate of item.candidates) {
    const identity = officialSourceIdentity(candidate.url);
    if (!candidate.verified || !identity || candidate.price === null || candidate.price <= 0)
      continue;
    const mode =
      item.comparisonPolicy === "base-upper-bound-v1" ||
      item.comparisonPolicy === "core-initial-first-five-v3"
        ? "*"
        : candidate.matchType === "similar"
          ? "similar"
          : "exact";
    const cohort = cohorts.get(mode) || new Set<string>();
    cohort.add(identity);
    cohorts.set(mode, cohort);
  }
  const selected = cohorts.get("*")?.size
    ? "*"
    : cohorts.get("exact")?.size
      ? "exact"
      : cohorts.get("similar")?.size
        ? "similar"
        : undefined;
  // Reaching the requested sample count does not require scanning the entire market.
  if (selected && cohorts.get(selected)!.size >= EQUIPMENT_QUOTE_LIMIT) return false;
  const stages = new Map<string, boolean>();
  for (const entry of records) {
    if (!entry || typeof entry !== "object" || !("key" in entry) || entry.key !== item.key)
      continue;
    const record = entry as Record<string, unknown>;
    if (record.reason === "result_order_changed") stages.clear();
    if (record.matchType === "diagnostic") continue;
    const modes = Array.isArray(record.modes) ? record.modes : [record];
    for (const stage of modes) {
      if (!stage || typeof stage !== "object" || typeof stage.exhausted !== "boolean") continue;
      const stageMode = stage.mode || stage.matchType || "*";
      const mode =
        stageMode === "base-attributes"
          ? "*"
          : ["same-gems", "near-gems"].includes(stageMode)
            ? "exact"
            : stageMode;
      const boundedComplete =
        [
          "overall_search_pet",
          "overall_search_equip",
          "overall_search_lingshi",
          "overall_search_yuanshen",
          "yupo_search",
        ].includes(String(record.act)) &&
        stage.sampleLimit === EQUIPMENT_QUOTE_LIMIT &&
        stage.sampled === EQUIPMENT_QUOTE_LIMIT &&
        stage.samplingComplete === true &&
        Array.isArray(stage.detailFailures) &&
        stage.detailFailures.length === 0 &&
        (record.act !== "overall_search_pet" ||
          (Array.isArray(stage.unsupportedDetails) && stage.unsupportedDetails.length === 0));
      if (["exact", "similar", "*"].includes(mode))
        stages.set(mode, stage.exhausted || boundedComplete);
    }
  }
  if (!stages.size) return false;
  if (selected && stages.has(selected)) return stages.get(selected) === false;
  return [...stages.values()].some((exhausted) => !exhausted);
}

const exactReference = (
  candidates: EquipmentCandidate[],
  now: number,
  priceMethod?: EquipmentPricingItem["priceMethod"],
  comparisonPolicy?: EquipmentPricingItem["comparisonPolicy"],
): number | null => {
  const prices = new Map<string, number>();
  for (const candidate of candidates) {
    if (
      candidate.verified !== true ||
      (candidate.matchType !== undefined &&
        candidate.matchType !== "exact" &&
        !(
          (comparisonPolicy === "base-upper-bound-v1" ||
            comparisonPolicy === "core-initial-first-five-v3") &&
          candidate.matchType === "similar"
        )) ||
      candidate.priceType !== "listing" ||
      candidate.price === null ||
      !Number.isFinite(candidate.price) ||
      candidate.price <= 0 ||
      candidate.price > 1e9 ||
      !candidate.sourceHash ||
      !candidate.quote ||
      !candidateQuoteMatchesPrice(candidate) ||
      !pricingTimestampFresh(candidate.fetchedAt, now)
    )
      continue;
    const identity = officialSourceIdentity(candidate.url);
    if (!identity) continue;
    const previous = prices.get(identity);
    if (previous !== undefined && previous !== candidate.price) return null;
    prices.set(identity, candidate.price);
  }
  const values = [...prices.values()];
  return priceMethod === EQUIPMENT_QUOTE_POLICY
    ? priceMinimum(values.slice(0, EQUIPMENT_QUOTE_LIMIT))
    : priceMethod === "first-five-average-v3"
      ? priceAverage(values.slice(0, EQUIPMENT_QUOTE_LIMIT))
      : priceMedian(values);
};

/** Legacy totals use exact candidates; flagged equipment uses the unified qualified pool. */
export function validateExactPricing(
  snapshot: PricingSnapshot | undefined,
  inventoryItems: readonly PricingItem[],
  now = Date.now(),
): boolean {
  if (
    !snapshot ||
    !inventoryMatchesSnapshot(snapshot, inventoryItems) ||
    !pricingTimestampFresh(snapshot.searchedAt, now)
  )
    return false;
  let knownTotal = 0;
  for (const item of snapshot.items) {
    if (!Array.isArray(item.candidates)) return false;
    if (item.searchState === "skipped" && !skippedPricingItem(item)) return false;
    if (item.samplingStopped && (item.searchState === "completed" || item.status === "priced"))
      return false;
    if (
      (item.searchState === "completed" || item.status === "priced") &&
      unfinishedPricingSearch(item, snapshot.searchItems)
    )
      return false;
    if (
      item.exclusion &&
      (snapshot.provider !== "browser" || !validEquipmentExclusion(item, snapshot.searchItems))
    )
      return false;
    const inventoryItem = inventoryItems.find((value) => value.key === item.key)!;
    if (
      inventoryItem.searchState === "skipped" &&
      (item.searchState !== "skipped" || item.skipReason !== inventoryItem.skipReason)
    )
      return false;
    if (
      inventoryItem.status !== "no_match" &&
      (item.status !== inventoryItem.status || item.referencePrice !== null)
    )
      return false;
    if (item.status !== "priced") {
      if (item.referencePrice !== null) return false;
      continue;
    }
    if (
      inventoryItem.priceMethod === EQUIPMENT_QUOTE_POLICY &&
      ["pending", "read_failed"].includes(item.searchState || "")
    )
      return false;
    const reference = exactReference(
      item.candidates,
      now,
      inventoryItem.priceMethod,
      inventoryItem.comparisonPolicy,
    );
    if (reference === null || item.referencePrice !== reference) return false;
    knownTotal += reference;
  }
  knownTotal = round(knownTotal);
  const total =
    snapshot.captureComplete && snapshot.items.every((item) => item.status === "priced")
      ? knownTotal
      : null;
  return (
    Number.isFinite(knownTotal) && snapshot.knownTotal === knownTotal && snapshot.total === total
  );
}
