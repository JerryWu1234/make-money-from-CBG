import type { CrawlOptions } from "./runner";
import { isDeepStrictEqual } from "node:util";
import type { CrawlStore } from "./store";
import { compactListing } from "./compact";
import { IncompleteCaptureError } from "./capture-readiness";
import { browserConnectionFailure } from "../browser-connection";
import { pageSignature, refreshRepeatedPage } from "./repeated-pages";
import { DEFAULT_HEAD_REFRESH, headRefreshDelayMs } from "./head-refresh";
import {
  DEFAULT_CRAWL_CONCURRENCY,
  crawlAccessFailure,
  ListingChangedError,
  ListingDisappearedError,
  ListingUnavailableError,
  SellingOrderUnavailableError,
  type Checkpoint,
  type CrawlLane,
  type CrawlSource,
  type CrawlStatus,
  type Listing,
  type ListingPage,
  type SavedRoleRecord,
} from "./types";

const ORDER = "selling_time DESC";

function checkPage(page: ListingPage, number: number, order = ORDER) {
  if (page.order !== order)
    throw new Error(
      order === ORDER ? "持续采集必须使用上架时间倒序，已暂停采集" : "列表排序发生变化，已暂停采集",
    );
  if (page.page !== number)
    throw new Error(`翻页未生效：请求第 ${number} 页，返回第 ${page.page} 页`);
  if (order !== ORDER) return;
  let previous: string | undefined;
  for (const item of page.items) {
    const time = item.sellingTime;
    if (!time || !Number.isFinite(Date.parse(time)) || item.orderTime !== time)
      throw new Error("列表缺少可靠的上架时间，已暂停以免漏采");
    if (previous && time > previous) throw new Error("列表未按上架时间倒序，已暂停以免漏采");
    previous = time;
  }
}

