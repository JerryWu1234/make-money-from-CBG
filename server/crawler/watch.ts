import type { CrawlOptions } from "./runner";
import { isDeepStrictEqual } from "node:util";
import type { CrawlStore } from "./store";
import { compactListing } from "./compact";
import { IncompleteCaptureError } from "./capture-readiness";
import { locateCheckpoint } from "./resume";
import {
  DEFAULT_CRAWL_CONCURRENCY,
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
  const interval = options.headIntervalMs ?? 60000;
  const running = { new: 0, old: 0 };
  const inFlight = new Map<string, Promise<void>>();
  const runningItems = new Map<string, Listing>();
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
  let historyDone = ordered && store.backfillComplete();
  let historyPass = 0;
  const check = () => {
    signal.throwIfAborted();
    if (failure) throw failure.error;
  };
  const queued = () => {
    const queues: Record<CrawlLane, Listing[]> = { new: [], old: [] };
    for (const item of store.retryItems())
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
      !running.old &&
      !queues.old.length &&
      ![...failedVersions.keys()].some((key) => store.captureLane(key) === "old") &&
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
      signal.throwIfAborted();
      if (failure) {
        if (!failure.preserveCompleted) throw failure.error;
        const current = store.detail(item.key) as SavedRoleRecord | null;
        if (
          current?.status !== "pending" ||
          !isDeepStrictEqual(current.listing, JSON.parse(JSON.stringify(compactListing(item))))
        )
          throw new ListingChangedError();
      }
      const history =
        lane === "old" && store.captureLane(item.key) === "old"
          ? historyPoints.get(item.key)
          : undefined;
      const currentPoint = store.checkpoint();
      const advance =
        !failure &&
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
      if (signal.aborted && error instanceof IncompleteCaptureError)
        store.savePartial(item, error.detail);
      if (!signal.aborted && !failure) {
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
        if (error instanceof IncompleteCaptureError) store.save(item, error.detail);
        const message = error instanceof Error ? error.message : String(error);
        store.fail(item.key, message);
        failedVersions.set(item.key, item.sellingTime);
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
      while (true) {
        check();
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
        if (item.key !== listed.key || item.sellingTime !== listed.sellingTime)
          throw new ListingChangedError();
        const active = runningItems.get(item.key);
        if (active && (active.sellingTime !== item.sellingTime || active.price !== item.price))
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
        failure ??= { error, preserveCompleted: timeout };
        // 发现阶段失败也必须登记为任务；不能把未核验的列表资料发布为完整商品。
        // 已在途或完整的同版本商品由原任务负责，避免覆盖其有效资料。
        if (timeout && !inFlight.has(listed.key) && !store.observe(listed, lane)) {
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
  const discoverHead = async (first: ListingPage) => {
    if (!ordered) {
      publish({ headPage: 1 });
      for (const listed of first.items) await observe(listed, "new");
      publish({ headCheckedAt: new Date().toISOString() });
      return;
    }
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
      checkPage(page, number, order);
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
    message: "优先采集新上架角色，空闲名额继续从原断点补齐历史角色…",
  });
  try {
    const first = await retryDiscovery(async () => {
      const first = await source.prepare(order);
      check();
      checkPage(first, 1, order);
      totalPages = first.totalPages;
      await discoverHead(first);
      return first;
    });
    nextHeadCheck = Date.now() + interval;
    const point = store.checkpoint();
    if (ordered && !historyDone && point)
      historyPage = (await locateCheckpoint(source, first, point, signal)) ?? 1;
    let previousSignature = "",
      previousHeadSignature = first.items.map((item) => item.key).join("|");
    while (true) {
      check();
      pump();
      publish({ nextHeadCheckAt: new Date(nextHeadCheck).toISOString() });
      if (Date.now() >= nextHeadCheck) {
        const headPointBefore = JSON.stringify(store.headCheckpoint());
        const refreshed = await retryDiscovery(async () => {
          const refreshed = await source.prepare(order);
          check();
          checkPage(refreshed, 1, order);
          totalPages = refreshed.totalPages;
          await discoverHead(refreshed);
          return refreshed;
        });
        nextHeadCheck = Date.now() + interval;
        const headSignature = refreshed.items.map((item) => item.key).join("|");
        // 首页商品确有位移时，历史重叠页才需重建比较；相同首页不能掩盖重复页。
        if (
          headSignature !== previousHeadSignature ||
          JSON.stringify(store.headCheckpoint()) !== headPointBefore
        )
          previousSignature = "";
        previousHeadSignature = headSignature;
        if (!ordered && historyDone) {
          historyDone = false;
          historyPage = 1;
          historyPass++;
          previousSignature = "";
        }
      } else if (!historyDone && !queued().new.length && queued().old.length < concurrency) {
        const discovered = await retryDiscovery(async () => {
          const page = await source.page(historyPage);
          check();
          checkPage(page, historyPage, order);
          totalPages = page.totalPages;
          const signature = page.items.map((item) => item.key).join("|");
          if (signature && signature === previousSignature)
            throw new Error("连续两页返回相同商品，已暂停，避免循环翻页");
          publish({ historyPage, page: historyPage, totalPages });
          for (const listed of page.items) {
            const lane = !ordered && historyPass > 0 && !store.detail(listed.key) ? "new" : "old";
            // 队列满时保留当前历史页，让出发现流程供到期头扫使用。
            // 下次重读同页；只有全页登记后才推进页码和重复页签名。
            if (queued()[lane].length >= concurrency) return { signature, complete: false };
            const item = await observe(listed, lane);
            if (store.captureLane(item.key) === "old")
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
          return { signature, complete: true };
        });
        if (discovered.complete) {
          previousSignature = discovered.signature;
          historyDone = historyPage >= totalPages;
          historyPage++;
        }
        pump();
      } else await waitForWork();
    }
  } catch (error) {
    if (error instanceof ListingChangedError)
      error.message = "列表在采集中发生变化，已暂停以免漏采或保存旧资料";
    failure ??= { error };
    if (!signal.aborted && !(error instanceof SellingOrderUnavailableError))
      publish({
        message: "采集遇到错误，已停止派发；正在结束在途任务并保存仍有效的完整详情…",
        lastItemError: error instanceof Error ? error.message : String(error),
      });
  } finally {
    // 暂停、列表失败、安全验证和租约中止都必须等在途页面操作结束。
    await Promise.all(inFlight.values());
  }
  signal.throwIfAborted();
  if (failure) throw failure.error;
}
