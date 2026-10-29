import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { collectRole } from "./source";
import type { Listing } from "./types";

vi.mock("./page", async (original) => ({
  ...(await original<typeof import("./page")>()),
  pace: async () => {},
}));
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});

it.each(["login.py", "show_login.py"])(
  "详情HTTP重定向到%s时只访问一次并明确要求登录",
  async (loginPage) => {
    const page = await browser.newPage();
    const url = "https://xyq.cbg.163.com/equip?s=1&eid=redirect-fixture";
    let visits = 0;
    try {
      await page.route("https://xyq.cbg.163.com/**", (route) => {
        if (route.request().url() === url) {
          visits++;
          return route.fulfill({ status: 302, headers: { location: `/cgi-bin/${loginPage}` } });
        }
        return route.fulfill({
          contentType: "text/html",
          body: "<meta charset=utf-8><h1>扫码登录</h1>",
        });
      });
      const error = await collectRole(
        page,
        { key: "1:redirect-fixture", serverId: "1", eid: "redirect-fixture", url } as Listing,
        {
          signal: new AbortController().signal,
          log: vi.fn(),
          onDetailProgress: vi.fn(),
        },
      ).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ name: "CrawlAccessError", kind: "login" });
      expect(visits).toBe(1);
    } finally {
      await page.close();
    }
  },
);

it("没有登录跳转证据的上下文销毁保留原错误，不盲目重读", async () => {
  const page = await browser.newPage();
  const url = "https://xyq.cbg.163.com/equip?s=1&eid=unknown-fixture";
  const original = new Error(
    "page.evaluate: Execution context was destroyed, most likely because of a navigation",
  );
  let visits = 0;
  try {
    await page.route(url, (route) => {
      visits++;
      return route.fulfill({ contentType: "text/html", body: "<p>模拟详情</p>" });
    });
    vi.spyOn(page, "evaluate").mockRejectedValueOnce(original);
    const error = await collectRole(
      page,
      { key: "1:unknown-fixture", serverId: "1", eid: "unknown-fixture", url } as Listing,
      {
        signal: new AbortController().signal,
        log: vi.fn(),
        onDetailProgress: vi.fn(),
      },
    ).catch((failure: unknown) => failure);
    expect(error).toBe(original);
    expect(visits).toBe(1);
  } finally {
    await page.close();
  }
});

it("正常详情采集遇到登录跳转及上下文销毁时，报告登录而不是通用evaluate错误，且不重读", async () => {
  const page = await browser.newPage();
  const url = "https://xyq.cbg.163.com/equip?s=1&eid=login-fixture";
  let visits = 0;
  try {
    await page.route("https://xyq.cbg.163.com/**", (route) => {
      if (route.request().url() === url) visits++;
      return route.fulfill({
        contentType: "text/html",
        body: "<meta charset=utf-8><p>模拟详情</p>",
      });
    });
    // Reproduce the observed race in the normal role-reading path, with real navigation.
    vi.spyOn(page, "evaluate").mockImplementationOnce(async () => {
      await page.goto("https://xyq.cbg.163.com/cgi-bin/show_login.py");
      throw new Error(
        "page.evaluate: Execution context was destroyed, most likely because of a navigation",
      );
    });
    const error = await collectRole(
      page,
      { key: "1:login-fixture", serverId: "1", eid: "login-fixture", url } as Listing,
      {
        signal: new AbortController().signal,
        log: vi.fn(),
        onDetailProgress: vi.fn(),
      },
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ name: "CrawlAccessError", kind: "login" });
    expect((error as Error).message).toContain("登录");
    expect(visits).toBe(1);
  } finally {
    await page.close();
  }
});
