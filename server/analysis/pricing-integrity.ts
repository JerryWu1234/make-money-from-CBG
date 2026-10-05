import type {
  EquipmentCandidate,
  EquipmentPricingItem,
  EquipmentPricingSnapshot,
} from "./equipment-pricing";
import type { PetPricingItem, PetPricingSnapshot } from "./pet-pricing";

type PricingItem = EquipmentPricingItem | PetPricingItem;
type PricingSnapshot = EquipmentPricingSnapshot | PetPricingSnapshot;
const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function pricingTimestampFresh(value: string | null | undefined, now = Date.now()) {
  const age = value ? now - Date.parse(value) : Infinity;
  return Number.isFinite(age) && age >= -60_000 && age < 24 * 60 * 60 * 1000;
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
    ...("fields" in item
      ? {
          fields: item.fields,
          skills: item.skills,
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

const exactMedian = (candidates: EquipmentCandidate[], now: number): number | null => {
  const prices = new Map<string, number>();
  for (const candidate of candidates) {
    if (
      candidate.verified !== true ||
      (candidate.matchType !== undefined && candidate.matchType !== "exact") ||
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
  const sorted = [...prices.values()].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
};

/** Legacy verified candidates were strictly exact; explicit comparable ranges never set exact totals. */
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
    const inventoryItem = inventoryItems.find((value) => value.key === item.key)!;
    if (
      inventoryItem.status !== "no_match" &&
      (item.status !== inventoryItem.status || item.referencePrice !== null)
    )
      return false;
    if (item.status !== "priced") {
      if (item.referencePrice !== null) return false;
      continue;
    }
    const median = exactMedian(item.candidates, now);
    if (median === null || item.referencePrice !== median) return false;
    knownTotal += median;
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
