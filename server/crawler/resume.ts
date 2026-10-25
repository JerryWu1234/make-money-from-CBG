import type { CrawlStore } from "./store";
import {
  ListingUnavailableError,
  type Checkpoint,
  type CrawlSource,
  type CrawlStatus,
  type Listing,
  type ListingPage,
} from "./types";

function timeRange(page: ListingPage): [string, string] | null {
  const times = page.items.map((item) => item.orderTime);
  if (!times.length || times.some((time) => !time)) return null;
  for (let i = 1; i < times.length; i++) if (times[i]! > times[i - 1]!) return null;
  return [times[0]!, times[times.length - 1]!];
}

export async function locateCheckpoint(
  source: CrawlSource,
  first: ListingPage,
  point: Checkpoint,
  signal: AbortSignal,
): Promise<number | null> {
  if (
    !point.time ||
    point.order !== first.order ||
    !timeRange(first) ||
    !["selling_time DESC", "expire_time DESC"].includes(first.order)
  )
    return null;
  let low = 1,
    high = first.totalPages;
  let result: number | null = null;
  const sampled = new Map<number, ListingPage>([[1, first]]);
  while (low <= high) {
    signal.throwIfAborted();
    const mid = Math.floor((low + high) / 2);
    const page = sampled.get(mid) || (await source.page(mid));
    sampled.set(mid, page);
    const range = timeRange(page);
    if (!range || page.order !== point.order || page.page !== mid) return null;
    // 采样页之间必须保持时间倒序，推荐混排或排序失效时放弃二分。
    const entries = [...sampled].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < entries.length; i++) {
      const left = timeRange(entries[i - 1][1]),
        right = timeRange(entries[i][1]);
      if (!left || !right || left[1] < right[0]) return null;
    }
    if (range[1] <= point.time) {
      result = mid;
      high = mid - 1;
    } else low = mid + 1;
  }
  // 从相等时间的第一批开始；同秒发布、多页同时间和断点商品下架都不能跳过。
  return result === null ? null : Math.max(1, result - 1);
}

export async function prepareCrawlPages(
  source: CrawlSource,
  store: CrawlStore,
  signal: AbortSignal,
  publish: (state: Partial<CrawlStatus>) => void,
) {
  const savedPoint = store.checkpoint();
  let anchor: Listing | undefined;
  if (savedPoint) {
    const candidates = store.anchorItems().slice(0, 12);
    for (const [index, item] of candidates.entries()) {
      signal.throwIfAborted();
      publish({
        phase: "locating",
        current: item.name || item.eid,
        message: `正在核对上次入库锚点 ${index + 1}/${candidates.length} 是否仍上架…`,
      });
      try {
        if (await source.onShelf(item)) {
          anchor = item;
          break;
        }
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof ListingUnavailableError)) throw error;
        store.markUnavailable(item.key, error.message);
        publish({ current: item.name || item.eid, detailProgress: error.message });
      }
    }
  }

  const first = await source.prepare();
  const point =
    anchor && savedPoint
      ? { ...savedPoint, key: anchor.key, time: anchor.orderTime || savedPoint.time }
      : undefined;
  publish({
    phase: "locating",
    page: 1,
    totalPages: first.totalPages,
    message: "正在核对排序和上次成功入库的断点…",
  });
  const resume = point ? await locateCheckpoint(source, first, point, signal) : null;
  const fullScan = !point || resume === null;
  const backfillComplete = store.backfillComplete() && !fullScan;
  const end = first.totalPages;
  const anchorPage = point ? Math.min(end, resume ? resume + 1 : Math.max(1, point.page)) : 1;
  const numbers = fullScan
    ? Array.from({ length: end }, (_, i) => i + 1)
    : backfillComplete
      ? Array.from({ length: anchorPage }, (_, i) => i + 1)
      : Array.from(
          { length: end - Math.max(1, anchorPage - 1) + 1 },
          (_, i) => Math.max(1, anchorPage - 1) + i,
        );
  publish({
    strategy: fullScan
      ? savedPoint
        ? "续采锚点或排序不可靠：从第 1 页逐页核对完整列表"
        : "首次全量采集：逐页补齐历史商品"
      : backfillComplete
        ? `已找到仍上架锚点；只检查第 1 至 ${anchorPage} 页的新增商品`
        : `已找到仍上架锚点；从第 ${Math.max(1, anchorPage - 1)} 页继续补齐后段历史商品`,
    message: "逐条悬停核对商品编号，已完整入库的商品跳过详情。",
  });
  return { numbers, backfillComplete, end, fullScan };
}
