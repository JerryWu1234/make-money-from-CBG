import type {
  EquipmentPricingItem,
  EquipmentPricingSnapshot,
  EquipmentSearchCursor,
} from "./equipment-pricing";
import { unfinishedPricingSearch, validateExactPricing } from "./pricing-integrity";

export type PricingSearchState = "completed" | "pending" | "read_failed" | "unsupported";
export type PricingSearchAttempt = {
  searchedAt: string;
  requestText?: string;
  requestHash?: string;
  queries: string[];
  rawResponse: string;
  searchItems?: unknown[];
};

/** Changed results invalidate both saved row positions and the adopted sample order. */
export function resetPricingCursor(cursor: EquipmentSearchCursor) {
  delete cursor.emptyFirstPageModes;
  Object.assign(cursor, {
    modeIndex: 0,
    pageNumber: 1,
    rowIndex: 0,
    pageRowsHash: "",
    pageHistory: [],
    historyIndex: 0,
    seen: [],
    failed: [],
    restartCount: (cursor.restartCount || 0) + 1,
  });
}

/** Save even completely scanned pages: earlier pages can change before a resumed sample. */
export function rememberPricingPage(
  cursor: EquipmentSearchCursor,
  modeIndex: number,
  pageNumber: number,
  rowsHash: string,
) {
  cursor.pageHistory ||= [];
  const previous = cursor.pageHistory.find(
    (page) => page.modeIndex === modeIndex && page.pageNumber === pageNumber,
  );
  if (previous && previous.rowsHash !== rowsHash) return false;
  if (!previous) cursor.pageHistory.push({ modeIndex, pageNumber, rowsHash });
  return true;
}

export function validPricingPageHistory(cursor: EquipmentSearchCursor) {
  if (cursor.pageHistory === undefined) return cursor.historyIndex === undefined;
  return (
    Array.isArray(cursor.pageHistory) &&
    cursor.pageHistory.every(
      (page, index, pages) =>
        Number.isInteger(page.modeIndex) &&
        page.modeIndex >= 0 &&
        page.modeIndex <= cursor.modeIndex &&
        Number.isInteger(page.pageNumber) &&
        page.pageNumber > 0 &&
        typeof page.rowsHash === "string" &&
        !!page.rowsHash &&
        (!index ||
          page.modeIndex > pages[index - 1].modeIndex ||
          (page.modeIndex === pages[index - 1].modeIndex &&
            page.pageNumber > pages[index - 1].pageNumber)),
    ) &&
    Number.isInteger(cursor.historyIndex ?? 0) &&
    (cursor.historyIndex ?? 0) >= 0 &&
    (cursor.historyIndex ?? 0) <= cursor.pageHistory.length
  );
}

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
        if (resumed.samplingStopped) {
          delete resumed.searchCursor;
          delete resumed.samplingStopped;
        }
      }
      return resumed;
    }
    return { ...item, searchState: "pending" };
  }) as T["items"];
  return snapshot;
}

export function reconcilePricingCompletion(item: EquipmentPricingItem, records?: unknown[]) {
  if (item.searchState !== "completed" || !unfinishedPricingSearch(item, records)) return;
  item.searchState = "pending";
  item.referencePrice = null;
  if (item.status === "priced") item.status = "no_match";
  delete item.exclusion;
  item.issues.push("搜索记录显示结果尚未读完且有效样本不足10件，继续查价；不能按完成结果计价");
}

export function finishPricingSearch<T extends EquipmentPricingSnapshot>(snapshot: T): T {
  for (const item of snapshot.items) reconcilePricingCompletion(item, snapshot.searchItems);
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

/** Continue only after an asset finishes or a saved official query cursor advances. */
export function pricingSearchAdvanced(
  previous: EquipmentPricingSnapshot | undefined,
  current: EquipmentPricingSnapshot,
) {
  if (current.items.some((item) => item.searchState === "read_failed" || item.samplingStopped))
    return false;
  return current.items.some((item) => {
    const saved = previous?.items.find((value) => value.key === item.key);
    if (
      ["completed", "unsupported"].includes(item.searchState || "") &&
      item.searchState !== saved?.searchState
    )
      return true;
    const cursor = item.searchCursor;
    if (item.searchState !== "pending" || !cursor) return false;
    const previousCursor = saved?.searchCursor;
    if (!previousCursor) return true;
    if (cursor.planHash !== previousCursor.planHash) return false;
    if ((cursor.historyIndex || 0) > (previousCursor.historyIndex || 0)) return true;
    // Allow one automatic rebuild; repeated market churn requires a new user attempt.
    if (cursor.restartCount === 1 && !previousCursor.restartCount) return true;
    return (
      cursor.modeIndex > previousCursor.modeIndex ||
      (cursor.modeIndex === previousCursor.modeIndex &&
        (cursor.pageNumber > previousCursor.pageNumber ||
          (cursor.pageNumber === previousCursor.pageNumber &&
            cursor.rowIndex > previousCursor.rowIndex)))
    );
  });
}