/** 列表发现保持串行；详情在同一个有上限的池中按新、老两个队列派发。 */
export async function watchCrawl(
  source: CrawlSource,
  store: CrawlStore,
  signal: AbortSignal,
  publish: (state: Partial<CrawlStatus>) => void,
  options: CrawlOptions,
  order = ORDER,
  seed: { saved: number; skipped?: number; failed: number; failedItems: Listing[] } = {
    saved: 0,
    failed: 0,
    failedItems: [],
  },
) {
  const ordered = order === ORDER;
  const concurrency = options.concurrency ?? DEFAULT_CRAWL_CONCURRENCY;
  const headRefresh = { ...(options.headRefresh ?? DEFAULT_HEAD_REFRESH) };
  const running = { new: 0, old: 0 };
  const inFlight = new Map<string, Promise<void>>();
  const failedVersions = new Map<string, Listing["sellingTime"]>(
    seed.failedItems.map((item) => [item.key, item.sellingTime]),
  );
  const historyPoints = new Map<string, { point: Checkpoint; index: number }>();
  let failure: { error: unknown; preserveCompleted?: boolean } | undefined;
  let wake: (() => void) | undefined;
  let saved = seed.saved,
    skipped = seed.skipped || 0,
    failed = seed.failed,
    historyIndex = 0,
    savedHistoryIndex = -1,
    historyPage = 1,
    totalPages = 1,
    nextHeadCheck = Date.now();
  const hadBackfill = store.backfillComplete();
  let scanHead: { time: string; keys: string[] } | undefined;
  let historyDone = false;
  let historyPass = 0;
  let currentPage: ListingPage | undefined;
  let itemIndex = 0;
  let previousSignature = "";
  let previousLastTime: string | undefined;
  const check = () => {
    signal.throwIfAborted();
    if (failure) throw failure.error;
  };
  const queued = () => {
    const queues: Record<CrawlLane, Listing[]> = { new: [], old: [] };
    for (const item of store.pendingItems())
      if (
        !inFlight.has(item.key) &&
        (!failedVersions.has(item.key) || failedVersions.get(item.key) !== item.sellingTime)
      )
        queues[store.captureLane(item.key)].push(item);
    return queues;
  };
  const report = () => {
    const queues = queued();
    publish({
      concurrency,
      captureStrategy: "new-first",
      newRunning: running.new,
      oldRunning: running.old,
      newQueued: queues.new.length,
      oldQueued: queues.old.length,
      saved,
      skipped,
      failed,
      totalSaved: store.count(),
    });
    if (
      !signal.aborted &&
      !failure &&
      historyDone &&
      !store.pageReviews().length &&
      !running.old &&
      !queues.old.length &&
      ![...failedVersions.keys()].some((key) => store.captureLane(key) === "old") &&
      !store.backfillComplete()
    )
      store.markBackfillComplete();
  };
  const samePendingVersion = (item: Listing) => {
    const current = store.detail(item.key) as SavedRoleRecord | null;
    return (
      current?.status === "pending" &&
      isDeepStrictEqual(current.listing, JSON.parse(JSON.stringify(compactListing(item))))
    );
  };
  const capture = async (item: Listing, lane: CrawlLane) => {
    try {
      check();
      store.beginRetry(item.key);
      publish({ current: item.name || item.eid });
      const detail = await source.detail(item);
      signal.throwIfAborted();
      if (failure) {
        if (!failure.preserveCompleted) throw failure.error;
        if (!samePendingVersion(item)) throw new ListingChangedError();
      }
      const history =
        lane === "old" && store.captureLane(item.key) === "old"
          ? historyPoints.get(item.key)
          : undefined;
      const currentPoint = store.checkpoint();
      const advance =
        !failure &&
        !store.pageReviews().length &&
        history &&
        history.index > savedHistoryIndex &&
        (!ordered || !currentPoint?.time || history.point.time! <= currentPoint.time);
      const checkpoint = advance ? { ...history.point, savedAt: detail.collectedAt } : undefined;
      if (!store.save(item, detail, checkpoint))
        throw Object.assign(new Error("采集完整性校验未通过，未推进成功断点"), {
          name: "IncompleteDetailError",
        });
      saved++;
      failedVersions.delete(item.key);
      if (advance) {
        savedHistoryIndex = history.index;
        publish({ checkpoint });
      }
      publish({ saved, totalSaved: store.count() });
    } catch (error) {
      if (
        !signal.aborted &&
        failure &&
        !crawlAccessFailure(failure.error) &&
        !browserConnectionFailure(failure.error) &&
        !(failure.error instanceof ListingChangedError) &&
        samePendingVersion(item)
      ) {
        if (error instanceof IncompleteCaptureError) store.savePartial(item, error.detail);
        const message = error instanceof Error ? error.message : String(error);
        store.fail(item.key, message);
        failedVersions.set(item.key, item.sellingTime);
        failed++;
      }
      if (signal.aborted && error instanceof IncompleteCaptureError)
        store.savePartial(item, error.detail);
      else if (
        (crawlAccessFailure(failure?.error) || browserConnectionFailure(failure?.error)) &&
        error instanceof IncompleteCaptureError &&
        samePendingVersion(item)
      )
        store.savePartial(item, error.detail);
      if (!signal.aborted && !failure) {
        const connection = browserConnectionFailure(error);
        if (connection) {
          if (error instanceof IncompleteCaptureError) store.savePartial(item, error.detail);
          failure = { error: connection, preserveCompleted: true };
          publish({ message: connection.message });
          return;
        }
        if (error instanceof ListingUnavailableError) {
          store.markUnavailable(item.key, error.message);
          failedVersions.delete(item.key);
          skipped++;
          publish({
            skipped,
            current: item.name || item.eid,
            detailProgress: error.message,
            totalSaved: store.count(),
          });
          return;
        }
        const access = crawlAccessFailure(error);
        if (error instanceof IncompleteCaptureError) store.savePartial(item, error.detail);
        const message = error instanceof Error ? error.message : String(error);
        store.fail(item.key, message);
        failedVersions.set(item.key, item.sellingTime);
        failed++;
        publish({ failed, lastItemError: `商品 ${item.key}：${message}` });
        if (access || !(error instanceof Error && error.name === "IncompleteDetailError"))
          failure ??= { error, preserveCompleted: !!access };
      }
    }
  };
  const pump = () => {
    while (!failure && !signal.aborted && inFlight.size < concurrency) {
      const queues = queued();
      let lane: CrawlLane;
      if (queues.new.length) lane = "new";
      else if (queues.old.length) lane = "old";
      else break;
      const item = queues[lane][0]!;
      running[lane]++;
      // 先登记在途，避免同步完成或下一次发现把同一条商品再次派发。
      const task = Promise.resolve()
        .then(() => capture(item, lane))
        .catch((error: unknown) => {
          failure ??= { error };
        })
        .finally(() => {
          inFlight.delete(item.key);
          running[lane]--;
          pump();
          wake?.();
        });
      inFlight.set(item.key, task);
    }
    report();
  };
  const skipKnown = (item: Listing) => {
    // key 来自列表 URL 的 serverId:eid；已有任务保持原状态，不重复悬停或登记。
    if (!inFlight.has(item.key) && !store.hasListing(item.key)) return false;
    skipped++;
    publish({ skipped });
    return true;
  };
  const observe = async (listed: Listing, lane: CrawlLane) => {
    try {
      while (true) {
        check();
        if (skipKnown(listed)) return;
        // 两侧分别有界，老号排队不能阻止刚发现的新号登记。
        while (queued()[lane].length >= concurrency) {
          pump();
          if (queued()[lane].length < concurrency) break;
          publish({ detailProgress: "详情待采队列已满，先处理已发现商品，再继续扫描…" });
          await waitForWork(true);
          check();
        }
        const item = await source.hover(listed);
        check();
        // 悬停期间若已有同一 URL 的任务登记，仍由原任务负责。
        if (item.key === listed.key && skipKnown(listed)) return;
        if (item.key !== listed.key || item.sellingTime !== listed.sellingTime)
          throw new ListingChangedError();
        if (store.observe(item, lane)) {
          skipped++;
          const unavailable = store.unavailableReason(item.key);
          if (unavailable)
            publish({ skipped, current: item.name || item.eid, detailProgress: unavailable });
        }
        // 真正重新上架后，不沿用本轮旧版本的失败排除。
        if (failedVersions.get(item.key) !== item.sellingTime) failedVersions.delete(item.key);
        return item;
      }
    } catch (error) {
      if (!(error instanceof ListingDisappearedError)) {
        const timeout = error instanceof Error && error.name === "TimeoutError";
        failure ??= { error, preserveCompleted: timeout || !!crawlAccessFailure(error) };
        // 发现阶段失败也必须登记为任务；不能把未核验的列表资料发布为完整商品。
        // 已在途或完整的同版本商品由原任务负责，避免覆盖其有效资料。
        if (
          timeout &&
          !inFlight.has(listed.key) &&
          !store.hasListing(listed.key) &&
          !store.observe(listed, lane)
        ) {
          store.fail(listed.key, error.message);
          failedVersions.set(listed.key, listed.sellingTime);
          failed++;
          report();
        }
      }
      throw error;
    }
  };
  const retryDiscovery = async <T>(discover: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await discover();
      } catch (error) {
        check();
        if (!(error instanceof ListingDisappearedError) || attempt > 0) throw error;
        publish({ detailProgress: "列表商品已消失，重新读取当前页核对一次…" });
      }
    }
  };
  const beginScan = (first: ListingPage) => {
    checkPage(first, 1, order);
    // 刷新已经回到第一页，直接复用返回的列表，不再跳回旧页或重取第一页。
    historyPage = 1;
    totalPages = first.totalPages;
    historyDone = false;
    historyPass++;
    currentPage = first;
    const top = first.items[0]?.sellingTime;
    scanHead =
      ordered && top
        ? {
            time: top,
            keys: first.items.filter((item) => item.sellingTime === top).map((item) => item.key),
          }
        : undefined;
    itemIndex = 0;
    previousSignature = "";
    previousLastTime = undefined;
    publish({ page: 1, historyPage: 1, headPage: 1, totalPages });
  };
  const scheduleHeadCheck = () => {
    // 每一轮只抽取一次，详情完成、状态轮询等事件不会重置已经排定的时间。
    const delay = options.headIntervalMs ?? headRefreshDelayMs(headRefresh);
    nextHeadCheck = Date.now() + delay;
    publish({
      headRefresh,
      headRefreshDelayMs: delay,
      nextHeadCheckAt: new Date(nextHeadCheck).toISOString(),
    });
  };
  const waitForWork = (detailsOnly = false) =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        wake = undefined;
        resolve();
      };
      const timer = detailsOnly
        ? undefined
        : setTimeout(finish, Math.max(0, nextHeadCheck - Date.now()));
      wake = finish;
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted || failure) finish();
    });

  publish({
    phase: "collecting",
    current: undefined,
    detailProgress: undefined,
    message: "从第一页按商品 URL 查重，已登记的跳过，未加入的核验后登记待采；刷新后重新顺扫…",
  });
  try {
    beginScan(await source.prepare(order));
    scheduleHeadCheck();
    while (true) {
      check();
      // 先登记刷新后的第一页，避免旧队列抢在本页新号前派发。
      if (!(historyPage === 1 && itemIndex === 0 && currentPage)) pump();
      publish({ nextHeadCheckAt: new Date(nextHeadCheck).toISOString() });
      if (Date.now() >= nextHeadCheck) {
        // 生产 Source 刷新页面后直接读取自然返回的第一页；兼容旧的 Source 实现。
        const first = source.refresh ? await source.refresh(order) : await source.prepare(order);
        check();
        beginScan(first);
        scheduleHeadCheck();
      } else if (historyDone) {
        await waitForWork();
      } else if (historyPage > 1 && queued().new.length) {
        await waitForWork();
      } else {
        const discovered = await retryDiscovery(async () => {
          if (!currentPage) {
            let page = await source.page(historyPage);
            check();
            checkPage(page, historyPage, order);
            totalPages = page.totalPages;
            const result = await refreshRepeatedPage(
              source,
              store,
              page,
              previousSignature,
              signal,
              publish,
            );
            check();
            page = result.page;
            checkPage(page, historyPage, order);
            totalPages = page.totalPages;
            if (result.deferred)
              return { signature: pageSignature(page), complete: true, lastTime: undefined };
            const firstTime = page.items[0]?.sellingTime;
            if (ordered && previousLastTime && firstTime && firstTime > previousLastTime)
              throw new Error("相邻列表页未保持上架时间倒序，已暂停以免漏采");
            currentPage = page;
            itemIndex = 0;
          }
          const page = currentPage;
          publish({ historyPage, page: historyPage, totalPages });
          try {
            for (; itemIndex < page.items.length; itemIndex++) {
              const listed = page.items[itemIndex]!;
              // 在队列限流和悬停核对之前查重，已见商品不占用发现名额。
              if (skipKnown(listed)) continue;
              const lane = historyPage === 1 || historyPass > 1 || hadBackfill ? "new" : "old";
              // 复用现有有界队列；满时保留本页位置，等空位或下一次刷新，不重复点击分页。
              if (queued()[lane].length >= concurrency) {
                pump();
                if (queued()[lane].length >= concurrency)
                  return {
                    signature: pageSignature(page),
                    complete: false,
                    lastTime: page.items.at(-1)?.sellingTime,
                  };
              }
              const item = await observe(listed, lane);
              if (!item) continue;
              if (store.captureLane(item.key) === "old" && !inFlight.has(item.key))
                historyPoints.set(item.key, {
                  index: historyIndex++,
                  point: {
                    key: item.key,
                    time: ordered ? item.sellingTime : item.orderTime,
                    order,
                    page: historyPage,
                    savedAt: new Date().toISOString(),
                  },
                });
            }
          } catch (error) {
            if (error instanceof ListingDisappearedError) currentPage = undefined;
            throw error;
          }
          const signature = pageSignature(page);
          if (scanHead)
            scanHead.keys = [
              ...new Set([
                ...scanHead.keys,
                ...page.items
                  .filter((item) => item.sellingTime === scanHead!.time)
                  .map((item) => item.key),
              ]),
            ];
          // 只在顺扫实际经过该页且与本轮前页不同后清除复核；不再为复核跳回旧页。
          if (historyPage > 1 && previousSignature && signature !== previousSignature) {
            store.resolvePageReview(order, historyPage);
            publish({ pageReviews: store.pageReviews() });
          }
          if (historyPage === 1) publish({ headCheckedAt: new Date().toISOString() });
          return { signature, complete: true, lastTime: page.items.at(-1)?.sellingTime };
        });
        if (discovered.complete) {
          previousSignature = discovered.signature;
          previousLastTime = discovered.lastTime ?? undefined;
          historyDone = historyPage >= totalPages;
          const previousHead = store.headCheckpoint();
          if (
            historyDone &&
            scanHead &&
            !store.pageReviews(order).length &&
            (!previousHead || scanHead.time >= previousHead.time)
          )
            store.setHeadCheckpoint(scanHead);
          historyPage++;
          currentPage = undefined;
          itemIndex = 0;
          pump();
        } else await waitForWork();
      }
    }
  } catch (error) {
    if (error instanceof ListingChangedError)
      error.message = "列表在采集中发生变化，已暂停以免漏采或保存旧资料";
    failure ??= {
      error,
      preserveCompleted:
        !!crawlAccessFailure(error) ||
        !!browserConnectionFailure(error) ||
        (error instanceof Error && error.name === "TimeoutError"),
    };
    if (!signal.aborted && !(error instanceof SellingOrderUnavailableError))
      publish({
        message: "采集遇到错误，已停止派发；正在结束在途任务并保存仍有效的完整详情…",
        lastItemError: error instanceof Error ? error.message : String(error),
      });
  } finally {
    // Give valid in-flight captures a short grace period, then cancel their owned pages.
    // Still await their actual cleanup; never release the lease while old work can save.
    let cleanup: Promise<void> | undefined;
    const timer =
      source.cancelDetails && inFlight.size
        ? setTimeout(() => {
            cleanup = source.cancelDetails!(
              Object.assign(new Error("采集已停止，详情超过15秒收尾时限，已保留资料待补采"), {
                code: "DETAIL_DRAIN_TIMEOUT",
              }),
            );
            void cleanup.catch(() => {});
          }, 15_000)
        : undefined;
    try {
      await Promise.all(inFlight.values());
    } finally {
      clearTimeout(timer);
      await cleanup;
    }
  }
  signal.throwIfAborted();
  if (failure) throw failure.error;
}
