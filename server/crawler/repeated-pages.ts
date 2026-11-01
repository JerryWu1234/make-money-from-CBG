import { createHash } from "node:crypto";
import { diagnostics } from "../diagnostics";
import type { CrawlStore } from "./store";
import type { CrawlSource, CrawlStatus, ListingPage, PageReview } from "./types";

export const pageSignature = (page: ListingPage) => page.items.map((item) => item.key).join("|");

interface CheckedPage {
  page: ListingPage;
  deferred: boolean;
}

function validatePage(page: ListingPage, number: number, order: string) {
  if (page.page !== number)
    throw new Error(`翻页未生效：请求第 ${number} 页，返回第 ${page.page} 页`);
  if (page.order !== order) throw new Error("列表排序发生变化，已暂停采集");
}

function reportDuplicate(
  store: CrawlStore,
  page: ListingPage,
  publish: (state: Partial<CrawlStatus>) => void,
  reviewing: boolean,
) {
  const signature = pageSignature(page);
  store.deferPageReview(page.order, page.page, signature);
  const message = reviewing
    ? `第 ${page.page} 页复核后仍与前页重复，保留待复核，继续其他页面`
    : `第 ${page.page} 页刷新后仍与前页重复，已记录待复核，继续下一页`;
  publish({ pageReviews: store.pageReviews(), detailProgress: message });
  diagnostics.record("list.page_deferred", {
    requestedPage: page.page,
    previousPage: page.page - 1,
    order: page.order,
    itemCount: page.items.length,
    signature: createHash("sha256").update(signature).digest("hex").slice(0, 16),
    reviewing,
  });
}

/** A repeated page gets one real reload; a second duplicate is durable work, not a run failure. */
export async function refreshRepeatedPage(
  source: CrawlSource,
  store: CrawlStore,
  page: ListingPage,
  previousSignature: string,
  signal: AbortSignal,
  publish: (state: Partial<CrawlStatus>) => void,
): Promise<CheckedPage> {
  const signature = pageSignature(page);
  if (!signature || signature !== previousSignature) return { page, deferred: false };
  publish({ detailProgress: `第 ${page.page} 页与前页重复，正在强制刷新核对一次…` });
  signal.throwIfAborted();
  const refreshed = await source.page(page.page, true);
  signal.throwIfAborted();
  validatePage(refreshed, page.page, page.order);
  if (!pageSignature(refreshed) || pageSignature(refreshed) !== previousSignature)
    return { page: refreshed, deferred: false };
  reportDuplicate(store, refreshed, publish, false);
  return { page: refreshed, deferred: true };
}

/** One bounded end-of-pass check against the current adjacent page, without stale signatures. */
export async function readPageReview(
  source: CrawlSource,
  store: CrawlStore,
  review: PageReview,
  signal: AbortSignal,
  publish: (state: Partial<CrawlStatus>) => void,
): Promise<CheckedPage> {
  signal.throwIfAborted();
  const previous = await source.page(Math.max(1, review.page - 1), true);
  signal.throwIfAborted();
  // A shrinking list does not prove that the skipped page was ever inspected.
  if (previous.order !== review.order) throw new Error("列表排序发生变化，已暂停采集");
  if (review.page > previous.totalPages) return { page: previous, deferred: true };
  validatePage(previous, Math.max(1, review.page - 1), review.order);
  const page = await source.page(review.page, true);
  signal.throwIfAborted();
  validatePage(page, review.page, review.order);
  if (pageSignature(page) && pageSignature(page) === pageSignature(previous)) {
    reportDuplicate(store, page, publish, true);
    return { page, deferred: true };
  }
  publish({ detailProgress: `正在补查第 ${review.page} 页的商品…` });
  return { page, deferred: false };
}
