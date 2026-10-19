import { prepareAnalysisClient } from "../ai-connection";
import type { AiProvider } from "../ai/types";
import {
  crawlDatabase,
  captureRetryItems,
  startCrawl,
  crawlActivity,
  crawlStatus,
  isCrawling,
  stopCrawl,
} from "../crawler/controller";
import { AnalysisRunner, pricingUntilAborted } from "./runner";
import { AnalysisStore } from "./store";
import { refreshMarket, marketServers } from "./market";
import { loadProfile, saveProfile, PROMPT_FILE } from "./profile";
import { validateSampleSelection } from "./sample-selection";
import { reconcileCapturedEquipmentCategories } from "./equipment-category-evidence";

type CapturePreparation = {
  controller: AbortController;
  ownsCapture: boolean;
  total: number;
  completion: Promise<void>;
  status: typeof crawlStatus;
  stopOwnedCapture: () => void;
  activity?: NonNullable<ReturnType<typeof crawlActivity>>;
};
type AnalysisService = {
  store: AnalysisStore;
  runner: AnalysisRunner;
  preparing?: CapturePreparation;
};
const serviceKey = Symbol.for("cbg.analysis-service.v1");
const runtime = globalThis as typeof globalThis & { [serviceKey]?: AnalysisService };
function service() {
  let analysis = runtime[serviceKey];
  // A page or Vite module reload must keep the in-flight queue and its abort controller.
  if (
    !analysis ||
    (!(analysis.store instanceof AnalysisStore) &&
      !analysis.runner.isRunning() &&
      !analysis.preparing)
  ) {
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
export function analysisOverview(options: Parameters<AnalysisStore["overview"]>[0]) {
  service().store.recover();
  const profile = loadProfile(service().store.db);
  const preparation = service().preparing;
  const capture = preparation?.ownsCapture ? preparation.status() : undefined;
  return {
    ...service().store.overview({ ...options, currentProfile: profile }),
    ...(preparation
      ? {
          capturePreparation: {
            total: preparation.total,
            completed: capture?.retryCompleted || 0,
            current: capture?.current || null,
            message: capture?.detailProgress || capture?.message || "正在采集并核验角色完整资料…",
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
async function prepareCaptures(keys?: string[]) {
  const analysis = service();
  if (analysis.preparing) throw new Error("正在采集角色完整资料，请等待当前准备完成");
  const missing = captureRetryItems(keys);
  if (!missing.length) {
    reconcileCapturedEquipmentCategories(analysis.store.db, keys);
    return;
  }
  const preparation: CapturePreparation = {
    controller: new AbortController(),
    ownsCapture: false,
    total: missing.length,
    completion: Promise.resolve(),
    status: crawlStatus,
    stopOwnedCapture: () => {
      if (preparation.activity && crawlActivity() === preparation.activity) stopCrawl();
    },
  };
  analysis.preparing = preparation;
  preparation.completion = (async () => {
    const signal = preparation.controller.signal;
    if (isCrawling()) {
      const activity = crawlActivity();
      if (!activity) throw new Error("当前采集状态尚未稳定，请稍后重试");
      await pricingUntilAborted(activity.completion, signal);
    }
    signal.throwIfAborted();
    const remaining = captureRetryItems(keys);
    if (!remaining.length) return;
    const attempt = await startCrawl("manual", undefined, {
      backfillOnly: true,
      includeAssets: true,
      keys: remaining.map((item) => item.key),
    });
    preparation.ownsCapture = attempt.started;
    preparation.activity = attempt.activity || undefined;
    if (signal.aborted && attempt.started) {
      preparation.stopOwnedCapture();
      await attempt.activity?.completion;
    }
    signal.throwIfAborted();
    if (!attempt.activity) throw new Error("角色资料采集尚未启动");
    const status = await pricingUntilAborted(attempt.activity.completion, signal);
    signal.throwIfAborted();
    if (status.phase === "error" || status.phase === "paused")
      throw new Error(status.error || status.message);
    const incomplete = captureRetryItems(keys);
    if (incomplete.length)
      throw Object.assign(
        new Error(
          `还有 ${incomplete.length} 个角色资料待补采：${incomplete
            .slice(0, 5)
            .map((item) => item.name)
            .join("、")}${incomplete.length > 5 ? "等" : ""}。` +
            "请先在采集列表查看失败原因并补采，资料完整后再开始分析。",
        ),
        { name: "CapturePreparationError" },
      );
  })().finally(() => {
    if (analysis.preparing === preparation) analysis.preparing = undefined;
  });
  await preparation.completion;
  reconcileCapturedEquipmentCategories(analysis.store.db, keys);
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
  validateSampleSelection(sample, sampleSize, productKeys);
  const analysis = service();
  const preparationProfile = loadProfile(analysis.store.db);
  if (
    !analysis.runner.isRunning() &&
    !(!sample && !productKeys && isCrawling() && analysis.store.counts().complete > 0) &&
    (preparationProfile.equipmentSearch ||
      preparationProfile.petSearch ||
      preparationProfile.petGearSearch)
  ) {
    const keys =
      productKeys ||
      (sample
        ? analysis.store.db
            .prepare("SELECT key FROM listings ORDER BY key ASC LIMIT ?")
            .all(sampleSize)
            .map((row) => String(row.key))
        : undefined);
    await prepareCaptures(keys);
  }
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
  const analysis = service();
  if (!analysis.runner.isRunning()) {
    const row = analysis.store.db
      .prepare("SELECT profile_json FROM analysis_runs WHERE id=?")
      .get(id);
    if (!row) throw new Error("分析批次不存在");
    const profile = row.profile_json ? JSON.parse(String(row.profile_json)) : null;
    if (profile?.equipmentSearch || profile?.petSearch || profile?.petGearSearch) {
      const keys = analysis.store.db
        .prepare(
          "SELECT listing_key FROM analysis_tasks WHERE run_id=? AND status IN ('queued','waiting_pricing','failed')",
        )
        .all(id)
        .map((task) => String(task.listing_key));
      await prepareCaptures(keys);
      analysis.store.refreshPendingCaptures(id);
    }
  }
  await service().runner.resume(id, retry);
  return service().store.run(id);
}
export async function pauseAnalysis(id?: string) {
  const preparation = service().preparing;
  if (preparation) {
    preparation.controller.abort(new Error("已暂停完整资料采集准备"));
    if (preparation.ownsCapture) {
      preparation.stopOwnedCapture();
      await preparation.activity?.completion;
    }
    await preparation.completion.catch(() => {});
  }
  await service().runner.pause(id);
  return id ? service().store.run(id) : service().store.activeRun();
}
export function analysisDetail(id: string) {
  const detail = service().store.detail(id, loadProfile(service().store.db));
  if (!detail) throw new Error("商品分析记录不存在");
  return detail;
}
export function isAnalyzing() {
  return !!service().preparing || service().runner.isRunning();
}
export async function shutdownAnalysis() {
  if (runtime[serviceKey]?.preparing) await pauseAnalysis();
  if (runtime[serviceKey]) await runtime[serviceKey].runner.shutdown();
}
