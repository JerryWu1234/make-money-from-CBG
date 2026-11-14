import type { SavedRoleRecord } from "../crawler/types";
import type { ValuationResult } from "./valuation-types";
import {
  defaultConditions,
  evaluateConditions,
  normalizeConditions,
  type ConditionGroup,
} from "./conditions";

export type Recommendation = {
  status: "recommended" | "manual" | "excluded";
  basis?: "bare-role-discount" | "conditions" | "default-price";
  gap: number | null;
  factors: string[];
  strongerFactors: string[];
  conditionReview?: ReturnType<typeof evaluateConditions>;
};

export function recommendationFor(
  record: SavedRoleRecord,
  value?: ValuationResult,
  conditions?: ConditionGroup,
): Recommendation {
  const result: Recommendation = {
    status: "excluded",
    gap: null,
    factors: [],
    strongerFactors: [],
  };
  const asking = Number(record.listing.price),
    bare = value?.bare_role_value;
  if (
    !Number.isFinite(asking) ||
    asking <= 0 ||
    typeof bare !== "number" ||
    !Number.isFinite(bare) ||
    bare < 0 ||
    value?.decision === "NEED_INFO"
  )
    return result;
  result.gap = (Math.round(asking * 100) - Math.round(bare * 100)) / 100;
  const tree = conditions || defaultConditions();
  // Only evidence from this exact saved configuration can satisfy text conditions.
  const evidence =
    conditions &&
    JSON.stringify(normalizeConditions(value?.condition_review?.tree)) ===
      JSON.stringify(normalizeConditions(conditions))
      ? value?.condition_review?.results
      : [];
  const review = evaluateConditions(tree, evidence, { asking, bare });
  result.conditionReview = review;
  const status = review.results.find((entry) => entry.id === tree.id)?.status;
  result.status = status === "met" ? "recommended" : status === "unknown" ? "manual" : "excluded";
  if (result.status === "recommended") result.basis = conditions ? "conditions" : "default-price";
  return result;
}
