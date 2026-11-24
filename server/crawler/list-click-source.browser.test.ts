import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { createListClickSource, openListingDetail } from "./list-click-source";
import type { Listing } from "./types";

vi.mock("./browser-evidence", () => ({
  captureBrowserStep: vi.fn(),
  registerBrowserEvidence: vi.fn(),
}));
let browser: Browser;
let context: BrowserContext;
let list: Page;
const origin = "https://xyq.cbg.163.com";
const item: Listing = {
  key: "1:one",
  serverId: "1",
  eid: "one",
  ordersn: "1",
  url: `${origin}/equip?s=1&eid=one`,
  name: "角色",
  price: "10",
  sellingTime: null,
  createdTime: null,
  orderTime: null,
  attrs: {},
  summary: null,
};
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await context?.close();
  await browser?.close();
});
beforeEach(async () => {
  vi.clearAllMocks();
  await context?.close();
  context = await browser.newContext();
  list = await context.newPage();
});
async function fixture(target = "_blank", extra = "", detailEid = "one") {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/list")
      await route.fulfill({
        contentType: "text/html",
        body: `<script>window.IsLogin=1; window.QueryArgs={server_type:'1,2,3',page:1,order_by:'selling_time DESC',price_min:100};window.clicks=Number(sessionStorage.getItem('clicks')||0);</script><div id="pager_bar">第1页 共1页</div><table id="soldList"><tr><td><a class="soldImg" href="/equip?s=1&eid=one" target="${target}" onclick="window.clicks++;sessionStorage.setItem('clicks',String(window.clicks))"><img width="80" height="80" alt="角色"></a>${extra}</td></tr></table>`,
      });
    else if (url.pathname === "/equip")
      await route.fulfill({
        contentType: "text/html",
        body: `<script>window.IsLogin=1;window.EquipInfo={server_id:'1',eid:'${detailEid}'}</script><h1>角色详情</h1><p>状态：上架中</p>`,
      });
    else await route.abort();
  });
  await list.goto(`${origin}/list`);
}
it("点击产生详情新标签，保持原列表和其他用户标签，不预建空白页", async () => {
  await fixture();
  const other = await context.newPage();
  const opened = vi.fn();
  const page = await openListingDetail(list, item, new AbortController().signal, opened);
  expect(page).not.toBe(list);
  expect(context.pages()).toHaveLength(3);
  expect(await list.evaluate(() => Reflect.get(window, "clicks"))).toBe(1);
  expect(list.url()).toBe(`${origin}/list`);
  expect(other.isClosed()).toBe(false);
  expect(opened).toHaveBeenCalledWith(page);
});
it("网站在原标签跳转时复用该标签，不补发点击", async () => {
  await fixture("_self");
  const page = await openListingDetail(list, item, new AbortController().signal);
  expect(page).toBe(list);
  expect(context.pages()).toHaveLength(1);
  await page.goBack();
  expect(await page.evaluate(() => Reflect.get(window, "clicks"))).toBe(1);
});
it("商品身份错误时拒绝并关闭本次子页", async () => {
  await fixture("_blank", "", "wrong");
  await expect(openListingDetail(list, item, new AbortController().signal)).rejects.toThrow(
    "商品身份未确认",
  );
  expect(context.pages()).toEqual([list]);
});
it("重复或消失的头像不点击，也不从保存URL直接打开", async () => {
  await fixture("_blank", '<a class="soldImg" href="/equip?s=1&eid=one">重复</a>');
  await expect(openListingDetail(list, item, new AbortController().signal)).rejects.toThrow("唯一");
  await list.locator("a.soldImg").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  await expect(openListingDetail(list, item, new AbortController().signal)).rejects.toThrow("唯一");
  expect(context.pages()).toHaveLength(1);
  expect(await list.evaluate(() => Reflect.get(window, "clicks"))).toBe(0);
});
it("点击无结果只尝试一次；取消之后不点击", async () => {
  await fixture();
  await list
    .locator("a")
    .evaluate((node) => node.addEventListener("click", (event) => event.preventDefault()));
  await expect(
    openListingDetail(list, item, new AbortController().signal, undefined, 100),
  ).rejects.toThrow("未确认详情");
  const control = new AbortController();
  control.abort(new Error("fixture cancel"));
  await expect(openListingDetail(list, item, control.signal)).rejects.toThrow("fixture cancel");
  expect(await list.evaluate(() => Reflect.get(window, "clicks"))).toBe(1);
});
it.each(["_blank", "_self"])(
  "正式source使用已打开详情，采完返回原列表并保留筛选（%s）",
  async (target) => {
    await fixture(target);
    const readRole = vi.fn(async (page: Page) => ({
      url: page.url(),
      tabs: [],
      raw: {},
      collectedAt: "fixture",
    }));
    const source = createListClickSource(
      {
        listPage: list,
        signal: new AbortController().signal,
        onDetailProgress: vi.fn(),
        log: vi.fn(),
      },
      readRole,
    );
    const go = vi.spyOn(list, "goto");
    await source.detail(item);
    expect(readRole).toHaveBeenCalledWith(
      expect.anything(),
      item,
      expect.objectContaining({ alreadyOpened: true }),
    );
    expect(source.maxConcurrency).toBe(1);
    expect(go).not.toHaveBeenCalled();
    expect(context.pages()).toEqual([list]);
    expect(list.url()).toBe(`${origin}/list`);
    expect(await list.evaluate(() => Reflect.get(window, "QueryArgs"))).toMatchObject({
      price_min: 100,
      page: 1,
      order_by: "selling_time DESC",
    });
  },
);

