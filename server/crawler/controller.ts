import { withNativeWorkflow } from "../adapters/native-workflow";
import { browserSettings } from "../browser-settings";
import { officialGovernor, bindOfficialPage, officialPageContext } from "../official-access";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { getBrowser, getCbgPage } from "../session";
import { checkCbgStatus } from "../cbg";
import { crawl, validateCrawlOptions, type CrawlOptions } from "./runner";
import { createPlaywrightCrawlAdapter } from "../adapters/playwright";
import { CrawlStore } from "./store";
import {
  DEFAULT_CRAWL_CONCURRENCY,
  crawlAccessFailure,
  type CrawlAccessError,
  type CrawlStatus,
  type SavedRoleRecord,
} from "./types";
import { diagnostics, watchWorkPage } from "../diagnostics";
import { loadProfile, saveProfile } from "../analysis/profile";
import { assertServiceOpen } from "../service-lifecycle";
import { showBrowserWorkPages } from "../config";
import { BrowserConnectionError, browserConnectionFailure } from "../browser-connection";
import { headRefreshSettings } from "./head-refresh-settings";
import { roleTrainingSettings } from "./role-training-settings";
import { watchCrawlAccess } from "./access-guard";
import { createCaptureFailureBudget, CrawlFailureLimitError } from "./failure-budget";

