import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { refreshList } from "./page";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

it.each(["ok", "filters-lost", "order-lost"])(
  "刷新自然返回第一页，无额外分页点击，并校验条件：%s",
  async (mode) => {
    const page = await browser.newPage();
    let requests = 0;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    // 所有导航由内存响应拦截，不访问官网或正在运行的项目服务。
    await page.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== "http://refresh-list.test")
        return route.abort();
      requests++;
      const number = requests === 1 ? 20 : 1;
      const server_type = requests > 1 && mode === "filters-lost" ? "3" : "1,2,3";
      const order =
        requests > 1 && mode === "order-lost" ? "selling_time DESC" : "expire_time DESC";
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `
      <script>window.QueryArgs={server_type:'${server_type}',order_by:'${order}',page:${number}};
      window.goto=()=>{throw Error('不应额外点击分页')};</script>
      <div id="query_result"><div id="soldList"></div><div id="pager_bar"></div></div>
      <script>setTimeout(()=>{document.querySelector('#pager_bar').textContent='第 ${number} 页 共 30 页';
      document.querySelector('#soldList').innerHTML='<a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=fixture-${number}">角色</a>';},100);</script>`,
      });
    });
    try {
      await page.goto("http://refresh-list.test/list");
      const result = refreshList(page, new AbortController().signal, "expire_time DESC");
      if (mode === "ok")
        await expect(result).resolves.toMatchObject({ page: 1, items: [{ key: "1:fixture-1" }] });
      else
        await expect(result).rejects.toThrow(
          mode === "filters-lost" ? "全部三个服龄条件" : "未能恢复到期时间倒序",
        );
      expect(requests).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  },
);

it.each([
  ["expire_time", ""],
  ["expire_time", "expire_time ASC"],
  ["expire_time", "selling_time DESC"],
  ["expire_time", "expire_time DESC"],
  ["selling_time", ""],
  ["selling_time", "selling_time ASC"],
  ["selling_time", "expire_time DESC"],
  ["selling_time", "selling_time DESC"],
] as const)(
  "刷新后恢复 %s DESC，网站返回 %s，不再额外请求第一页",
  async (field, observed) => {
    const page = await browser.newPage();
    let requests = 0;
    const audit: { expected: string; observed: string; restored?: string }[] = [];
    await page.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== "http://restore-sort.test")
        return route.abort();
      requests++;
      const number = requests === 1 ? 20 : 1;
      const order = requests === 1 ? `${field} DESC` : observed;
      await route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `
      <style>#order_menu a{display:block;width:220px;height:40px}</style>
      <script>window.QueryArgs={server_type:'1,2,3',order_by:${JSON.stringify(order)},page:${number}};
      window.sortClicks=[];window.goto=()=>{throw Error('不应额外点击第一页')};</script>
      <div id="order_menu"><a href="#" data_attr_name="${field}">排序</a></div>
      <div id="query_result"><div id="soldList"></div><div id="pager_bar"></div></div>
      <script>
      function render(){document.querySelector('#pager_bar').textContent='第 '+QueryArgs.page+' 页 共 30 页';
        document.querySelector('#soldList').innerHTML='<a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=fixture-'+QueryArgs.page+'">角色</a>';}
      render();
      document.querySelector('#order_menu a').onclick=function(event){event.preventDefault();
        sortClicks.push(event.isTrusted);QueryArgs.order_by=QueryArgs.order_by==='${field} ASC'?'${field} DESC':'${field} ASC';
        QueryArgs.page=1;setTimeout(render,60);};
      </script>`,
      });
    });
    try {
      await page.goto("http://restore-sort.test/list");
      await expect(
        refreshList(page, new AbortController().signal, `${field} DESC`, (state) =>
          audit.push(state),
        ),
      ).resolves.toMatchObject({
        page: 1,
        order: `${field} DESC`,
        items: [{ key: "1:fixture-1" }],
      });
      expect(requests).toBe(2); // 一次打开、一次刷新，排序恢复不额外导航第一页。
      const clicks = await page.evaluate(() => Reflect.get(window, "sortClicks") as boolean[]);
      const expectedClicks = observed === `${field} DESC` ? 0 : observed === `${field} ASC` ? 1 : 2;
      expect(clicks).toEqual(Array.from({ length: expectedClicks }, () => true));
      if (expectedClicks)
        expect(audit).toEqual([
          { expected: `${field} DESC`, observed },
          { expected: `${field} DESC`, observed, restored: `${field} DESC` },
        ]);
      else expect(audit).toEqual([]);
    } finally {
      await page.close();
    }
  },
  20_000,
);

it("排序控件不能恢复倒序时最多点击两次并暂停，保留实际排序信息", async () => {
  const page = await browser.newPage();
  await page.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== "http://broken-sort.test") return route.abort();
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `
      <style>a{display:block;height:40px;width:240px}</style>
      <script>window.QueryArgs={server_type:'1,2,3',order_by:'expire_time ASC',page:1};window.sortClicks=0;
      window.goto=()=>{throw Error('不应额外分页')};</script>
      <div id="order_menu"><a href="#" data_attr_name="expire_time" onclick="event.preventDefault();sortClicks++;document.querySelector('#soldList').innerHTML=document.querySelector('#soldList').innerHTML">排序</a></div>
      <div id="query_result"><div id="soldList"><a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=fixture">角色</a></div><div id="pager_bar">第1页 共3页</div></div>`,
    });
  });
  try {
    await page.goto("http://broken-sort.test/list");
    await expect(
      refreshList(page, new AbortController().signal, "expire_time DESC"),
    ).rejects.toThrow("实际排序：expire_time ASC");
    expect(await page.evaluate(() => Reflect.get(window, "sortClicks"))).toBe(2);
  } finally {
    await page.close();
  }
}, 20_000);
