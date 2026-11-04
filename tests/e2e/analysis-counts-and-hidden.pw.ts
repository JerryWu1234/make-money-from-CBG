import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { AnalysisOverview, AnalysisRun } from "../../server/analysis/types";
import { buildProductDocument } from "../../server/analysis/product-document";
import { analysisRecord, analysisResponse } from "../fixtures/analysis";

// Failure cases: a batch total replaces the global result count; local reuse is
// counted as fresh AI work; recalculation is presented as a new AI response; an
// all-hidden ranking is called ineligible; showing hidden items loses counts or
// detail return state; reload restores inconsistent counts; or a missing current
// run hides historical results. All HTTP, roles, totals and AI results below are
// fixtures. External origins and mutation requests are blocked.
const origin = "http://analysis-counts.test";
const timestamp = "2026-11-04T05:38:52.000Z";
const run: AnalysisRun = {
  id: "counts-fixture-run",
  provider: "codex",
  model: "fixture-model",
  ruleVersion: "role-valuation-v1",
  status: "paused",
  createdAt: "2026-11-04T05:30:09.000Z",
  updatedAt: timestamp,
  error: null,
  total: 826,
  completed: 749,
  reused: 710,
  queued: 77,
  failed: 0,
  waitingPricing: 0,
  current: null,
  runningCount: 0,
  concurrency: 10,
};

