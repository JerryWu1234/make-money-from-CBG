import type { SavedRoleRecord } from "../crawler/types";
import type { ValuationResult } from "./valuation-types";
import { defaultConditions, type ConditionGroup } from "./conditions";
import { evaluateDirectConditions } from "./direct-condition-review";

export type Recommendation = {
  status: "recommended" | "manual" | "excluded";
  basis?: "bare-role-discount" | "conditions" | "default-price";
  gap: number | null;
  factors: string[];
  strongerFactors: string[];
  conditionReview?: ReturnType<typeof evaluateDirectConditions>;
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
  const review = evaluateDirectConditions(tree, record, { asking, bare }, value?.condition_review);
  result.conditionReview = review;
  const status = review.results.find((entry) => entry.id === tree.id)?.status;
  result.status = status === "met" ? "recommended" : status === "unknown" ? "manual" : "excluded";
  if (result.status === "recommended") result.basis = conditions ? "conditions" : "default-price";
  return result;
}
