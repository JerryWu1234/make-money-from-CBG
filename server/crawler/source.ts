import type { Page } from "playwright-core";
import { collectDetail, collectValuationDetail, isOnShelf, MAIN_TABS } from "./detail";
import { gotoPage, hoverListing, pace, prepareList } from "./page";
import {
  SellingOrderUnavailableError,
  type CrawlSource,
  type Listing,
  type SavedRoleRecord,
} from "./types";
import { collectCompleteCapture, captureIssues, IncompleteCaptureError } from "./capture-readiness";
import { accessNavigationFailure } from "./access-navigation";
import { crawlAccessFailure } from "./types";
import { saveCaptureFailure } from "./capture-failure";
import { captureBrowserStep } from "../browser-evidence";

interface SourceOptions {
  listPage: Page;
  detailPage: Page;
  createDetailPage?: () => Promise<Page>;
  signal: AbortSignal;
  preferredOrder?: string;
  savedRecord?: (key: string) => SavedRoleRecord | null;
  onDetailProgress: (message: string) => void;
  log: (event: string, data?: Record<string, unknown>) => void;
  detailTimeoutMs?: number;
}

/** 完整抓取一个角色，包括标签、装备、宝宝及采集完整性重读。 */
export async function collectRole(
  detailPage: Page,
  item: Listing,
  {
    signal,
    savedRecord,
    onDetailProgress,
    log,
  }: Pick<SourceOptions, "signal" | "savedRecord" | "onDetailProgress" | "log">,
) {
  const started = Date.now();
  let attempt = 0;
  let stage = "开始读取角色详情";
  log("detail.start", { key: item.key });
  const report = (message: string) => {
    const prefix = "召唤兽图标核对异常：";
    if (message.startsWith(prefix)) {
      log("detail.pet_icon_mismatch", {
        key: item.key,
        diagnostic: JSON.parse(message.slice(prefix.length)),
      });
      return;
    }
    stage = message;
    onDetailProgress(`${item.name || item.eid}：${message}`);
  };
  const previous = savedRecord?.(item.key);
  const result = await collectCompleteCapture(
    async () => {
      attempt++;
      stage = "开始读取角色详情";
      try {
        await pace(signal, 1800, 1700);
        const detail =
          previous?.detail &&
          !captureIssues(previous.detail, true, true, item).length &&
          MAIN_TABS.every((name) => previous.detail!.tabs.some((tab) => tab.name === name))
            ? await collectValuationDetail(detailPage, item, previous.detail, signal, report)
            : await collectDetail(detailPage, item, signal, report);
        const issues = captureIssues(detail, true, true, item);
        if (issues.length)
          await saveCaptureFailure(
            detailPage,
            signal,
            { key: item.key, attempt, stage, issues },
            log,
          );
        return detail;
      } catch (error) {
        const access = signal.aborted
          ? undefined
          : await accessNavigationFailure(detailPage, error, signal);
        const failure =
          access && !crawlAccessFailure(error)
            ? error instanceof IncompleteCaptureError
              ? new IncompleteCaptureError(access.message, error.detail, access)
              : access
            : error;
        await saveCaptureFailure(
          detailPage,
          signal,
          { key: item.key, attempt, stage, error: failure },
          log,
        );
        throw failure;
      }
    },
    signal,
    report,
    item,
  );
  if (signal.aborted)
    throw new IncompleteCaptureError("采集已中断，已保留读取资料", result, signal.reason);
  await captureBrowserStep(
    detailPage,
    { flow: "collection", stage: "角色详情读取完成", key: item.key },
    signal,
  );
  log("detail.collected", {
    key: item.key,
    durationMs: Date.now() - started,
    equipmentComplete: result.equipmentCapture?.complete,
    equipmentIssues: result.equipmentCapture?.issues,
    petsComplete: result.petCapture?.complete,
    petIssues: result.petCapture?.issues,
    tabs: result.tabs.map((tab) => ({
      name: tab.name,
      petCount: tab.petCount,
      capturedPets: tab.pets?.length,
      items: tab.items?.length,
    })),
  });
  return result;
}

