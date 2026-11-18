import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { browserStatus, crawlStatus } from "../fixtures/saved-role";

for (const failed of [false, true]) {
  test(`产品页面移除官网访问保护面板，原有状态仍可使用：${failed ? "错误" : "就绪"}`, async ({
    page,
  }) => {
    const accessRequests: string[] = [];
    const browserMessage = "登录失效，请重新扫码登录";
    const crawlMessage = "采集已暂停：页面要求安全验证";
    const overview = {
      counts: { total: 0, complete: 0, waitingDetail: 0, pendingDetail: 0, failedDetail: 0 },
      captureActivity: { running: false, phase: "idle" },
      run: null,
      activeRun: null,
      runs: [],
      ranking: [],
      history: [],
      rankingPagination: { page: 1, totalPages: 1, total: 0 },
      records: { page: 1, totalPages: 1, total: 0, items: [] },
      results: { page: 1, totalPages: 1, total: 0, items: [] },
    };
    // Built product pages only; all requests stay inside this isolated mock API.
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://access-ui.test") return route.abort();
      if (url.pathname.startsWith("/api/access/")) {
        accessRequests.push(url.pathname);
        return route.fulfill({ status: 410, json: { error: "产品页面不再挂载访问保护面板" } });
      }
      if (url.pathname.startsWith("/api/")) {
        const responses: Record<string, unknown> = {
          "/api/browser/status": failed
            ? {
                ...browserStatus,
                workflowStep: "error",
                isLoggedIn: false,
                loginStatus: "not_logged_in",
                message: browserMessage,
                error: { code: "LOGIN_REQUIRED", message: browserMessage },
              }
            : browserStatus,
          "/api/browser/settings": {
            mode: "dedicated",
            accessAdapter: "playwright",
            connected: true,
            busy: false,
          },
          "/api/runtime/settings": { saveScreenshots: false },
          "/api/crawl/settings": { analyzeEquipment: false },
          "/api/crawl/status": failed
            ? { ...crawlStatus(false, false), phase: "error", message: crawlMessage }
            : crawlStatus(false, false),
          "/api/crawl/records": { page: 1, total: 0, totalPages: 1, items: [] },
          "/api/crawl/head-refresh": { intervalSeconds: 60, random: false, listingAgeMinutes: 10 },
          "/api/crawl/role-training-filter": { minTotal: null },
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
          "/api/analysis/progress": overview,
          "/api/analysis/status": overview,
          "/api/ai/status": {
            codex: { state: "unconfigured" },
            deepseek: { state: "unconfigured" },
          },
          "/api/ai/models": { provider: "codex", defaultModel: null, models: [] },
        };
        if (!(url.pathname in responses)) throw new Error("未模拟接口：" + url.pathname);
        return route.fulfill({ json: responses[url.pathname] });
      }
      const file = path.join(
        "dist",
        url.pathname === "/" || url.pathname === "/analysis-preview" ? "index.html" : url.pathname,
      );
      return route.fulfill({
        contentType: file.endsWith(".js")
          ? "application/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
        body: await readFile(file),
      });
    });

    await page.goto("http://access-ui.test");
    await expect(page.getByRole("heading", { name: "藏宝阁角色查询", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "浏览器运行方式", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "详情采集与续采", exact: true })).toBeVisible();
    if (failed) {
      await expect(page.locator(".status-box")).toContainText(browserMessage);
      await expect(page.getByRole("alert").filter({ hasText: crawlMessage })).toBeVisible();
    } else {
      await expect(page.locator(".status-box")).toContainText("角色列表已就绪");
    }
    for (const pathname of ["/", "/analysis-preview"]) {
      if (pathname !== "/") {
        await page.getByRole("link", { name: "商品分析", exact: true }).click();
        await expect(page.getByRole("heading", { name: "商品分析", exact: true })).toBeVisible();
      }
      await expect(page.getByRole("region", { name: "官网访问保护" })).toHaveCount(0);
      await expect(page.getByText("官网访问保护", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "立即停止官网动作" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "打开人工处理页面" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "核验页面并人工继续" })).toHaveCount(0);
      await expect(page.getByText("访问节奏与诊断设置", { exact: true })).toHaveCount(0);
      await expect(page.getByLabel("我已在绑定页面处理全部暂停原因", { exact: false })).toHaveCount(
        0,
      );
      await expect(page.getByText(/当前最小动作间隔/)).toHaveCount(0);
    }
    expect(accessRequests).toEqual([]);
  });
}
