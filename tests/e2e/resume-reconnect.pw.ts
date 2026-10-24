import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { CrawlStatus } from "../../server/crawler/types";
import { browserStatus } from "../fixtures/saved-role";

for (const cancel of [false, true]) {
  test(`重启后断点续采：连接失败可重试，${cancel ? "取消等待后不自动采集" : "恢复后自动采集一次"}`, async ({
    page,
    context,
  }) => {
    let opened = false,
      allowReady = false,
      failConnection = true,
      openCalls = 0,
      startCalls = 0;
    const idle = {
      connected: false,
      loginStatus: "unknown",
      title: "",
      url: "",
      serverName: "未连接",
      isLoggedIn: false,
      needLogin: false,
      step: "idle",
      workflowStep: "idle",
      running: false,
      message: "点击开始，在本页扫码并进入角色列表。",
    };
    const status: CrawlStatus = {
      running: false,
      phase: "idle",
      message: "查询角色列表后，可开始采集或继续上次任务。",
      page: 0,
      totalPages: 0,
      saved: 0,
      skipped: 0,
      totalSaved: 4,
      database: "mock.sqlite",
      checkpoint: {
        key: "367:saved-role",
        time: "2026-10-23T01:00:00.000Z",
        order: "expire_time DESC",
        page: 3,
        savedAt: "2026-10-23T01:00:00.000Z",
      },
    };
    const browser = () =>
      !opened
        ? idle
        : failConnection
          ? {
              ...idle,
              workflowStep: "error",
              error: { code: "CBG_CONNECTING", message: "模拟 Chrome 暂未连接" },
            }
          : allowReady
            ? browserStatus
            : { ...idle, running: true, workflowStep: "connecting", message: "正在恢复连接" };
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      // 只访问本地构建与固定模拟接口，不连接日常 Chrome 或真实官网。
      if (url.origin !== "http://resume-ui.test") return route.abort();
      if (url.pathname.startsWith("/api/")) {
        let body: unknown;
        switch (url.pathname) {
          case "/api/browser/status":
            body = browser();
            break;
          case "/api/browser/open":
            opened = true;
            openCalls++;
            body = browser();
            break;
          case "/api/crawl/settings":
            body = { analyzeEquipment: false };
            break;
          case "/api/crawl/status":
            body = status;
            break;
          case "/api/crawl/records":
            body = { page: 1, pageSize: 20, total: 0, totalPages: 1, items: [] };
            break;
          case "/api/crawl/start":
            expect(allowReady).toBe(true);
            expect(failConnection).toBe(false);
            expect(route.request().postDataJSON()).toEqual({ concurrency: 10 });
            startCalls++;
            Object.assign(status, {
              running: true,
              phase: "collecting",
              page: 3,
              totalPages: 100,
              message: "已恢复第3页采集",
            });
            body = status;
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
              message: "未启用",
              timezone: "Asia/Shanghai",
            };
            break;
          default:
            throw new Error("未模拟接口：" + url.pathname);
        }
        return route.fulfill({ json: body });
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
    await page.goto("http://resume-ui.test/");
    const resume = page.getByRole("button", { name: "继续采集 / 检查新增", exact: true });
    await expect(resume).toBeEnabled();
    await resume.click();
    await expect(page.getByRole("alert")).toHaveText("模拟 Chrome 暂未连接");
    expect(startCalls).toBe(0);
    await expect(resume).toBeEnabled();
    failConnection = false;
    await resume.click();
    await expect(page.getByText(/正在恢复 Chrome 连接和角色列表/)).toBeVisible();
    expect(startCalls).toBe(0);
    await expect(page.getByRole("button", { name: "取消继续采集", exact: true })).toBeEnabled();
    if (cancel) await page.getByRole("button", { name: "取消继续采集", exact: true }).click();
    allowReady = true;
    if (cancel) {
      await expect(page.locator(".status-header-row strong")).toHaveText("角色列表已就绪");
      expect(startCalls).toBe(0);
      await resume.click();
    }
    await expect(page.getByText("已恢复第3页采集", { exact: true })).toBeVisible();
    await expect(resume).toBeDisabled();
    expect(openCalls).toBe(2);
    expect(startCalls).toBe(1);
    expect(status.totalSaved).toBe(4);
    expect(status.checkpoint?.key).toBe("367:saved-role");
  });
}
