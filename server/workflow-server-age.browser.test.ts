import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { readRoleList, runFixedWorkflow, selectServerAge } from "./workflow";
import { readListings } from "./crawler/page";

vi.mock("./browser-evidence", () => ({ captureBrowserStep: vi.fn() }));

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

it("完整搜号流程在两个表单全选后，提交三个服龄并读取结果", async () => {
  const page = await browser.newPage();
  let submitted = "";
  const panel = (id: string) => `<ul id="${id}">
    <li data_value="1">1年以内服</li><li data_value="2">1到3年服</li>
    <li data_value="3" class="on">3年以上服</li></ul>
    <script>document.querySelectorAll('li').forEach(el=>el.onclick=()=>el.classList.toggle('on'))</script>`;
  // 所有地址都被拦截并由内存数据响应，不向官网发送请求。
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    let content: string;
    if (url.pathname === "/form") {
      content = `${panel("server_type")}<form name="query_form">
        <button type="button" id="btn_do_query" onclick="location.href='/results?ages='+[...document.querySelectorAll('li.on')].map(el=>el.getAttribute('data_value')).join(',')">搜索</button></form>`;
    } else if (url.pathname === "/results") {
      submitted = url.searchParams.get("ages") || "";
      content = `<script>window.QueryArgs={server_type:${JSON.stringify(submitted)}}</script>
        <table id="soldList"><tr><th>角色</th></tr><tr><td>测试角色</td></tr></table>`;
    } else {
      content = `${panel("server_type_panel")}<a id="sub_role" href="/form">角色搜索</a>`;
    }
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<script>var IsLogin=1;var LoginInfo={login:1}</script><a href="/logout.py">退出</a>${content}`,
    });
  });
  try {
    const result = await runFixedWorkflow(page, vi.fn());
    expect(submitted).toBe("1,2,3");
    expect(result).toMatchObject({
      workflowStep: "completed",
      roleList: { serverAge: "全部服龄", rows: [["测试角色"]] },
    });
  } finally {
    await page.close();
  }
});

// 只操作内存模拟页面；不访问官网，也不使用采集浏览器的持久化配置。
it.each(["server_type_panel", "server_type"])(
  "%s 从仅三年以上服补选另外两个标签，重复执行不反选",
  async (panel) => {
    const page = await browser.newPage();
    try {
      await page.setContent(`
        <button id="btn_advance_search_fold" onclick="document.querySelector('ul').hidden=false">展开</button>
        <ul id="${panel}" ${panel === "server_type" ? "hidden" : ""}>
          <li data_value="1"><span>1年以内服</span></li>
          <li data_value="2"><span>1到3年服</span></li>
          <li data_value="3" class="on"><span>3年以上服</span></li>
        </ul>
        <script>
          window.clicks = [];
          document.querySelectorAll('li').forEach(el => el.onclick = () => {
            window.clicks.push(el.getAttribute('data_value'));
            el.classList.toggle('on');
          });
        </script>`);
      await selectServerAge(page, `#${panel}` as "#server_type_panel" | "#server_type");
      await selectServerAge(page, `#${panel}` as "#server_type_panel" | "#server_type");
      expect(
        await page.locator("li.on").evaluateAll((els) => els.map((el) => el.textContent)),
      ).toEqual(["1年以内服", "1到3年服", "3年以上服"]);
      expect(await page.evaluate(() => Reflect.get(window, "clicks"))).toEqual(["1", "2"]);
    } finally {
      await page.close();
    }
  },
);

it.each(["1,2,3", "3,1,2", [3, 2, 1]])(
  "全服龄查询 %s 可展示和采集，不将角色一律标记为三年以上服",
  async (serverTypes) => {
    const page = await browser.newPage();
    try {
      await page.setContent(`<table id="soldList"><tr><th>角色</th></tr><tr><td>
        <a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=fixture">测试角色</a>
        </td></tr></table>`);
      await page.evaluate((server_type) => {
        Reflect.set(window, "QueryArgs", { server_type });
      }, serverTypes);
      expect(await readRoleList(page)).toMatchObject({
        serverAge: "全部服龄",
        rows: [["测试角色"]],
      });
      const list = await readListings(page);
      expect(list.items.map((item) => item.key)).toEqual(["1:fixture"]);
      expect(list.items[0].serverAge).toBeUndefined();
    } finally {
      await page.close();
    }
  },
);

it.each(["3", "2,3", "1,2", "1,2,3,4", "1,2,3,3", "", null])(
  "查询缺少或混入服龄条件 %s 时拒绝继续读取旧列表",
  async (serverTypes) => {
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="query_result">没有符合条件</div>');
      await page.evaluate((server_type) => {
        Reflect.set(window, "QueryArgs", { server_type });
      }, serverTypes);
      await expect(readRoleList(page)).rejects.toThrow("全部三个服龄条件");
      await expect(readListings(page)).rejects.toThrow("全部三个服龄条件");
    } finally {
      await page.close();
    }
  },
);
