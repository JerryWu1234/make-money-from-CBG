import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createCrawlSource } from "../crawler/source";
import type { CrawlSource, ListingPage, RoleDetail } from "../crawler/types";
import { officialPageContext } from "../official-access";
import {
  type ActionPlan,
  type PageObserver,
  type PageSnapshot,
  type UiDriver,
  UnsupportedAdapterOperation,
  validateObservedCapture,
} from "./contracts";

/** The existing browser implementation remains an adapter behind the same data contracts. */
export function createPlaywrightCrawlAdapter(
  options: Parameters<typeof createCrawlSource>[0],
  raw: CrawlSource = createCrawlSource(options),
) {
  const changes = new EventEmitter();
  const snapshots = new Map<string, PageSnapshot>();
  const waiters = new Set<() => void>();
  let latest: PageSnapshot | undefined;
  const observe = (value: ListingPage | RoleDetail, kind: "list" | "detail") => {
    const context =
      kind === "detail"
        ? (value as RoleDetail).accessContext
        : officialPageContext(options.listPage);
    if (!context) return undefined; // Standalone offline fixtures can still use CrawlSource without a service session.
    const snapshot: PageSnapshot = {
      context: {
        ...context,
        schemaVersion: 1,
        actionId: context.actionId ?? null,
        observedAt: new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        sourceKind: "playwright",
      },
      url: kind === "detail" ? (value as RoleDetail).url : options.listPage.url(),
      title: kind === "detail" ? "角色详情" : "角色列表",
      revision: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
      visible: false,
      loading: false,
      access: "normal",
      empty: false,
    };
    if (kind === "list") {
      snapshot.listing = value as ListingPage;
      snapshot.empty = snapshot.listing.items.length === 0;
    } else {
      snapshot.detail = value as RoleDetail;
      const identity = snapshot.detail.valuation?.source;
      if (typeof identity?.serverId === "string" && typeof identity?.eid === "string")
        snapshot.productIdentity = { serverId: identity.serverId, eid: identity.eid };
    }
    latest = snapshot;
    snapshots.set(context.pageId, snapshot);
    changes.emit("change");
    return snapshot;
  };
  const source: CrawlSource = {
    ...raw,
    prepare: async (order) => {
      const value = await raw.prepare(order);
      observe(value, "list");
      return value;
    },
    page: async (number, refresh) => {
      const value = await raw.page(number, refresh);
      observe(value, "list");
      return value;
    },
    ...(raw.refresh
      ? {
          refresh: async (order?: string) => {
            const value = await raw.refresh!(order);
            observe(value, "list");
            return value;
          },
        }
      : {}),
    detail: async (item) => {
      const value = await raw.detail(item),
        snapshot = observe(value, "detail");
      if (snapshot) validateObservedCapture(snapshot, item);
      return value;
    },
  };
  const snapshot = async (pageId?: string): Promise<PageSnapshot> => {
    const value = pageId ? snapshots.get(pageId) : latest;
    if (!value) throw new UnsupportedAdapterOperation("尚未形成的浏览器观察快照");
    const page = value.listing ? options.listPage : undefined;
    if (
      page &&
      (page.isClosed() ||
        officialPageContext(page)?.pageGeneration !== value.context.pageGeneration ||
        officialPageContext(page)?.queryId !== value.context.queryId)
    )
      throw new UnsupportedAdapterOperation("已变化页面的旧观察快照");
    return structuredClone(value);
  };
  const observer: PageObserver = {
    mode: "playwright",
    snapshot,
    waitFor: (predicate, wait) =>
      new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          changes.off("change", check);
          wait.signal?.removeEventListener("abort", abort);
          waiters.delete(closed);
        };
        const closed = () => {
          cleanup();
          reject(new Error("浏览器观察已关闭"));
        };
        const abort = () => {
          cleanup();
          reject(wait.signal?.reason ?? new Error("观察已取消"));
        };
        const check = () => {
          const value = wait.pageId ? snapshots.get(wait.pageId) : latest;
          if (value && value.revision !== wait.after && predicate(value)) {
            cleanup();
            resolve(structuredClone(value));
          }
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("未观察到对应官网业务结果"));
        }, wait.timeoutMs);
        waiters.add(closed);
        changes.on("change", check);
        wait.signal?.addEventListener("abort", abort, { once: true });
        if (wait.signal?.aborted) abort();
        else check();
      }),
    evidence: async (pageId) => {
      const value = await snapshot(pageId);
      return { context: value.context, revision: value.revision, snapshot: value };
    },
    close: async () => {
      for (const closed of waiters) closed();
      changes.removeAllListeners();
      snapshots.clear();
      latest = undefined;
    },
  };
  const driver: UiDriver = {
    mode: "playwright",
    execute: async (plan: ActionPlan, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const before = await snapshot(plan.pageId);
      if (
        before.context.pageGeneration !== plan.pageGeneration ||
        before.context.stopEpoch !== plan.stopEpoch ||
        before.context.browserSessionEpoch !== plan.browserSessionEpoch
      )
        throw new Error("浏览器动作计划已过期");
      const target = plan.target;
      if (target.kind === "next-page") await source.page(target.currentPage + 1);
      else if (target.kind === "jump-page") await source.page(target.page);
      else if (target.kind === "query" || target.kind === "refresh-list") {
        if (!source.refresh) throw new UnsupportedAdapterOperation("列表刷新");
        await source.refresh(before.listing?.order);
      } else if (target.kind === "listing-detail") {
        const item = before.listing?.items.find(
          (item) => item.serverId === target.serverId && item.eid === target.eid,
        );
        if (!item) throw new UnsupportedAdapterOperation("不在当前列表的角色详情");
        await source.detail(item);
      } else throw new UnsupportedAdapterOperation(`此角色适配器中的${target.kind}`);
      signal?.throwIfAborted();
      const result = await snapshot();
      if (plan.expected.kind === "page" && result.listing?.page !== plan.expected.page)
        throw new Error("浏览器翻页业务结果未确认");
      if (
        plan.expected.kind === "detail" &&
        (result.productIdentity?.eid !== plan.expected.eid ||
          result.productIdentity.serverId !== plan.expected.serverId)
      )
        throw new Error("浏览器详情身份未确认");
      return result;
    },
    stop: async (reason) => {
      await source.cancelDetails?.(new Error(reason));
    },
  };
  return { source, observer, driver };
}
