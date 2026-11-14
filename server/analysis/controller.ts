import {
  assertConditionsCompiled,
  conditionNodes,
  normalizeConditions,
  type ConditionGroup,
} from "./conditions";
import { compileConditionTexts } from "./condition-compiler";
import { prepareConditionRules } from "./condition-rule-cache";
import { aiProvider } from "../ai-connection";
import { prepareAnalysisClient } from "../ai-connection";
import type { AiProvider } from "../ai/types";
import { crawlDatabase, crawlStatus } from "../crawler/controller";
import { AnalysisRunner } from "./runner";
import { AnalysisStore } from "./store";
import { EXPIRED_MARKET_NOTICE, refreshMarket, marketServers } from "./market";
import { createProfile, loadProfile, saveProfile, PROMPT_FILE } from "./profile";
import { validateSampleSelection } from "./sample-selection";
import { reconcileCapturedEquipmentCategories } from "./equipment-category-evidence";
import { analysisConcurrency, DEFAULT_ANALYSIS_CONCURRENCY } from "./types";
import { assertServiceOpen } from "../service-lifecycle";
import { confirmAscendedSchoolFormula } from "./school-confirmation";
import { overviewOffThread, shutdownOverviewWorkers } from "./overview-worker";

type AnalysisService = {
  store: AnalysisStore;
  runner: AnalysisRunner;
};
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
export function appendCapturedAnalysis() {
  return runtime[serviceKey]?.runner.appendCaptured() || 0;
}
function overviewStatus(profile: ReturnType<typeof loadProfile>) {
  const capture = crawlStatus();
  return {
    ...(capture
      ? {
          captureActivity: {
            running: capture.running,
            phase: capture.phase,
            ...(capture.running && (capture.phase === "collecting" || capture.phase === "retrying")
              ? { inFlight: (capture.newRunning || 0) + (capture.oldRunning || 0) }
              : {}),
          },
        }
      : {}),
    profile: {
      hash: profile.hash,
      version: profile.version,
      promptHash: profile.promptHash,
      calculationCompatible: profile.calculationCompatible,
      calculationVersion: profile.calculationVersion,
      equipmentSearch: profile.equipmentSearch,
      petSearch: profile.petSearch,
    },
  };
}
export function analysisOverview(options: Parameters<AnalysisStore["overview"]>[0]) {
  service().store.recover();
  const profile = loadProfile(service().store.db, PROMPT_FILE, { allowExpiredMarket: true });
  return {
    ...service().store.overview({ ...options, currentProfile: profile }),
    ...overviewStatus(profile),
  };
}
export async function analysisOverviewAsync(
  options: Parameters<AnalysisStore["overview"]>[0],
  signal?: AbortSignal,
) {
  service().store.recover();
  const profile = loadProfile(service().store.db, PROMPT_FILE, { allowExpiredMarket: true });
  const store = service().store;
  const file = String(store.db.prepare("PRAGMA database_list").get()?.file || "");
  const overview = file
    ? await overviewOffThread(file, { ...options, currentProfile: profile }, signal)
    : await store.overviewAsync({ ...options, currentProfile: profile }, signal);
  return { ...overview, ...store.progress(options), ...overviewStatus(profile) };
}
export function analysisProgress(options: Parameters<AnalysisStore["progress"]>[0]) {
  const current = service();
  current.store.recover();
  const profile = loadProfile(current.store.db, PROMPT_FILE, { allowExpiredMarket: true });
  return { ...current.store.progress(options), ...overviewStatus(profile) };
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
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("分析设置格式错误");
  const profile = saveProfile(service().store.db, input);
  return { profile };
}
export async function compileAnalysisConditions(
  input: Record<string, unknown>,
  signal: AbortSignal,
) {
  assertServiceOpen();
  const tree = normalizeConditions(input.conditions);
  if (!tree) throw new Error("请先输入文字条件");
  const provider = aiProvider(input.provider ?? "codex");
  if (
    input.model !== undefined &&
    (typeof input.model !== "string" || !input.model.trim() || input.model.length > 200)
  )
    throw new Error("请选择有效的解析模型");
  const textNodes = conditionNodes(tree).filter((node) => !("children" in node) && !node.price);
  if (!textNodes.length) return { conditions: tree };
  const compiled = await compileConditionTexts(
    textNodes.map((node) => ({ id: node.id, text: (node as { text: string }).text })),
    {
      provider,
      model: input.model as string | undefined,
      signal,
    },
  );
  signal.throwIfAborted();
  const rules = new Map(compiled.map((entry) => [entry.id, entry.rule]));
  const attach = (group: ConditionGroup): ConditionGroup => ({
    ...group,
    children: group.children.map((node) =>
      "children" in node ? attach(node) : node.price ? node : { ...node, rule: rules.get(node.id) },
    ),
  });
  const conditions = normalizeConditions(attach(tree));
  assertConditionsCompiled(conditions);
  return { conditions };
}

