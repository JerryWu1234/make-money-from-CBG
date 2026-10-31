import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import type { SavedRoleRecord } from "../../server/crawler/types";
import { analysisRecord, analysisResponse } from "../fixtures/analysis";

// Failure cases: hidden lists still load; a pending tab shows an empty result;
// each keystroke issues a search; pagination changes; compact lists lose detail;
// the light workspace or its narrow layout becomes unreadable or overflows;
// configuration and maintenance push the first result below the desktop viewport.
test("浅色工作台按页签加载、合并搜索请求并保留分页和完整详情", async ({
  page,
  browser,
}, testInfo) => {
  const crawl = new CrawlStore(":memory:");
  const keys = Array.from({ length: 42 }, (_, index) => `ui-${String(index).padStart(3, "0")}`);
  for (const key of keys) {
    const record = analysisRecord(key);
    crawl.observe(record.listing);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
  }
  const store = new AnalysisStore(crawl.db);
  const runId = store.createRun("codex", "ui-fixture", true);
  keys.forEach((key, index) => {
    const record = crawl.detail(key) as SavedRoleRecord;
    crawl.db
      .prepare(
        "UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=? WHERE listing_key=?",
      )
      .run(
        JSON.stringify({ ...analysisResponse(record), score: 80 }),
        new Date(Date.UTC(2026, 9, 29, 8, 0, index)).toISOString(),
        key,
      );
  });
  crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(runId);
  const calls: Array<{
    includeRecords: boolean;
    includeResults: boolean;
    includeRanking: boolean;
    search: string;
    records: number;
    results: number;
    bytes: number;
  }> = [];
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  let holdAll = true;
  let pendingAll = false;
  let releaseAll!: () => void;
  const delayedAll = new Promise<void>((resolve) => {
    releaseAll = resolve;
  });
  // Real build and SQLite stores; fixture transport blocks every external origin.
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://workspace-ui.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      switch (url.pathname) {
        case "/api/ai/status":
          return route.fulfill({
            json: { codex: { state: "configured" }, deepseek: { state: "unconfigured" } },
          });
        case "/api/ai/models":
          return route.fulfill({
            json: {
              provider: "codex",
              defaultModel: "ui-fixture",
              models: [{ id: "ui-fixture", name: "模拟模型" }],
            },
          });
        case "/api/analysis/progress":
          return route.fulfill({ json: store.progress({ provider: "codex", scope: "complete" }) });
        case "/api/analysis/status": {
          const flags = {
            includeRecords: url.searchParams.get("includeRecords") === "true",
            includeResults: url.searchParams.get("includeResults") === "true",
            includeRanking: url.searchParams.get("includeRanking") === "true",
          };
          if (holdAll && flags.includeRecords) {
            pendingAll = true;
            await delayedAll;
          }
          const body = store.overview({
            provider: "codex",
            scope: "complete",
            summary: true,
            page: Number(url.searchParams.get("page") || 1),
            resultsPage: Number(url.searchParams.get("resultsPage") || 1),
            rankingPage: Number(url.searchParams.get("rankingPage") || 1),
            search: url.searchParams.get("search") || undefined,
            filter: url.searchParams.get("filter") || undefined,
            ...flags,
          });
          calls.push({
            ...flags,
            search: url.searchParams.get("search") || "",
            records: body.records.items.length,
            results: body.results.items.length,
            bytes: Buffer.byteLength(JSON.stringify(body)),
          });
          return route.fulfill({ json: body });
        }
        case "/api/analysis/detail":
          return route.fulfill({ json: store.detail(url.searchParams.get("taskId")!) });
        default:
          throw new Error(`未模拟接口：${url.pathname}`);
      }
    }
    const filename = path.join(
      "dist",
      url.pathname === "/analysis-preview" ? "index.html" : url.pathname,
    );
    return route.fulfill({
      contentType: filename.endsWith(".js")
        ? "application/javascript"
        : filename.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(filename),
    });
  });

  try {
    await page.goto("http://workspace-ui.test/analysis-preview");
    const history = page.getByRole("tabpanel", { name: "分析记录", exact: true });
    await expect(history.getByRole("article")).toHaveCount(20);
    expect(calls.at(-1)).toMatchObject({
      includeRecords: false,
      includeResults: true,
      includeRanking: false,
      records: 0,
      results: 20,
    });
    const desktopLayout = await page.evaluate(() => ({
      viewport: window.innerHeight,
      firstResultTop:
        document.querySelector(".analysis-result-row")!.getBoundingClientRect().top + scrollY,
    }));
    expect(desktopLayout.firstResultTop).toBeLessThan(desktopLayout.viewport - 40);
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(
      background
        .match(/\d+/g)!
        .slice(0, 3)
        .map(Number)
        .reduce((sum, channel) => sum + channel, 0),
    ).toBeGreaterThan(650);
    await page.screenshot({ path: testInfo.outputPath("workspace-overview.png") });
    await page.screenshot({
      path: testInfo.outputPath("workspace-history-desktop.png"),
      fullPage: true,
    });
    await history
      .getByRole("button", { name: /查看分析详情/ })
      .first()
      .click();
    const detail = page.getByRole("dialog", { name: "角色ui-041", exact: true });
    await expect(detail.getByRole("heading", { name: "评分字段依据" })).toBeVisible();
    await detail.getByText("查看完整商品原文", { exact: true }).click();
    await expect(
      detail.locator("details").filter({ hasText: "查看完整商品原文" }).locator("pre"),
    ).toContainText("宝宝8");
    await page.screenshot({ path: testInfo.outputPath("workspace-full-detail.png") });
    await page.keyboard.press("Escape");

    await page.getByRole("tab", { name: /^全部商品/ }).click();
    await expect.poll(() => pendingAll).toBe(true);
    await expect(page.getByRole("status").filter({ hasText: "正在加载商品记录" })).toHaveCount(1);
    await expect(page.getByText("没有符合条件的商品", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("searchbox", { name: "搜索商品" })).toBeVisible();
    holdAll = false;
    releaseAll();
    const all = page.getByRole("tabpanel", { name: "全部商品", exact: true });
    await expect(all.locator("tbody tr")).toHaveCount(20);
    expect(calls.at(-1)).toMatchObject({
      includeRecords: true,
      includeResults: false,
      includeRanking: false,
      records: 20,
      results: 0,
    });
    await all.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(all).toContainText("第 2 / 3 页");
    await expect(all.locator("tbody tr")).toHaveCount(20);
    await expect(all.locator("tbody tr").first()).toContainText("角色ui-020");
    await all.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(all.locator("tbody tr")).toHaveCount(2);
    await expect(all).toContainText("第 3 / 3 页");

    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const search = page.getByRole("searchbox", { name: "搜索商品" });
    await search.fill("角");
    await page.clock.runFor(50);
    await search.fill("角色");
    await page.clock.runFor(50);
    await search.fill("角色ui-041");
    await page.clock.runFor(249);
    expect(calls.filter((call) => call.search)).toHaveLength(0);
    await page.clock.runFor(50);
    await expect(all.locator("tbody tr")).toHaveCount(1);
    await expect(all.locator("tbody tr").first()).toContainText("角色ui-041");
    expect(calls.filter((call) => call.search).map((call) => call.search)).toEqual(["角色ui-041"]);
    await page.clock.resume();
    await search.fill("");
    await expect(all.locator("tbody tr")).toHaveCount(20);
    await expect(all).toContainText("第 1 / 3 页");
    await page.screenshot({
      path: testInfo.outputPath("workspace-all-desktop.png"),
      fullPage: true,
    });
    await page.getByRole("tab", { name: /^推荐榜/ }).click();
    await expect(page.getByText("暂无可排序的结果", { exact: true })).toBeVisible();
    expect(calls.at(-1)).toMatchObject({
      includeRecords: false,
      includeResults: false,
      includeRanking: true,
      records: 0,
      results: 0,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: /^全部商品/ }).click();
    await expect(all.locator("tbody tr")).toHaveCount(20);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("workspace-mobile.png") });
    await page.screenshot({
      path: testInfo.outputPath("workspace-all-mobile.png"),
      fullPage: true,
    });
    expect(pageErrors).toEqual([]);
    const evidence = {
      repeat:
        "vp run build && vp exec playwright test tests/e2e/analysis-loading.pw.ts --workers=1",
      browser: browser.version(),
      desktopLayout,
      rows: keys.length,
      source:
        "actual built UI and in-memory SQLite; fixture API transport; all other origins blocked",
      checks: [
        "only the selected tab loads list items",
        "a pending tab shows loading instead of an empty result",
        "three edits make one debounced search request",
        "pagination stays 20/20/2 and search resets to page one",
        "full source evidence remains available on detail open",
        "light desktop and 390px mobile layout",
      ],
      limits: ["42 synthetic roles", "no real AI call, collection, login or database used"],
      calls,
      pageErrors,
    };
    const evidencePath = testInfo.outputPath("workspace-loading-evidence.json");
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
    await testInfo.attach("workspace-loading-evidence", {
      path: evidencePath,
      contentType: "application/json",
    });
  } finally {
    releaseAll();
    await page.unrouteAll({ behavior: "wait" });
    crawl.close();
  }
});