async function fixture(page: Page, eligibleTotal: number, currentRun: AnalysisRun | null = run) {
  const roles = Array.from({ length: 17 }, (_, index) =>
    analysisRecord(`hidden-${String(index + 1).padStart(2, "0")}`),
  );
  const calls: Array<{ pathname: string; showViewed: boolean; method: string }> = [];
  const counts = { total: 912, complete: 912, waitingDetail: 0, pendingDetail: 0, failedDetail: 0 };
  const profile: NonNullable<AnalysisOverview["profile"]> = {
    hash: "fixture-profile",
    version: "role-valuation-v1",
    promptHash: "fixture-prompt-hash",
    calculationCompatible: true,
    calculationVersion: "price-comparison-v39",
    equipmentSearch: false,
    petSearch: false,
  };
  const results = roles.slice(0, 2).map((record, index) => ({
    taskId: `task-${index + 1}`,
    name: record.listing.name,
    server: record.listing.serverName || record.listing.serverId,
    price: record.listing.price,
    provider: "codex" as const,
    model: "fixture-model",
    completedAt: timestamp,
    stale: false,
    profileHash: null,
    profileChanged: false,
    reused: index === 0,
    result: { ...analysisResponse(record), score: 80 },
  }));
  const ranking = roles.map((record, index) => ({
    key: record.listing.key,
    name: record.listing.name,
    server: record.listing.serverName || record.listing.serverId,
    price: record.listing.price,
    url: record.listing.url,
    collectedAt: record.detail!.collectedAt,
    collectionStatus: "complete",
    state: "completed" as const,
    taskId: `task-${index + 1}`,
    score: 80,
    summary: "模拟推荐，仅用于验证隐藏状态与计数。",
    highlights: [],
    error: null,
    recommendationViewed: true,
    recommendation: { status: "recommended" as const, gap: -100, factors: [], strongerFactors: [] },
  }));
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname.startsWith("/api/")) {
      calls.push({
        pathname: url.pathname,
        showViewed: url.searchParams.get("showViewed") === "true",
        method: request.method(),
      });
      if (request.method() !== "GET") throw new Error("本旅程不应提交修改：" + url.pathname);
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
      if (url.pathname === "/api/analysis/progress")
        return route.fulfill({ json: { counts, profile, run: currentRun, activeRun: null } });
      if (url.pathname === "/api/analysis/status") {
        const includeRanking = url.searchParams.get("includeRanking") === "true";
        const includeResults = url.searchParams.get("includeResults") === "true";
        const showViewed = url.searchParams.get("showViewed") === "true";
        const visible = showViewed ? ranking.slice(0, eligibleTotal) : [];
        const rankingPagination = {
          page: 1,
          totalPages: 1,
          total: visible.length,
          eligibleTotal,
          hiddenTotal: eligibleTotal,
        };
        const overview: AnalysisOverview = {
          ...(includeRanking ? {} : { rankingDeferred: true }),
          counts,
          profile,
          run: currentRun,
          activeRun: null,
          runs: currentRun ? [currentRun] : [],
          ranking: includeRanking ? visible : [],
          rankingPagination,
          records: { page: 1, totalPages: 46, total: 912, items: [] },
          results: { page: 1, totalPages: 42, total: 836, items: includeResults ? results : [] },
          history: [],
        };
        return route.fulfill({ json: overview });
      }
      if (url.pathname === "/api/analysis/detail") {
        const taskId = url.searchParams.get("taskId")!;
        const index = Number(taskId.replace("task-", "")) - 1;
        const record = roles[index];
        const document = buildProductDocument(record);
        return route.fulfill({
          json: {
            taskId,
            runId: run.id,
            provider: "codex",
            model: "fixture-model",
            ruleVersion: run.ruleVersion,
            listing: record.listing,
            state: "completed",
            inputHash: document.contentHash,
            inputText: document.text,
            promptHash: "fixture-prompt-hash",
            promptText: "模拟请求，未调用 AI。",
            result: { ...analysisResponse(record), score: 80 },
            completedAt: timestamp,
            error: null,
            reusedFrom: index === 0 ? "original-fixture-task" : null,
            attempts: [],
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
  return { calls, roles };
}

async function evidence(testInfo: TestInfo, calls: unknown, checks: string[]) {
  await writeFile(
    testInfo.outputPath("evidence.json"),
    JSON.stringify(
      {
        fixture: true,
        scope:
          "Production built UI with fixture HTTP, role records and AI results; no live service or user database",
        global: { completeGoods: 912, goodsWithResults: 836 },
        batch: { total: 826, completed: 749, reused: 710, aiCompleted: 39, aiTotal: 116 },
        checks,
        calls,
        repeat:
          "vp run build && vp exec playwright test tests/e2e/analysis-counts-and-hidden.pw.ts --workers=1 --trace=on",
      },
      null,
      2,
    ),
  );
}

async function assertGlobalCounts(page: Page) {
  await expect(page.getByRole("tab", { name: "全部商品 912", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "分析记录 836", exact: true })).toBeVisible();
  await expect(page.getByLabel("分析页面概览")).toContainText("836 件已有结果");
}

test("历史结果与本轮AI计数分开：查看详情→全隐藏提示→显示17件→返回→关闭→刷新", async ({
  page,
}, testInfo) => {
  const { calls, roles } = await fixture(page, 17);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(origin + "/analysis-preview");
  await assertGlobalCounts(page);
  const current = page.locator(".analysis-current");
  await expect(current).toContainText("本轮 AI 分析完成");
  await expect(current.locator("strong")).toHaveText("39 / 116");
  await expect(current).toContainText("已复用 710 件结果（未调用 AI）");
  const history = page.getByRole("tabpanel", { name: "分析记录", exact: true });
  await expect(history.getByRole("article")).toHaveCount(2);
  await expect(history.getByRole("article").nth(0)).toContainText("本地复用/复算");
  await expect(history.getByRole("article").nth(1)).toContainText("AI 分析");
  await history
    .getByRole("button", { name: `查看分析详情：${roles[0].listing.name}`, exact: true })
    .click();
  const detail = page.getByRole("dialog", { name: roles[0].listing.name, exact: true });
  await expect(detail).toContainText("复用已有结论");
  await detail.getByRole("button", { name: "关闭分析详情" }).click();
  await expect(detail).not.toBeVisible();
  await expect(history.getByRole("article")).toHaveCount(2);
  await page.screenshot({ path: testInfo.outputPath("A1-counts-and-reuse.png"), fullPage: true });

  await page.getByRole("tab", { name: "推荐榜" }).click();
  const recommendations = page.getByRole("tabpanel", { name: "推荐榜", exact: true });
  await expect(recommendations).toContainText("17 件推荐已隐藏");
  await expect(recommendations).toContainText("显示已隐藏的推荐");
  await expect(recommendations).toContainText("已有 836 件分析结果");
  await expect(recommendations).not.toContainText("已有 749 件分析结果");
  await expect(recommendations.getByText("暂无符合推荐条件的商品", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "推荐榜 0", exact: true })).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("A2-all-recommendations-hidden.png"),
    fullPage: true,
  });

  await recommendations.getByRole("checkbox", { name: "显示已隐藏的推荐", exact: true }).check();
  await expect(recommendations.getByRole("article")).toHaveCount(17);
  await expect(page.getByRole("tab", { name: "推荐榜 17", exact: true })).toBeVisible();
  const first = recommendations.getByRole("article").nth(0);
  await expect(first.getByRole("button", { name: "已隐藏", exact: true })).toBeDisabled();
  await first.getByRole("button", { name: "查看分析依据 →", exact: true }).click();
  await expect(detail).toBeVisible();
  await page.getByRole("button", { name: "关闭分析详情" }).click();
  await expect(recommendations.getByRole("article")).toHaveCount(17);
  await expect(recommendations.getByRole("checkbox", { name: "显示已隐藏的推荐" })).toBeChecked();
  await page.screenshot({
    path: testInfo.outputPath("A2-shown-hidden-recommendations.png"),
    fullPage: true,
  });
  await recommendations.getByRole("checkbox", { name: "显示已隐藏的推荐" }).uncheck();
  await expect(recommendations).toContainText("17 件推荐已隐藏");
  await page.reload();
  await assertGlobalCounts(page);
  await expect(current.locator("strong")).toHaveText("39 / 116");
  await page.getByRole("tab", { name: "推荐榜" }).click();
  await expect(recommendations).toContainText("17 件推荐已隐藏");
  await expect(recommendations).toContainText("已有 836 件分析结果");
  expect(calls.every((call) => call.method === "GET")).toBe(true);
  expect(calls.some((call) => call.pathname === "/api/analysis/status" && call.showViewed)).toBe(
    true,
  );
  expect(pageErrors).toEqual([]);
  await evidence(testInfo, calls, [
    "All global result counters stay 836 while current AI progress is 39/116",
    "710 local results are labelled as reuse, not AI work",
    "All 17 eligible recommendations are hidden; toggling reveals them and detail close returns correctly",
    "Reload preserves consistent counters and hidden-state explanation",
    "No mutation, real database, real website or AI call",
  ]);
});

test("没有当前批次但有历史836件结果时，仅真正无推荐才显示无符合条件", async ({
  page,
}, testInfo) => {
  const { calls } = await fixture(page, 0, null);
  await page.goto(origin + "/analysis-preview");
  await assertGlobalCounts(page);
  await page.getByRole("tab", { name: "推荐榜" }).click();
  const recommendations = page.getByRole("tabpanel", { name: "推荐榜", exact: true });
  await expect(recommendations).toContainText("暂无符合推荐条件的商品");
  await expect(recommendations).toContainText("已有 836 件分析结果");
  await expect(recommendations.getByText("暂无分析结果", { exact: true })).toHaveCount(0);
  await recommendations.getByRole("checkbox", { name: "显示已隐藏的推荐" }).check();
  await expect(recommendations.getByRole("article")).toHaveCount(0);
  await expect(recommendations).toContainText("暂无符合推荐条件的商品");
  await page.reload();
  await assertGlobalCounts(page);
  await page.getByRole("tab", { name: "推荐榜" }).click();
  await expect(recommendations).toContainText("已有 836 件分析结果");
  await page.screenshot({
    path: testInfo.outputPath("A2-no-eligible-with-history.png"),
    fullPage: true,
  });
  await evidence(testInfo, calls, [
    "Historical result count remains available without a current run",
    "Zero eligible and zero hidden recommendations uses the no-eligible state",
    "No-results empty state is not shown for 836 saved results",
    "Show-hidden and reload keep the same count semantics",
  ]);
});
