import type { CrawlOptions } from "./runner";
import type { CrawlStore } from "./store";
import { IncompleteCaptureError } from "./capture-readiness";
import { locateCheckpoint } from "./resume";
import {
  DEFAULT_CRAWL_CONCURRENCY,
  ListingChangedError,
  type Checkpoint,
  type CrawlLane,
  type CrawlSource,
  type CrawlStatus,
  type Listing,
  type ListingPage,
} from "./types";

const ORDER = "selling_time DESC";

function checkPage(page: ListingPage, number: number) {
  if (page.order !== ORDER) throw new Error("持续采集必须使用上架时间倒序，已暂停采集");
  if (page.page !== number)
    throw new Error(`翻页未生效：请求第 ${number} 页，返回第 ${page.page} 页`);
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
) {
  const concurrency = options.concurrency ?? DEFAULT_CRAWL_CONCURRENCY;
  const interval = options.headIntervalMs ?? 60000;
  const limits = { new: Math.ceil(concurrency / 2), old: Math.floor(concurrency / 2) };
  const running = { new: 0, old: 0 };
  const inFlight = new Map<string, Promise<void>>();
  const runningItems = new Map<string, Listing>();
  const failedKeys = new Set<string>();
  const historyPoints = new Map<string, { point: Checkpoint; index: number }>();
  let failure: { error: unknown } | undefined;
  let wake: (() => void) | undefined;
  let saved = 0,
    skipped = 0,
    failed = 0,
    historyIndex = 0,
    savedHistoryIndex = -1,
    historyPage = 1,
    totalPages = 1,
    nextHeadCheck = Date.now();
  let historyDone = store.backfillComplete();
  let lastLane: CrawlLane = "old";
  const check = () => {
    signal.throwIfAborted();
    if (failure) throw failure.error;
  };
  const queued = () => {
    const queues: Record<CrawlLane, Listing[]> = { new: [], old: [] };
    for (const item of store.retryItems())
      if (!inFlight.has(item.key) && !failedKeys.has(item.key))
        queues[store.captureLane(item.key)].push(item);
    return queues;
  };
  const report = () => {
    const queues = queued();
    publish({
      concurrency,
      newRunning: running.new,
      oldRunning: running.old,
      newQueued: queues.new.length,
      oldQueued: queues.old.length,
      newLimit: limits.new,
      oldLimit: limits.old,
      saved,
      skipped,
      failed,
      totalSaved: store.count(),
    });
    if (
      !signal.aborted &&
      !failure &&
      historyDone &&
      !running.old &&
      !queues.old.length &&
      ![...failedKeys].some((key) => store.captureLane(key) === "old") &&
      !store.backfillComplete()
    )
      store.markBackfillComplete();
  };
  const capture = async (item: Listing, lane: CrawlLane) => {
    try {
      check();
      store.beginRetry(item.key);
      publish({ current: item.name || item.eid });
      const detail = await source.detail(item);
      check();
      const history =
        lane === "old" && store.captureLane(item.key) === "old"
          ? historyPoints.get(item.key)
          : undefined;
      const currentPoint = store.checkpoint();
      const advance =
        history &&
        history.index > savedHistoryIndex &&
        (!currentPoint?.time || history.point.time! <= currentPoint.time);
      const checkpoint = advance ? { ...history.point, savedAt: detail.collectedAt } : undefined;
      if (!store.save(item, detail, checkpoint))
        throw Object.assign(new Error("采集完整性校验未通过，未推进成功断点"), {
          name: "IncompleteDetailError",
        });
      saved++;
      if (advance) {
        savedHistoryIndex = history.index;
        publish({ checkpoint });
      }
    } catch (error) {
      if (!signal.aborted && !failure) {
        if (error instanceof IncompleteCaptureError) store.save(item, error.detail);
        const message = error instanceof Error ? error.message : String(error);
        store.fail(item.key, message);
        failedKeys.add(item.key);
        failed++;
        publish({ failed, lastItemError: `商品 ${item.key}：${message}` });
        if (!(error instanceof Error && error.name === "IncompleteDetailError"))
          failure ??= { error };
      }
    }
  };
  const pump = () => {
    while (!failure && !signal.aborted && inFlight.size < concurrency) {
      const queues = queued();
      let lane: CrawlLane;
      if (queues.new.length && queues.old.length) {
        lane =
          concurrency === 1
            ? lastLane === "new"
              ? "old"
              : "new"
            : running.new < limits.new
              ? "new"
              : "old";
      } else if (queues.new.length) lane = "new";
      else if (queues.old.length) lane = "old";
      else break;
      const item = queues[lane][0]!;
      running[lane]++;
      lastLane = lane;
      // 先登记在途，避免同步完成或下一次发现把同一条商品再次派发。
      const task = Promise.resolve()
        .then(() => capture(item, lane))
        .catch((error: unknown) => {
          failure ??= { error };
        })
        .finally(() => {
          inFlight.delete(item.key);
          runningItems.delete(item.key);
          running[lane]--;
          pump();
          wake?.();
        });
      inFlight.set(item.key, task);
      runningItems.set(item.key, item);
    }
    report();
  };
  const observe = async (listed: Listing, lane: CrawlLane) => {
    try {
      check();
      const item = await source.hover(listed);
      check();
      if (item.key !== listed.key || item.sellingTime !== listed.sellingTime)
        throw new ListingChangedError();
      const active = runningItems.get(item.key);
      if (active && (active.sellingTime !== item.sellingTime || active.price !== item.price))
        throw new ListingChangedError();
      if (store.observe(item, lane)) skipped++;
      return item;
    } catch (error) {
      failure ??= { error };
      throw error;
    }
  };
  const discoverHead = async (first: ListingPage) => {
    const previous = store.headCheckpoint();
    const top = first.items[0]?.sellingTime;
    const catchUp = !previous && store.backfillComplete();
    const legacyPoint = catchUp ? store.checkpoint() : undefined;
    const legacyBoundary =
      legacyPoint?.order === ORDER &&
      legacyPoint.time &&
      Number.isFinite(Date.parse(legacyPoint.time))
        ? legacyPoint.time
        : undefined;
    const boundary = previous?.time ?? (catchUp ? legacyBoundary : top);
    const keys = new Set<string>(previous?.time === top ? previous.keys : []);
    let page = first,
      signature = "",
      previousLastTime: string | undefined;
    for (let number = 1; ; number++) {
      check();
      checkPage(page, number);
      const firstTime = page.items[0]?.sellingTime;
      if (previousLastTime && firstTime && firstTime > previousLastTime)
        throw new Error("相邻列表页未保持上架时间倒序，已暂停以免漏采");
      previousLastTime = page.items.at(-1)?.sellingTime ?? undefined;
      const currentSignature = page.items.map((item) => item.key).join("|");
      if (signature && currentSignature === signature)
        throw new Error("连续两页返回相同商品，已暂停，避免循环翻页");
      signature = currentSignature;
      publish({ headPage: number, page: number, totalPages: page.totalPages });
      for (const listed of page.items) {
        if ((previous || catchUp) && boundary && listed.sellingTime! < boundary) break;
        // 第一次以当前首页建界；同一秒延伸到下一页时继续登记，避免截断。
        if (!previous && !catchUp && number > 1 && listed.sellingTime! < boundary!) break;
        const item = await observe(listed, "new");
        if (item.sellingTime === top) keys.add(item.key);
      }
      pump();
      if (
        !page.items.length ||
        (boundary && page.items.at(-1)!.sellingTime! < boundary) ||
        number >= page.totalPages
      )
        break;
      page = await source.page(number + 1);
    }
    check();
    // 所有本次发现项已由 observe 持久登记，详情失败也不会丢失发现边界。
    if (top && (!previous || top >= previous.time))
      store.setHeadCheckpoint({ time: top, keys: [...keys] });
    publish({ headCheckedAt: new Date().toISOString() });
  };
  const waitForWork = () =>
    new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        wake = undefined;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, nextHeadCheck - Date.now()));
      wake = finish;
      signal.addEventListener("abort", finish, { once: true });
      if (signal.aborted || failure) finish();
    });

  publish({ phase: "collecting", message: "持续检查新上架角色，并从原断点补齐历史角色…" });
  try {
    const first = await source.prepare(ORDER);
    check();
    checkPage(first, 1);
    totalPages = first.totalPages;
    nextHeadCheck = Date.now() + interval;
    await discoverHead(first);
    const point = store.checkpoint();
    if (!historyDone && point)
      historyPage = (await locateCheckpoint(source, first, point, signal)) ?? 1;
    let previousSignature = "";
    while (true) {
      check();
      pump();
      publish({ nextHeadCheckAt: new Date(nextHeadCheck).toISOString() });
      if (Date.now() >= nextHeadCheck) {
        nextHeadCheck = Date.now() + interval;
        const refreshed = await source.prepare(ORDER);
        check();
        checkPage(refreshed, 1);
        totalPages = refreshed.totalPages;
        await discoverHead(refreshed);
      } else if (!historyDone && queued().old.length < Math.max(1, limits.old)) {
        const page = await source.page(historyPage);
        check();
        checkPage(page, historyPage);
        totalPages = page.totalPages;
        const signature = page.items.map((item) => item.key).join("|");
        if (signature && signature === previousSignature)
          throw new Error("连续两页返回相同商品，已暂停，避免循环翻页");
        previousSignature = signature;
        publish({ historyPage, page: historyPage, totalPages });
        for (const listed of page.items) {
          const item = await observe(listed, "old");
          if (store.captureLane(item.key) === "old")
            historyPoints.set(item.key, {
              index: historyIndex++,
              point: {
                key: item.key,
                time: item.sellingTime,
                order: ORDER,
                page: historyPage,
                savedAt: new Date().toISOString(),
              },
            });
        }
        historyDone = historyPage >= totalPages;
        historyPage++;
        pump();
      } else await waitForWork();
    }
  } catch (error) {
    if (error instanceof ListingChangedError)
      error.message = "列表在采集中发生变化，已暂停以免漏采或保存旧资料";
    failure ??= { error };
  } finally {
    // 暂停、列表失败、安全验证和租约中止都必须等在途页面操作结束。
    await Promise.all(inFlight.values());
  }
  signal.throwIfAborted();
  if (failure) throw failure.error;
}
