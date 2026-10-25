import type { Page } from "playwright-core";
import { collectDetail, collectValuationDetail, isOnShelf, MAIN_TABS } from "./detail";
import { gotoPage, hoverListing, pace, prepareList } from "./page";
import {
  SellingOrderUnavailableError,
  type CrawlSource,
  type Listing,
  type SavedRoleRecord,
} from "./types";
import { collectCompleteCapture, captureIssues } from "./capture-readiness";
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
        await saveCaptureFailure(detailPage, signal, { key: item.key, attempt, stage, error }, log);
        throw error;
      }
    },
    signal,
    report,
    item,
  );
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
}: SourceOptions): CrawlSource {
  const available = [detailPage];
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
      try {
        return await collectRole(page, item, { signal, savedRecord, onDetailProgress, log });
      } finally {
        available.push(page);
      }
    },
  };
}
