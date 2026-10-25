import type { Page } from "playwright-core";
import { ensureWorkViewport, hoverForInspection } from "../viewport";
import { parseListing } from "./listing";
import {
  ListingChangedError,
  CrawlAccessError,
  ListingDisappearedError,
  SellingOrderUnavailableError,
  type Listing,
  type ListingPage,
} from "./types";
import { accessNavigationFailure } from "./access-navigation";

export interface ListingHoverDiagnostic {
  event: "timeout" | "retry_recovered";
  key: string;
  attempt: number;
  matches: number;
  page: number;
  order: string;
  keys: string[];
  hrefs: string[];
  retrying: boolean;
}

async function matchingListingHrefs(page: Page, item: Listing) {
  const hrefs = await page.locator("#soldList a.soldImg[href]").evaluateAll(
    (anchors, { serverId, eid }) =>
      anchors
        .filter((anchor) => {
          try {
            const url = new URL((anchor as HTMLAnchorElement).href.replaceAll("&amp;", "&"));
            return url.searchParams.get("s") === serverId && url.searchParams.get("eid") === eid;
          } catch {
            return false;
          }
        })
        .slice(0, 5)
        .map((anchor) => anchor.getAttribute("href") || ""),
    { serverId: item.serverId, eid: item.eid },
  );
  return hrefs.map((href) =>
    href
      .replace(/\/\/[^/?#]*@/, "//[redacted]@")
      .replace(/([?&])([^=&#]+)=([^&#]*)/g, (part, prefix: string, name: string) => {
        let parameter = name;
        try {
          parameter = decodeURIComponent(name);
        } catch {
          // 非法编码的参数不保留其值。
        }
        return ["s", "eid", "reco_request_id"].includes(parameter)
          ? part
          : `${prefix}${name}=[redacted]`;
      })
      .replace(/#.*$/, "#[redacted]")
      .slice(0, 2000),
  );
}

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
  const navigation = await accessNavigationFailure(page, undefined);
  if (navigation) throw navigation;
  let issue: "login" | "verification" | "busy" | "";
  try {
    issue = await page.evaluate(() => {
      const globals = window as Window & {
        CaptchaCheck?: { need_captcha?: boolean };
        IsLogin?: number | boolean;
        LoginInfo?: { login?: number | boolean };
      };
      const visible = (selector: string) =>
        Array.from(document.querySelectorAll(selector)).some((el) => el.checkVisibility());
      if (
        globals.CaptchaCheck?.need_captcha ||
        visible(".yidun_popup, .geetest_panel, #captcha_container")
      )
        return "verification" as const;
      if (
        globals.IsLogin === 0 ||
        globals.IsLogin === false ||
        globals.LoginInfo?.login === 0 ||
        globals.LoginInfo?.login === false ||
        visible("#loginContainer,#qrcode,input[type=password]") ||
        /show_login\.py/.test(location.pathname)
      )
        return "login" as const;
      if (/系统繁忙|访问过于频繁|请求过于频繁/.test(document.body.innerText))
        return "busy" as const;
      return "" as const;
    });
  } catch (error) {
    throw (await accessNavigationFailure(page, error)) || error;
  }
  if (issue) throw new CrawlAccessError(issue);
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
  if (
    preferredOrder === "selling_time DESC" &&
    !(await selling.count()) &&
    (await readListings(page)).order !== preferredOrder
  )
    throw new SellingOrderUnavailableError();
  const field =
    preferredOrder === "selling_time DESC"
      ? "selling_time"
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
  const result = await gotoPage(page, 1, signal, true);
  if (preferredOrder === "selling_time DESC" && result.order !== preferredOrder)
    throw new Error("未能确认上架时间倒序，已暂停采集");
  return result;
}
export async function hoverListing(
  page: Page,
  item: Listing,
  signal: AbortSignal,
  recoveredActionability?: (stage: "scroll" | "visibility" | "handle") => void,
  onDiagnostic?: (diagnostic: ListingHoverDiagnostic) => void,
): Promise<Listing> {
  checkAborted(signal);
  if (!/^\d+$/.test(item.serverId) || !/^[\w-]+$/.test(item.eid))
    throw new Error("商品缺少稳定的服务器编号或 eid，不能安全定位");
  const parameter = (name: string, value: string) =>
    `:is(${["?", "&"]
      .flatMap((prefix) => {
        const part = `${prefix}${name}=${value}`;
        return [`[href*="${part}&"]`, `[href*="${part}#"]`, `[href$="${part}"]`];
      })
      .join(",")})`;
  // 追踪参数会在滚动或重绘时变化。定位器只匹配稳定身份及参数边界，
  // 每次动作重新解析当前节点，不冻结旧 href，也不按列表序号定位。
  const selector = `#soldList a.soldImg${parameter("s", item.serverId)}${parameter("eid", item.eid)}`;
  const before = await readListings(page);
  const sameVersion = (value: Listing) =>
    value.key === item.key && value.price === item.price && value.sellingTime === item.sellingTime;
  let diagnostic: ListingHoverDiagnostic | undefined;
  let recovered = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    checkAborted(signal);
    const targets = page.locator(selector);
    const target = targets;
    const count = await targets.count();
    if (!count) throw new ListingDisappearedError();
    if (count !== 1) throw new ListingChangedError();
    try {
      await hoverForInspection(page, target, (stage) => {
        recovered = true;
        recoveredActionability?.(stage);
      });
      break;
    } catch (error) {
      checkAborted(signal);
      if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
      const current = await readListings(page);
      const refreshed = current.items.find((value) => value.key === item.key);
      const matches = await targets.count();
      // 仅恢复尚未解析到目标的定位超时；遮挡、不可见和鼠标动作错误仍安全失败。
      const lookupTimeout =
        error.message.startsWith("locator.hover:") &&
        error.message.includes("waiting for locator") &&
        !/locator resolved|intercepts pointer events|visible and stable|not visible|not stable|performing hover action/.test(
          error.message,
        );
      const retrying =
        attempt === 1 &&
        lookupTimeout &&
        matches === 1 &&
        !!refreshed &&
        sameVersion(refreshed) &&
        current.page === before.page &&
        current.order === before.order;
      diagnostic = {
        event: "timeout",
        key: item.key,
        attempt,
        matches,
        page: current.page,
        order: current.order,
        keys: current.items.map((value) => value.key),
        hrefs: await matchingListingHrefs(page, item),
        retrying,
      };
      onDiagnostic?.(diagnostic);
      if (!refreshed) throw new ListingDisappearedError();
      if (!sameVersion(refreshed) || current.page !== before.page || current.order !== before.order)
        throw new ListingChangedError();
      if (!retrying) throw error;
    }
  }
  await pace(signal, 350, 350);
  const current = await readListings(page);
  const refreshed = current.items.find((value) => value.key === item.key);
  if (!refreshed) throw new ListingDisappearedError();
  if (
    (diagnostic || recovered) &&
    (!sameVersion(refreshed) || current.page !== before.page || current.order !== before.order)
  )
    throw new ListingChangedError();
  if (diagnostic)
    onDiagnostic?.({ ...diagnostic, event: "retry_recovered", attempt: 2, retrying: false });
  return refreshed;
}