type CrawlRuntime = {
  storage?: CrawlStore;
  status: CrawlStatus;
  abort: AbortController | null;
  activeRun: ActiveCrawl | null;
};
const runtimeKey = Symbol.for("cbg.crawl-runtime.v1");
const runtime = globalThis as typeof globalThis & { [runtimeKey]?: CrawlRuntime };
// 模块重载后仍由同一份状态和暂停控制器管理在途采集，避免误报为其他服务。
const cache = (runtime[runtimeKey] ??= {
  status: {
    running: false,
    phase: "idle",
    message: "查询角色列表后，可开始采集或继续上次任务。",
    page: 0,
    totalPages: 0,
    saved: 0,
    skipped: 0,
    totalSaved: 0,
    database: "data/cbg.sqlite",
  },
  abort: null,
  activeRun: null,
});
const store = () => {
  cache.storage ||= new CrawlStore();
  officialGovernor(cache.storage.db);
  // Upgrade methods after HMR without replacing the connection used by in-flight tasks.
  if (Object.getPrototypeOf(cache.storage) !== CrawlStore.prototype)
    Object.setPrototypeOf(cache.storage, CrawlStore.prototype);
  return cache.storage;
};
export type CrawlOrigin = "manual" | "scheduled";
export interface ActiveCrawl {
  origin: CrawlOrigin;
  startedAt: number;
  completion: Promise<CrawlStatus>;
}
export interface CrawlStartResult {
  status: CrawlStatus;
  started: boolean;
  activity: ActiveCrawl | null;
}
export function crawlStatus() {
  return {
    ...cache.status,
    totalSaved: store().count(),
    checkpoint: store().checkpoint(),
    pageReviews: store().pageReviews(),
    latestComplete: store().latestComplete(),
    recent: store().recent(),
  };
}
export function isCrawling() {
  return cache.status.running || cache.activeRun !== null;
}
export function crawlActivity() {
  return cache.activeRun;
}
export function clearCrawl() {
  if (isCrawling()) throw new Error("请先暂停采集，再清空数据");
  store().clear();
  cache.status = {
    running: false,
    phase: "idle",
    message: "历史采集数据已清空，可重新开始采集。",
    page: 0,
    totalPages: 0,
    saved: 0,
    skipped: 0,
    totalSaved: 0,
    database: "data/cbg.sqlite",
  };
  return crawlStatus();
}
export function savedDetail(key: string) {
  return store().detail(key);
}
export function crawlDatabase() {
  return store().db;
}
export function captureRetryItems(keys?: string[]) {
  return store().retryItems(keys);
}
export function equipmentAnalysisSettings() {
  return { analyzeEquipment: loadProfile(store().db).settings.analyzeEquipment === true };
}
export function setEquipmentAnalysis(value: unknown) {
  if (typeof value !== "boolean") throw new Error("装备分析开关无效");
  const profile = loadProfile(store().db);
  saveProfile(store().db, {
    template: profile.template,
    baseHash: profile.hash,
    settings: { ...profile.settings, analyzeEquipment: value },
  });
  return equipmentAnalysisSettings();
}
export function savedRecords(
  page: number,
  pageSize: number,
  scope: import("./types").SavedListingScope = "all",
) {
  return store().records(page, pageSize, scope);
}
export function stopCrawl(reason: "manual" | "time_limit" = "manual") {
  diagnostics.record("crawl.stop_requested", { running: isCrawling(), reason });
  cache.abort?.abort(
    Object.assign(new Error(reason === "time_limit" ? "达到最长运行时长" : "用户暂停采集"), {
      code: reason === "time_limit" ? "CRAWL_TIME_LIMIT" : "CRAWL_MANUAL_PAUSE",
    }),
  );
  if (cache.status.running)
    cache.status = { ...cache.status, message: "正在暂停，当前已入库数据和断点会保留…" };
  return crawlStatus();
}
export async function startCrawl(
  origin: CrawlOrigin = "manual",
  canStart?: () => boolean,
  options: CrawlOptions = {},
): Promise<CrawlStartResult> {
  assertServiceOpen();
  const access = officialGovernor(store().db).read();
  if (access.state !== "ready")
    throw new Error("官网访问已暂停，请处理登录、验证或冷却原因，并在访问状态中人工继续");
  options = {
    ...options,
    minRoleTrainingTotal:
      options.minRoleTrainingTotal === undefined
        ? roleTrainingSettings().minTotal
        : options.minRoleTrainingTotal,
    headRefresh: options.headRefresh ?? headRefreshSettings(),
    newTaskQuota: options.newTaskQuota ?? access.policy.newTaskQuota,
  };
  validateCrawlOptions(options);
  if (browserSettings().accessAdapter === "extension-native" && (options.concurrency ?? 1) !== 1)
    throw new Error("扩展与 macOS 输入当前只支持并发 1，请将采集并发改为 1 后开始");
  if (options.refresh) store().retryItems(options.keys, true);
  if (isCrawling()) return { status: crawlStatus(), started: false, activity: cache.activeRun };
  if (browserSettings().accessAdapter === "extension-native")
    return startNativeCrawl(origin, canStart, options);
  const current = await checkCbgStatus();
  assertServiceOpen();
  const page = getCbgPage();
  if (current.running || !current.isLoggedIn || !page || current.workflowStep !== "completed")
    throw new Error("请先完成登录并进入角色列表，再开始采集");
  // checkCbgStatus 会等待页面，返回后再查一次，防止双击并发启动。
  if (isCrawling()) return { status: crawlStatus(), started: false, activity: cache.activeRun };
  if (origin === "scheduled" && canStart && !canStart())
    return { status: crawlStatus(), started: false, activity: null };
  const owner = randomUUID();
  const db = store();
  const preferredOrder = db.checkpoint()?.order;
  if (!db.acquire(owner)) throw new Error("已有另一个本地服务正在采集，请先暂停它");
  const crawlLease = db.crawlLease(owner);
  try {
    await bindOfficialPage(page, { runId: owner, sourceKind: "crawl-list", crawlLease });
  } catch (error) {
    db.release(owner);
    throw error;
  }
  db.setProgressContext(() => officialPageContext(page));
  const started = Date.now();
  const concurrency = options.concurrency ?? DEFAULT_CRAWL_CONCURRENCY;
  const log = (event: string, data: Record<string, unknown> = {}) =>
    diagnostics.record(event, { crawlId: owner, ...data });
  log("crawl.start", {
    checkpoint: db.checkpoint(),
    totalSaved: db.count(),
    includeAssets: true,
    concurrency,
  });
  const control = new AbortController();
  cache.abort = control;
  cache.status = {
    ...cache.status,
    running: true,
    concurrency,
    minRoleTrainingTotal: options.minRoleTrainingTotal ?? null,
    filteredTraining: 0,
    includeAssets: true,
    phase: "locating",
    message: "正在创建隐藏详情页并读取断点…",
    saved: 0,
    skipped: 0,
    error: undefined,
    failed: 0,
    accessIssue: undefined,
    browserIssue: undefined,
    retryTotal: undefined,
    retryCompleted: undefined,
    headRefresh: options.backfillOnly ? undefined : options.headRefresh,
    nextHeadCheckAt: undefined,
    lastHeadRefreshAt: undefined,
    lastItemError: undefined,
    current: undefined,
    itemIndex: 0,
    itemsOnPage: 0,
    detailProgress: undefined,
  };
  const lease = setInterval(() => {
    try {
      if (!db.acquire(owner)) control.abort(new Error("采集锁失效，已暂停"));
    } catch (error) {
      control.abort(error);
    }
  }, 30000);
  const runningTask = (async () => {
    const detailPages: Page[] = [];
    const guards: (() => Promise<void>)[] = [];
    let closingAccessPages: Promise<unknown> | undefined;
    const cancelAccessPages = () => {
      if (
        !crawlAccessFailure(control.signal.reason) &&
        !(control.signal.reason instanceof CrawlFailureLimitError)
      )
        return;
      // Only this project's collection pages are closed. This interrupts native browser
      // waits too; no background list action can outlive the lock or affect a later run.
      closingAccessPages = Promise.allSettled(detailPages.map((target) => target.close()));
    };
    control.signal.addEventListener("abort", cancelAccessPages, { once: true });
    const stopForAccess = (error: CrawlAccessError) => {
      if (control.signal.aborted) return;
      cache.status = {
        ...cache.status,
        phase: "paused",
        accessIssue: error.kind,
        message: error.message,
      };
      // The source already closes every active detail page on this shared signal.
      control.abort(error);
      log("crawl.access_blocked", { accessIssue: error.kind, error });
    };
    const watchAccess = async (target: Page, kind: "list" | "detail") => {
      const stop = (error: CrawlAccessError) => {
        log("crawl.access_detected", { kind, accessIssue: error.kind, error });
        stopForAccess(error);
      };
      guards.push(await watchCrawlAccess(target, control.signal, stop));
      control.signal.throwIfAborted();
    };
    const onOpenedDetail = async (detailPage: Page) => {
      control.signal.throwIfAborted();
      if (detailPage === page) return;
      detailPages.push(detailPage);
      watchWorkPage(detailPage, "detail");
      log("page.ready", { kind: "detail" });
      detailPage.setDefaultTimeout(15000);
      await bindOfficialPage(detailPage, {
        runId: owner,
        sourceKind: "crawl-detail",
        signal: control.signal,
        crawlLease,
      });
      await watchAccess(detailPage, "detail");
    };
    try {
      await getBrowser(false).catch((error: unknown) => {
        throw browserConnectionFailure(error) || new BrowserConnectionError("disconnected", error);
      });
      await watchAccess(page, "list");
      const failureBudget = createCaptureFailureBudget();
      await db.withCrawlLease(owner, () =>
        crawl(
          createPlaywrightCrawlAdapter({
            listPage: page,
            detailPage: page,
            openFromList: true,
            onOpenedDetail,
            onFatal: (error) => control.abort(error),
            signal: control.signal,
            preferredOrder,
            savedRecord:
              options.backfillOnly && !options.refresh
                ? (key) => db.detail(key) as SavedRoleRecord | null
                : undefined,
            onDetailProgress: (message) => {
              cache.status = { ...cache.status, detailProgress: message };
            },
            log,
            onAccessFailure: stopForAccess,
            detailTimeoutMs: access.policy.detailReadBudgetMs,
          }).source,
          db,
          control.signal,
          (update) => {
            const captured = (update.saved || 0) > cache.status.saved;
            cache.status = { ...cache.status, ...update };
            const limit = failureBudget(update);
            if (limit && !control.signal.aborted) {
              cache.status = { ...cache.status, phase: "paused", message: limit.message };
              control.abort(limit);
            }
            if (captured) {
              void import("../analysis/controller")
                .then((analysis) => analysis.appendCapturedAnalysis())
                .catch((error: unknown) =>
                  diagnostics.record("analysis.capture_enqueue_failed", { error }),
                );
            }
          },
          { ...options, watch: options.watch ?? !options.backfillOnly },
        ),
      );
    } finally {
      control.signal.removeEventListener("abort", cancelAccessPages);
      await closingAccessPages;
      await Promise.allSettled(guards.map((dispose) => dispose()));
      if (
        !showBrowserWorkPages() ||
        crawlAccessFailure(control.signal.reason) ||
        control.signal.reason instanceof CrawlFailureLimitError
      )
        await Promise.allSettled(detailPages.map((page) => page.close()));
    }
  })()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const access = crawlAccessFailure(control.signal.reason) || crawlAccessFailure(error);
      const connection = browserConnectionFailure(error);
      const paused = control.signal.aborted || !!access || !!connection;
      log(paused ? "crawl.paused" : "crawl.error", {
        error,
        accessIssue: access?.kind,
        browserIssue: connection?.kind,
        page: cache.status.page,
        itemIndex: cache.status.itemIndex,
        detailProgress: cache.status.detailProgress,
      });
      cache.status = {
        ...cache.status,
        running: false,
        phase: paused ? "paused" : "error",
        message:
          access?.message ||
          (control.signal.reason instanceof CrawlFailureLimitError
            ? control.signal.reason.message
            : control.signal.aborted
              ? "采集已暂停，断点已保留。"
              : connection?.message || message),
        error: paused ? undefined : message,
        accessIssue: access?.kind,
        browserIssue: connection?.kind,
        detailProgress: undefined,
      };
      if (!paused) console.error("[CBG_CRAWL]", message);
    })
    .finally(() => {
      clearInterval(lease);
      db.setProgressContext(undefined);
      db.release(owner);
      cache.abort = null;
      cache.status = { ...cache.status, running: false };
      log("crawl.finished", {
        phase: cache.status.phase,
        saved: cache.status.saved,
        skipped: cache.status.skipped,
        durationMs: Date.now() - started,
      });
    });
  const completion = runningTask
    .then(() => crawlStatus())
    .finally(() => {
      cache.activeRun = null;
    });
  const activity = { origin, startedAt: started, completion };
  cache.activeRun = activity;
  return { status: crawlStatus(), started: true, activity };
}

