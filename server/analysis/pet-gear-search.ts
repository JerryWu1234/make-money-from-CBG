import type { SavedRoleRecord } from "../crawler/types";
import { createPetGearSource } from "./browser-pet-gear-source";
import {
  PET_GEAR_ACCOUNTING,
  petGearInventory,
  petGearReference,
  type PetGearPricingSnapshot,
} from "./pet-gear-inventory";

/** Called by ordinary analysis; gear is supporting evidence inside the pet's inclusive price. */
export async function searchPetGearPricing(
  record: SavedRoleRecord,
  signal: AbortSignal,
  previous?: PetGearPricingSnapshot,
): Promise<PetGearPricingSnapshot> {
  signal.throwIfAborted();
  const inventory = petGearInventory(record);
  const previousAge = previous ? Date.now() - Date.parse(previous.searchedAt) : Infinity;
  const reusable =
    previous?.inputHash === inventory.inputHash &&
    Number.isFinite(previousAge) &&
    previousAge >= -60_000 &&
    previousAge < 24 * 60 * 60 * 1000;
  const snapshot: PetGearPricingSnapshot = {
    version: 1,
    inputHash: inventory.inputHash,
    searchedAt: new Date().toISOString(),
    provider: "browser",
    model: "browser-ui",
    captureComplete: inventory.captureComplete,
    searchComplete: false,
    queries: reusable ? previous.queries : [],
    rawResponse: null,
    searchItems: reusable ? previous.searchItems : [],
    // These fields intentionally exclude gear from the parent pet's valuation sum.
    total: null,
    knownTotal: 0,
    accounting: PET_GEAR_ACCOUNTING,
    issues: inventory.issues,
    items: inventory.items.map((item) => {
      const saved = reusable ? previous.items.find((value) => value.key === item.key) : undefined;
      const savedAge = saved?.queriedAt ? Date.now() - Date.parse(saved.queriedAt) : Infinity;
      return saved &&
        ["completed", "skipped", "pending", "read_failed"].includes(saved.searchStatus || "") &&
        savedAge >= -60_000 &&
        savedAge < 24 * 60 * 60 * 1000 &&
        (saved.searchStatus !== "completed" ||
          saved.referencePrice === null ||
          petGearReference(saved.candidates).referencePrice === saved.referencePrice)
        ? { ...item, ...saved }
        : { ...item };
    }),
  };
  if (!inventory.captureComplete) {
    snapshot.searchComplete = true;
    snapshot.issues = [...new Set([...snapshot.issues, "宝宝装备采集不完整，请先补采后再查价"])];
    snapshot.items = snapshot.items.map((item) => ({
      ...item,
      status: "incomplete",
      searchStatus: "incomplete",
      searchState: "unsupported",
      reason: "宝宝装备采集不完整，需先补采后再查价",
      issues: [...item.issues, ...inventory.issues, "宝宝装备采集不完整，需先补采后再查价"],
    }));
    return snapshot;
  }
  const pending = snapshot.items.filter(
    (item) =>
      !["unsupported", "untradable", "incomplete"].includes(item.status) &&
      !["completed", "skipped"].includes(item.searchStatus || ""),
  );
  if (pending.length) {
    const source = await createPetGearSource(signal);
    try {
      const result = await source.findCandidates(pending, signal);
      signal.throwIfAborted();
      snapshot.queries = [...new Set([...snapshot.queries, ...result.queries])];
      snapshot.searchItems = [...(snapshot.searchItems || []), ...(result.searchItems || [])];
      for (const item of snapshot.items) {
        const found = result.items.find((value) => value.key === item.key);
        if (!found) continue;
        if (found.skipped) {
          item.searchStatus = found.searchStatus;
          item.searchState = found.searchStatus;
          if (found.note) {
            item.reason = found.note;
            item.issues = [...new Set([...item.issues, found.note])];
          }
          continue;
        }
        const reference = petGearReference(found.candidates);
        item.candidates = found.candidates;
        item.referencePrice = found.searchStatus === "completed" ? reference.referencePrice : null;
        item.similarEstimate = reference.similarEstimate;
        item.status = item.referencePrice === null ? "no_match" : "priced";
        item.query = found.query || "";
        item.reason = found.note;
        item.scopeEvidence = found.scopeEvidence;
        item.searchStatus = found.searchStatus;
        item.searchState = found.searchStatus;
        item.searchCursor = found.searchCursor;
        if (
          found.samplingStopped &&
          found.searchStatus === "pending" &&
          found.searchCursor?.modeIndex === 2 &&
          !found.candidates.some((candidate) => candidate.verified) &&
          !found.searchCursor?.failed.length
        ) {
          item.searchStatus = "skipped";
          item.searchState = "skipped";
          item.samplingStopped = true;
          item.skipReason = "无样本，宝宝装备不计价；市场售价未知";
        } else delete item.samplingStopped;
        item.queriedAt = new Date().toISOString();
        item.issues = [
          ...(reference.referencePrice === null ? reference.similarEstimate.issues : []),
          ...(found.searchStatus !== "completed" && found.note ? [found.note] : []),
        ];
      }
    } finally {
      await source.close();
    }
  }
  snapshot.searchComplete = snapshot.items.every(
    (item) =>
      ["completed", "skipped"].includes(item.searchStatus || "") ||
      ["unsupported", "untradable"].includes(item.status),
  );
  snapshot.issues = [
    ...new Set([
      ...snapshot.issues,
      ...snapshot.items
        .filter((item) => ["read_failed", "pending"].includes(item.searchStatus || ""))
        .flatMap((item) => item.issues),
    ]),
  ];
  snapshot.rawResponse = JSON.stringify({
    searchItems: snapshot.searchItems,
    accounting: snapshot.accounting,
  });
  return snapshot;
}
