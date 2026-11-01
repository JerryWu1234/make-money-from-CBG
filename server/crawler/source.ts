import type { Page } from "playwright-core";
import { collectDetail, isOnShelf, MAIN_TABS } from "./detail";
import { gotoPage, hoverListing, pace, prepareList } from "./page";
import {
  SellingOrderUnavailableError,
  type CrawlSource,
  type Listing,
  type SavedRoleRecord,
} from "./types";
import {
  collectCompleteCapture,
  captureIssues,
  IncompleteCaptureError,
  CaptureDeadlineError,
  captureAbortMessage,
  isRetryableDetailNavigation,
  DetailNavigationResetError,
} from "./capture-readiness";
import { accessNavigationFailure } from "./access-navigation";
import { crawlAccessFailure } from "./types";
import { saveCaptureFailure } from "./capture-failure";
import { captureBrowserStep } from "../browser-evidence";
import { classifyBrowserFailure } from "../browser-connection";
import { roleIdentityIssues } from "./role-identity";

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

/** 完整商品直接复用；新商品读取一次，未读到资料前的导航失败可有界恢复。 */
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
  signal.throwIfAborted();
  const previous = savedRecord?.(item.key);
  if (
    previous?.status === "complete" &&
    previous.listing.key === item.key &&
    previous.listing.serverId === item.serverId &&
    previous.listing.eid === item.eid &&
    previous.listing.ordersn === item.ordersn &&
    previous.listing.sellingTime === item.sellingTime &&
    previous.listing.price === item.price &&
    previous.detail &&
    previous.detail.captureMode === "all" &&
    !roleIdentityIssues(previous.detail.valuation?.source, item).length &&
    !captureIssues(previous.detail, true, true, item).length &&
    MAIN_TABS.every((name) => previous.detail!.tabs.some((tab) => tab.name === name))
  ) {
    onDetailProgress(`${item.name || item.eid}：资料已完整，使用已保存的采集结果`);
    log("detail.reused", { key: item.key, collectedAt: previous.detail.collectedAt });
    return structuredClone(previous.detail);
  }
  const started = Date.now();
  let attempt = 0;
  let stage = "开始读取角色详情";
  log("detail.start", { key: item.key });
  const report = (message: string) => {
    const metadataPrefix = "物品元数据读取异常：";
    if (message.startsWith(metadataPrefix)) {
      log("detail.model_metadata_error", {
        key: item.key,
        ...JSON.parse(message.slice(metadataPrefix.length)),
      });
      return;
    }
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
  const result = await collectCompleteCapture(
    async () => {
      attempt++;
      stage = "开始读取角色详情";
      try {
        await pace(signal, 1800, 1700);
        const detail = await collectDetail(detailPage, item, signal, report);
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
            : classifyBrowserFailure(detailPage, error, signal);
        await saveCaptureFailure(
          detailPage,
          signal,
          { key: item.key, attempt, stage, error: failure },
          log,
        );
        if (!signal.aborted && isRetryableDetailNavigation(failure)) {
          // A timed-out goto can still be navigating. Commit an empty document before
          // retrying so its late response or scheduled reload cannot interrupt the next goto.
          const resetStarted = Date.now();
          try {
            await detailPage.goto("about:blank", { waitUntil: "commit", timeout: 5000 });
            signal.throwIfAborted();
            log("detail.navigation_reset", {
              key: item.key,
              attempt,
              durationMs: Date.now() - resetStarted,
              error: failure,
            });
          } catch (resetError) {
            signal.throwIfAborted();
            const connection = classifyBrowserFailure(detailPage, resetError, signal);
            if (connection !== resetError) throw connection;
            await detailPage.close().catch(() => {});
            throw new DetailNavigationResetError(resetError);
          }
        }
        throw failure;
      }
    },
    signal,
    report,
    item,
  );
  if (signal.aborted)
    throw new IncompleteCaptureError(captureAbortMessage(signal.reason), result, signal.reason);
  await captureBrowserStep(
    detailPage,
    { flow: "collection", stage: "角色详情读取完成", key: item.key },
    signal,
  );
  log("detail.collected", {
    key: item.key,
    durationMs: Date.now() - started,
    attempts: attempt,
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
      const failure = classifyBrowserFailure(page, error, signal);
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
      throw failure;
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
    page: (number, refresh = false) =>
      step(listPage, `列表翻页至第 ${number} 页`, async () => {
        const result = await gotoPage(listPage, number, signal, refresh);
        log("list.page_ready", {
          requestedPage: number,
          actualPage: result.page,
          totalPages: result.totalPages,
          count: result.items.length,
          order: result.order,
          refresh,
          keys: result.items.map((item) => item.key),
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
      const started = Date.now();
      let stage = "准备读取详情";
      const failureLog = (event: string, error: unknown) => {
        const cause = local.aborted
          ? local.reason
          : error instanceof Error
            ? error.cause
            : undefined;
        let reasonCode: string | undefined;
        for (
          let reason = local.aborted ? local.reason : error, depth = 0;
          reason instanceof Error && depth < 5;
          reason = reason.cause, depth++
        ) {
          if ("code" in reason && typeof reason.code === "string") {
            reasonCode = reason.code;
            break;
          }
        }
        try {
          log(event, {
            key: item.key,
            stage,
            durationMs: Date.now() - started,
            reasonCode:
              reasonCode ||
              (signal.aborted
                ? "CRAWL_CANCELLED"
                : local.aborted
                  ? "DETAIL_CANCELLED"
                  : "DETAIL_READ_FAILED"),
            error,
            cause,
          });
        } catch {
          /* Diagnostics cannot replace a capture failure or prevent page cleanup. */
        }
      };
      let closing: Promise<void> | undefined;
      const close = () => (closing ||= page.close());
      const cancel = () => {
        failureLog("detail.cancelled", local.reason);
        void close().catch((error: unknown) =>
          log("detail.close_failed", { key: item.key, error }),
        );
      };
      local.addEventListener("abort", cancel, { once: true });
      if (local.aborted) cancel();
      active.set(control, close);
      const timer = setTimeout(
        () => control.abort(new CaptureDeadlineError(detailTimeoutMs, stage)),
        detailTimeoutMs,
      );
      try {
        local.throwIfAborted();
        return await collectRole(page, item, {
          signal: local,
          savedRecord,
          log,
          onDetailProgress: (message) => {
            stage = message;
            local.throwIfAborted();
            onDetailProgress(message);
          },
        });
      } catch (error) {
        failureLog("detail.failed", error);
        throw error;
      } finally {
        clearTimeout(timer);
        local.removeEventListener("abort", cancel);
        active.delete(control);
        if (closing)
          await closing.catch((error: unknown) =>
            log("detail.close_failed", { key: item.key, error }),
          );
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
