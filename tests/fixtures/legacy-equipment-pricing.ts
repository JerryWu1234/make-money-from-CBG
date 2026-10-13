import type { SavedRoleRecord } from "../../server/crawler/types";
import { makeEquipmentBaseline } from "../../server/analysis/equipment-baseline";
import { equipmentPricingPlan } from "../../server/analysis/equipment-pricing";
import type { ValuationSettings } from "../../server/analysis/valuation-types";

/** Reconstruct saved preset reports; new production plans must always search. */
export function legacyEquipmentPricing(record: SavedRoleRecord, settings: ValuationSettings) {
  const snapshot = equipmentPricingPlan(record, settings);
  for (const item of snapshot.items) {
    const baseline = makeEquipmentBaseline(item, String(record.listing.serverId), settings);
    if (baseline) item.baselineEstimate = baseline;
  }
  return snapshot;
}
