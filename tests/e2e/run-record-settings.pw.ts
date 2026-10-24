import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { browserStatus, crawlStatus } from "../fixtures/saved-role";

const preview = {
  token: "fixture-preview-token",
  runs: 3,
  files: 25,
  bytes: 1048576,
  protectedRuns: ["active-run"],
};
const cleared = {
  removedRuns: 3,
  removedFiles: 25,
  freedBytes: 1048576,
  skippedRuns: [],
  errors: [],
};

async function mount(page: Page, runtime: (route: Route, pathname: string) => Promise<void>) {
  // All APIs and assets are intercepted. No request reaches the running project.
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-run-records.test") return route.abort();
    if (url.pathname.startsWith("/api/runtime/") || url.pathname.startsWith("/api/logs/"))
      return runtime(route, url.pathname);
    if (url.pathname.startsWith("/api/")) {
      const responses: Record<string, unknown> = {
        "/api/browser/status": browserStatus,
        "/api/crawl/settings": { analyzeEquipment: false },
        "/api/crawl/status": crawlStatus(true, true),
        "/api/crawl/records": { page: 1, total: 0, totalPages: 1, items: [] },
        "/api/scan/status": {
          config: {
            scheduleType: "daily",
            daily: { startTime: "09:00" },
            days: [],
            maxDurationMinutes: null,
          },
          mode: "disabled",
          state: "disabled",
          message: "未启用",
          timezone: "Asia/Shanghai",
        },
      };
      if (!(url.pathname in responses)) throw new Error("未模拟接口：" + url.pathname);
      return route.fulfill({ json: responses[url.pathname] });
    }
    const file = path.join("dist", url.pathname === "/" ? "index.html" : url.pathname);
    return route.fulfill({
      contentType: file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(file),
    });
  });
  await page.goto("http://cbg-run-records.test");
}

test("截图开关读取保存值，采集运行时仍可切换，保存失败保留旧值并可重试", async ({
  page,
}, testInfo) => {
  let enabled = false;
  let fail = false;
  let release: (() => void) | undefined;
  let wait: Promise<void> | undefined;
  const writes: boolean[] = [];
  await mount(page, async (route, pathname) => {
    if (pathname === "/api/runtime/settings")
      return route.fulfill({ json: { saveScreenshots: enabled } });
    if (pathname !== "/api/runtime/settings/save") throw new Error("非预期清理请求");
    writes.push(route.request().postDataJSON().saveScreenshots);
    if (wait) await wait;
    if (fail) return route.fulfill({ status: 500, json: { error: "模拟设置保存失败" } });
    enabled = route.request().postDataJSON().saveScreenshots;
    return route.fulfill({ json: { saveScreenshots: enabled } });
  });
  const toggle = page.getByRole("checkbox", { name: "保存过程截图" });
  await expect(page.getByRole("spinbutton", { name: "并发抓取数" })).toBeDisabled();
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  await toggle.click();
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  expect(writes).toEqual([true]);
  release!();
  await expect(toggle).toBeChecked();
  wait = undefined;
  await page.reload();
  await expect(toggle).toBeChecked();
  fail = true;
  await toggle.click();
  await expect(page.getByRole("alert")).toHaveText("模拟设置保存失败");
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  fail = false;
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(writes).toEqual([true, false, false]);
  await page
    .getByRole("group", { name: "运行记录设置" })
    .screenshot({ path: testInfo.outputPath("settings-off.png") });
});

