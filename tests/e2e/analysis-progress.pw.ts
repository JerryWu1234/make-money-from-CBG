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
