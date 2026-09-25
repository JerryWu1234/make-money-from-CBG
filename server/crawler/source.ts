import type { Page } from "playwright-core";
import { collectDetail, isOnShelf } from "./detail";
import { gotoPage, hoverListing, pace, prepareList } from "./page";
import type { CrawlSource } from "./types";

interface SourceOptions {
  listPage: Page;
  detailPage: Page;
  signal: AbortSignal;
  preferredOrder?: string;
  onDetailProgress: (message: string) => void;
  log: (event: string, data?: Record<string, unknown>) => void;
}

export function createCrawlSource({
  listPage,
  detailPage,
  signal,
  preferredOrder,
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
      await pace(signal, 1800, 1700);
      const result = await collectDetail(detailPage, item, signal, onDetailProgress);
      log("detail.collected", {
        key: item.key,
        durationMs: Date.now() - started,
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
