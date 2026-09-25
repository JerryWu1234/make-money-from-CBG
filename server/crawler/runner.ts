import {
  ListingChangedError,
  type Checkpoint,
  type CrawlSource,
  type CrawlStatus,
  type Listing,
} from "./types";
import type { CrawlStore } from "./store";
import { prepareCrawlPages } from "./resume";
export async function crawl(
  source: CrawlSource,
  store: CrawlStore,
  signal: AbortSignal,
  publish: (state: Partial<CrawlStatus>) => void,
) {
  signal.throwIfAborted();
  let saved = 0,
    skipped = 0,
    failed = 0;
  const retries = store.retryItems();
  const retryFailed = new Set<string>();
  if (retries.length) {
    publish({
      phase: "retrying",
      page: 0,
      totalPages: 0,
      retryTotal: retries.length,
      retryCompleted: 0,
      message: `优先补采 ${retries.length} 条未完成详情…`,
    });
    for (const [index, item] of retries.entries()) {
      signal.throwIfAborted();
      store.beginRetry(item.key);
      publish({
        current: item.name || item.eid,
        retryCompleted: index,
        detailProgress: `正在补采 ${index + 1}/${retries.length}：打开已保存商品链接…`,
      });
      try {
        const detail = await source.detail(item);
        signal.throwIfAborted();
        // 补采旧记录只补详情，不改变正常列表续采的成功断点。
        store.save(item, detail);
        saved++;
        publish({ saved, retryCompleted: index + 1, totalSaved: store.count() });
      } catch (error) {
        signal.throwIfAborted();
        const message = error instanceof Error ? error.message : String(error);
        store.fail(item.key, message);
        failed++;
        retryFailed.add(item.key);
        publish({
          failed,
          retryCompleted: index + 1,
          lastItemError: `商品 ${item.key}：${message}`,
          detailProgress: "该商品详情待重试，继续正常采集",
        });
        if (!(error instanceof Error && error.name === "IncompleteDetailError")) throw error;
      }
    }
  }
  const plan = await prepareCrawlPages(source, store, signal, publish);
  const { numbers, backfillComplete } = plan;
  let end = plan.end;
  let previousSignature = "";
  let previousPage = 0;
  for (let cursor = 0; cursor < numbers.length; cursor++) {
    const number = numbers[cursor];
    signal.throwIfAborted();
    const page = await source.page(number);
    if (!backfillComplete)
      for (let added = end + 1; added <= page.totalPages; added++) numbers.push(added);
    end = Math.max(end, page.totalPages);
    if (page.page !== number)
      throw new Error(`翻页未生效：请求第 ${number} 页，返回第 ${page.page} 页`);
    const signature = page.items.map((item) => item.key).join("|");
    if (number === previousPage + 1 && signature && signature === previousSignature)
      throw new Error("连续两页返回相同商品，已暂停，避免循环翻页");
    previousSignature = signature;
    previousPage = number;
    publish({
      phase: "collecting",
      page: number,
      totalPages: end,
      itemsOnPage: page.items.length,
      itemIndex: 0,
      detailProgress: undefined,
      message: backfillComplete ? "正在检查列表新增商品…" : "正在续采断点之后的商品…",
    });
    let items = page.items;
    const handled = new Set<string>();
    let changes = 0;
    while (true) {
      signal.throwIfAborted();
      const listed = items.find((item) => !handled.has(item.key));
      if (!listed) break;
      const itemIndex = Math.min(handled.size + 1, items.length);
      if (retryFailed.has(listed.key)) {
        handled.add(listed.key);
        publish({
          itemIndex,
          detailProgress: "该商品本轮补采未完成，保留待重试",
        });
        continue;
      }
      publish({ itemIndex, detailProgress: "正在悬停核对列表商品…" });
      let item: Listing;
      try {
        item = await source.hover(listed);
      } catch (error) {
        if (!(error instanceof ListingChangedError)) throw error;
        handled.add(listed.key);
        if (++changes > 3) throw new Error("当前页列表连续变化，已暂停以免漏采");
        const refreshed = await source.page(number);
        if (refreshed.page !== number)
          throw new Error(`翻页未生效：请求第 ${number} 页，返回第 ${refreshed.page} 页`);
        items = refreshed.items;
        publish({
          itemsOnPage: items.length,
          itemIndex: Math.min(handled.size, items.length),
          detailProgress: "列表已变化，跳过旧商品并继续匹配当前下一条",
        });
        continue;
      }
      handled.add(listed.key);
      publish({ current: item.name || item.eid });
      if (store.observe(item)) {
        skipped++;
        publish({ skipped, detailProgress: "详情已完整保存，跳过重复采集" });
        continue;
      }
      try {
        const detail = await source.detail(item);
        signal.throwIfAborted();
        const checkpoint: Checkpoint = {
          key: item.key,
          time: item.orderTime,
          order: page.order,
          page: number,
          savedAt: detail.collectedAt,
        };
        store.save(item, detail, checkpoint);
        saved++;
        publish({ saved, totalSaved: store.count(), checkpoint });
      } catch (error) {
        signal.throwIfAborted();
        store.fail(item.key, error instanceof Error ? error.message : String(error));
        if (error instanceof Error && error.name === "IncompleteDetailError") {
          failed++;
          publish({
            failed,
            lastItemError: `商品 ${item.key}：${error.message}`,
            detailProgress: "该商品详情待重试，继续下一条",
          });
          continue;
        }
        throw error;
      }
    }
  }
  store.markBackfillComplete();
  publish({
    phase: "completed",
    running: false,
    current: undefined,
    detailProgress: undefined,
    message: `本轮完成：新增或更新 ${saved} 条，跳过 ${skipped} 条已采集商品，${failed} 条详情待重试。`,
    saved,
    skipped,
    failed,
    totalSaved: store.count(),
  });
}