test("清理先预览范围与保护数量，取消和Escape均不发送删除请求", async ({ page }, testInfo) => {
  let previews = 0;
  let clears = 0;
  await mount(page, async (route, pathname) => {
    if (pathname === "/api/runtime/settings")
      return route.fulfill({ json: { saveScreenshots: true } });
    if (pathname === "/api/logs/storage") {
      previews++;
      return route.fulfill({ json: preview });
    }
    clears++;
    throw new Error("取消不得清理");
  });
  const clean = page.getByRole("button", { name: "清理运行记录", exact: true });
  await clean.click();
  const dialog = page.getByRole("dialog", { name: "确认清理运行记录" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("3 个运行 · 25 个文件 · 1.0 MiB");
  await expect(dialog).toContainText("保留 1 个受保护运行");
  await expect(dialog).toContainText("全部商品资料和分析结果");
  await dialog.screenshot({ path: testInfo.outputPath("cleanup-preview.png") });
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).not.toBeVisible();
  await clean.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(previews).toBe(2);
  expect(clears).toBe(0);
});

test("清理只提交确认token，进行中防重复并显示实际释放空间和跳过数量", async ({ page }) => {
  let release: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bodies: unknown[] = [];
  await mount(page, async (route, pathname) => {
    if (pathname === "/api/runtime/settings")
      return route.fulfill({ json: { saveScreenshots: true } });
    if (pathname === "/api/logs/storage") return route.fulfill({ json: preview });
    expect(pathname).toBe("/api/logs/clear");
    bodies.push(route.request().postDataJSON());
    await wait;
    return route.fulfill({ json: { ...cleared, skippedRuns: ["became-active"] } });
  });
  await page.getByRole("button", { name: "清理运行记录", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "确认清理" }).click();
  await expect(dialog.getByRole("button", { name: "正在清理…" })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "取消" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(bodies).toEqual([{ token: preview.token }]);
  release!();
  await expect(dialog).not.toBeVisible();
  const controls = page.getByRole("group", { name: "运行记录设置" });
  await expect(controls).toContainText("已清理 3 个运行、25 个文件，释放 1.0 MiB");
  await expect(controls).toContainText("1 个运行受保护，已保留");
  await expect(controls.getByRole("button", { name: "清理运行记录", exact: true })).toBeEnabled();
});

test("预览和过期token失败均可重新预览，部分清理错误单列且不伪装全部成功", async ({ page }) => {
  let previewFails = true;
  let expired = true;
  let previews = 0;
  let clears = 0;
  await mount(page, async (route, pathname) => {
    if (pathname === "/api/runtime/settings")
      return route.fulfill({ json: { saveScreenshots: false } });
    if (pathname === "/api/logs/storage") {
      previews++;
      if (previewFails) return route.fulfill({ status: 500, json: { error: "模拟预览读取失败" } });
      return route.fulfill({ json: { ...preview, token: "preview-" + previews } });
    }
    clears++;
    expect(route.request().postDataJSON()).toEqual({ token: "preview-" + previews });
    if (expired) return route.fulfill({ status: 409, json: { error: "清理预览已过期" } });
    return route.fulfill({
      json: {
        ...cleared,
        removedRuns: 2,
        errors: [{ runId: "fixture-error", message: "模拟文件占用" }],
      },
    });
  });
  const clean = page.getByRole("button", { name: "清理运行记录", exact: true });
  await clean.click();
  await expect(page.getByRole("alert")).toContainText("模拟预览读取失败");
  expect(clears).toBe(0);
  previewFails = false;
  await clean.click();
  await page.getByRole("dialog").getByRole("button", { name: "确认清理" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "清理结果未确认（清理预览已过期）。请重新预览核对",
  );
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expired = false;
  await clean.click();
  await page.getByRole("dialog").getByRole("button", { name: "确认清理" }).click();
  await expect(page.getByRole("alert")).toContainText("部分记录未能清理：模拟文件占用");
  await expect(page.getByRole("group", { name: "运行记录设置" })).toContainText("已清理 2 个运行");
  expect(previews).toBe(3);
  expect(clears).toBe(2);
  await expect(clean).toBeEnabled();
});

test("初次截图设置读取失败可单独重试，未知状态不允许写入", async ({ page }) => {
  let reads = 0;
  await mount(page, async (route, pathname) => {
    expect(pathname).toBe("/api/runtime/settings");
    reads++;
    if (reads === 1) return route.fulfill({ status: 500, json: { error: "模拟设置读取失败" } });
    return route.fulfill({ json: { saveScreenshots: true } });
  });
  const toggle = page.getByRole("checkbox", { name: "保存过程截图" });
  await expect(page.getByRole("alert")).toContainText("模拟设置读取失败");
  await expect(toggle).toBeDisabled();
  await page.getByRole("button", { name: "重试读取截图设置" }).click();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
  expect(reads).toBe(2);
});

test("清理响应中断时结果保留未确认，重新预览不自动再次删除", async ({ page }) => {
  let previews = 0;
  let clears = 0;
  await mount(page, async (route, pathname) => {
    if (pathname === "/api/runtime/settings")
      return route.fulfill({ json: { saveScreenshots: false } });
    if (pathname === "/api/logs/storage") {
      previews++;
      return route.fulfill({ json: { ...preview, token: "preview-" + previews } });
    }
    clears++;
    return route.abort("connectionclosed");
  });
  const clean = page.getByRole("button", { name: "清理运行记录", exact: true });
  await clean.click();
  await page.getByRole("dialog").getByRole("button", { name: "确认清理" }).click();
  await expect(page.getByRole("alert")).toContainText("清理结果未确认");
  await expect(page.getByRole("alert")).toContainText("请重新预览核对");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await clean.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(previews).toBe(2);
  expect(clears).toBe(1);
});
