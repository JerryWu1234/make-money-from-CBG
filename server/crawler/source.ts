import type { Page } from "playwright-core";
import { collectDetail, collectValuationDetail, isOnShelf, MAIN_TABS } from "./detail";
import { gotoPage, hoverListing, pace, prepareList } from "./page";
import type { CrawlSource, SavedRoleRecord } from "./types";
import { collectCompleteCapture, captureIssues } from "./capture-readiness";

interface SourceOptions {
  listPage: Page;
  detailPage: Page;
  signal: AbortSignal;
  preferredOrder?: string;
  includeAssets?: boolean;
  savedRecord?: (key: string) => SavedRoleRecord | null;
  onDetailProgress: (message: string) => void;
  log: (event: string, data?: Record<string, unknown>) => void;
}

export function createCrawlSource({
  listPage,
  detailPage,
  signal,
  preferredOrder,
  includeAssets = true,
  savedRecord,
  onDetailProgress,
  log,
}: SourceOptions): CrawlSource {
  return {
    prepare: async () => {
      const result = await prepareList(listPage, signal, preferredOrder);
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
      const started = Date.now();
      log("detail.start", { key: item.key });
      const previous = savedRecord?.(item.key);
      const result = await collectCompleteCapture(
        async () => {
          await pace(signal, 1800, 1700);
          return includeAssets &&
            previous?.detail &&
            !captureIssues(previous.detail, true).length &&
            MAIN_TABS.every((name) => previous.detail!.tabs.some((tab) => tab.name === name))
            ? await collectValuationDetail(
                detailPage,
                item,
                previous.detail,
                signal,
                onDetailProgress,
              )
            : await collectDetail(detailPage, item, signal, onDetailProgress, includeAssets);
        },
        signal,
        onDetailProgress,
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
    },
  };
}
