import { prepareAnalysisClient } from "../ai-connection";
import type { AiProvider } from "../ai/types";
import { crawlDatabase } from "../crawler/controller";
import { AnalysisRunner } from "./runner";
import { AnalysisStore } from "./store";
import { refreshMarket, marketServers } from "./market";
import { loadProfile, saveProfile, PROMPT_FILE } from "./profile";

type AnalysisService = { store: AnalysisStore; runner: AnalysisRunner };
const serviceKey = Symbol.for("cbg.analysis-service.v1");
const runtime = globalThis as typeof globalThis & { [serviceKey]?: AnalysisService };
function service() {
  let analysis = runtime[serviceKey];
  // A page or Vite module reload must keep the in-flight queue and its abort controller.
  if (!analysis || (!(analysis.store instanceof AnalysisStore) && !analysis.runner.isRunning())) {
    const store = new AnalysisStore(crawlDatabase());
    analysis = runtime[serviceKey] = {
      store,
      runner: new AnalysisRunner(store, prepareAnalysisClient),
    };
  }
  return analysis;
}
export function analysisOverview(options: Parameters<AnalysisStore["overview"]>[0]) {
  service().store.recover();
  const profile = loadProfile(service().store.db);
  return {
    ...service().store.overview({ ...options, currentProfile: profile }),
    profile: {
      hash: profile.hash,
      version: profile.version,
      promptHash: profile.promptHash,
      calculationCompatible: profile.calculationCompatible,
      calculationVersion: profile.calculationVersion,
    },
  };
}
export async function analysisSettings() {
  const db = service().store.db;
  let marketError: string | undefined;
  try {
    await refreshMarket(db);
  } catch (error) {
    marketError = error instanceof Error ? error.message : "行情读取失败";
  }
  const servers = db
    .prepare(
      "SELECT DISTINCT json_extract(listing_json,'$.serverId') serverId,json_extract(listing_json,'$.serverName') serverName FROM listings ORDER BY serverId",
    )
    .all()
    .map((row) => ({
      serverId: String(row.serverId),
      serverName: String(row.serverName || row.serverId),
    }));
  return {
    profile: loadProfile(db),
    promptFile: PROMPT_FILE,
    servers,
    marketError,
    market: marketServers(db),
  };
}
export function saveAnalysisSettings(input: unknown) {
  const profile = saveProfile(service().store.db, input);
  return { profile };
}
export async function startAnalysis(
  provider: AiProvider,
  force = false,
  sample = false,
  model?: string,
  sampleSize = 1,
  productKeys?: string[],
) {
  try {
    await refreshMarket(service().store.db);
  } catch {
    /* 缺失行情仍可分析，结果明确列出缺项。 */
  }
  const profile = loadProfile(service().store.db);
  const id = await service().runner.start(
    provider,
    force || sample,
    profile,
    sample,
    model,
    sampleSize,
    productKeys,
  );
  return service().store.run(id);
}
export async function resumeAnalysis(id: string, retry = false) {
  await service().runner.resume(id, retry);
  return service().store.run(id);
}
export async function pauseAnalysis(id?: string) {
  await service().runner.pause(id);
  return id ? service().store.run(id) : service().store.activeRun();
}
export function analysisDetail(id: string) {
  const detail = service().store.detail(id, loadProfile(service().store.db));
  if (!detail) throw new Error("商品分析记录不存在");
  return detail;
}
export function isAnalyzing() {
  return service().runner.isRunning();
}
export async function shutdownAnalysis() {
  if (runtime[serviceKey]) await runtime[serviceKey].runner.shutdown();
}
