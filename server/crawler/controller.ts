import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { getBrowser, getCbgPage, createHiddenPage } from "../session";
import { checkCbgStatus } from "../cbg";
import { crawl, validateCrawlOptions, type CrawlOptions } from "./runner";
import { createCrawlSource } from "./source";
import { CrawlStore } from "./store";
import { DEFAULT_CRAWL_CONCURRENCY, type CrawlStatus, type SavedRoleRecord } from "./types";
import { diagnostics, watchWorkPage } from "../diagnostics";
import { loadProfile, saveProfile } from "../analysis/profile";
import { assertServiceOpen } from "../service-lifecycle";
import { showBrowserWorkPages } from "../config";

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
const store = () => (cache.storage ||= new CrawlStore());
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
  cache.abort?.abort(new Error(reason === "time_limit" ? "达到最长运行时长" : "用户暂停采集"));
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
  validateCrawlOptions(options);
  if (options.refresh) store().retryItems(options.keys, true);
  if (isCrawling()) return { status: crawlStatus(), started: false, activity: cache.activeRun };
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
    includeAssets: true,
    phase: "locating",
    message: "正在创建隐藏详情页并读取断点…",
    saved: 0,
    skipped: 0,
    error: undefined,
    failed: 0,
    retryTotal: undefined,
    retryCompleted: undefined,
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
    const createDetailPage = async () => {
      control.signal.throwIfAborted();
      const detailPage = await createHiddenPage(await getBrowser(true, undefined, "detail"));
      detailPages.push(detailPage);
      watchWorkPage(detailPage, "detail");
      log("page.ready", { kind: "detail" });
      detailPage.setDefaultTimeout(15000);
      return detailPage;
    };
    try {
      const detailPage = await createDetailPage();
      await crawl(
        createCrawlSource({
          listPage: page,
          detailPage,
          createDetailPage,
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
        }),
        db,
        control.signal,
        (update) => {
          const captured = (update.saved || 0) > cache.status.saved;
          cache.status = { ...cache.status, ...update };
          if (captured) {
            void import("../analysis/controller")
              .then((analysis) => analysis.appendCapturedAnalysis())
              .catch((error: unknown) =>
                diagnostics.record("analysis.capture_enqueue_failed", { error }),
              );
          }
        },
        { ...options, watch: options.watch ?? !options.backfillOnly },
      );
    } finally {
      if (!showBrowserWorkPages())
        await Promise.allSettled(detailPages.map((page) => page.close()));
    }
  })()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(control.signal.aborted ? "crawl.paused" : "crawl.error", {
        error,
        page: cache.status.page,
        itemIndex: cache.status.itemIndex,
        detailProgress: cache.status.detailProgress,
      });
      cache.status = {
        ...cache.status,
        running: false,
        phase: control.signal.aborted ? "paused" : "error",
        message: control.signal.aborted ? "采集已暂停，断点已保留。" : message,
        error: control.signal.aborted ? undefined : message,
        detailProgress: undefined,
      };
      if (!control.signal.aborted) console.error("[CBG_CRAWL]", message);
    })
    .finally(() => {
      clearInterval(lease);
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
