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
export function resumePricingItems<T extends EquipmentPricingSnapshot>(
  snapshot: T,
  previous?: T,
  allowPartialCapture = false,
) {
  if (!snapshot.captureComplete && !allowPartialCapture) return snapshot;
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
    if (
      saved &&
      ["completed", "unsupported", "pending", "read_failed"].includes(saved.searchState || "")
    ) {
      const resumed = structuredClone(saved);
      if (["pending", "read_failed"].includes(resumed.searchState || "")) {
        resumed.searchState = "pending";
        resumed.issues = [...item.issues];
      }
      return resumed;
    }
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

/** Continue a bounded search only when a saved official query cursor actually advances. */
export function equipmentSearchAdvanced(
  previous: EquipmentPricingSnapshot | undefined,
  current: EquipmentPricingSnapshot,
) {
  if (current.items.some((item) => item.searchState === "read_failed")) return false;
  return current.items.some((item) => {
    const saved = previous?.items.find((value) => value.key === item.key);
    if (
      ["completed", "unsupported"].includes(item.searchState || "") &&
      item.searchState !== saved?.searchState
    )
      return true;
    return (
      item.searchState === "pending" &&
      !!item.searchCursor &&
      JSON.stringify(saved?.searchCursor) !== JSON.stringify(item.searchCursor)
    );
  });
}
