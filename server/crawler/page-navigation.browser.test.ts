import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { gotoPage } from "./page";

// 只使用隔离 Chrome 和内存模拟页面；不访问真实站点或采集配置。
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 30_000);
afterAll(async () => {
  await browser?.close();
});

const fixture = `<!doctype html><meta charset="utf-8">
<div id="query_result"><div id="soldList"></div><div id="pager_bar"></div></div>
<script>
window.QueryArgs = { server_type: '3', order_by: 'expire_time DESC', page: 1 };
window.fixtureCalls = 0;
window.fixtureCommits = 0;
function render(number) {
  document.querySelector('#soldList').innerHTML = '<a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=item-' + number + '" data_price="100">角色</a>';
}
document.querySelector('#pager_bar').textContent = '第 1 页 共 3 页';
render(1);
window.goto = function(number) {
  window.fixtureCalls++;
  QueryArgs.page = number;
  document.querySelector('#pager_bar').textContent = '第 ' + number + ' 页 共 3 页';
  setTimeout(() => {
    render(number);
    window.fixtureCommits++;
  }, 600);
};
</script>`;

it("页码先变化且没有加载遮罩时，等待延迟提交的商品节点", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const result = await gotoPage(page, 2, new AbortController().signal);
    expect(result.page).toBe(2);
    expect(result.items.map((item) => item.key)).toEqual(["1:item-2"]);
    expect(await page.evaluate(() => Reflect.get(window, "fixtureCommits"))).toBe(1);
  } finally {
    await page.close();
  }
}, 15_000);

it("同页普通读取可复用，强制刷新等待相同 ID 的新一次重绘", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    const signal = new AbortController().signal;
    const cached = await gotoPage(page, 1, signal);
    expect(cached.items[0]?.key).toBe("1:item-1");
    expect(await page.evaluate(() => Reflect.get(window, "fixtureCalls"))).toBe(0);
    const refreshed = await gotoPage(page, 1, signal, true);
    expect(refreshed.items[0]?.key).toBe("1:item-1");
    expect(await page.evaluate(() => Reflect.get(window, "fixtureCalls"))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, "fixtureCommits"))).toBe(1);
    expect(await page.evaluate(() => Reflect.has(window, "__cbgListNavigation"))).toBe(false);
  } finally {
    await page.close();
  }
}, 15_000);

it("空列表强制刷新等待新的空结果文本提交，不把页码更新当成成功", async () => {
  const page = await browser.newPage();
  try {
    await page.setContent(fixture);
    await page.evaluate(() => {
      document.querySelector("#soldList")!.innerHTML = "<p>没有符合条件</p>";
      Reflect.set(window, "goto", (number: number) => {
        Reflect.get(window, "QueryArgs").page = number;
        document.querySelector("#pager_bar")!.textContent = `第 ${number} 页 共 3 页`;
        setTimeout(() => {
          document.querySelector("#soldList")!.innerHTML = "<p>没有符合条件</p>";
          Reflect.set(window, "fixtureCommits", 1);
        }, 600);
      });
    });
    const result = await gotoPage(page, 2, new AbortController().signal, true);
    expect(result.items).toEqual([]);
    expect(result.page).toBe(2);
    expect(await page.evaluate(() => Reflect.get(window, "fixtureCommits"))).toBe(1);
  } finally {
    await page.close();
  }
}, 15_000);
