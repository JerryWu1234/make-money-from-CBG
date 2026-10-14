import type { EquipmentCandidate } from "./equipment-pricing";
import {
  candidateQuoteMatchesPrice,
  officialSourceIdentity,
  priceMedian,
  priceAverage,
  EQUIPMENT_QUOTE_LIMIT,
} from "./pricing-integrity";

export type PriceRange = { min: number; max: number };
export type SimilarEstimate = {
  policyVersion: string;
  status: "range" | "insufficient" | "dispersed";
  range: PriceRange | null;
  observedRange?: PriceRange;
  sampleCount: number;
  median?: number;
  average?: number;
  issues: string[];
};
export const SIMILAR_POLICY_VERSION = "protected-core-first-five-average-v6";
export const EQUIPMENT_SIMILAR_POLICY_VERSION = "bounded-attributes-first-five-average-v8";

export function buildEquipmentEstimate(candidates: EquipmentCandidate[]): SimilarEstimate {
  return buildSimilarEstimate(candidates, true);
}

/** Keep official listing order, deduplicate, and average up to five verified quotations. */
export function buildSimilarEstimate(
  candidates: EquipmentCandidate[],
  equipment = false,
): SimilarEstimate {
  const policyVersion = equipment ? EQUIPMENT_SIMILAR_POLICY_VERSION : SIMILAR_POLICY_VERSION;
  const distinct = new Map<string, number>();
  for (const candidate of candidates) {
    const age = candidate.fetchedAt ? Date.now() - Date.parse(candidate.fetchedAt) : Infinity;
    if (
      candidate.verified !== true ||
      candidate.matchType !== "similar" ||
      candidate.priceType !== "listing" ||
      candidate.price === null ||
      !Number.isFinite(candidate.price) ||
      candidate.price <= 0 ||
      candidate.price > 1e9 ||
      !candidate.sourceHash ||
      !candidate.quote ||
      !candidateQuoteMatchesPrice(candidate) ||
      !Number.isFinite(age) ||
      age < -60_000 ||
      age >= 24 * 60 * 60 * 1000
    )
      continue;
    const identity = officialSourceIdentity(candidate.url);
    if (!identity) continue;
    const previous = distinct.get(identity);
    if (previous !== undefined && previous !== candidate.price) {
      return {
        policyVersion,
        status: "insufficient",
        range: null,
        sampleCount: distinct.size,
        issues: ["同一商品的报价冲突，需要重新读取"],
      };
    }
    distinct.set(identity, candidate.price);
  }
  const prices = [...distinct.values()].slice(0, EQUIPMENT_QUOTE_LIMIT).sort((a, b) => a - b);
  const base = {
    policyVersion,
    sampleCount: prices.length,
    ...(prices.length ? { observedRange: { min: prices[0], max: prices[prices.length - 1] } } : {}),
  };
  if (!prices.length)
    return {
      ...base,
      status: "insufficient",
      range: null,
      issues: ["没有已核验的独立在售商品，无法计算挂牌平均价"],
    };
  const min = Math.min(...prices),
    max = Math.max(...prices);
  return {
    ...base,
    status: "range",
    range: { min, max },
    median: priceMedian(prices)!,
    average: priceAverage(prices)!,
    issues: [
      `参考价为前${prices.length}件已核实相近在售商品的算术平均价，目标为${EQUIPMENT_QUOTE_LIMIT}件；保留挂牌范围及配置差异，不代表成交价`,
      ...(prices.length < EQUIPMENT_QUOTE_LIMIT
        ? [`仅${prices.length}件样本，须确认本次检索已结束后才采用实际样本数`]
        : []),
      ...(max / min > 1.5
        ? ["挂牌价差超过1.5倍，均价受高价样本影响，需结合范围和配置差异判断"]
        : []),
    ],
  };
}
