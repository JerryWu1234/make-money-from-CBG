import { randomUUID } from "node:crypto";
import type { AiProvider } from "../ai/types";
import { aiRequestIssue, aiRequestMessage } from "../ai/request-error";
import { AnalysisRateLimit } from "./rate-limit";
import type { SavedRoleRecord } from "../crawler/types";
import { equipmentInventory, type EquipmentPricingSnapshot } from "./equipment-pricing";
import type { PetPricingSnapshot } from "./pet-pricing";
import { petGearInventory, type PetGearPricingSnapshot } from "./pet-gear-inventory";
import { ANALYSIS_SCHEMA, validateAnalysis } from "./contract";
import { AnalysisStore, type AnalysisTask } from "./store";
import { analysisConcurrency, analysisLaneLimits, DEFAULT_ANALYSIS_CONCURRENCY } from "./types";
import type { AnalysisLane } from "./types";
import type { PricingSearchProgress } from "./equipment-pricing";
import { VALUATION_SCHEMA, validateValuation, recalculateValuation } from "./valuation-contract";
import type { AnalysisProfile, ValuationSettings } from "./valuation-types";
import { CALCULATION_VERSION } from "./profile";
import { validateSampleSelection } from "./sample-selection";
import { pricingSearchAdvanced } from "./pricing-progress";
import { pricingSnapshotFresh } from "./pricing-integrity";
import { captureIssues } from "../crawler/capture-readiness";
import { isCurrentRoleCapture } from "../crawler/role-identity";
import { EXPIRED_MARKET_NOTICE } from "./market";
import { assertServiceOpen } from "../service-lifecycle";