export function confirmSchoolFormula(productKeys: unknown, confirmed: unknown) {
  assertServiceOpen();
  return confirmAscendedSchoolFormula(service().store.db, productKeys, confirmed);
}
export async function startAnalysis(
  provider: AiProvider,
  force = false,
  sample = false,
  model?: string,
  sampleSize = 1,
  productKeys?: string[],
  equipmentOnly = false,
  concurrency = DEFAULT_ANALYSIS_CONCURRENCY,
) {
  assertServiceOpen();
  analysisConcurrency(concurrency);
  validateSampleSelection(sample, sampleSize, productKeys);
  const analysis = service();
  if (sample && !analysis.runner.isRunning()) {
    const keys =
      productKeys ||
      analysis.store.db
        .prepare(
          "SELECT key FROM listings WHERE status='complete' AND detail_json IS NOT NULL ORDER BY key ASC LIMIT ?",
        )
        .all(sampleSize)
        .map((row) => String(row.key));
    if (keys.length) reconcileCapturedEquipmentCategories(analysis.store.db, keys);
  }
  try {
    await refreshMarket(service().store.db);
  } catch {
    /* 缺失行情仍可分析，结果明确列出缺项。 */
  }
  assertServiceOpen();
  // Interpret saved text once, then use the same evidence checks for every product.
  const currentProfile = await prepareConditionRules(analysis.store.db, { provider, model });
  const profile = equipmentOnly
    ? {
        ...createProfile(currentProfile.template, currentProfile.settings, true, false),
        marketSources: currentProfile.marketSources,
        ...(currentProfile.ascendedSchoolFormulaConfirmations
          ? {
              ascendedSchoolFormulaConfirmations: currentProfile.ascendedSchoolFormulaConfirmations,
            }
          : {}),
      }
    : currentProfile;
  assertServiceOpen();
  const id = await service().runner.start(
    provider,
    force || sample,
    profile,
    sample,
    model,
    sampleSize,
    productKeys,
    concurrency,
  );
  if (equipmentOnly) {
    const frozen = service()
      .store.db.prepare("SELECT profile_json FROM analysis_runs WHERE id=?")
      .get(id);
    const saved = frozen?.profile_json ? JSON.parse(String(frozen.profile_json)) : null;
    if (!saved?.equipmentSearch || saved.petSearch !== false || saved.petGearSearch !== false)
      throw new Error("当前运行批次不是只查装备，请先暂停，再按本次范围开始新分析");
  }
  return service().store.run(id);
}
export async function resumeAnalysis(id: string, retry = false, concurrency?: number) {
  assertServiceOpen();
  if (concurrency !== undefined) analysisConcurrency(concurrency);
  const analysis = service();
  const run = analysis.store.run(id);
  if (!run) throw new Error("分析批次不存在");
  if (run.marketExpired) throw new Error(EXPIRED_MARKET_NOTICE);
  await prepareConditionRules(analysis.store.db, { provider: run.provider, model: run.model });
  if (!analysis.runner.isRunning()) {
    const row = analysis.store.db.prepare("SELECT id FROM analysis_runs WHERE id=?").get(id);
    if (!row) throw new Error("分析批次不存在");
    const keys = analysis.store.db
      .prepare(
        "SELECT listing_key FROM analysis_tasks WHERE run_id=? AND status IN ('queued','waiting_pricing','failed')",
      )
      .all(id)
      .map((task) => String(task.listing_key));
    if (keys.length) reconcileCapturedEquipmentCategories(analysis.store.db, keys);
    analysis.store.refreshPendingCaptures(id);
  }
  assertServiceOpen();
  await service().runner.resume(id, retry, concurrency);
  return service().store.run(id);
}
export async function pauseAnalysis(id?: string) {
  await service().runner.pause(id);
  return id ? service().store.run(id) : service().store.activeRun();
}
export function analysisDetail(id: string) {
  const detail = service().store.detail(
    id,
    loadProfile(service().store.db, PROMPT_FILE, { allowExpiredMarket: true }),
  );
  if (!detail) throw new Error("商品分析记录不存在");
  return detail;
}
export function markRecommendationViewed(key: unknown) {
  return service().store.markRecommendationViewed(key);
}
export function isAnalyzing() {
  return service().runner.isRunning();
}
export async function shutdownAnalysis() {
  if (runtime[serviceKey]) await runtime[serviceKey].runner.shutdown();
  await shutdownOverviewWorkers();
}
