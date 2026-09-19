import { randomUUID } from "node:crypto";
import { getBrowser, getCbgPage, createHiddenPage } from "../session";
import { checkCbgStatus } from "../cbg";
import { collectDetail, isOnShelf } from "./detail";
import { gotoPage, hoverListing, pace, prepareList } from "./page";
import { crawl } from "./runner";
import { CrawlStore } from "./store";
import type { CrawlStatus } from "./types";
import { diagnostics, watchWorkPage } from "../diagnostics";

let storage: CrawlStore | undefined;
const store = () => (storage ||= new CrawlStore());
let status: CrawlStatus = {
  running: false,
  phase: "idle",
  message: "查询角色列表后，可开始采集或继续上次任务。",
  page: 0,
  totalPages: 0,
  saved: 0,
  skipped: 0,
  totalSaved: 0,
  database: "data/cbg.sqlite",
};
let abort: AbortController | null = null;
export function crawlStatus() {
  return {
    ...status,
    totalSaved: store().count(),
    checkpoint: store().checkpoint(),
    recent: store().recent(),
  };
}
export function isCrawling() {
  return status.running;
}
export function clearCrawl() {
  if (status.running) throw new Error("请先暂停采集，再清空数据");
  store().clear();
  status = {
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
export function savedRecords(page: number, pageSize: number) {
  return store().records(page, pageSize);
}
export function stopCrawl() {
  diagnostics.record("crawl.stop_requested", { running: status.running });
  abort?.abort(new Error("用户暂停采集"));
  if (status.running) status = { ...status, message: "正在暂停，当前已入库数据和断点会保留…" };
  return crawlStatus();
}
export async function startCrawl() {
  if (status.running) return crawlStatus();
  const current = await checkCbgStatus();
  const page = getCbgPage();
  if (current.running || !current.isLoggedIn || !page || current.workflowStep !== "completed")
    throw new Error("请先完成登录并进入角色列表，再开始采集");
  // checkCbgStatus 会等待页面，返回后再查一次，防止双击并发启动。
  if (status.running) return crawlStatus();
  const owner = randomUUID();
  const db = store();
  const preferredOrder = db.checkpoint()?.order;
  if (!db.acquire(owner)) throw new Error("已有另一个本地服务正在采集，请先暂停它");
  const started = Date.now();
  const log = (event: string, data: Record<string, unknown> = {}) =>
    diagnostics.record(event, { crawlId: owner, ...data });
  log("crawl.start", { checkpoint: db.checkpoint(), totalSaved: db.count() });
  const control = new AbortController();
  abort = control;
  status = {
    ...status,
    running: true,
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
  void (async () => {
    log("page.create_start", { kind: "detail" });
    const detailPage = await createHiddenPage(await getBrowser());
    watchWorkPage(detailPage, "detail");
    log("page.ready", { kind: "detail" });
    detailPage.setDefaultTimeout(15000);
    try {
      await crawl(
        {
          prepare: async () => {
            log("list.prepare_start");
            const result = await prepareList(page, control.signal, preferredOrder);
            log("list.prepared", {
              page: result.page,
              totalPages: result.totalPages,
              order: result.order,
              count: result.items.length,
            });
            return result;
          },
          page: async (number) => {
            log("list.page_start", { requestedPage: number });
            const result = await gotoPage(page, number, control.signal);
            log("list.page_ready", {
              requestedPage: number,
              actualPage: result.page,
              totalPages: result.totalPages,
              count: result.items.length,
            });
            return result;
          },
          onShelf: async (item) => {
            log("anchor.check_start", { key: item.key });
            await pace(control.signal, 600, 400);
            const onShelf = await isOnShelf(detailPage, item, control.signal);
            log("anchor.checked", { key: item.key, onShelf });
            return onShelf;
          },
          hover: async (item) => {
            log("listing.inspect", {
              key: item.key,
              page: status.page,
              itemIndex: status.itemIndex,
            });
            return hoverListing(page, item, control.signal);
          },
          detail: async (item) => {
            const detailStarted = Date.now();
            log("detail.start", { key: item.key });
            await pace(control.signal, 1800, 1700);
            const result = await collectDetail(detailPage, item, control.signal, (message) => {
              status = { ...status, detailProgress: message };
              log("detail.progress", { key: item.key, message });
            });
            log("detail.collected", {
              key: item.key,
              durationMs: Date.now() - detailStarted,
              tabs: result.tabs.map((tab) => ({
                name: tab.name,
                petCount: tab.petCount,
                capturedPets: tab.pets?.length,
                items: tab.items?.length,
              })),
            });
            return result;
          },
        },
        db,
        control.signal,
        (update) => {
          status = { ...status, ...update };
          const { current: _current, ...progress } = update;
          log("crawl.progress", progress);
        },
      );
    } finally {
      await detailPage.close().catch(() => {});
    }
  })()
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log(control.signal.aborted ? "crawl.paused" : "crawl.error", {
        error,
        page: status.page,
        itemIndex: status.itemIndex,
        detailProgress: status.detailProgress,
      });
      status = {
        ...status,
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
      abort = null;
      status = { ...status, running: false };
      log("crawl.finished", {
        phase: status.phase,
        saved: status.saved,
        skipped: status.skipped,
        durationMs: Date.now() - started,
      });
    });
  return crawlStatus();
}