export type AnalysisClient = {
  model: string;
  searchEquipment?: (
    record: SavedRoleRecord,
    signal: AbortSignal,
    settings?: ValuationSettings,
    previous?: EquipmentPricingSnapshot,
    onProgress?: (progress: PricingSearchProgress) => void,
    onCheckpoint?: (snapshot: EquipmentPricingSnapshot) => void,
  ) => Promise<EquipmentPricingSnapshot>;
  searchPets?: (
    record: SavedRoleRecord,
    signal: AbortSignal,
    previous?: PetPricingSnapshot,
  ) => Promise<PetPricingSnapshot>;
  searchPetGear?: (
    record: SavedRoleRecord,
    signal: AbortSignal,
    previous?: PetGearPricingSnapshot,
    pets?: PetPricingSnapshot,
  ) => Promise<PetGearPricingSnapshot>;
  analyze: (
    prompt: string,
    schema: unknown,
    signal: AbortSignal,
    options?: import("../ai/types").AnalysisRequestOptions,
  ) => Promise<{ text: string; usage?: unknown; truncated?: boolean }>;
};
export const MAX_PRICING_ROUNDS = 16;
const MAX_ROLE_PRICING_MS = 45 * 60_000;
function itemPricingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /登录|验证码|安全验证|频繁|繁忙|权限|禁止|policy|security|未连接|无法连接|调试端口|分析锁|状态已变化|资料与当前任务不匹配/i.test(
      message,
    )
  )
    return false;
  if (error instanceof Error && "code" in error && error.code === "PET_GROWTH_ARGUMENT_MISMATCH")
    return true;
  if (error instanceof Error && error.name === "TimeoutError") return true;
  if (/条件|范围/.test(message)) return false;
  return /详情|主商品|属性|页面结构|读取|未加载|游标|超时|TimeoutError|Timeout \d+ms exceeded/.test(
    message,
  );
}
/** Providers must settle on cancellation even if their own promise ignores abort. */
export function pricingUntilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) {
      promise.catch(() => {});
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
export class AnalysisRunner {
  private active: {
    id: string;
    owner: string;
    controller: AbortController;
    completion: Promise<void>;
  } | null = null;
  constructor(
    readonly store: AnalysisStore,
    private client: (provider: AiProvider, model?: string) => Promise<AnalysisClient>,
  ) {}
  appendCaptured() {
    const active = this.active;
    if (!active || active.controller.signal.aborted) return 0;
    return this.store.appendCaptured(active.id, active.owner);
  }
  isRunning() {
    return this.active !== null || this.store.activeRun() !== null;
  }
  private currentActivity() {
    return this.active;
  }
  async start(
    provider: AiProvider,
    force = false,
    profile?: AnalysisProfile,
    sample = false,
    selectedModel?: string,
    sampleSize = 1,
    productKeys?: string[],
    concurrency = DEFAULT_ANALYSIS_CONCURRENCY,
  ) {
    assertServiceOpen();
    analysisConcurrency(concurrency);
    validateSampleSelection(sample, sampleSize, productKeys);
    if (profile && profile.calculationVersion !== CALCULATION_VERSION)
      throw new Error("估值规则已更新，请按新规则开始分析；旧结果仍可查看");
    const existing = this.currentActivity();
    if (existing) {
      if (productKeys) throw new Error("请先暂停当前分析，再指定商品试分析");
      const run = this.store.run(existing.id);
      if (run?.provider !== provider) throw new Error("请先暂停当前分析，再切换 AI");
      if (selectedModel && run.model !== selectedModel)
        throw new Error("请先暂停当前分析，再切换模型");
      if (run.concurrency !== concurrency) throw new Error("请先暂停当前分析，再修改并发数");
      return existing.id;
    }
    if (sample && !this.store.counts().complete)
      throw new Error("暂无详情完整的商品，请先采集商品详情");
    const client = await this.client(provider, selectedModel);
    assertServiceOpen();
    // The lease also protects the await above and separate local Node services.
    const afterConnect = this.currentActivity();
    if (afterConnect) {
      if (productKeys) throw new Error("请先暂停当前分析，再指定商品试分析");
      const run = this.store.run(afterConnect.id);
      if (run?.provider !== provider) throw new Error("请先暂停当前分析，再切换 AI");
      if (selectedModel && run.model !== selectedModel)
        throw new Error("请先暂停当前分析，再切换模型");
      if (run.concurrency !== concurrency) throw new Error("请先暂停当前分析，再修改并发数");
      return afterConnect.id;
    }
    this.store.recover();
    const owner = randomUUID();
    if (!this.store.acquire(owner)) {
      if (productKeys) throw new Error("另一个本机服务正在分析，请先在该服务暂停");
      const current = this.store.activeRun();
      if (
        current?.provider === provider &&
        (!selectedModel || current.model === selectedModel) &&
        current.concurrency === concurrency
      )
        return current.id;
      throw new Error("另一个本机服务正在分析，请先在该服务暂停");
    }
    try {
      const id = this.store.createRun(
        provider,
        client.model,
        force,
        profile,
        sample,
        sampleSize,
        productKeys,
        concurrency,
      );
      if (this.store.run(id)?.status === "running" || (!sample && this.store.followsCapture(id))) {
        this.store.setRun(id, "running", null, owner);
        this.launch(id, owner, client, concurrency);
      } else this.store.release(owner);
      return id;
    } catch (error) {
      this.store.release(owner);
      throw error;
    }
  }
  async resume(id: string, retryFailed = false, concurrency?: number) {
    assertServiceOpen();
    if (concurrency !== undefined) analysisConcurrency(concurrency);
    if (this.active) {
      if (this.active.id !== id) throw new Error("请先暂停当前分析任务");
      if (concurrency !== undefined && this.store.run(id)?.concurrency !== concurrency)
        throw new Error("请先暂停当前分析，再修改并发数");
      return id;
    }
    // Retire terminal collection items before deciding whether the user must retry failures.
    const skippedUnavailable = this.store.skipUnavailableQueued(id);
    const run = this.store.run(id);
    if (!run) throw new Error("分析任务不存在");
    if (run.marketExpired) throw new Error(EXPIRED_MARKET_NOTICE);
    const count = analysisConcurrency(concurrency ?? run.concurrency);
    if (!retryFailed && (run.failed || run.waitingPricing))
      throw new Error("请先重试失败或待补齐的商品，再继续分析");
    if (
      !run.queued &&
      !skippedUnavailable &&
      !(retryFailed && (run.failed || run.waitingPricing)) &&
      !this.store.hasCapturedPending(id) &&
      !this.store.followsCapture(id)
    )
      return id;
    if (run.calculationVersion && run.calculationVersion !== CALCULATION_VERSION)
      throw new Error("估值规则已更新，请按新规则开始分析；旧结果仍可查看");
    const client = await this.client(run.provider, run.model);
    assertServiceOpen();
    const afterConnect = this.currentActivity();
    if (afterConnect) {
      if (afterConnect.id !== id) throw new Error("请先暂停当前分析任务");
      if (this.store.run(id)?.concurrency !== count)
        throw new Error("请先暂停当前分析，再修改并发数");
      return afterConnect.id;
    }
    this.store.recover();
    const owner = randomUUID();
    if (!this.store.acquire(owner)) throw new Error("另一个本机服务正在分析，请先在该服务暂停");
    try {
      if (retryFailed) this.store.retry(id);
      this.store.setRun(id, "running", null, owner);
      this.launch(id, owner, client, count, run.error);
      return id;
    } catch (error) {
      this.store.release(owner);
      throw error;
    }
  }
  private launch(
    id: string,
    owner: string,
    client: AnalysisClient,
    concurrency: number,
    previousError?: string | null,
  ) {
    this.store.setConcurrency(id, concurrency, owner);
    const provider = this.store.run(id)!.provider;
    const previous =
      this.store.providerBackoff(provider) ||
      (previousError && aiRequestIssue(new Error(previousError))?.kind === "rate_limit"
        ? { retryAt: Date.now() + 30_000, concurrency: 1, rounds: 0 }
        : null);
    const limit = new AnalysisRateLimit(concurrency, previous, (state) =>
      this.store.saveProviderBackoff(provider, state, owner),
    );
    const providerPause = { message: null as string | null };
    const limitedClient: AnalysisClient = {
      ...client,
      analyze: async (prompt, schema, signal, options) => {
        try {
          return await limit.run(
            () => pricingUntilAborted(client.analyze(prompt, schema, signal, options), signal),
            signal,
          );
        } catch (error) {
          if (!signal.aborted && aiRequestIssue(error)) {
            const failure = error instanceof Error ? error : new Error("AI 服务请求受限（429）");
            providerPause.message ||= aiRequestMessage(failure.message);
            // Reject requests still waiting for a permit; let already issued
            // requests settle within their existing cancellation/timeout budget.
            limit.halt(failure);
          }
          throw error;
        }
      },
    };
    const controller = new AbortController();
    const activity = { id, owner, controller, completion: Promise.resolve() };
    this.active = activity;
    const heartbeat = setInterval(() => {
      try {
        if (!this.store.acquire(owner)) controller.abort(new Error("分析锁已失效，请继续分析"));
      } catch {
        controller.abort(new Error("无法续期分析锁，请继续分析"));
      }
    }, 30_000);
    activity.completion = this.process(
      id,
      owner,
      limitedClient,
      controller,
      concurrency,
      providerPause,
    )
      .catch((error: unknown) => {
        if (this.store.owns(owner))
          this.store.setRun(
            id,
            "paused",
            error instanceof Error ? error.message : "分析已暂停，请重试",
            owner,
          );
      })
      .finally(() => {
        clearInterval(heartbeat);
        this.store.release(owner);
        if (this.active === activity) this.active = null;
      });
  }
  private async process(
    id: string,
    owner: string,
    client: AnalysisClient,
    controller: AbortController,
    concurrency: number,
    providerPause: { message: string | null },
  ) {
    const stop = controller.signal;
    const pending = new Set<Promise<void>>();
    const running = { new: 0, old: 0 };
    const limits = analysisLaneLimits(concurrency);
    let nextSingleLane: AnalysisLane = "new";
    try {
      while (!stop.aborted && this.store.owns(owner)) {
        if (providerPause.message) {
          await Promise.allSettled(pending);
          if (!stop.aborted && this.store.owns(owner))
            this.store.setRun(id, "paused", providerPause.message, owner);
          return;
        }
        if (this.store.run(id)?.marketExpired) {
          this.store.setRun(id, "paused", EXPIRED_MARKET_NOTICE, owner);
          return;
        }
        this.store.appendCaptured(id, owner);
        while (!stop.aborted && !providerPause.message && pending.size < concurrency) {
          const preferredLane =
            concurrency === 1 ? nextSingleLane : running.new < limits.newLimit ? "new" : "old";
          const task = this.store.next(id, preferredLane);
          if (!task) break;
          running[task.lane]++;
          nextSingleLane = task.lane === "new" ? "old" : "new";
          const work = this.processTask(task, owner, client, controller, providerPause)
            .catch((error: unknown) => {
              if (!stop.aborted && this.store.owns(owner))
                this.store.setRun(
                  id,
                  "paused",
                  error instanceof Error ? error.message : "分析失败",
                  owner,
                );
              controller.abort();
            })
            .finally(() => {
              running[task.lane]--;
              pending.delete(work);
            });
          pending.add(work);
        }
        if (pending.size) {
          // 有空闲槽位时继续检查新采集角色，不被其他慢请求挡住。
          await Promise.race([
            ...pending,
            ...(pending.size < concurrency && this.store.followsCapture(id)
              ? [new Promise<void>((resolve) => setTimeout(resolve, 1000))]
              : []),
          ]);
        } else if (this.store.followsCapture(id)) {
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              stop.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, 1000);
            stop.addEventListener("abort", done, { once: true });
          });
        } else {
          this.store.setRun(id, "completed", null, owner);
          return;
        }
      }
    } finally {
      controller.abort();
      await Promise.allSettled(pending);
      if (this.store.owns(owner) && this.store.run(id)?.status === "running")
        this.store.setRun(id, "paused", null, owner);
    }
  }
  private async processTask(
    task: AnalysisTask,
    owner: string,
    client: AnalysisClient,
    controller: AbortController,
    providerPause: { message: string | null },
  ) {
    const id = task.runId;
    const stop = controller.signal;
    const pause = (message: string) => {
      if (!stop.aborted) this.store.setRun(id, "paused", message, owner);
      controller.abort();
    };
    const deferPricing = (message: string) => {
      this.store.deferPricing(task, owner, message);
      controller.abort();
    };
    const budget = { started: Date.now(), rounds: 0 };
    while (!stop.aborted && this.store.owns(owner)) {
      if (this.store.skipUnavailableTask(task, owner)) return;
      if (
        (task.profile || isCurrentRoleCapture(task.record.detail)) &&
        (!task.record.detail ||
          captureIssues(task.record.detail, false, true, task.record.listing).length)
      ) {
        pause("角色资料尚未完整采集，请补采后继续分析");
        return;
      }
      const equipmentPricingCurrent =
        !!task.equipmentPricing &&
        task.equipmentPricing.inputHash ===
          equipmentInventory(task.record, task.profile?.settings).inputHash &&
        pricingSnapshotFresh(task.equipmentPricing);
      const pendingPricing =
        (task.profile?.equipmentSearch &&
          (!task.equipmentPricing ||
            task.equipmentPricing.searchComplete === false ||
            !equipmentPricingCurrent)) ||
        (task.profile?.petSearch &&
          (!task.petPricing ||
            task.petPricing.searchComplete === false ||
            !pricingSnapshotFresh(task.petPricing))) ||
        (task.profile?.petGearSearch &&
          petGearInventory(task.record).items.length &&
          (!task.petPricing?.gearPricing ||
            task.petPricing.gearPricing.searchComplete === false ||
            !pricingSnapshotFresh(task.petPricing.gearPricing) ||
            task.petPricing.gearPricing.items.some(
              (gear) =>
                !!gear.skippedWithPet !==
                task!.petPricing!.items.some(
                  (pet) => pet.key === gear.petKey && pet.searchState === "skipped",
                ),
            )));
      if (
        pendingPricing &&
        (budget.rounds >= MAX_PRICING_ROUNDS || Date.now() - budget.started >= MAX_ROLE_PRICING_MS)
      ) {
        deferPricing("达到本角色自动查价上限，报价仍未补齐");
        return;
      }
      const reportProgress = (progress: Partial<PricingSearchProgress> = {}) => {
        this.store.pricingProgress(task!, owner, {
          ...progress,
          round: budget.rounds,
          startedAt: new Date(budget.started).toISOString(),
          updatedAt: new Date().toISOString(),
        });
      };
      if (
        task.profile?.equipmentSearch &&
        (!task.equipmentPricing ||
          task.equipmentPricing.searchComplete === false ||
          !equipmentPricingCurrent)
      ) {
        const signal = AbortSignal.any([
          stop,
          AbortSignal.timeout(
            Math.max(1, Math.min(300_000, MAX_ROLE_PRICING_MS - (Date.now() - budget.started))),
          ),
        ]);
        try {
          this.store.beginEquipmentSearch(task, owner);
          budget.rounds++;
          reportProgress();
          if (!client.searchEquipment) throw new Error("装备联网查价尚未连接");
          const previousPricing = task.equipmentPricing;
          const snapshot = await pricingUntilAborted(
            client.searchEquipment(
              task.record,
              signal,
              task.profile.settings,
              task.equipmentPricing,
              reportProgress,
              (checkpoint) => {
                signal.throwIfAborted();
                task = this.store.saveEquipmentPricing(
                  task!,
                  structuredClone(checkpoint),
                  owner,
                  true,
                );
              },
            ),
            signal,
          );
          signal.throwIfAborted();
          if (!this.store.owns(owner)) return;
          task = this.store.saveEquipmentPricing(task, snapshot, owner);
          if (snapshot.searchComplete === false) {
            if (pricingSearchAdvanced(previousPricing, snapshot)) continue;
            deferPricing(
              (snapshot.items.some((item) => item.searchState === "read_failed")
                ? "装备查询或详情读取失败：" +
                  snapshot.items
                    .filter((item) => item.searchState === "read_failed")
                    .map((item) => item.name)
                    .join("、")
                : snapshot.items.some(
                      (item) => item.samplingStopped && item.searchState !== "skipped",
                    )
                  ? "各筛选条件第一页未取得有效样本，已停止翻页"
                  : "装备查价游标未推进") +
                "，已保存逐件进度；等待新的可核验数据或修复读取后继续查价",
            );
            return;
          }
        } catch (error) {
          if (!this.store.owns(owner)) return;
          this.store.abortEquipmentSearch(task, owner);
          const message = stop.aborted
            ? "已暂停装备查价，继续时先处理这件商品"
            : signal.aborted
              ? "装备联网查价超时，请重试"
              : error instanceof Error
                ? error.message
                : "装备联网查价失败，请重试";
          if (!stop.aborted && (signal.aborted || itemPricingError(error))) {
            deferPricing(message);
            return;
          }
          pause(message);
          return;
        }
        continue;
      }
      if (
        task.profile?.petSearch &&
        (!task.petPricing ||
          task.petPricing.searchComplete === false ||
          !pricingSnapshotFresh(task.petPricing))
      ) {
        const signal = AbortSignal.any([
          stop,
          AbortSignal.timeout(
            Math.max(1, Math.min(300_000, MAX_ROLE_PRICING_MS - (Date.now() - budget.started))),
          ),
        ]);
        try {
          this.store.beginPetSearch(task, owner);
          budget.rounds++;
          reportProgress();
          if (!client.searchPets) throw new Error("宝宝联网查价尚未连接");
          const previousPricing = task.petPricing;
          const snapshot = await pricingUntilAborted(
            client.searchPets(task.record, signal, task.petPricing),
            signal,
          );
          // Gear has its own cursor and expiry; the store verifies it against this frozen record.
          if (task.profile.petGearSearch && !snapshot.gearPricing && previousPricing?.gearPricing)
            snapshot.gearPricing = previousPricing.gearPricing;
          signal.throwIfAborted();
          if (!this.store.owns(owner)) return;
          task = this.store.savePetPricing(task, snapshot, owner);
          if (snapshot.searchComplete === false) {
            if (pricingSearchAdvanced(previousPricing, snapshot)) continue;
            deferPricing(
              (snapshot.items.some((item) => item.searchState === "read_failed")
                ? "宝宝详情读取失败"
                : "宝宝查价游标未推进") +
                "，已保存逐件进度；等待新的可核验数据或修复读取后继续查价",
            );
            return;
          }
        } catch (error) {
          if (!this.store.owns(owner)) return;
          this.store.abortPetSearch(task, owner);
          const message = stop.aborted
            ? "已暂停宝宝查价，继续时先处理这件商品"
            : signal.aborted
              ? "宝宝联网查价超时，请重试"
              : error instanceof Error
                ? error.message
                : "宝宝联网查价失败，请重试";
          if (!stop.aborted && (signal.aborted || itemPricingError(error))) {
            deferPricing(message);
            return;
          }
          pause(message);
          return;
        }
        continue;
      }
      if (
        task.profile?.petGearSearch &&
        task.petPricing &&
        petGearInventory(task.record).items.length &&
        (!task.petPricing.gearPricing ||
          task.petPricing.gearPricing.searchComplete === false ||
          !pricingSnapshotFresh(task.petPricing.gearPricing) ||
          task.petPricing.gearPricing.items.some(
            (gear) =>
              !!gear.skippedWithPet !==
              task!.petPricing!.items.some(
                (pet) => pet.key === gear.petKey && pet.searchState === "skipped",
              ),
          ))
      ) {
        const signal = AbortSignal.any([
          stop,
          AbortSignal.timeout(
            Math.max(1, Math.min(300_000, MAX_ROLE_PRICING_MS - (Date.now() - budget.started))),
          ),
        ]);
        try {
          this.store.beginPetSearch(task, owner);
          budget.rounds++;
          reportProgress();
          if (!client.searchPetGear) throw new Error("宝宝装备联网查价尚未连接");
          const previousPricing = task.petPricing.gearPricing;
          const gearPricing = await pricingUntilAborted(
            client.searchPetGear(task.record, signal, task.petPricing.gearPricing, task.petPricing),
            signal,
          );
          signal.throwIfAborted();
          if (!this.store.owns(owner)) return;
          task = this.store.savePetPricing(task, { ...task.petPricing, gearPricing }, owner);
          if (gearPricing.searchComplete === false) {
            const readFailed = gearPricing.items.some(
              (item) => item.searchState === "read_failed" || item.searchStatus === "read_failed",
            );
            if (!readFailed && pricingSearchAdvanced(previousPricing, gearPricing)) continue;
            deferPricing(
              (readFailed ? "宝宝装备详情读取失败" : "宝宝装备查价游标未推进") +
                "，已保存角色和宝宝查价进度；等待新的可核验数据或修复读取后继续查价" +
                (gearPricing.issues.length
                  ? "。" + gearPricing.issues.join("；").slice(0, 600)
                  : ""),
            );
            return;
          }
        } catch (error) {
          if (!this.store.owns(owner)) return;
          this.store.abortPetSearch(task, owner);
          const message = stop.aborted
            ? "已暂停宝宝装备查价，继续时先处理这件商品"
            : signal.aborted
              ? "宝宝装备联网查价超时，请重试"
              : error instanceof Error
                ? error.message
                : "宝宝装备联网查价失败，请重试";
          if (!stop.aborted && (signal.aborted || itemPricingError(error))) {
            deferPricing(message);
            return;
          }
          pause(message);
          return;
        }
        continue;
      }
      if (this.store.skipUnavailableTask(task, owner)) return;
      if (
        task.profile &&
        task.previousResult?.inputHash === task.document.contentHash &&
        task.previousResult.productKey === task.document.productKey &&
        task.previousResult.valuation?.calculation_version === task.profile.calculationVersion
      ) {
        const result = recalculateValuation(
          task.previousResult,
          task.document,
          task.record,
          task.profile,
          task.equipmentPricing,
          task.petPricing,
        );
        const attempt = this.store.begin(
          task,
          owner,
          "仅复用本任务相同输入中已验证的本体事实，按当前规则和新查价快照重新核算；本次未调用AI。",
        );
        this.store.finish(task, attempt, owner, {
          state: "completed",
          result,
          usage: { source: "validated-body-recalculation", inputHash: task.document.contentHash },
        });
        return;
      }
      const prompt =
        task.profile &&
        task.lastError &&
        task.lastAttemptHadResponse &&
        !task.lastError.startsWith("已暂停") &&
        task.attempts > 0
          ? task.prompt +
            "\n\n上次输出校验未通过：" +
            task.lastError.slice(0, 1000) +
            "。请复核原文引用与本批次计价规则后修正 JSON，不得补造缺失资料。"
          : task.prompt;
      const attempt = this.store.begin(task, owner, prompt);
      const signal = AbortSignal.any([stop, AbortSignal.timeout(300_000)]);
      let raw: string | undefined, usage: unknown;
      try {
        if (Buffer.byteLength(prompt, "utf8") > 256 * 1024)
          throw new Error("分析请求超过 256 KiB，已保留原文，请先核对请求长度后重试");
        const response = await pricingUntilAborted(
          client.analyze(
            prompt,
            task.profile ? VALUATION_SCHEMA : ANALYSIS_SCHEMA,
            signal,
            ...(task.profile && !task.profile.equipmentSearch && !task.profile.petSearch
              ? [{ bareRoleReview: true }]
              : []),
          ),
          signal,
        );
        raw = response.text;
        usage = response.usage;
        if (response.truncated) throw new Error("AI 输出超过长度限制，已保存原始回复，请重试");
        signal.throwIfAborted();
        if (!this.store.owns(owner)) throw new Error("分析锁已失效");
        const result = task.profile
          ? validateValuation(
              raw,
              task.document,
              task.record,
              task.profile,
              task.equipmentPricing,
              task.petPricing,
            )
          : validateAnalysis(raw, task.document, task.record);
        this.store.finish(task, attempt, owner, { state: "completed", result, raw, usage });
        return;
      } catch (error) {
        if (!this.store.owns(owner)) return;
        const message = stop.aborted
          ? "已暂停，继续时先处理这件商品"
          : signal.aborted
            ? "分析超时，请重试"
            : error instanceof Error
              ? aiRequestMessage(error.message)
              : "分析失败";
        const fatal =
          /401|403|429|unauth|authentication|api.?key|登录|quota|rate.?limit|限流|额度|余额|insufficient|账号已变化|model.*(?:not available|not found|unsupported)/i.test(
            message,
          );
        this.store.finish(task, attempt, owner, {
          state: stop.aborted ? "interrupted" : "failed",
          error: message,
          diagnosticError:
            !stop.aborted && !signal.aborted && error instanceof Error
              ? error.cause instanceof Error
                ? error.cause.message
                : error.message
              : undefined,
          raw,
          usage,
          requeue: stop.aborted || fatal,
        });
        if (!stop.aborted && providerPause.message) {
          this.store.setRun(
            id,
            "running",
            providerPause.message + " 正在保存已发出请求的结果，完成后暂停。",
            owner,
          );
          return;
        }
        pause(message);
        return;
      }
    }
  }
  async pause(id?: string) {
    if (this.active) {
      if (id && this.active.id !== id) throw new Error("请暂停当前正在执行的分析批次");
      const activity = this.active;
      const run = this.store.run(activity.id);
      if (run?.status === "running" && run.runningCount)
        this.store.setRun(activity.id, "paused", "已暂停，继续时先处理这件商品", activity.owner);
      activity.controller.abort();
      await activity.completion;
      return;
    }
    if (this.store.activeRun()) throw new Error("另一个本机服务正在分析，请在该服务暂停");
  }
  async shutdown() {
    if (this.active) await this.pause(this.active.id);
  }
  async settled() {
    await this.active?.completion;
  }
}
