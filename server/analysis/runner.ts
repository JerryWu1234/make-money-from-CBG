import { randomUUID } from "node:crypto";
import type { AiProvider } from "../ai/types";
import type { SavedRoleRecord } from "../crawler/types";
import type { EquipmentPricingSnapshot } from "./equipment-pricing";
import type { PetPricingSnapshot } from "./pet-pricing";
import { petGearInventory, type PetGearPricingSnapshot } from "./pet-gear-inventory";
import { ANALYSIS_SCHEMA, validateAnalysis } from "./contract";
import { AnalysisStore } from "./store";
import type { PricingSearchProgress } from "./equipment-pricing";
import { VALUATION_SCHEMA, validateValuation } from "./valuation-contract";
import type { AnalysisProfile, ValuationSettings } from "./valuation-types";
import { CALCULATION_VERSION } from "./profile";
import { validateSampleSelection } from "./sample-selection";
import { pricingSearchAdvanced } from "./pricing-progress";
import { pricingTimestampFresh } from "./pricing-integrity";

export type AnalysisClient = {
  model: string;
  searchEquipment?: (
    record: SavedRoleRecord,
    signal: AbortSignal,
    settings?: ValuationSettings,
    previous?: EquipmentPricingSnapshot,
    onProgress?: (progress: PricingSearchProgress) => void,
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
  ) => Promise<PetGearPricingSnapshot>;
  analyze: (
    prompt: string,
    schema: unknown,
    signal: AbortSignal,
  ) => Promise<{ text: string; usage?: unknown; truncated?: boolean }>;
};
export const MAX_PRICING_ROUNDS = 8;
const MAX_ROLE_PRICING_MS = 15 * 60_000;
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
    private captureRunning: () => boolean = () => false,
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
  ) {
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
      return existing.id;
    }
    if (!this.store.counts().complete) throw new Error("暂无详情完整的商品，请先采集商品详情");
    const client = await this.client(provider, selectedModel);
    // The lease also protects the await above and separate local Node services.
    const afterConnect = this.currentActivity();
    if (afterConnect) {
      if (productKeys) throw new Error("请先暂停当前分析，再指定商品试分析");
      const run = this.store.run(afterConnect.id);
      if (run?.provider !== provider) throw new Error("请先暂停当前分析，再切换 AI");
      if (selectedModel && run.model !== selectedModel)
        throw new Error("请先暂停当前分析，再切换模型");
      return afterConnect.id;
    }
    this.store.recover();
    const owner = randomUUID();
    if (!this.store.acquire(owner)) {
      if (productKeys) throw new Error("另一个本机服务正在分析，请先在该服务暂停");
      const current = this.store.activeRun();
      if (current?.provider === provider && (!selectedModel || current.model === selectedModel))
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
      );
      if (this.store.run(id)?.status === "running") this.launch(id, owner, client);
      else this.store.release(owner);
      return id;
    } catch (error) {
      this.store.release(owner);
      throw error;
    }
  }
  async resume(id: string, retryFailed = false) {
    if (this.active) {
      if (this.active.id !== id) throw new Error("请先暂停当前分析任务");
      return id;
    }
    const run = this.store.run(id);
    if (!run) throw new Error("分析任务不存在");
    if (
      !run.queued &&
      !(retryFailed && (run.failed || run.waitingPricing)) &&
      !this.store.hasCapturedPending(id)
    )
      return id;
    if (run.calculationVersion && run.calculationVersion !== CALCULATION_VERSION)
      throw new Error("估值规则已更新，请按新规则开始分析；旧结果仍可查看");
    const client = await this.client(run.provider, run.model);
    const afterConnect = this.currentActivity();
    if (afterConnect) {
      if (afterConnect.id !== id) throw new Error("请先暂停当前分析任务");
      return afterConnect.id;
    }
    this.store.recover();
    const owner = randomUUID();
    if (!this.store.acquire(owner)) throw new Error("另一个本机服务正在分析，请先在该服务暂停");
    try {
      if (retryFailed) this.store.retry(id);
      this.store.setRun(id, "running", null, owner);
      this.launch(id, owner, client);
      return id;
    } catch (error) {
      this.store.release(owner);
      throw error;
    }
  }
  private launch(id: string, owner: string, client: AnalysisClient) {
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
    activity.completion = this.process(id, owner, client, controller.signal)
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
  private async process(id: string, owner: string, client: AnalysisClient, stop: AbortSignal) {
    let budget = { taskId: "", started: Date.now(), rounds: 0 };
    while (!stop.aborted) {
      if (!this.store.owns(owner)) return;
      this.store.appendCaptured(id, owner);
      let task = this.store.next(id);
      if (!task) {
        if (this.store.followsCapture(id) && this.captureRunning()) {
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(timer);
              stop.removeEventListener("abort", done);
              resolve();
            };
            const timer = setTimeout(done, 1000);
            stop.addEventListener("abort", done, { once: true });
          });
          continue;
        }
        this.store.setRun(id, "completed", null, owner);
        return;
      }
      if (budget.taskId !== task.id) budget = { taskId: task.id, started: Date.now(), rounds: 0 };
      const pendingPricing =
        (task.profile?.equipmentSearch &&
          (!task.equipmentPricing ||
            task.equipmentPricing.searchComplete === false ||
            !pricingTimestampFresh(task.equipmentPricing.searchedAt))) ||
        (task.profile?.petSearch &&
          (!task.petPricing ||
            task.petPricing.searchComplete === false ||
            !pricingTimestampFresh(task.petPricing.searchedAt))) ||
        (task.profile?.petGearSearch &&
          petGearInventory(task.record).items.length &&
          (!task.petPricing?.gearPricing ||
            task.petPricing.gearPricing.searchComplete === false ||
            !pricingTimestampFresh(task.petPricing.gearPricing.searchedAt)));
      if (
        pendingPricing &&
        (budget.rounds >= MAX_PRICING_ROUNDS || Date.now() - budget.started >= MAX_ROLE_PRICING_MS)
      ) {
        this.store.deferPricing(task, owner, "达到本角色自动查价上限，报价仍未补齐");
        continue;
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
          !pricingTimestampFresh(task.equipmentPricing.searchedAt))
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
            ),
            signal,
          );
          signal.throwIfAborted();
          if (!this.store.owns(owner)) return;
          task = this.store.saveEquipmentPricing(task, snapshot, owner);
          if (snapshot.searchComplete === false) {
            if (pricingSearchAdvanced(previousPricing, snapshot)) continue;
            this.store.deferPricing(
              task,
              owner,
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
            continue;
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
            this.store.deferPricing(task, owner, message);
            continue;
          }
          this.store.setRun(id, "paused", message, owner);
          return;
        }
      }
      if (
        task.profile?.petSearch &&
        (!task.petPricing ||
          task.petPricing.searchComplete === false ||
          !pricingTimestampFresh(task.petPricing.searchedAt))
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
            this.store.deferPricing(
              task,
              owner,
              (snapshot.items.some((item) => item.searchState === "read_failed")
                ? "宝宝详情读取失败"
                : "宝宝查价游标未推进") +
                "，已保存逐件进度；等待新的可核验数据或修复读取后继续查价",
            );
            continue;
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
            this.store.deferPricing(task, owner, message);
            continue;
          }
          this.store.setRun(id, "paused", message, owner);
          return;
        }
      }
      if (
        task.profile?.petGearSearch &&
        task.petPricing &&
        petGearInventory(task.record).items.length &&
        (!task.petPricing.gearPricing ||
          task.petPricing.gearPricing.searchComplete === false ||
          !pricingTimestampFresh(task.petPricing.gearPricing.searchedAt))
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
            client.searchPetGear(task.record, signal, task.petPricing.gearPricing),
            signal,
          );
          signal.throwIfAborted();
          if (!this.store.owns(owner)) return;
          task = this.store.savePetPricing(task, { ...task.petPricing, gearPricing }, owner);
          if (gearPricing.searchComplete === false) {
            if (pricingSearchAdvanced(previousPricing, gearPricing)) continue;
            this.store.deferPricing(
              task,
              owner,
              (gearPricing.items.some((item) => item.searchState === "read_failed")
                ? "宝宝装备详情读取失败"
                : "宝宝装备查价游标未推进") +
                "，已保存角色和宝宝查价进度；等待新的可核验数据或修复读取后继续查价" +
                (gearPricing.issues.length
                  ? "。" + gearPricing.issues.join("；").slice(0, 600)
                  : ""),
            );
            continue;
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
            this.store.deferPricing(task, owner, message);
            continue;
          }
          this.store.setRun(id, "paused", message, owner);
          return;
        }
      }
      const prompt =
        task.profile && task.lastError && !task.lastError.startsWith("已暂停") && task.attempts > 0
          ? task.prompt +
            "\n\n上次输出校验未通过：" +
            task.lastError.slice(0, 1000) +
            "。请复核原文引用与本批次计价规则后修正 JSON，不得补造缺失资料。"
          : task.prompt;
      const attempt = this.store.begin(task, owner, prompt);
      const signal = AbortSignal.any([stop, AbortSignal.timeout(300_000)]);
      let raw: string | undefined, usage: unknown;
      try {
        if (Buffer.byteLength(task.document.text, "utf8") > 128 * 1024)
          throw new Error("完整商品原文超过 128 KiB，已保留原文，请先核对资料长度后重试");
        const response = await pricingUntilAborted(
          client.analyze(prompt, task.profile ? VALUATION_SCHEMA : ANALYSIS_SCHEMA, signal),
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
      } catch (error) {
        if (!this.store.owns(owner)) return;
        const message = stop.aborted
          ? "已暂停，继续时先处理这件商品"
          : signal.aborted
            ? "分析超时，请重试"
            : error instanceof Error
              ? error.message
              : "分析失败";
        const fatal =
          /401|403|429|unauth|authentication|api.?key|登录|quota|rate.?limit|额度|余额|insufficient|账号已变化|model.*(?:not available|not found|unsupported)/i.test(
            message,
          );
        const retry = !stop.aborted && !fatal && task.attempts < 1 && !message.includes("128 KiB");
        this.store.finish(task, attempt, owner, {
          state: stop.aborted ? "interrupted" : "failed",
          error: message,
          raw,
          usage,
          requeue: stop.aborted || fatal || retry,
        });
        if (stop.aborted || fatal) {
          this.store.setRun(id, "paused", message, owner);
          return;
        }
      }
    }
    this.store.setRun(id, "paused", null, owner);
  }
  async pause(id?: string) {
    if (this.active) {
      if (id && this.active.id !== id) throw new Error("请暂停当前正在执行的分析批次");
      const activity = this.active;
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
