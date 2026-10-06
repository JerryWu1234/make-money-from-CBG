import type { Page } from "playwright-core";
import { ensureWorkViewport, hoverForInspection } from "../viewport";
import { parseListing } from "./listing";
import { ListingChangedError, type Listing, type ListingPage } from "./types";

export function checkAborted(signal: AbortSignal) {
  signal.throwIfAborted();
}
export async function pace(signal: AbortSignal, minimum = 1200, spread = 900) {
  checkAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", cancel);
      resolve();
    };
    const timer = setTimeout(finish, minimum + Math.random() * spread);
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}
export async function assertAvailable(page: Page) {
  if (page.isClosed()) throw new Error("工作页已关闭，请重新连接后续采");
  const error = await page.evaluate(() => {
    const globals = window as Window & {
      CaptchaCheck?: { need_captcha?: boolean };
      IsLogin?: number;
      LoginInfo?: { login?: number };
    };
    const visible = (selector: string) =>
      Array.from(document.querySelectorAll(selector)).some((el) => el.checkVisibility());
    if (
      globals.CaptchaCheck?.need_captcha ||
      visible(".yidun_popup, .geetest_panel, #captcha_container")
    )
      return "网站要求安全验证，已暂停采集";
    if (
      globals.IsLogin === 0 ||
      globals.LoginInfo?.login === 0 ||
      /show_login\.py/.test(location.pathname)
    )
      return "网站登录已失效，已暂停采集";
    if (/系统繁忙|访问过于频繁|请求过于频繁/.test(document.body.innerText))
      return "网站繁忙或要求降低频率，已暂停采集";
    return "";
  });
  if (error) throw new Error(error);
}
export async function readListings(page: Page): Promise<ListingPage> {
  await assertAvailable(page);
  const data = await page.evaluate(() => {
    const globals = window as Window & {
      QueryArgs?: { server_type?: string; order_by?: string; page?: number };
      QueryResult?: Record<string, unknown>[];
    };
    if (String(globals.QueryArgs?.server_type) !== "3")
      throw new Error("当前列表未确认3年以上服条件");
    const pager = document.querySelector<HTMLElement>("#pager_bar")?.innerText || "";
    const current = Number(pager.match(/第\s*(\d+)\s*页/)?.[1] || globals.QueryArgs?.page || 1);
    const total = Number(pager.match(/共\s*(\d+)\s*页/)?.[1] || current);
    const anchors = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("#soldList a.soldImg[href]"),
    );
    const items = anchors.map((a, index) => {
      const attrs: Record<string, string> = {};
      for (const el of [a, a.querySelector("img")])
        if (el)
          for (const attr of el.attributes)
            if (
              attr.name.startsWith("data_") ||
              attr.name.startsWith("data-") ||
              attr.name === "mouse_over_begin"
            )
              attrs[attr.name.replaceAll("data-", "data_")] = attr.value;
      const raw =
        globals.QueryResult?.find((item) => String(item.game_ordersn) === attrs.data_ordersn) ||
        globals.QueryResult?.[index] ||
        {};
      const text = a.querySelector("textarea")?.value;
      let summary: unknown = text || null;
      if (text) {
        try {
          summary = JSON.parse(text);
        } catch {
          /* 原始内容保留 */
        }
      }
      return { href: a.href, attrs, summary, raw };
    });
    const empty = document
      .querySelector<HTMLElement>("#query_result")
      ?.innerText.includes("没有符合条件");
    if (!items.length && !empty) throw new Error("列表没有可识别的商品链接，已停止以免跳过数据");
    return { page: current, totalPages: total, order: globals.QueryArgs?.order_by || "", items };
  });
  return {
    ...data,
    items: data.items.map((item) => ({
      ...parseListing(item.href, item.attrs, item.summary, data.order, item.raw),
      serverAge: "older",
    })),
  };
}
export async function waitList(page: Page, wanted: number) {
  await page.waitForFunction(
    (pageNumber) => {
      const globals = window as Window & {
        QueryArgs?: { page?: number };
        CaptchaCheck?: { need_captcha?: boolean };
      };
      if (globals.CaptchaCheck?.need_captcha) throw new Error("网站要求安全验证，已暂停采集");
      const busy = Array.from(document.querySelectorAll("#LoadingCover, #LoadingImg")).some((el) =>
        el.checkVisibility(),
      );
      const pager = document.querySelector<HTMLElement>("#pager_bar")?.innerText || "";
      const current = Number(pager.match(/第\s*(\d+)\s*页/)?.[1]);
      const empty = document
        .querySelector<HTMLElement>("#query_result")
        ?.innerText.includes("没有符合条件");
      return (
        !busy &&
        ((current === pageNumber && !!document.querySelector("#soldList a.soldImg")) ||
          (empty && Number(globals.QueryArgs?.page) === pageNumber))
      );
    },
    wanted,
    { timeout: 45000, polling: 250 },
  );
  await assertAvailable(page);
}
export async function gotoPage(
  page: Page,
  wanted: number,
  signal: AbortSignal,
  refresh = false,
): Promise<ListingPage> {
  checkAborted(signal);
  const current = await readListings(page);
  if (current.page === wanted && !refresh) return current;
  await pace(signal);
  // 优先点击网站现有分页链接；远距离定位使用网站自己的跳页函数。
  const link = page.locator(`#pager_bar a[href="javascript:goto(${wanted})"]`).first();
  if (await link.count()) await link.evaluate((el) => (el as HTMLElement).click());
  else
    await page.evaluate((number) => {
      const goto = (window as Window & { goto?: (page: number) => void }).goto;
      if (typeof goto !== "function") throw new Error("网站未提供跳页函数，无法定位断点");
      goto(number);
    }, wanted);
  await waitList(page, wanted);
  checkAborted(signal);
  return readListings(page);
}
export async function prepareList(
  page: Page,
  signal: AbortSignal,
  preferredOrder?: string,
): Promise<ListingPage> {
  await ensureWorkViewport(page);
  const selling = page.locator('#order_menu a[data_attr_name="selling_time"]');
  const expiry = page.locator('#order_menu a[data_attr_name="expire_time"]');
  const preferred = /^(selling_time|expire_time) DESC$/.exec(preferredOrder || "")?.[1];
  const field =
    preferred === "selling_time" && (await selling.count())
      ? preferred
      : preferred === "expire_time" && (await expiry.count())
        ? preferred
        : (await selling.count())
          ? "selling_time"
          : (await expiry.count())
            ? "expire_time"
            : null;
  if (field) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await readListings(page);
      if (current.order === `${field} DESC`) break;
      await pace(signal);
      await page
        .locator(`#order_menu a[data_attr_name="${field}"]`)
        .evaluate((el) => (el as HTMLElement).click());
      await waitList(page, 1);
    }
  }
  return gotoPage(page, 1, signal, true);
}
export async function hoverListing(
  page: Page,
  item: Listing,
  signal: AbortSignal,
): Promise<Listing> {
  checkAborted(signal);
  const anchors = page.locator("#soldList a.soldImg[href]");
  const hrefs = await anchors.evaluateAll((elements) =>
    elements.map((el) => (el as HTMLAnchorElement).href),
  );
  const index = hrefs.findIndex((href) => {
    const url = new URL(href);
    return url.searchParams.get("eid") === item.eid && url.searchParams.get("s") === item.serverId;
  });
  if (index < 0) throw new ListingChangedError();
  await hoverForInspection(page, anchors.nth(index));
  await pace(signal, 350, 350);
  const refreshed = (await readListings(page)).items.find((value) => value.key === item.key);
  if (!refreshed) throw new ListingChangedError();
  return refreshed;
}
