import type { Evidence } from "./types";

export type Decision = "BUY" | "WATCH" | "PASS" | "NEED_INFO" | "OUT_OF_SCOPE";
export type ValuationSettings = {
  b: number | null;
  a: number | null;
  budget: number | null;
  extraCost: number | null;
  strengthMode: "single" | "cumulative" | null;
  schoolCapConfirmed: boolean;
  capMode: "both" | "effective" | null;
  capTie: "attack" | "magic" | null;
  holyLevelPremium: boolean | null;
  opportunityMode: "formula" | "discrete" | null;
  mountBoundary: "lower" | "upper" | null;
  sumAdvancedMounts: boolean;
  adjustmentMode: "add" | "multiply" | null;
  adjustmentScope: "body" | "all" | null;
  servers: {
    serverId: string;
    age: "one" | "three" | "older" | null;
    rank: number | null;
    goldPrice: number | null;
    goldUnit: number | null;
    baselineUnitConfirmed: boolean;
  }[];
};
export type AnalysisProfile = {
  version: "role-valuation-v1";
  template: string;
  promptHash: string;
  settings: ValuationSettings;
  settingsHash: string;
  calculationVersion: string;
  calculationCompatible: boolean;
  hash: string;
};
export type ValuationItem = {
  name: string;
  input: string;
  formula: string;
  amount: number | null;
  confirmed: boolean;
  evidence: Evidence[];
};
export type ValuationFact = {
  name: string;
  value: string;
  path: string;
  quote: string;
};
export type ValuationResult = {
  decision: Decision;
  asking_price: number | null;
  extra_cost: number | null;
  total_cost: number | null;
  model_value: number | null;
  max_listing_price: number | null;
  ideal_listing_price: number | null;
  margin_of_safety: number | null;
  items: ValuationItem[];
  missing_fields: string[];
  pending_rules: string[];
  reason: string;
  next_action: string;
  known_subtotal: number;
  calculation_version: string;
  body_value?: number | null;
  suggestions?: string[];
  extracted_facts?: ValuationFact[];
  ai_explanation?: string;
};
