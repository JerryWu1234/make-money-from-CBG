import type { ValuationSettings } from "./valuation-types";

/** Explicit, editable valuation rules. Market prices have no guessed defaults. */
export const RECOMMENDED_RULES = {
  strengthMode: "single",
  schoolCapConfirmed: true,
  capMode: "effective",
  capTie: "attack",
  holyLevelPremium: false,
  opportunityMode: "formula",
  mountBoundary: "lower",
  sumAdvancedMounts: true,
  adjustmentMode: "add",
  adjustmentScope: "body",
} satisfies Partial<ValuationSettings>;
/** Retained for historical profiles; listing comparisons do not apply a buying factor. */
export const RECOMMENDED_BUY_FACTOR = 0.8;
