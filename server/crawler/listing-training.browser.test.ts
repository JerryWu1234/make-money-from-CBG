import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { readListings } from "./page";

const fields = ["攻修", "防修", "法修", "抗法"];
const link = (id: string) =>
  `<a class="soldImg" data-keep="preserved-${id}" href="/equip?s=367&eid=${id}" onmouseover="window.businessInputs++">角色${id}</a>`;
const cells = (values: string[], tag = "td") =>
  values.map((value) => `<${tag}>${value}</${tag}>`).join("");
const header = `<tr>${cells(["角色", ...fields], "th")}</tr>`;
const values = { 攻修: "21/25", 防修: "20/25", 法修: "0/25", 抗法: "19/25" };
const cases = [
  {
    name: "按真实TH列名读取同商品，不从另一个商品或QueryResult取值",
    body: `${header}<tr><td>${link("a")}</td>${cells(Object.values(values))}</tr><tr><td>${link("b")}</td>${cells(["1/25", "2/25", "3/25", "4/25"])}</tr>`,
    expected: [values, { 攻修: "1/25", 防修: "2/25", 法修: "3/25", 抗法: "4/25" }],
  },
  {
    name: "综合排序/门派/等级的TD表头与图片colspan偏移",
    body: `<tr>${cells(["综合排序", "门派", "等级", ...fields], "td")}</tr><tr><td colspan="2">${link("a")}</td><td>175</td>${cells(Object.values(values))}</tr>`,
    expected: [values],
  },
  {
    name: "列重排按表头不按固定索引",
    body: `<tr>${cells(["角色", "抗法", "攻修", "法修", "防修"], "th")}</tr><tr><td>${link("a")}</td>${cells(["19/25", "21/25", "0/25", "20/25"])}</tr>`,
    expected: [values],
  },
  {
    name: "重复表头只采用当前商品之前最近的一组",
    body: `${header}<tr><td>${link("a")}</td>${cells(Object.values(values))}</tr><tr>${cells(["角色", "抗法", "法修", "防修", "攻修"], "th")}</tr><tr><td>${link("b")}</td>${cells(["4/25", "3/25", "2/25", "1/25"])}</tr>`,
    expected: [values, { 攻修: "1/25", 防修: "2/25", 法修: "3/25", 抗法: "4/25" }],
  },
  {
    name: "空缺不补0，合法0及非法原文保持原样给中央解析器",
    body: `${header}<tr><td>${link("a")}</td>${cells(["", "0/0", "--", "  9 / 25  "])}</tr>`,
    expected: [{ 防修: "0/0", 法修: "--", 抗法: "9 / 25" }],
  },
  {
    name: "没有表头及根外推荐表头不能凭位置补值",
    before: `<table>${header}</table>`,
    body: `<tr><td>${link("a")}</td>${cells(Object.values(values))}</tr>`,
    expected: [{}],
  },
  {
    name: "四修格内嵌推荐商品不能把推荐值借给外层商品",
    body: `${header}<tr><td>${link("a")}</td><td><table><tr><td>${link("b").replace("角色b", "21/25")}</td></tr></table></td>${cells(["20/25", "0/25", "19/25"])}</tr>`,
    expected: [{ 防修: "20/25", 法修: "0/25", 抗法: "19/25" }, {}],
  },
  {
    name: "重复同名表头只让该字段未知",
    body: `<tr>${cells(["角色", "攻修", "攻修", "防修", "法修", "抗法"], "th")}</tr><tr><td>${link("a")}</td>${cells(["1/25", "2/25", "3/25", "4/25", "5/25"])}</tr>`,
    expected: [{ 防修: "3/25", 法修: "4/25", 抗法: "5/25" }],
  },
  {
    name: "数据缺列不能向前错配",
    body: `${header}<tr><td>${link("a")}</td>${cells(["21/25", "20/25", "19/25"])}</tr>`,
    expected: [{}],
  },
  {
    name: "rowspan来自另一商品的字段不属于当前商品",
    body: `${header}<tr><td>${link("a")}</td><td rowspan="2">21/25</td>${cells(["20/25", "0/25", "19/25"])}</tr><tr><td>${link("b")}</td>${cells(["7/25", "8/25", "9/25"])}</tr>`,
    expected: [values, { 防修: "7/25", 法修: "8/25", 抗法: "9/25" }],
  },
  {
    name: "同一行有两个商品不能借用这一行的四修",
    body: `${header}<tr><td>${link("a")}${link("b")}</td>${cells(Object.values(values))}</tr>`,
    expected: [{}, {}],
  },
  {
    name: "表头rowspan及非修炼图片colspan均按实际列布局",
    body: `<tr><th rowspan="2" colspan="2">角色</th>${fields.map((field) => `<th rowspan="2">${field}</th>`).join("")}<th>附加信息</th></tr><tr><th>门派</th></tr><tr><td colspan="2">${link("a")}</td>${cells(Object.values(values))}<td>大唐官府</td></tr>`,
    expected: [values],
  },
];

