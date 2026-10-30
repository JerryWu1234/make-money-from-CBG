import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import type { SavedRoleRecord } from "../../server/crawler/types";
import { AnalysisStore } from "../../server/analysis/store";
import { analysisRecord, analysisResponse } from "../fixtures/analysis";

// Failure cases: opening collection closes the analysis; a top-layer close also closes the
// analysis; expanded calls, scroll, focus or the list page are lost; body scrolling unlocks
// too early; or a direct collection entry incorrectly returns to an analysis.
test("分析记录第二页→调用记录→当前采集资料→三种关闭方式返回原详情→直接查看资料", async ({
  page,
}, testInfo) => {
  const crawl = new CrawlStore(":memory:");
  const store = new AnalysisStore(crawl.db);
  const keys = Array.from({ length: 21 }, (_, index) => `drawer-${index + 1}`);
  for (const key of keys) {
    const record = analysisRecord(key);
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
  }
  const runId = store.createRun("codex", "fixture-model", true);
  const completedAt = new Date().toISOString();
  for (const key of keys) {
    const record = crawl.detail(key) as SavedRoleRecord;
    const task = crawl.db.prepare("SELECT id FROM analysis_tasks WHERE listing_key=?").get(key)!;
    crawl.db
      .prepare(
        "UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=? WHERE id=?",
      )
      .run(JSON.stringify(analysisResponse(record)), completedAt, task.id);
    crawl.db
      .prepare(
        "INSERT INTO analysis_attempts(id,task_id,state,created_at,finished_at,raw_response) VALUES(?,?,'completed',?,?,?)",
      )
      .run(
        `attempt-${key}`,
        task.id,
        completedAt,
        completedAt,
        "【模拟调用回复，仅验证页面返回】\n" + "已保存的调用证据。\n".repeat(80),
      );
  }
  crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(runId);
  const directRecord = analysisRecord("without-analysis");
  crawl.observe(directRecord.listing);
  crawl.save(directRecord.listing, directRecord.detail!);
  const expected = store.overview({ resultsPage: 2 }).results.items[0];
  const expectedKey = store.detail(expected.taskId)!.listing.key;
  let analysisReads = 0;
  const collectionReads: string[] = [];
  const closedBy: string[] = [];
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://analysis-drawer.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      switch (url.pathname) {
        case "/api/runtime/settings":
          body = { saveScreenshots: false };
          break;
        case "/api/browser/settings":
          body = { mode: "daily", connected: true, busy: false };
          break;
        case "/api/ai/status":
          body = {
            codex: { state: "connected", model: "fixture-model", response: "READY" },
            deepseek: { state: "unconfigured" },
          };
          break;
        case "/api/ai/models":
          body = {
            provider: "codex",
            defaultModel: "fixture-model",
            models: [{ id: "fixture-model", name: "模拟模型" }],
          };
          break;
        case "/api/analysis/progress":
        case "/api/analysis/status":
          body = store.overview({
            page: Number(url.searchParams.get("page") || 1),
            resultsPage: Number(url.searchParams.get("resultsPage") || 1),
            search: url.searchParams.get("search") || undefined,
            includeRanking: url.searchParams.get("includeRanking") === "true",
          });
          break;
        case "/api/analysis/detail":
          analysisReads++;
          body = store.detail(url.searchParams.get("taskId")!);
          break;
        case "/api/crawl/detail": {
          const key = url.searchParams.get("key")!;
          collectionReads.push(key);
          body = crawl.detail(key);
          break;
        }
        default:
          throw new Error("未模拟接口：" + url.pathname);
      }
      return route.fulfill({ json: body });
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
    await page.goto("http://analysis-drawer.test/analysis-preview");
    await page.getByRole("tab", { name: "分析记录" }).click();
    const results = page.getByRole("tabpanel", { name: "分析记录" });
    await expect(results.getByRole("article")).toHaveCount(20);
    await results.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(results).toContainText("第 2 / 2 页");
    const resultButton = results.getByRole("button", { name: `查看分析详情：${expected.name}` });
    await resultButton.click();
    const analysis = page.locator(".analysis-detail-dialog");
    await expect(analysis).toBeVisible();
    await expect(analysis.getByRole("heading", { name: expected.name, exact: true })).toBeVisible();
    const attempt = analysis.locator(".analysis-attempt");
    await attempt.locator("summary").first().click();
    await expect(attempt).toHaveAttribute("open", "");
    const showCollection = analysis.getByRole("button", { name: "查看当前采集资料" });
    await showCollection.scrollIntoViewIfNeeded();
    const content = analysis.locator(".analysis-modal-content");
    const scrollBefore = await content.evaluate((element) => element.scrollTop);
    expect(scrollBefore).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("analysis-before-collection.png") });

    for (const close of ["button", "escape", "backdrop"]) {
      await showCollection.click();
      const collection = page.locator(".role-drawer");
      await expect(collection).toBeVisible();
      await expect(collection).toContainText(expected.name);
      await expect(analysis).toHaveAttribute("open", "");
      await expect.poll(() => page.evaluate(() => document.body.style.overflow)).toBe("hidden");
      if (close === "button") {
        await page.screenshot({ path: testInfo.outputPath("collection-over-analysis.png") });
        await collection.getByRole("button", { name: "关闭角色详情" }).click();
      } else if (close === "escape") await page.keyboard.press("Escape");
      else await page.mouse.click(4, 4);
      await expect(collection).toHaveCount(0);
      await expect(analysis).toBeVisible();
      await expect(attempt).toHaveAttribute("open", "");
      await expect(showCollection).toBeFocused();
      await expect.poll(() => content.evaluate((element) => element.scrollTop)).toBe(scrollBefore);
      expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
      closedBy.push(close);
    }
    expect(analysisReads).toBe(1);
    expect(collectionReads).toEqual([expectedKey, expectedKey, expectedKey]);
    await page.screenshot({ path: testInfo.outputPath("analysis-return-preserved.png") });
    await analysis.getByRole("button", { name: "关闭分析详情" }).click();
    await expect(analysis).toHaveCount(0);
    await expect(resultButton).toBeFocused();
    await expect(results).toContainText("第 2 / 2 页");
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");

    await page.getByRole("tab", { name: "全部商品" }).click();
    await page.getByRole("searchbox", { name: "搜索商品" }).fill(directRecord.listing.name);
    const records = page.getByRole("tabpanel", { name: "全部商品" });
    await expect(records.locator("tbody tr")).toHaveCount(1);
    const directButton = records.getByRole("button", { name: "查看资料", exact: true });
    await directButton.click();
    await expect(page.locator(".role-drawer")).toContainText(directRecord.listing.name);
    await expect(analysis).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".role-drawer")).toHaveCount(0);
    await expect(directButton).toBeFocused();
    await expect(page.getByRole("searchbox", { name: "搜索商品" })).toHaveValue(
      directRecord.listing.name,
    );
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
    await page.screenshot({ path: testInfo.outputPath("final-original-list.png"), fullPage: true });
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          analyzedProducts: keys.length,
          resultPage: 2,
          taskId: expected.taskId,
          collectionKey: expectedKey,
          closedBy,
          analysisReads,
          collectionReads,
          preserved: ["expanded call", "detail scroll", "focus", "result page", "scroll lock"],
          directEntryReturnsTo: "filtered all-products list",
          repeat:
            "vp run build && vp exec playwright test tests/e2e/analysis-drawer-return.pw.ts --workers=1 --trace=on",
        },
        null,
        2,
      ),
    );
  } finally {
    await page.close();
    crawl.close();
  }
});
