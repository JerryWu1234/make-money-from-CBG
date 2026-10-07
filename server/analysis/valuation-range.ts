import type { SavedRoleRecord } from "../crawler/types";
import {
  equipmentInventory,
  type EquipmentPricingItem,
  type EquipmentPricingSnapshot,
} from "./equipment-pricing";
import { petInventory, type PetPricingItem, type PetPricingSnapshot } from "./pet-pricing";
import {
  buildEquipmentEstimate,
  buildSimilarEstimate,
  EQUIPMENT_SIMILAR_POLICY_VERSION,
  type PriceRange,
} from "./pricing-estimate";
import { validateExactPricing } from "./pricing-integrity";
import { validateEquipmentBaseline } from "./equipment-baseline";
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
  let referenceSubtotal: PriceRange = { min: 0, max: 0 };
  let referenceValue = 0;
  let knownAssetValue = 0;
  const assetRanges: Pick<ValuationResult, "estimated_equipment_range" | "estimated_pet_range"> =
    {};
  let equipmentReferences = 0;
  let allReferencesHaveValue = true;
  let missing = bare.model_value === null ? 1 : 0;
  let similar = 0;
  let baseline = 0;
  const missingFields = [...bare.missing_fields];
  const recoverySuggestions = new Set([...(result.suggestions || []), ...(bare.suggestions || [])]);
  const missingAsset = (item: EquipmentPricingItem | PetPricingItem, reason?: string) => {
    missingFields.push(
      item.name +
        "（" +
        item.key +
        "）：" +
        (reason || item.baselineInvalidReason || item.issues.join("；") || "缺少可核验价格"),
    );
    missing++;
  };
  const baselineSources = new Set<"historical" | "preset" | "excluded">();
  const include = (
    snapshot: EquipmentPricingSnapshot | PetPricingSnapshot | undefined,
    inputHash: string,
    captured: boolean,
    inventoryItems: Array<EquipmentPricingItem | PetPricingItem>,
    allowBaseline = false,
    inventoryIssues: string[] = [],
  ) => {
    const age = snapshot ? Date.now() - Date.parse(snapshot.searchedAt) : Infinity;
    if (
      !snapshot ||
      snapshot.captureComplete !== captured ||
      snapshot.inputHash !== inputHash ||
      !validateExactPricing(snapshot, inventoryItems) ||
      age < -60_000 ||
      age >= 24 * 60 * 60 * 1000 ||
      !Number.isFinite(age)
    ) {
      missing += Math.max(1, inventoryItems.length);
      missingFields.push(...inventoryIssues, ...(snapshot?.issues || []));
      missingFields.push(
        (allowBaseline ? "装备" : "宝宝") +
          "资料或查价快照未通过完整性、身份或时效核验，需要补采或重新查价",
      );
      return;
    }
    const previousMissing = missing;
    let assetRange: PriceRange | undefined;
    const addAsset = (price: PriceRange) => {
      assetRange = add(assetRange || { min: 0, max: 0 }, price);
      total = add(total, price);
    };
    missingFields.push(...snapshot.issues);
    for (const item of snapshot.items) {
      if (
        item.status === "priced" &&
        item.referencePrice !== null &&
        Number.isFinite(item.referencePrice) &&
        item.referencePrice > 0
      ) {
        addAsset({ min: item.referencePrice, max: item.referencePrice });
        knownAssetValue = round(knownAssetValue + item.referencePrice);
        continue;
      }
      if (allowBaseline && item.baselineEstimate) {
        const estimate = item.baselineEstimate;
        if (
          !item.baselineInvalidReason &&
          validateEquipmentBaseline(item, record.listing.serverId, profile.settings) &&
          estimate.amount !== null &&
          Number.isFinite(estimate.amount) &&
          estimate.amount >= 0
        ) {
          const price = { min: estimate.amount, max: estimate.amount };
          addAsset(price);
          referenceSubtotal = add(referenceSubtotal, price);
          referenceValue = round(referenceValue + estimate.amount);
          baseline++;
          baselineSources.add(estimate.source.basis);
        } else missingAsset(item);
        continue;
      }
      const equipmentReference =
        allowBaseline && item.similarEstimate?.policyVersion === EQUIPMENT_SIMILAR_POLICY_VERSION;
      const estimate = equipmentReference
        ? buildEquipmentEstimate(item.candidates)
        : buildSimilarEstimate(item.candidates);
      if (
        item.status === "no_match" &&
        item.similarEstimate?.status === "range" &&
        estimate.range &&
        item.similarEstimate.policyVersion === estimate.policyVersion &&
        item.similarEstimate.range?.min === estimate.range.min &&
        item.similarEstimate.range.max === estimate.range.max &&
        item.similarEstimate.median === estimate.median
      ) {
        addAsset(estimate.range);
        referenceSubtotal = add(referenceSubtotal, estimate.range);
        if (equipmentReference && estimate.median !== undefined) {
          referenceValue = round(referenceValue + estimate.median);
          equipmentReferences++;
        } else allReferencesHaveValue = false;
        similar++;
      } else missingAsset(item);
    }
    if (assetRange)
      assetRanges[allowBaseline ? "estimated_equipment_range" : "estimated_pet_range"] = assetRange;
    if (!captured) {
      missing = Math.max(missing, previousMissing + 1);
      missingFields.push(
        ...inventoryIssues,
        (allowBaseline ? "装备" : "宝宝") + "清单尚未完整，以上仅为已核验项目的小计",
      );
    }
    if (captured && missing === previousMissing)
      recoverySuggestions.delete(
        allowBaseline
          ? "查看装备查价模块的候选与匹配原因；可靠同类报价不足时继续保留未定价。"
          : "查看宝宝查价的匹配原因；未找到可靠同类报价的宝宝保留未定价。",
      );
  };
  if (profile.equipmentSearch) {
    const inventory = equipmentInventory(record);
    include(
      result.equipment_pricing,
      inventory.inputHash,
      inventory.captureComplete,
      inventory.items,
      true,
      inventory.issues,
    );
  }
  if (profile.petSearch) {
    const inventory = petInventory(record);
    include(
      result.pet_pricing,
      inventory.inputHash,
      inventory.captureComplete,
      inventory.items,
      false,
      inventory.issues,
    );
  }
  const finalMissing = [...new Set(missingFields)];
  const knownSubtotal = round(bare.known_subtotal + knownAssetValue);
  const pendingSuggestions = missing
    ? ["逐项查看剩余未定价资产的资料、实际筛选条件与候选拒绝原因，再补采或补查。"]
    : [];
  const finalSuggestions = [...new Set([...recoverySuggestions, ...pendingSuggestions])];
  if (!similar && !baseline)
    return {
      ...result,
      ...assetRanges,
      known_subtotal: knownSubtotal,
      missing_fields: finalMissing,
      estimate_missing_count: missing,
      suggestions: finalSuggestions,
      next_action: finalSuggestions.join(""),
    };
  const sources: Array<"similar" | "baseline"> = [
    ...(similar ? ["similar" as const] : []),
    ...(baseline ? ["baseline" as const] : []),
  ];
  const basisLabels = {
    historical: "历史参考价",
    preset: "人工预设价",
    excluded: "低值未计入",
  };
  const disclosure =
    (similar ? "包含相近配置挂牌样本，未推测属性差异折价。" : "") +
    (baseline
      ? "包含默认参考价（" +
        [...baselineSources].map((basis) => basisLabels[basis]).join("、") +
        "），这些默认值不是同配置挂牌报价。" +
        (baselineSources.has("excluded") ? "低值排除不代表其市场售价为0。" : "")
      : "");
  const suggestions = [
    ...finalSuggestions,
    ...(similar ? ["查看相近样本的配置差异与来源；挂牌价不代表成交价。"] : []),
    ...(baseline
      ? [
          baselineSources.has("historical") || baselineSources.has("preset")
            ? "核对默认参考价和区服金价；历史参考或人工预设可在分析设置调整。"
            : "查看低价值资产排除规则；本次估值未计入，不代表其市场售价为0。",
        ]
      : []),
  ];
  const subtotal = add({ min: knownSubtotal, max: knownSubtotal }, referenceSubtotal);
  const referenceAmount =
    equipmentReferences && allReferencesHaveValue
      ? round(knownSubtotal + referenceValue)
      : undefined;
  if (missing)
    return {
      ...result,
      ...assetRanges,
      known_subtotal: knownSubtotal,
      missing_fields: finalMissing,
      estimated_subtotal_range: subtotal,
      ...(referenceAmount !== undefined ? { estimated_subtotal_value: referenceAmount } : {}),
      estimated_sources: sources,
      estimate_missing_count: missing,
      reason:
        (referenceAmount !== undefined
          ? "已算参考小计" + money(referenceAmount)
          : "已找到部分参考价区间" + money(subtotal.min) + "—" + money(subtotal.max)) +
        "；还缺" +
        missing +
        "项，不能作为完整估值比较挂牌价。" +
        disclosure,
      suggestions: [...new Set(suggestions)],
      next_action: [...new Set(suggestions)].join(""),
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
    ...assetRanges,
    known_subtotal: knownSubtotal,
    missing_fields: finalMissing,
    estimated_value_range: total,
    estimated_subtotal_range: subtotal,
    ...(referenceAmount !== undefined
      ? { estimated_value: referenceAmount, estimated_subtotal_value: referenceAmount }
      : {}),
    estimated_sources: sources,
    estimated_price_difference: difference,
    estimated_comparison: relation,
    estimate_missing_count: 0,
    reason:
      (referenceAmount !== undefined
        ? "总参考估值" +
          money(referenceAmount) +
          "；样本合计范围" +
          money(total.min) +
          "—" +
          money(total.max)
        : (baseline ? "参考估值（含默认参考价）" : "参考估值区间") +
          money(total.min) +
          "—" +
          money(total.max)) +
      (difference
        ? "，挂牌" + money(asking!) + "；" + text + "。"
        : "；挂牌价格缺失，暂不能比较。") +
      disclosure,
    next_action: suggestions.join(""),
    suggestions,
  };
}
