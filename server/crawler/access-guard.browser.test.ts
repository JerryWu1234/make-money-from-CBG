import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { watchCrawlAccess } from "./access-guard";
import { assertAvailable } from "./page";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture() {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<script>window.IsLogin=1;window.LoginInfo={login:1}</script><body>列表</body>",
    }),
  );
  await page.goto("https://xyq.cbg.163.com/list");
  return page;
}

it.each(["captcha", "verification-popup", "busy", "login-flag", "redirect"])(
  "读取间隙出现 %s 也会主动通知并取消，不依赖下一次采集操作",
  async (mode) => {
    const page = await fixture();
    const control = new AbortController();
    const notify = vi.fn((error) => control.abort(error));
    const dispose = await watchCrawlAccess(page, control.signal, notify);
    try {
      if (mode === "redirect") await page.goto("https://xyq.cbg.163.com/cgi-bin/show_login.py");
      else
        await page.evaluate((mode) => {
          if (mode === "captcha")
            document.body.insertAdjacentHTML(
              "beforeend",
              '<div id="ajax_guard_ne_captcha">验证组件</div>',
            );
          if (mode === "verification-popup")
            document.body.insertAdjacentHTML(
              "beforeend",
              '<div class="popupDialog">请完成安全验证</div>',
            );
          if (mode === "busy") document.body.innerHTML = "访问过于频繁";
          if (mode === "login-flag") Reflect.set(window, "IsLogin", 0);
        }, mode);
      await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
      expect(control.signal.reason).toMatchObject({
        kind:
          mode.startsWith("login") || mode === "redirect"
            ? "login"
            : mode === "busy"
              ? "busy"
              : "verification",
      });
    } finally {
      await dispose();
      await page.close();
    }
  },
);

it.each([403, 429])("正常页面的业务 fetch 返回 %s 立即触发访问暂停", async (status) => {
  const page = await fixture();
  const control = new AbortController();
  const notify = vi.fn((error) => control.abort(error));
  const dispose = await watchCrawlAccess(page, control.signal, notify);
  try {
    await page.route("**/cgi-bin/query.py", (route) => route.fulfill({ status, body: "denied" }));
    await page.evaluate(() => fetch("/cgi-bin/query.py").then(() => undefined));
    await vi.waitFor(() => expect(notify).toHaveBeenCalledOnce());
    expect(control.signal.reason).toMatchObject({ status, code: "CBG_HTTP_ACCESS_BLOCKED" });
  } finally {
    await dispose();
    await page.close();
  }
});

it("隐藏验证模板和统计图片的403不暂停；结束后的旧监听不能影响下一轮", async () => {
  const page = await fixture();
  const old = vi.fn(),
    next = vi.fn();
  const dispose = await watchCrawlAccess(page, new AbortController().signal, old);
  try {
    await page.evaluate(() => {
      document.body.insertAdjacentHTML(
        "beforeend",
        '<div style="display:none"><div id="ajax_guard_ne_captcha">请完成安全验证</div></div>',
      );
    });
    await page.route("**/icon.gif", (route) => route.fulfill({ status: 403, body: "denied" }));
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const img = new Image();
          img.onload = img.onerror = () => resolve();
          img.src = "/icon.gif";
        }),
    );
    await expect(assertAvailable(page)).resolves.toBeUndefined();
    await page.waitForTimeout(250);
    expect(old).not.toHaveBeenCalled();
    await dispose();
    const disposeNext = await watchCrawlAccess(page, new AbortController().signal, next);
    try {
      await page.evaluate(() => {
        Reflect.set(window, "IsLogin", 0);
      });
      await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
      expect(old).not.toHaveBeenCalled();
    } finally {
      await disposeNext();
    }
  } finally {
    await dispose();
    await page.close();
  }
});
