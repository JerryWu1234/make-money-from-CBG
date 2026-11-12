import type { Page, Response } from "playwright-core";
import { assertAvailable } from "../crawler/page";
import { clickForInspection, ensureWorkViewport } from "../viewport";
import { captureBrowserStep, registerBrowserEvidence } from "../browser-evidence";
import { equipmentIdentity, safeEquipmentUrl } from "./equipment-pricing";

/** Own only popups opened by this query page, including late or extra popups. */
export function createMarketDetailReader(
  searchPage: Page,
  signal: AbortSignal,
  timeoutMs = 15_000,
) {
  const pages = new Set<Page>();
  let closed = false;
  let opening: ((page: Page) => void) | undefined;
  let cancel: ((reason: unknown) => void) | undefined;
  const onPopup = (page: Page) => {
    pages.add(page);
    registerBrowserEvidence(page);
    if (!closed && opening) {
      const receive = opening;
      opening = undefined;
      receive(page);
    } else
      void page
        .close()
        .catch(() => {})
        .finally(() => pages.delete(page));
  };
  searchPage.on("popup", onPopup);
  searchPage.once("close", () => searchPage.off("popup", onPopup));
  const close = async () => {
    closed = true;
    cancel?.(new Error("商品查询页面已关闭"));
    await Promise.allSettled([...pages].map((page) => page.close()));
  };
  return {
    close,
    async read<T>(url: string, requestSignal: AbortSignal, read: (page: Page) => Promise<T>) {
      const local = AbortSignal.any([signal, requestSignal]);
      local.throwIfAborted();
      if (closed) throw new Error("商品查询页面已关闭");
      if (cancel) throw new Error("同一列表不能同时打开多个候选商品");
      const identity = equipmentIdentity(safeEquipmentUrl(url));
      await assertAvailable(searchPage);
      local.throwIfAborted();
      if (closed) throw new Error("商品查询页面已关闭");
      const links = searchPage.locator("#search_result a.soldImg[href], #soldList a.soldImg[href]");
      const hrefs = await links.evaluateAll((nodes) =>
        nodes.map((node) => (node.checkVisibility() ? (node as HTMLAnchorElement).href : "")),
      );
      const matches = hrefs.flatMap((href, index) => {
        try {
          return equipmentIdentity(safeEquipmentUrl(href)) === identity ? [index] : [];
        } catch {
          return [];
        }
      });
      local.throwIfAborted();
      if (closed) throw new Error("商品查询页面已关闭");
      if (matches.length !== 1) throw new Error("当前列表未找到唯一的候选商品，未打开详情");
      let page: Page | undefined;
      const responses = new Map<Page, Response>();
      const context = searchPage.context();
      const response = (value: Response) => {
        try {
          if (value.request().isNavigationRequest() && !value.frame().parentFrame())
            responses.set(value.frame().page(), value);
        } catch {
          /* A closed frame has no usable response. */
        }
      };
      context.on("response", response);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: () => void = () => {};
      const cancelled = new Promise<never>((_resolve, reject) => {
        cancel = reject;
        abort = () => reject(local.reason);
        local.addEventListener("abort", abort, { once: true });
        if (local.aborted) abort();
      });
      const opened = new Promise<Page>((resolve) => {
        opening = resolve;
      });
      try {
        timer = setTimeout(() => {
          closed = true; // An uncertain click must not be replayed on this list.
          cancel?.(new Error("点击商品后未及时打开新详情页，已停止本查询页"));
        }, timeoutMs);
        const work = async () => {
          await Promise.all([
            clickForInspection(links.nth(matches[0]), local),
            opened.then((value) => {
              page = value;
            }),
          ]);
          local.throwIfAborted();
          const target = page!;
          await ensureWorkViewport(target);
          await target.waitForURL((value) => value.href !== "about:blank", { timeout: timeoutMs });
          await target.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
          const status = responses.get(target)?.status();
          if (status && [401, 403, 429].includes(status))
            throw new Error(`商品详情访问被拒绝（HTTP ${status}），请核对登录或访问权限后继续`);
          await assertAvailable(target);
          if (equipmentIdentity(safeEquipmentUrl(target.url())) !== identity)
            throw new Error("商品详情跳转到另一商品，报价未采用");
          clearTimeout(timer);
          local.throwIfAborted();
          return read(target);
        };
        return await Promise.race([work(), cancelled]);
      } catch (error) {
        if (!page) closed = true;
        await captureBrowserStep(
          page || searchPage,
          { flow: "analysis", stage: "商品列表点击读取失败", key: identity, error },
          local,
        );
        throw error;
      } finally {
        clearTimeout(timer);
        opening = undefined;
        cancel = undefined;
        local.removeEventListener("abort", abort);
        context.off("response", response);
        if (page) {
          await page.close().catch(() => {});
          pages.delete(page);
        }
      }
    },
  };
}

/** Re-find saved quotations under the same official filters, within the caller's budget. */
export async function refreshMarketCandidates(
  pending: Map<string, number>,
  modeIndex: number,
  load: (page: number) => Promise<{ rows: Array<{ url: string }>; hasNext: boolean }>,
  read: (url: string) => Promise<unknown>,
  budget: () => boolean,
  readBudget = budget,
) {
  for (let number = 1; [...pending.values()].includes(modeIndex) && budget(); number++) {
    const listing = await load(number);
    await readMarketCandidatesOnPage(pending, modeIndex, listing.rows, read, readBudget);
    if (!listing.hasNext) break;
  }
}

export async function readMarketCandidatesOnPage(
  pending: Map<string, number>,
  modeIndex: number,
  rows: Array<{ url: string }>,
  read: (url: string) => Promise<unknown>,
  budget: () => boolean,
) {
  for (const row of rows) {
    const identity = equipmentIdentity(row.url);
    const entry = [...pending].find(
      ([url, mode]) => mode === modeIndex && equipmentIdentity(url) === identity,
    );
    if (!entry) continue;
    if (!budget()) return;
    await read(entry[0]);
    pending.delete(entry[0]);
  }
}
