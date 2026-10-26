import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { AnalysisRun } from "../../server/analysis/types";

test("商品记录尚未返回时先显示实时进度，旧记录响应不能覆盖新进度", async ({ page }, testInfo) => {
  let completed = 3,
    progressCalls = 0,
    recordCalls = 0;
  let release!: () => void;
  let releaseRanking!: () => void;
  let rateLimit: AnalysisRun["rateLimit"] = null;
  const records = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ranking = new Promise<void>((resolve) => {
    releaseRanking = resolve;
  });
  const run = (count: number): AnalysisRun => ({
    id: "progress-fixture",
    provider: "codex",
    model: "fixture-model",
    ruleVersion: "role-valuation-v1",
    status: "running",
    createdAt: "2026-10-25T14:00:00Z",
    updatedAt: new Date().toISOString(),
    error: null,
    total: 20,
    completed: count,
    failed: 0,
    queued: 10 - count,
    reused: 0,
    current: "fixture-role",
    currentItems: ["fixture-role"],
    runningCount: 10,
    concurrency: 10,
    phase: "analysis",
    rateLimit,
  });
  const counts = { total: 20, complete: 20, waitingDetail: 0, pendingDetail: 0, failedDetail: 0 };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://analysis-progress.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      if (url.pathname === "/api/ai/status")
        return route.fulfill({
          json: { codex: { state: "configured" }, deepseek: { state: "unconfigured" } },
        });
      if (url.pathname === "/api/ai/models")
        return route.fulfill({
          json: {
            provider: "codex",
            defaultModel: "fixture-model",
            models: [{ id: "fixture-model", name: "模拟模型" }],
          },
        });
      if (url.pathname === "/api/analysis/progress") {
        progressCalls++;
        return route.fulfill({ json: { counts, run: run(completed), activeRun: run(completed) } });
      }
      if (url.pathname === "/api/analysis/status") {
        recordCalls++;
        const includeRanking = url.searchParams.get("includeRanking") === "true";
        await (includeRanking ? ranking : records);
        return route.fulfill({
          json: {
            ...(includeRanking ? {} : { rankingDeferred: true }),
            counts,
            run: run(3),
            activeRun: run(3),
            runs: [],
            ranking: [],
            history: [],
            records: { page: 1, totalPages: 1, total: 0, items: [] },
            results: { page: 1, totalPages: 1, total: 0, items: [] },
          },
        });
      }
      throw new Error("未模拟接口：" + url.pathname);
    }
    const file = path.join(
      "dist",
      url.pathname === "/analysis-preview" ? "index.html" : url.pathname,
    );
    return route.fulfill({
      body: await readFile(file),
      contentType: file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
  });
  try {
    await page.goto("http://analysis-progress.test/analysis-preview");
    const current = page.locator(".analysis-current strong");
    await expect(current).toHaveText("3 / 20");
    const loading = page.getByRole("status").filter({ hasText: "正在加载商品记录" });
    await expect(loading).toHaveCount(1);
    completed = 6;
    await expect(current).toHaveText("6 / 20", { timeout: 5000 });
    expect(progressCalls).toBeGreaterThan(1);
    expect(recordCalls).toBe(1);
    rateLimit = { retryAt: Date.now() + 60_000, concurrency: 1, rounds: 1 };
    const cooling = page.getByRole("status", { name: "AI限流恢复状态" });
    await expect(cooling).toContainText("AI 服务限流冷却中");
    await expect(cooling).toContainText("模型请求恢复并发上限：1");
    await expect(page.locator(".analysis-visual-focus strong")).toHaveText("限流冷却中");
    await expect(page.getByRole("spinbutton", { name: "分析并发数" })).toHaveValue("10");
    await page.screenshot({ path: testInfo.outputPath("rate-limit-cooling.png"), fullPage: true });
    rateLimit = { retryAt: 0, concurrency: 2, rounds: 0 };
    await expect(cooling).toContainText("AI 服务正在降速恢复");
    await expect(cooling).toContainText("模型请求恢复并发上限：2");
    await expect(page.locator(".analysis-visual-focus strong")).toHaveText("降速恢复中");
    rateLimit = null;
    await expect(cooling).toHaveCount(0);
    const initialRecords = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        url.pathname === "/api/analysis/status" &&
        url.searchParams.get("includeRanking") === "false"
      );
    });
    release();
    await initialRecords;
    await expect(loading).toHaveCount(0);
    await expect(current).toHaveText("6 / 20");
    await page.getByRole("tab", { name: "推荐榜" }).click();
    await expect(page.getByRole("status").filter({ hasText: "正在加载推荐榜" })).toHaveCount(1);
    await expect(page.getByText("暂无符合推荐条件的商品")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "推荐榜" })).toHaveText("推荐榜");
    releaseRanking();
    await expect(page.getByRole("status").filter({ hasText: "正在加载推荐榜" })).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "推荐榜 0" })).toHaveCount(1);
    await page.screenshot({
      path: testInfo.outputPath("live-progress-before-records.png"),
      fullPage: true,
    });
  } finally {
    release();
    releaseRanking();
  }
});
