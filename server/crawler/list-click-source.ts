import type { Page } from "playwright-core";
import { clickForInspection } from "../viewport";
import { captureBrowserStep } from "../browser-evidence";
import { readDetailIdentity } from "./detail-identity";
import { assertAvailable, gotoPage, readListings } from "./page";
import { onShelfFromText } from "./detail";
import { collectRole, createCrawlSource } from "./source";
import { createDetailOpenQueue } from "./detail-open-queue";
import { CaptureDeadlineError } from "./capture-readiness";
import type { CrawlSource, Listing } from "./types";

type Options = Omit<Parameters<typeof createCrawlSource>[0], "detailPage" | "createDetailPage">;

function isProduct(address: string, item: Listing) {
  try {
    const url = new URL(address);
    return (
      url.origin === "https://xyq.cbg.163.com" &&
      ["/equip", "/cgi-bin/equip_detail.py"].includes(url.pathname) &&
      url.searchParams.get("s") === item.serverId &&
      url.searchParams.get("eid") === item.eid
    );
  } catch {
    return false;
  }
}

/** A popup must be produced by this exact list click; never create a page or navigate a URL. */
export async function openListingDetail(
  list: Page,
  item: Listing,
  signal: AbortSignal,
  opened: (page: Page) => Promise<void> = async () => {},
  timeoutMs = 15_000,
) {
  signal.throwIfAborted();
  await assertAvailable(list);
  const hrefs = await list.locator("#soldList a.soldImg[href]").evaluateAll(
    (nodes, target) =>
      nodes
        .filter((node) => {
          const link = node as HTMLAnchorElement;
          const url = new URL(link.href);
          return (
            url.origin === "https://xyq.cbg.163.com" &&
            ["/equip", "/cgi-bin/equip_detail.py"].includes(url.pathname) &&
            url.searchParams.get("s") === target.serverId &&
            url.searchParams.get("eid") === target.eid &&
            node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          );
        })
        .map((node) => node.getAttribute("href")!),
    { serverId: item.serverId, eid: item.eid },
  );
  if (hrefs.length !== 1)
    throw new Error("当前列表没有唯一对应的角色头像，已停止；请重新定位商品后继续");
  const children: Page[] = [];
  let resolvePopup: () => void = () => {};
  const popupReady = new Promise<void>((resolve) => {
    resolvePopup = resolve;
  });
  const popup = (page: Page) => {
    children.push(page);
    resolvePopup();
  };
  list.on("popup", popup);
  try {
    await clickForInspection(
      list.locator(`#soldList a.soldImg[href=${JSON.stringify(hrefs[0])}]`),
      signal,
      undefined,
      async () => {
        if (children.length) return false;
        return Promise.race([
          popupReady.then(() => false),
          list
            .waitForURL((url) => isProduct(url.href, item), { waitUntil: "commit", timeout: 1000 })
            .then(
              () => true,
              () => false,
            ),
        ]);
      },
    );
    const deadline = Date.now() + timeoutMs;
    let page: Page | undefined;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (children.length > 1) throw new Error("一次头像点击产生多个详情窗口，已停止以免采错商品");
      page = children[0] || (isProduct(list.url(), item) ? list : undefined);
      if (page && page.url() !== "about:blank") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!page || page.url() === "about:blank")
      throw new Error("头像点击后未确认详情页面，已停止；不会重复点击或直接打开地址");
    await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
    signal.throwIfAborted();
    await opened(page);
    await assertAvailable(page);
    if (!isProduct(page.url(), item))
      throw new Error("头像点击后的详情地址与目标商品不一致，已停止");
    const identity = await readDetailIdentity(page);
    if (identity.issues.length || identity.serverId !== item.serverId || identity.eid !== item.eid)
      throw new Error("头像点击后的详情商品身份未确认，已停止");
    return page;
  } catch (error) {
    await Promise.allSettled(children.map((page) => page.close()));
    throw error;
  } finally {
    list.off("popup", popup);
  }
}

async function querySignature(page: Page) {
  return page.evaluate(() => {
    const args = (window as Window & { QueryArgs?: Record<string, unknown> }).QueryArgs;
    if (!args) throw new Error("当前列表缺少查询条件证据");
    const sorted = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(sorted)
        : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, item]) => [key, sorted(item)]),
            )
          : value;
    return JSON.stringify(sorted(args));
  });
}