it("并发提交三件时仍逐件点击、采集、关闭后再开始下一件", async () => {
  await fixture();
  let active = 0,
    maximum = 0;
  const readRole = vi.fn(async (page: Page) => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active--;
    return { url: page.url(), tabs: [], raw: {}, collectedAt: "fixture" };
  });
  const source = createListClickSource(
    {
      listPage: list,
      signal: new AbortController().signal,
      onDetailProgress: vi.fn(),
      log: vi.fn(),
    },
    readRole,
  );
  await Promise.all([source.detail(item), source.detail(item), source.detail(item)]);
  expect(maximum).toBe(1);
  expect(readRole).toHaveBeenCalledTimes(3);
  expect(await list.evaluate(() => Reflect.get(window, "clicks"))).toBe(3);
  expect(context.pages()).toEqual([list]);
}, 20_000);

it("取消只关闭本次详情，保留列表和用户原有标签，不再开始排队点击", async () => {
  await fixture();
  const other = await context.newPage();
  const readRole = vi.fn(
    (_page: Page, _item: Listing, options: { signal: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        });
      }),
  );
  const source = createListClickSource(
    {
      listPage: list,
      signal: new AbortController().signal,
      onDetailProgress: vi.fn(),
      log: vi.fn(),
    },
    readRole,
  );
  const work = source.detail(item).catch((error: unknown) => error);
  const queued = source.detail(item).catch((error: unknown) => error);
  await vi.waitFor(() => expect(readRole).toHaveBeenCalledOnce(), { timeout: 4000 });
  await source.cancelDetails!(new Error("fixture stop"));
  expect(await work).toBeInstanceOf(Error);
  expect(await queued).toBeInstanceOf(Error);
  expect(context.pages()).toEqual([list, other]);
  expect(await list.evaluate(() => Reflect.get(window, "clicks"))).toBe(1);
});

it("返回后筛选条件变化时停止，后续排队任务不再点击", async () => {
  await fixture();
  const fatal = vi.fn();
  const readRole = vi.fn(async (page: Page) => {
    await list.evaluate(() => {
      Reflect.get(window, "QueryArgs").price_min = 200;
    });
    return { url: page.url(), tabs: [], raw: {}, collectedAt: "fixture" };
  });
  const source = createListClickSource(
    {
      listPage: list,
      signal: new AbortController().signal,
      onDetailProgress: vi.fn(),
      log: vi.fn(),
      onFatal: fatal,
    },
    readRole,
  );
  await expect(source.detail(item)).rejects.toThrow("查询条件");
  await expect(source.detail(item)).rejects.toThrow("查询条件");
  expect(fatal).toHaveBeenCalledOnce();
  expect(readRole).toHaveBeenCalledOnce();
  expect(context.pages()).toEqual([list]);
});