export function createCrawlSource({
  listPage,
  detailPage,
  createDetailPage,
  signal,
  preferredOrder,
  savedRecord,
  onDetailProgress,
  log,
  detailTimeoutMs = 180_000,
}: SourceOptions): CrawlSource {
  const available = [detailPage];
  const active = new Map<AbortController, () => Promise<void>>();
  const step = async <T>(page: Page, stage: string, read: () => Promise<T>, key?: string) => {
    try {
      const result = await read();
      await captureBrowserStep(page, { flow: "collection", stage: stage + "完成", key }, signal);
      return result;
    } catch (error) {
      // This typed signal selects runner's existing full-list scan; it is not a failed action.
      // Keep throwing it so expiry order never inherits the selling-time watermark strategy.
      const orderFallback = error instanceof SellingOrderUnavailableError;
      if (orderFallback)
        log("list.selling_order_unavailable", {
          requestedOrder: "selling_time DESC",
          strategy: "full-scan",
        });
      await captureBrowserStep(
        page,
        orderFallback
          ? { flow: "collection", stage: "上架时间排序不可用-切换逐页全表扫描", key }
          : { flow: "collection", stage: stage + "失败", key, error },
        signal,
      );
      throw error;
    }
  };
  return {
    prepare: (order) =>
      step(listPage, "列表准备", async () => {
        const result = await prepareList(listPage, signal, order ?? preferredOrder);
        log("list.prepared", {
          page: result.page,
          totalPages: result.totalPages,
          order: result.order,
          count: result.items.length,
        });
        return result;
      }),
    page: (number) =>
      step(listPage, `列表翻页至第 ${number} 页`, async () => {
        const result = await gotoPage(listPage, number, signal);
        log("list.page_ready", {
          requestedPage: number,
          actualPage: result.page,
          totalPages: result.totalPages,
          count: result.items.length,
        });
        return result;
      }),
    onShelf: (item) =>
      step(
        detailPage,
        "角色上架状态读取",
        async () => {
          await pace(signal, 600, 400);
          const onShelf = await isOnShelf(detailPage, item, signal);
          log("anchor.checked", { key: item.key, onShelf });
          return onShelf;
        },
        item.key,
      ),
    hover: (item) =>
      step(
        listPage,
        "列表角色悬停读取",
        () =>
          hoverListing(
            listPage,
            item,
            signal,
            (stage) => log("list.hover_recovered", { key: item.key, stage }),
            ({ event, ...diagnostic }) => log(`list.hover_${event}`, diagnostic),
          ),
        item.key,
      ),
    detail: async (item) => {
      signal.throwIfAborted();
      const page = available.pop() || (await createDetailPage?.());
      if (!page) throw new Error("并发采集需要独立的角色详情页");
      const control = new AbortController();
      const local = AbortSignal.any([signal, control.signal]);
      let closing: Promise<void> | undefined;
      const close = () => (closing ||= page.close());
      const cancel = () => {
        void close().catch((error: unknown) =>
          log("detail.close_failed", { key: item.key, error }),
        );
      };
      local.addEventListener("abort", cancel, { once: true });
      if (local.aborted) cancel();
      active.set(control, close);
      const timer = setTimeout(
        () =>
          control.abort(
            Object.assign(
              new Error(
                `角色详情采集超过 ${detailTimeoutMs / 1000} 秒总时限，已停止本件读取并保留资料`,
              ),
              { name: "IncompleteDetailError" },
            ),
          ),
        detailTimeoutMs,
      );
      try {
        local.throwIfAborted();
        return await collectRole(page, item, {
          signal: local,
          savedRecord,
          log,
          onDetailProgress: (message) => {
            local.throwIfAborted();
            onDetailProgress(message);
          },
        });
      } finally {
        clearTimeout(timer);
        local.removeEventListener("abort", cancel);
        active.delete(control);
        if (closing) await closing;
        if (!local.aborted && !page.isClosed()) available.push(page);
      }
    },
    cancelDetails: async (reason) => {
      const current = [...active];
      for (const [control] of current) control.abort(reason);
      await Promise.all(current.map(([, close]) => close()));
    },
  };
}