/** One list and one active detail: list refresh/page/hover cannot race a detail click or return. */
export function createListClickSource(options: Options, readRole = collectRole): CrawlSource {
  const { listPage: list, signal, onFatal, onOpenedDetail, log } = options;
  const base = createCrawlSource({ ...options, openFromList: false, detailPage: list });
  const waitForOpen = createDetailOpenQueue();
  let tail = Promise.resolve();
  let stopped: unknown;
  let active: AbortController | undefined;
  let child: Page | undefined;
  const serial = <T>(run: () => Promise<T>) => {
    const task = tail.then(async () => {
      signal.throwIfAborted();
      if (stopped) throw stopped;
      return run();
    });
    tail = task.then(
      () => {},
      () => {},
    );
    return task;
  };
  const fail = (error: unknown) => {
    stopped = error;
    onFatal?.(error);
    return error;
  };
  const inspect = async <T>(
    item: Listing,
    read: (page: Page, local: AbortSignal) => Promise<T>,
  ) => {
    const control = new AbortController();
    active = control;
    const local = AbortSignal.any([signal, control.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let target: Page | undefined;
    let originalPage = 0;
    let originalQuery = "";
    let result: T | undefined;
    let failure: { error: unknown } | undefined;
    const cancel = () => {
      if (child) void child.close().catch(() => {});
    };
    local.addEventListener("abort", cancel, { once: true });
    try {
      const original = await readListings(list);
      originalPage = original.page;
      originalQuery = await querySignature(list);
      // Retry tasks must also locate a real list entry. Saved URLs are never an opening fallback.
      if (!original.items.some((value) => value.key === item.key)) {
        let found = false;
        for (let number = 1; number <= original.totalPages; number++) {
          local.throwIfAborted();
          if (number === original.page) continue;
          const current = await base.page(number);
          if (current.items.some((value) => value.key === item.key)) {
            found = true;
            break;
          }
        }
        if (!found)
          throw fail(
            new Error(
              `列表中未找到商品 ${item.key}，保留待采任务；请核对筛选或重新定位，不判定为下架`,
            ),
          );
      }
      await waitForOpen(local);
      timer = setTimeout(
        () =>
          control.abort(
            new CaptureDeadlineError(options.detailTimeoutMs ?? 180_000, "列表点击及详情读取"),
          ),
        options.detailTimeoutMs ?? 180_000,
      );
      try {
        target = await openListingDetail(list, item, local, async (page) => {
          if (page !== list) child = page;
          await onOpenedDetail?.(page);
        });
        log("detail.opened_from_list", { key: item.key, newTab: target !== list });
      } catch (error) {
        throw fail(error);
      }
      result = await read(target, local);
    } catch (error) {
      failure = { error };
    } finally {
      clearTimeout(timer);
      local.removeEventListener("abort", cancel);
      if (child) {
        await child.close().catch(() => {});
        child = undefined;
      }
    }
    if (!local.aborted && originalPage) {
      try {
        if (target === list) await list.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
        const current = await readListings(list);
        if (current.page !== originalPage) await gotoPage(list, originalPage, local);
        if ((await querySignature(list)) !== originalQuery)
          throw new Error("返回后的查询条件、排序或页码与原列表不一致");
      } catch (error) {
        fail(error);
        // Preserve a partial capture as the primary failure so the runner can save it.
        failure ??= { error };
      }
    }
    active = undefined;
    if (failure) throw failure.error;
    local.throwIfAborted();
    return result as T;
  };
  return {
    maxConcurrency: 1,
    prepare: (order) => serial(() => base.prepare(order)),
    refresh: (order) => serial(() => base.refresh!(order)),
    page: (number, refresh) => serial(() => base.page(number, refresh)),
    hover: (item) => serial(() => base.hover(item)),
    onShelf: (item) =>
      serial(() =>
        inspect(item, async (page, local) => {
          local.throwIfAborted();
          return onShelfFromText(await page.evaluate(() => document.body.innerText));
        }),
      ),
    detail: (item) =>
      serial(() =>
        inspect(item, async (page, local) => {
          const detail = await readRole(page, item, {
            ...options,
            signal: local,
            alreadyOpened: true,
          });
          await captureBrowserStep(
            page,
            { flow: "collection", stage: "列表点击详情采集完成", key: item.key },
            local,
          );
          return detail;
        }),
      ),
    cancelDetails: async (reason) => {
      stopped = reason;
      active?.abort(reason);
      await tail;
    },
  };
}
