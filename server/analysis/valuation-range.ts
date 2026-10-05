import type { SavedRoleRecord } from "../crawler/types";
import {
  equipmentInventory,
  type EquipmentPricingItem,
  type EquipmentPricingSnapshot,
} from "./equipment-pricing";
import { petInventory, type PetPricingItem, type PetPricingSnapshot } from "./pet-pricing";
import { buildSimilarEstimate, type PriceRange } from "./pricing-estimate";
import { validateExactPricing } from "./pricing-integrity";
import type { AnalysisProfile, ValuationResult } from "./valuation-types";

const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const add = (left: PriceRange, right: PriceRange): PriceRange => ({
  min: round(left.min + right.min),
  max: round(left.max + right.max),
});
const money = (value: number) => "¥" + value.toFixed(2);

/** Keep comparable ranges separate from exact prices and partial known subtotals. */
export function applyValuationRange(
  result: ValuationResult,
  bare: ValuationResult,
  record: SavedRoleRecord,
  profile: AnalysisProfile,
): ValuationResult {
  if (result.decision === "OUT_OF_SCOPE" || result.model_value !== null) return result;
  let total: PriceRange = { min: bare.model_value ?? 0, max: bare.model_value ?? 0 };
  let similarSubtotal: PriceRange = { min: 0, max: 0 };
  let missing = bare.model_value === null ? 1 : 0;
  let similar = 0;
  const include = (
    snapshot: EquipmentPricingSnapshot | PetPricingSnapshot | undefined,
    inputHash: string,
    captured: boolean,
    inventoryItems: Array<EquipmentPricingItem | PetPricingItem>,
  ) => {
    const age = snapshot ? Date.now() - Date.parse(snapshot.searchedAt) : Infinity;
    if (
      !captured ||
      !snapshot?.captureComplete ||
      snapshot.inputHash !== inputHash ||
      !validateExactPricing(snapshot, inventoryItems) ||
      age < -60_000 ||
      age >= 24 * 60 * 60 * 1000 ||
      !Number.isFinite(age)
    ) {
      missing += Math.max(1, inventoryItems.length);
      return;
    }
    for (const item of snapshot.items) {
      if (
        item.status === "priced" &&
        item.referencePrice !== null &&
        Number.isFinite(item.referencePrice) &&
        item.referencePrice > 0
      ) {
        total = add(total, { min: item.referencePrice, max: item.referencePrice });
        continue;
      }
      const estimate = buildSimilarEstimate(item.candidates);
      if (
        item.status === "no_match" &&
        item.similarEstimate?.status === "range" &&
        estimate.range &&
        item.similarEstimate.policyVersion === estimate.policyVersion &&
        item.similarEstimate.range?.min === estimate.range.min &&
        item.similarEstimate.range.max === estimate.range.max
      ) {
        total = add(total, estimate.range);
        similarSubtotal = add(similarSubtotal, estimate.range);
        similar++;
      } else missing++;
    }
  };
  if (profile.equipmentSearch) {
    const inventory = equipmentInventory(record);
    include(
      result.equipment_pricing,
      inventory.inputHash,
      inventory.captureComplete,
      inventory.items,
    );
  }
  if (profile.petSearch) {
    const inventory = petInventory(record);
    include(result.pet_pricing, inventory.inputHash, inventory.captureComplete, inventory.items);
  }
  if (!similar) return result;
  const subtotal = add({ min: result.known_subtotal, max: result.known_subtotal }, similarSubtotal);
  if (missing)
    return {
      ...result,
      estimated_subtotal_range: subtotal,
      estimate_missing_count: missing,
      reason:
        "已找到部分参考价区间" +
        money(subtotal.min) +
        "—" +
        money(subtotal.max) +
        "；还缺" +
        missing +
        "项，不能作为完整估值比较挂牌价。",
    };
  const asking = result.asking_price;
  const difference =
    asking !== null && asking > 0
      ? { min: round(total.min - asking), max: round(total.max - asking) }
      : undefined;
  const relation = difference
    ? difference.min > 0
      ? "below"
      : difference.max < 0
        ? "above"
        : "within"
    : undefined;
  const text =
    relation === "below"
      ? "挂牌低于参考区间下限"
      : relation === "above"
        ? "挂牌高于参考区间上限"
        : "挂牌落在参考区间内";
  return {
    ...result,
    estimated_value_range: total,
    estimated_subtotal_range: subtotal,
    estimated_price_difference: difference,
    estimated_comparison: relation,
    estimate_missing_count: 0,
    reason:
      "参考估值区间" +
      money(total.min) +
      "—" +
      money(total.max) +
      (difference
        ? "，挂牌" + money(asking!) + "；" + text + "。"
        : "；挂牌价格缺失，暂不能比较。") +
      "包含相近配置挂牌样本，未推测属性差异折价。",
    next_action: "查看相近样本的配置差异与来源；挂牌价不代表成交价。",
    suggestions: ["查看相近样本的配置差异与来源；区间不代表成交价格。"],
  };
}
