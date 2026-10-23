import type { Page } from "playwright-core";
import { collectDetail, collectValuationDetail, isOnShelf, MAIN_TABS } from "./detail";
import { gotoPage, hoverListing, pace, prepareList } from "./page";
import type { CrawlSource, Listing, SavedRoleRecord } from "./types";
import { collectCompleteCapture, captureIssues } from "./capture-readiness";

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
  log("detail.start", { key: item.key });
  const report = (message: string) => onDetailProgress(`${item.name || item.eid}：${message}`);
  const previous = savedRecord?.(item.key);
  const result = await collectCompleteCapture(
    async () => {
      await pace(signal, 1800, 1700);
      return previous?.detail &&
        !captureIssues(previous.detail, true).length &&
        MAIN_TABS.every((name) => previous.detail!.tabs.some((tab) => tab.name === name))
        ? await collectValuationDetail(detailPage, item, previous.detail, signal, report)
        : await collectDetail(detailPage, item, signal, report);
    },
    signal,
    report,
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
  return {
    prepare: async (order) => {
      const result = await prepareList(listPage, signal, order ?? preferredOrder);
      log("list.prepared", {
        page: result.page,
        totalPages: result.totalPages,
        order: result.order,
        count: result.items.length,
      });
      return result;
    },
    page: async (number) => {
      const result = await gotoPage(listPage, number, signal);
      log("list.page_ready", {
        requestedPage: number,
        actualPage: result.page,
        totalPages: result.totalPages,
        count: result.items.length,
      });
      return result;
    },
    onShelf: async (item) => {
      await pace(signal, 600, 400);
      const onShelf = await isOnShelf(detailPage, item, signal);
      log("anchor.checked", { key: item.key, onShelf });
      return onShelf;
    },
    hover: (item) => hoverListing(listPage, item, signal),
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
