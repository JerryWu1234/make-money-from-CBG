import { randomUUID } from "node:crypto";
import type { AiProvider } from "../ai/types";
import type { SavedRoleRecord } from "../crawler/types";
import type { EquipmentPricingSnapshot } from "./equipment-pricing";
import type { PetPricingSnapshot } from "./pet-pricing";
import { petGearInventory, type PetGearPricingSnapshot } from "./pet-gear-inventory";
import { ANALYSIS_SCHEMA, validateAnalysis } from "./contract";
import { AnalysisStore } from "./store";
import { VALUATION_SCHEMA, validateValuation } from "./valuation-contract";
import type { AnalysisProfile, ValuationSettings } from "./valuation-types";
import { CALCULATION_VERSION } from "./profile";
import { validateSampleSelection } from "./sample-selection";
import { pricingSearchAdvanced } from "./pricing-progress";
import { pricingTimestampFresh } from "./pricing-integrity";
import { validateRolePricing, type RolePricingSnapshot } from "./role-pricing";

export type AnalysisClient = {
  model: string;
  searchEquipment?: (
    record: SavedRoleRecord,
    signal: AbortSignal,
    settings?: ValuationSettings,
    previous?: EquipmentPricingSnapshot,
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
  searchRole?: (
    record: SavedRoleRecord,
    signal: AbortSignal,
    previous?: RolePricingSnapshot,
  ) => Promise<RolePricingSnapshot>;
  analyze: (
    prompt: string,
    schema: unknown,
    signal: AbortSignal,
  ) => Promise<{ text: string; usage?: unknown; truncated?: boolean }>;
};
export class AnalysisRunner {
  private active: { id: string; controller: AbortController; completion: Promise<void> } | null =
    null;
  constructor(
    readonly store: AnalysisStore,
    private client: (provider: AiProvider, model?: string) => Promise<AnalysisClient>,
  ) {}
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
    if (!run.queued && !run.failed) return id;
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
    const activity = { id, controller, completion: Promise.resolve() };
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
    while (!stop.aborted) {
      if (!this.store.owns(owner)) return;
      let task = this.store.next(id);
      if (!task) {
        this.store.setRun(id, "completed", null, owner);
        return;
      }
      if (
        task.profile?.equipmentSearch &&
        (!task.equipmentPricing ||
          task.equipmentPricing.searchComplete === false ||
          !pricingTimestampFresh(task.equipmentPricing.searchedAt))
      ) {
        const signal = AbortSignal.any([stop, AbortSignal.timeout(300_000)]);
        try {
          this.store.beginEquipmentSearch(task, owner);
          if (!client.searchEquipment) throw new Error("装备联网查价尚未连接");
          const previousPricing = task.equipmentPricing;
          const snapshot = await client.searchEquipment(
            task.record,
            signal,
            task.profile.settings,
            task.equipmentPricing,
          );
          signal.throwIfAborted();
          if (!this.store.owns(owner)) return;
          task = this.store.saveEquipmentPricing(task, snapshot, owner);
          if (snapshot.searchComplete === false) {
            if (pricingSearchAdvanced(previousPricing, snapshot)) continue;
            this.store.setRun(
              id,
              "paused",
              (snapshot.items.some((item) => item.searchState === "read_failed")
                ? "装备详情读取失败"
                : "装备查价游标未推进") +
                "，已保存逐件进度；等待新的可核验数据或修复读取后继续查价",
              owner,
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
        const signal = AbortSignal.any([stop, AbortSignal.timeout(300_000)]);
        try {
          this.store.beginPetSearch(task, owner);
          if (!client.searchPets) throw new Error("宝宝联网查价尚未连接");
          const previousPricing = task.petPricing;
          const snapshot = await client.searchPets(task.record, signal, task.petPricing);
          // Gear has its own cursor and expiry; the store verifies it against this frozen record.
          if (task.profile.petGearSearch && !snapshot.gearPricing && previousPricing?.gearPricing)
            snapshot.gearPricing = previousPricing.gearPricing;
          signal.throwIfAborted();
          if (!this.store.owns(owner)) return;
          task = this.store.savePetPricing(task, snapshot, owner);
          if (snapshot.searchComplete === false) {
            if (pricingSearchAdvanced(previousPricing, snapshot)) continue;
            this.store.setRun(
              id,
              "paused",
              (snapshot.items.some((item) => item.searchState === "read_failed")
                ? "宝宝详情读取失败"
                : "宝宝查价游标未推进") +
                "，已保存逐件进度；等待新的可核验数据或修复读取后继续查价",
              owner,
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
        const signal = AbortSignal.any([stop, AbortSignal.timeout(300_000)]);
        try {
          this.store.beginPetSearch(task, owner);
          if (!client.searchPetGear) throw new Error("宝宝装备联网查价尚未连接");
          const previousPricing = task.petPricing.gearPricing;
          const gearPricing = await client.searchPetGear(
            task.record,
            signal,
            task.petPricing.gearPricing,
          );
          signal.throwIfAborted();
          if (!this.store.owns(owner)) return;
          task = this.store.savePetPricing(task, { ...task.petPricing, gearPricing }, owner);
          if (gearPricing.searchComplete === false) {
            if (pricingSearchAdvanced(previousPricing, gearPricing)) continue;
            this.store.setRun(
              id,
              "paused",
              (gearPricing.items.some((item) => item.searchState === "read_failed")
                ? "宝宝装备详情读取失败"
                : "宝宝装备查价游标未推进") +
                "，已保存角色和宝宝查价进度；等待新的可核验数据或修复读取后继续查价" +
                (gearPricing.issues.length
                  ? "。" + gearPricing.issues.join("；").slice(0, 600)
                  : ""),
              owner,
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
          this.store.setRun(id, "paused", message, owner);
          return;
        }
      }
      if (task.profile?.roleSearch && !validateRolePricing(task.rolePricing, task.record)) {
        const signal = AbortSignal.any([stop, AbortSignal.timeout(900_000)]);
        try {
          this.store.beginRoleSearch(task, owner);
          if (!client.searchRole) throw new Error("整号联网查价尚未连接");
          const snapshot = await client.searchRole(task.record, signal, task.rolePricing);
          signal.throwIfAborted();
          if (!this.store.owns(owner)) return;
          task = this.store.saveRolePricing(task, snapshot, owner);
        } catch (error) {
          if (!this.store.owns(owner)) return;
          this.store.abortRoleSearch(task, owner);
          this.store.setRun(
            id,
            "paused",
            stop.aborted
              ? "已暂停整号查价，继续时只重试未完成的整号阶段"
              : signal.aborted
                ? "整号联网查价超时，请重试"
                : error instanceof Error
                  ? error.message
                  : "整号联网查价失败，请重试",
            owner,
          );
          return;
        }
      }
      const prompt =
        task.profile && task.lastError && task.attempts > 0
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
        const response = await client.analyze(
          prompt,
          task.profile ? VALUATION_SCHEMA : ANALYSIS_SCHEMA,
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
              task.rolePricing,
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
