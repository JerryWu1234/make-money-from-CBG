import type { EquipmentCandidate } from "./equipment-pricing";
import { candidateQuoteMatchesPrice, officialSourceIdentity } from "./pricing-integrity";

export type PriceRange = { min: number; max: number };
export type SimilarEstimate = {
  policyVersion: string;
  status: "range" | "insufficient" | "dispersed";
  range: PriceRange | null;
  observedRange?: PriceRange;
  sampleCount: number;
  median?: number;
  issues: string[];
};
export const SIMILAR_POLICY_VERSION = "same-level-comparables-v1";
export const EQUIPMENT_SIMILAR_POLICY_VERSION = "same-core-gem-bands-v4";

export function buildEquipmentEstimate(candidates: EquipmentCandidate[]): SimilarEstimate {
  return buildSimilarEstimate(candidates, true);
}

/** Observed listing bounds, not a confidence interval or an invented adjustment. */
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
  const prices = [...distinct.values()].sort((a, b) => a - b);
  const base = {
    policyVersion,
    sampleCount: prices.length,
    ...(prices.length ? { observedRange: { min: prices[0], max: prices[prices.length - 1] } } : {}),
  };
  if (prices.length < 3)
    return {
      ...base,
      status: "insufficient",
      range: null,
      issues: [
        equipment
          ? "相近装备有效挂牌样本不足3条，暂不生成参考价"
          : "相近配置有效挂牌样本不足3条，暂不生成估价区间",
      ],
    };
  const min = Math.min(...prices),
    max = Math.max(...prices);
  if (max / min > 1.5)
    return {
      ...base,
      status: "dispersed",
      range: null,
      issues: ["相近样本最高价超过最低价的1.5倍，报价过于分散，需要继续核实"],
    };
  return {
    ...base,
    status: "range",
    range: { min, max },
    ...(equipment
      ? {
          median:
            prices.length % 2
              ? prices[Math.floor(prices.length / 2)]
              : Math.round((prices[prices.length / 2 - 1] + prices[prices.length / 2]) * 50) / 100,
        }
      : {}),
    issues: [
      equipment
        ? "参考价为同级同类型、核心特技/特效一致的挂牌样本中位数；套装、宝石、熔炼等差异已保留，未推测折价，不代表成交价"
        : "区间为相近配置的在售挂牌价范围，未根据属性差异推测折价，不代表成交价",
    ],
  };
}
