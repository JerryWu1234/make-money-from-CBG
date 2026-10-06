import type { EquipmentPricingSnapshot } from "./equipment-pricing";
import { validateExactPricing } from "./pricing-integrity";

export type PricingSearchState = "completed" | "pending" | "read_failed" | "unsupported";
export type PricingSearchAttempt = {
  searchedAt: string;
  requestText?: string;
  requestHash?: string;
  queries: string[];
  rawResponse: string;
  searchItems?: unknown[];
};

/** Only explicitly finished, fresh, identity-checked assets may skip a resumed search. */
export function resumePricingItems<T extends EquipmentPricingSnapshot>(snapshot: T, previous?: T) {
  if (!snapshot.captureComplete) return snapshot;
  const reusable =
    previous?.inputHash === snapshot.inputHash && validateExactPricing(previous, snapshot.items);
  if (reusable) {
    snapshot.queries = [...previous!.queries];
    snapshot.searchItems = [...(previous!.searchItems || [])];
    snapshot.searchAttempts = [...(previous!.searchAttempts || [])];
  }
  snapshot.items = snapshot.items.map((item) => {
    if (item.status !== "no_match" || item.baselineEstimate) return item;
    const saved = reusable ? previous!.items.find((value) => value.key === item.key) : undefined;
    if (saved && ["completed", "unsupported"].includes(saved.searchState || ""))
      return structuredClone(saved);
    return { ...item, searchState: "pending" };
  }) as T["items"];
  return snapshot;
}

export function finishPricingSearch<T extends EquipmentPricingSnapshot>(snapshot: T): T {
  snapshot.knownTotal =
    Math.round(snapshot.items.reduce((sum, item) => sum + (item.referencePrice ?? 0), 0) * 100) /
    100;
  snapshot.total =
    snapshot.captureComplete && snapshot.items.every((item) => item.status === "priced")
      ? snapshot.knownTotal
      : null;
  snapshot.searchComplete = !snapshot.items.some((item) =>
    ["pending", "read_failed"].includes(item.searchState || ""),
  );
  return snapshot;
}

export function saveSearchAttempt(
  snapshot: EquipmentPricingSnapshot,
  response: {
    queries: string[];
    searchItems?: unknown[];
  },
) {
  snapshot.searchAttempts ||= [];
  snapshot.searchAttempts.push({
    searchedAt: snapshot.searchedAt,
    requestText: snapshot.requestText,
    requestHash: snapshot.requestHash,
    queries: response.queries,
    rawResponse: snapshot.rawResponse!,
    searchItems: response.searchItems,
  });
  snapshot.searchItems = [...(snapshot.searchItems || []), ...(response.searchItems || [])];
  snapshot.queries = [
    ...new Set([...snapshot.queries, ...response.queries.filter((q) => q.trim())]),
  ];
}