let context: BrowserContext, profile: string;
beforeAll(async () => {
  profile = await mkdtemp(path.join(os.tmpdir(), "cbg-list-training-"));
  context = await chromium.launchPersistentContext(profile, { channel: "chrome", headless: true });
}, 30000);
afterAll(async () => {
  await context?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
});

type ObservedItem = { href: string; attrs: Record<string, string> };
const observedItems = (page: Page) =>
  page.evaluate(() => {
    const messages = Reflect.get(window, "listingSnapshots") as {
      payload: { listing?: { items: ObservedItem[] } };
    }[];
    return messages.filter((message) => message.payload?.listing).at(-1)?.payload.listing?.items;
  });
const training = (attrs: Record<string, string>) =>
  Object.fromEntries(
    fields.filter((field) => Object.hasOwn(attrs, field)).map((field) => [field, attrs[field]]),
  );

it.each(cases)("Playwright与真实MAIN/ISOLATED列表读取一致：$name", async (test) => {
  const page = await context.newPage();
  let requests = 0;
  try {
    await page.route("**/*", (route) => {
      requests++;
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html><script>window.businessInputs=0;window.QueryArgs={server_type:'1,2,3',page:1,order_by:'selling_time DESC'};window.QueryResult=[{game_ordersn:'unrelated',攻修:'99/99'}];</script>${test.before || ""}<div id="query_result"><table id="soldList">${test.body}</table></div><div id="pager_bar">第1页 共1页</div>`,
      });
    });
    await page.goto("https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role");
    const playwright = await readListings(page);
    expect(playwright.items.map((item) => training(item.attrs))).toEqual(test.expected);
    expect(playwright.items.map((item) => item.attrs.data_keep)).toEqual(
      playwright.items.map((item) => `preserved-${item.eid}`),
    );
    await page.evaluate(() => {
      Reflect.set(window, "listingSnapshots", []);
      Reflect.set(window, "listingListeners", []);
      Reflect.set(window, "chrome", {
        runtime: {
          id: "training-fixture",
          sendMessage: async (message: unknown) =>
            Reflect.get(window, "listingSnapshots").push(message),
          onMessage: {
            addListener: (listener: unknown) =>
              Reflect.get(window, "listingListeners").push(listener),
          },
        },
      });
    });
    for (const name of ["main.js", "isolated.js"])
      await page.addScriptTag({
        content: readFileSync(
          new URL(`../../extension/cbg-access/${name}`, import.meta.url),
          "utf8",
        ),
      });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          Reflect.get(window, "listingListeners")[0](
            { kind: "bind" },
            { id: "training-fixture" },
            resolve,
          ),
        ),
    );
    await expect.poll(async () => (await observedItems(page))?.length).toBe(test.expected.length);
    const extension = (await observedItems(page))!;
    expect(extension.map((item) => training(item.attrs))).toEqual(test.expected);
    expect(extension.map((item) => item.attrs.data_keep)).toEqual(
      playwright.items.map((item) => item.attrs.data_keep),
    );
    expect(await page.evaluate(() => Reflect.get(window, "businessInputs"))).toBe(0);
    expect(requests).toBe(1);
  } finally {
    await page.close();
  }
});
