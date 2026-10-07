import type { AiProvider } from "../ai/types";
import type { Listing } from "../crawler/types";
import type { AnalysisProfile, ValuationResult } from "./valuation-types";
import type { EquipmentPricingSnapshot } from "./equipment-pricing";
import type { PetPricingSnapshot } from "./pet-pricing";

export type DimensionId = "foundation" | "equipment" | "pets";
export type Evidence = { path: string; value: string; reason: string };
export type Dimension = { score: number | null; reason: string; evidence: Evidence[] };
export type ProductAnalysis = {
  productKey: string;
  inputHash: string;
  summary: string;
  highlights: string[];
  risks: string[];
  missingData: string[];
  dimensions: Record<DimensionId, Dimension>;
  score: number | null;
  valuation?: ValuationResult;
};
export type AnalysisRun = {
  id: string;
  provider: AiProvider;
  model: string;
  ruleVersion: string;
  status: "running" | "paused" | "completed";
  createdAt: string;
  updatedAt: string;
  error: string | null;
  total: number;
  completed: number;
  failed: number;
  queued: number;
  reused: number;
  current: string | null;
  phase?: "equipment_search" | "pet_search" | "analysis" | null;
  profileHash?: string;
  calculationVersion?: string;
};
export type AnalysisItemState =
  | "ready"
  | "waiting_detail"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stale";
export type AnalysisItem = {
  key: string;
  name: string;
  server: string;
  price: string;
  url: string;
  collectedAt: string | null;
  collectionStatus: string;
  state: AnalysisItemState;
  taskId: string | null;
  score: number | null;
  summary: string | null;
  highlights: string[];
  error: string | null;
  valuation?: ValuationResult;
};
export type AnalysisResultItem = {
  taskId: string;
  name: string;
  server: string;
  price: string;
  provider: AiProvider;
  model: string;
  completedAt: string;
  stale: boolean;
  result: ProductAnalysis;
};
export type AnalysisOverview = {
  profile?: Pick<
    AnalysisProfile,
    "hash" | "version" | "promptHash" | "calculationCompatible" | "calculationVersion"
  >;
  counts: { total: number; complete: number; waitingDetail: number };
  run: AnalysisRun | null;
  activeRun: AnalysisRun | null;
  runs: AnalysisRun[];
  ranking: AnalysisItem[];
  records: { page: number; totalPages: number; total: number; items: AnalysisItem[] };
  results: { page: number; totalPages: number; total: number; items: AnalysisResultItem[] };
  history: {
    id: string;
    taskId: string;
    name: string;
    state: string;
    createdAt: string;
    finishedAt: string | null;
    error: string | null;
  }[];
};
export type AnalysisDetail = {
  taskId: string;
  runId: string;
  provider: AiProvider;
  model: string;
  ruleVersion: string;
  listing: Listing;
  state: string;
  inputHash: string;
  inputText: string;
  promptHash: string;
  promptText: string;
  result: ProductAnalysis | null;
  completedAt: string | null;
  error: string | null;
  reusedFrom: string | null;
  profile?: AnalysisProfile | null;
  equipmentPricing?: EquipmentPricingSnapshot | null;
  petPricing?: PetPricingSnapshot | null;
  attempts: {
    id: string;
    state: string;
    createdAt: string;
    finishedAt: string | null;
    rawResponse: string | null;
    usage: unknown;
    error: string | null;
    requestText?: string | null;
    requestHash?: string | null;
  }[];
};
