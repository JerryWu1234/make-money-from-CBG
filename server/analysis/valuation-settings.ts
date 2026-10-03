import type { ValuationSettings } from "./valuation-types";

/** Explicit, editable platform policy. Market prices and transaction fees have no defaults. */
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
export const RECOMMENDED_BUY_FACTOR = 0.8;
