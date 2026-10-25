import type { AiProvider } from "../ai/types";
import type { CrawlStatus, Listing } from "../crawler/types";
import type { AnalysisProfile, ValuationResult } from "./valuation-types";
import type { EquipmentPricingSnapshot } from "./equipment-pricing";
import type { PetPricingSnapshot } from "./pet-pricing";

export const DEFAULT_ANALYSIS_CONCURRENCY = 10;
export function analysisConcurrency(value: unknown = DEFAULT_ANALYSIS_CONCURRENCY): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("分析并发数必须是正整数");
  return value;
}
export type AnalysisLane = "new" | "old";
export function analysisLaneLimits(concurrency: number) {
  const newLimit = concurrency === 1 ? 1 : Math.min(concurrency - 1, Math.ceil(concurrency * 0.7));
  return { newLimit, oldLimit: concurrency - newLimit };
}

export type DimensionId = "foundation" | "equipment" | "pets";
export type CapturedAssetCounts = {
  equipment: number | null;
  jewelry: number | null;
  pets: number;
  equipmentTotal?: number;
  equipmentItems?: Array<{
    name: string;
    level: number | null;
    gemLevel: number | null;
    specialSkills: string[];
    specialEffects: string[];
    sets: string[];
  }>;
};
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
  concurrency?: number;
  runningCount?: number;
  newRunning?: number;
  oldRunning?: number;
  newLimit?: number;
  oldLimit?: number;
  currentItems?: string[];
  assetCounts?: CapturedAssetCounts | null;
  id: string;
  provider: AiProvider;
  model: string;
  ruleVersion: string;
  status: "running" | "paused" | "completed";
  createdAt: string;
  updatedAt: string;
  error: string | null;
  pauseNotice?: string | null;
  total: number;
  completed: number;
  failed: number;
  queued: number;
  waitingPricing?: number;
  pricingProgress?: {
    assetName?: string;
    page?: number;
    validSamples?: number;
    retryCount?: number;
    round: number;
    startedAt: string;
    updatedAt: string;
  } | null;
  reused: number;
  current: string | null;
  phase?:
    | "equipment_search"
    | "pet_search"
    | "pet_gear_search"
    | "analysis"
    | "waiting_capture"
    | null;
  profileHash?: string;
  marketExpired?: boolean;
  calculationVersion?: string;
};
export type AnalysisItemState =
  | "ready"
  | "waiting_detail"
  | "waiting_pricing"
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
  lastSeenAt?: string | null;
  collectionStatus: string;
  state: AnalysisItemState;
  taskId: string | null;
  score: number | null;
  summary: string | null;
  highlights: string[];
  error: string | null;
  profileChanged?: boolean;
  valuation?: ValuationResult;
  recommendation?: import("./recommendation").Recommendation;
  recommendationViewed?: boolean;
  assetSummary?: { equipment: string; pets: string } | null;
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
  profileHash: string | null;
  profileChanged: boolean;
  result: ProductAnalysis;
};
export type AnalysisOverview = {
  captureTasks?: { total: number; pending: number; failed: number };
  captureActivity?: Pick<CrawlStatus, "running" | "phase"> & {
    inFlight?: number;
  };
  capturePreparation?: {
    total: number;
    completed: number;
    current: string | null;
    message: string;
  };
  profile?: Pick<
    AnalysisProfile,
    | "hash"
    | "version"
    | "promptHash"
    | "calculationCompatible"
    | "calculationVersion"
    | "equipmentSearch"
    | "petSearch"
  >;
  counts: {
    total: number;
    complete: number;
    waitingDetail: number;
    pendingDetail: number;
    failedDetail: number;
  };
  run: AnalysisRun | null;
  activeRun: AnalysisRun | null;
  runs: AnalysisRun[];
  ranking: AnalysisItem[];
  manualReview?: AnalysisItem[];
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
  assetCounts?: CapturedAssetCounts | null;
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
  requestTemplate?: string;
  result: ProductAnalysis | null;
  completedAt: string | null;
  error: string | null;
  reusedFrom: string | null;
  profile?: AnalysisProfile | null;
  profileChanged?: boolean;
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
