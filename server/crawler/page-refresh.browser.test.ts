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
          mode === "filters-lost" ? "全部三个服龄条件" : "排序发生变化",
        );
      expect(requests).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  },
);
