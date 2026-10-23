import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { browserStatus, crawlStatus } from "../fixtures/saved-role";

test("首页装备总开关默认关闭、持久保存，保存失败不伪装切换成功", async ({ page }, testInfo) => {
  let enabled = false;
  let fail = false;
  const writes: boolean[] = [];
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-ui.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      switch (url.pathname) {
        case "/api/crawl/settings":
          body = { analyzeEquipment: enabled };
          break;
        case "/api/crawl/settings/save":
          writes.push(route.request().postDataJSON().analyzeEquipment);
          if (fail) return route.fulfill({ status: 500, json: { error: "模拟保存失败" } });
          enabled = route.request().postDataJSON().analyzeEquipment;
          body = { analyzeEquipment: enabled };
          break;
        case "/api/browser/status":
          body = browserStatus;
          break;
        case "/api/crawl/status":
          body = crawlStatus(false, true);
          break;
        case "/api/crawl/records":
          body = { page: 1, total: 0, totalPages: 1, items: [] };
          break;
        case "/api/scan/status":
          body = {
            config: {
              scheduleType: "daily",
              daily: { startTime: "09:00" },
              days: [],
              maxDurationMinutes: null,
            },
            mode: "disabled",
            state: "disabled",
            message: "定时计划未启用。",
            timezone: "Asia/Shanghai",
          };
          break;
        default:
          throw new Error("未模拟接口：" + url.pathname);
      }
      return route.fulfill({ json: body });
    }
    const filename = path.join("dist", url.pathname === "/" ? "index.html" : url.pathname);
    return route.fulfill({
      contentType: filename.endsWith(".js")
        ? "application/javascript"
        : filename.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(filename),
    });
  });
  await page.goto("http://cbg-ui.test");
  const toggle = page.getByRole("checkbox", { name: "分析装备" });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(page.getByText("已关闭（默认）", { exact: false })).toBeVisible();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await page.reload();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  fail = true;
  await toggle.click();
  await expect(page.getByRole("alert")).toHaveText("模拟保存失败");
  await expect(toggle).not.toBeChecked();
  expect(writes).toEqual([true, false, true]);
  await page
    .getByRole("region", { name: "详情采集" })
    .screenshot({ path: testInfo.outputPath("bare-role-default.png") });
});