async function startNativeCrawl(
  origin: CrawlOrigin,
  canStart: (() => boolean) | undefined,
  options: CrawlOptions,
): Promise<CrawlStartResult> {
  const { nativeAccess, nativeAccessOwner } = await import("../native-access");
  const { bindNativeCrawlSource } = await import("../adapters/native-query-health");
  const adapter = await nativeAccess(store().db);
  if (adapter.status().idle)
    await withNativeWorkflow(new AbortController().signal, () => adapter.resumeForRun());
  const current = await adapter.snapshot();
  if (
    !current.listing ||
    current.access !== "normal" ||
    current.authenticated !== true ||
    current.loading ||
    adapter.status().stopped
  )
    throw new Error("请先通过扩展绑定已登录并完成查询的角色列表");
  if (isCrawling()) return { status: crawlStatus(), started: false, activity: cache.activeRun };
  if (origin === "scheduled" && canStart && !canStart())
    return { status: crawlStatus(), started: false, activity: null };
  const owner = randomUUID(),
    db = store(),
    control = new AbortController();
  if (!db.acquire(owner)) throw new Error("已有另一个本地服务正在采集");
  let source: ReturnType<typeof bindNativeCrawlSource>;
  try {
    source = bindNativeCrawlSource(
      adapter,
      officialGovernor(db.db),
      nativeAccessOwner(),
      control.signal,
      db.crawlLease(owner),
      current,
    );
  } catch (error) {
    db.release(owner);
    throw error;
  }
  db.setProgressContext(source.context);
  cache.abort = control;
  cache.status = {
    ...cache.status,
    running: true,
    phase: "collecting",
    concurrency: 1,
    minRoleTrainingTotal: options.minRoleTrainingTotal ?? null,
    filteredTraining: 0,
    error: undefined,
    message: "正在通过扩展读取与 macOS 输入采集",
    saved: 0,
    skipped: 0,
    failed: 0,
  };
  const startedAt = Date.now();
  const failureBudget = createCaptureFailureBudget();
  const lease = setInterval(() => {
    try {
      if (!db.acquire(owner)) control.abort(new Error("采集租约已失效"));
    } catch (error) {
      control.abort(error);
    }
  }, 30000);
  const completion = Promise.resolve()
    .then(() =>
      db.withCrawlLease(owner, () =>
        crawl(
          source.source,
          db,
          control.signal,
          (update) => {
            const captured = (update.saved || 0) > cache.status.saved;
            cache.status = { ...cache.status, ...update };
            const failure = failureBudget(update);
            if (failure && !control.signal.aborted) control.abort(failure);
            if (captured) {
              void import("../analysis/controller")
                .then((analysis) => analysis.appendCapturedAnalysis())
                .catch((error: unknown) =>
                  diagnostics.record("analysis.capture_enqueue_failed", { error }),
                );
            }
          },
          { ...options, concurrency: 1, watch: options.watch ?? !options.backfillOnly },
        ),
      ),
    )
    .catch((error) => {
      cache.status = {
        ...cache.status,
        phase: "paused",
        running: false,
        message: error instanceof Error ? error.message : String(error),
        error: undefined,
      };
    })
    .finally(async () => {
      clearInterval(lease);
      db.release(owner);
      db.setProgressContext(undefined);
      try {
        await withNativeWorkflow(new AbortController().signal, () =>
          adapter.finishRun("本轮采集已停止，资料与进度已保留"),
        );
      } catch (error) {
        cache.status = {
          ...cache.status,
          phase: "paused",
          message: error instanceof Error ? error.message : String(error),
        };
        diagnostics.record("crawl.native_finish_failed", { error });
      } finally {
        cache.abort = null;
        cache.status = { ...cache.status, running: false };
        cache.activeRun = null;
      }
    })
    .then(() => crawlStatus());
  const activity = { origin, startedAt, completion };
  cache.activeRun = activity;
  return { status: crawlStatus(), started: true, activity };
}
