import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { createHiddenPage } from "./session";
import { openWorkTransport } from "./work-transport";
import { clickForInspection } from "./viewport";
import { prepareList } from "./crawler/page";

vi.mock("./browser-evidence", () => ({
  registerBrowserEvidence: vi.fn(),
  captureBrowserStep: vi.fn().mockResolvedValue(undefined),
}));
let persistent: BrowserContext;
let browser: Browser;
let directory: string;
beforeAll(async () => {
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "0");
  directory = await mkdtemp(path.join(os.tmpdir(), "cbg-input-compatibility-"));
  persistent = await chromium.launchPersistentContext(directory, {
    channel: "chrome",
    headless: false,
    args: ["--remote-debugging-port=0"],
  });
  const [port, endpoint] = (await readFile(path.join(directory, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  browser = await chromium.connectOverCDP(
    await openWorkTransport(`ws://127.0.0.1:${port}${endpoint}`),
    { noDefaults: true },
  );
}, 30000);
afterAll(async () => {
  await browser?.close();
  await persistent?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function fixture() {
  const page = await createHiddenPage(browser);
  await page.route("**/*", (route) => route.abort());
  await page.setContent(`<style>body{margin:40px}#order_menu a{display:block;width:160px;height:45px}</style>
    <div id="order_menu"><a id="target" data_attr_name="expire_time" href="#">到期排序</a></div>
    <div id="query_result"><div id="soldList"><a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=fixture" data_price="100">角色</a></div><div id="pager_bar">第 1 页 共 3 页</div></div>
    <script>window.QueryArgs={server_type:'1,2,3',order_by:'',page:1};window.events=[];window.commits=0;
      document.addEventListener('click',e=>events.push({trusted:e.isTrusted}));
      function commit(){document.querySelector('#soldList').innerHTML='<a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=fixture" data_price="100">角色</a>';commits++}
      document.querySelector('#target').onclick=e=>{e.preventDefault();QueryArgs.order_by='expire_time DESC';setTimeout(commit,50)};
      window.goto=()=>setTimeout(commit,50);
    </script>`);
  return page;
}
const observed = (page: Page) =>
  page.evaluate(() => ({
    events: Reflect.get(window, "events"),
    order: Reflect.get(window, "QueryArgs").order_by,
  }));
async function ignoreInput(page: Page) {
  const session = await page.context().newCDPSession(page);
  await session.send("Input.setIgnoreInputEvents", { ignore: true });
}

it("隐藏页丢弃坐标输入时，原采集准备流程通过一次控件点击完成排序，不再等45秒", async () => {
  const page = await fixture();
  try {
    await ignoreInput(page);
    const result = await prepareList(page, new AbortController().signal);
    expect(result.order).toBe("expire_time DESC");
    expect((await observed(page)).events).toEqual([{ trusted: false }]);
  } finally {
    await page.close();
  }
}, 15000);

it("正常隐藏页仍使用真实鼠标输入，只点击一次", async () => {
  const page = await fixture();
  try {
    await clickForInspection(page.locator("#target"));
    expect((await observed(page)).events).toEqual([{ trusted: true }]);
  } finally {
    await page.close();
  }
});

it("只收到鼠标按下时暂停，不补页面内点击", async () => {
  const page = await fixture();
  const click = vi.spyOn(page.mouse, "click").mockImplementation(async () => {
    await page.mouse.down();
  });
  try {
    await expect(clickForInspection(page.locator("#target"))).rejects.toMatchObject({
      kind: "input_unavailable",
    });
    expect((await observed(page)).events).toEqual([]);
  } finally {
    click.mockRestore();
    await page.close();
  }
});

it("网站脚本已触发点击时不再补点", async () => {
  const page = await fixture();
  const click = vi.spyOn(page.mouse, "click").mockImplementation(async () => {
    await page.locator("#target").evaluateAll((nodes) => (nodes[0] as HTMLElement).click());
  });
  try {
    await expect(clickForInspection(page.locator("#target"))).rejects.toMatchObject({
      kind: "input_unavailable",
    });
    expect((await observed(page)).events).toEqual([{ trusted: false }]);
  } finally {
    click.mockRestore();
    await page.close();
  }
});

it("迟到的真实点击在确认期内抵达时不再补点", async () => {
  const page = await fixture();
  const original = page.mouse.click.bind(page.mouse);
  let delivery: Promise<void> | undefined;
  const click = vi.spyOn(page.mouse, "click").mockImplementation(async (x, y) => {
    delivery = new Promise<void>((resolve) => setTimeout(resolve, 50)).then(() => original(x, y));
  });
  try {
    await clickForInspection(page.locator("#target"));
    await delivery;
    expect((await observed(page)).events).toEqual([{ trusted: true }]);
  } finally {
    await delivery;
    click.mockRestore();
    await page.close();
  }
});

it("鼠标输入后命令报错，即使控件已收到点击也不重放", async () => {
  const page = await fixture();
  const original = page.mouse.click.bind(page.mouse);
  const error = new Error("输入结果不确定");
  const click = vi.spyOn(page.mouse, "click").mockImplementation(async (x, y) => {
    await original(x, y);
    throw error;
  });
  try {
    await expect(clickForInspection(page.locator("#target"))).rejects.toBe(error);
    expect((await observed(page)).events).toEqual([{ trusted: true }]);
  } finally {
    click.mockRestore();
    await page.close();
  }
});

it.each(["replace", "cover", "disable", "login", "captcha", "busy", "abort"])(
  "无鼠标事件后遇到%s，不执行兼容点击",
  async (scenario) => {
    const page = await fixture();
    const control = new AbortController();
    const click = vi.spyOn(page.mouse, "click").mockImplementation(async () => {
      if (scenario === "abort") {
        control.abort(new Error("用户暂停"));
        return;
      }
      await page.evaluate((scenario) => {
        const target = document.querySelector("#target")!;
        if (scenario === "replace") target.replaceWith(target.cloneNode(true));
        if (scenario === "cover")
          document.body.insertAdjacentHTML(
            "beforeend",
            '<div style="position:fixed;inset:0;background:white">遮罩</div>',
          );
        if (scenario === "disable") target.setAttribute("aria-disabled", "true");
        if (scenario === "login")
          document.body.insertAdjacentHTML(
            "beforeend",
            '<div class="popupDialog">请登录后，再进行操作</div>',
          );
        if (scenario === "captcha") Reflect.set(window, "CaptchaCheck", { need_captcha: true });
        if (scenario === "busy")
          document.body.insertAdjacentHTML("beforeend", "<div>访问过于频繁</div>");
      }, scenario);
    });
    try {
      await expect(
        clickForInspection(page.locator("#target"), control.signal),
      ).rejects.toBeInstanceOf(Error);
      expect((await observed(page)).events).toEqual([]);
    } finally {
      click.mockRestore();
      await page.close();
    }
  },
);
