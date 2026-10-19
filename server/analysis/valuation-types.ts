import type { Evidence } from "./types";

export type Decision = "BUY" | "WATCH" | "PASS" | "NEED_INFO" | "OUT_OF_SCOPE";
export type ValuationSettings = {
  /** Homepage master switch. Missing legacy values default to bare-role analysis. */
  analyzeEquipment?: boolean;
  pricingScope?: "all" | "equipment";
  /** Explicit operator choice to leave jade assets unpriced in this batch. */
  deferJade?: boolean;
  equipmentBaselinePrices?: import("./equipment-baseline").EquipmentBaselinePrices;
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
    source?: "auto" | "manual";
    age: "one" | "three" | "older" | null;
    rank: number | null;
    goldPrice: number | null;
    goldUnit: number | null;
    baselineUnitConfirmed: boolean;
  }[];
};
export type AnalysisProfile = {
  /** Operator confirmation for this product and the exact five skill levels used by the formula. */
  ascendedSchoolFormulaConfirmations?: Record<string, number[]>;
  marketSources?: import("./market").MarketServer[];
  equipmentSearch?: boolean;
  petSearch?: boolean;
  petGearSearch?: boolean;
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
  referenceBasis?: "baseline" | "excluded";
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
  asset_scope?: "body";
  excluded_assets?: Array<{ key: string; name: string; reason: string }>;
  decision: Decision;
  comparison_mode?: "listing-only";
  price_difference?: number | null;
  price_difference_ratio?: number | null;
  price_comparison_scope?: string;
  estimated_value?: number;
  estimated_subtotal_value?: number;
  estimated_value_range?: import("./pricing-estimate").PriceRange;
  estimated_subtotal_range?: import("./pricing-estimate").PriceRange;
  estimated_equipment_range?: import("./pricing-estimate").PriceRange;
  estimated_pet_range?: import("./pricing-estimate").PriceRange;
  estimated_price_difference?: import("./pricing-estimate").PriceRange;
  estimated_comparison?: "below" | "within" | "above";
  estimate_missing_count?: number;
  estimated_sources?: Array<"similar" | "baseline">;
  asking_price: number | null;
  extra_cost: number | null;
  total_cost: number | null;
  model_value: number | null;
  max_total_cost?: number | null;
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
  bare_role_value?: number | null;
  equipment_value?: number | null;
  equipment_pricing?: import("./equipment-pricing").EquipmentPricingSnapshot;
  pet_value?: number | null;
  pet_pricing?: import("./pet-pricing").PetPricingSnapshot;
  suggestions?: string[];
  extracted_facts?: ValuationFact[];
  ai_explanation?: string;
};
