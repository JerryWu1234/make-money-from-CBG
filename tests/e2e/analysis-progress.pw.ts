import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { AnalysisRun } from "../../server/analysis/types";

test("商品记录尚未返回时先显示实时进度，旧记录响应不能覆盖新进度", async ({ page }, testInfo) => {
  let completed = 3,
    progressCalls = 0,
    recordCalls = 0;
  let release!: () => void;
  const records = new Promise<void>((resolve) => {
    release = resolve;
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
        await records;
        return route.fulfill({
          json: {
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
    release();
    await expect(loading).toHaveCount(0);
    await expect(current).toHaveText("6 / 20");
    await page.screenshot({
      path: testInfo.outputPath("live-progress-before-records.png"),
      fullPage: true,
    });
  } finally {
    release();
  }
});
