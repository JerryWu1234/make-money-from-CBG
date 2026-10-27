import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import { analysisRecord } from "../fixtures/analysis";

test("分析只等待已完成资料，开始和暂停均不启动或暂停采集", async ({ page }, testInfo) => {
  const crawl = new CrawlStore(":memory:");
  const record = analysisRecord("a");
  record.detail!.equipmentCapture!.complete = false;
  record.detail!.equipmentCapture!.issues = ["模拟：武器属性未完整读取"];
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
  const store = new AnalysisStore(crawl.db);
  let runId: string | undefined;
  let startCalls = 0,
    pauseCalls = 0,
    crawlMutations = 0;
  try {
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://cbg-capture.test") return route.abort();
      if (url.pathname === "/api/runtime/settings")
        return route.fulfill({ json: { saveScreenshots: false } });
      if (url.pathname === "/api/browser/settings")
        return route.fulfill({ json: { mode: "daily", connected: true, busy: false } });
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/analysis/start") {
          startCalls++;
          runId = store.createRun("codex", "test-model");
          return route.fulfill({ json: store.run(runId) });
        }
        if (url.pathname === "/api/analysis/pause") {
          pauseCalls++;
          crawl.db.prepare("UPDATE analysis_runs SET status='paused' WHERE id=?").run(runId!);
          return route.fulfill({ json: store.run(runId!) });
        }
        if (url.pathname.startsWith("/api/crawl/") && route.request().method() !== "GET") {
          crawlMutations++;
          return route.fulfill({ status: 500, json: { error: "分析不能控制采集" } });
        }
        const body =
          url.pathname === "/api/analysis/status" || url.pathname === "/api/analysis/progress"
            ? {
                ...store.overview({}),
                captureActivity: { running: true, phase: "retrying", inFlight: 1 },
              }
            : url.pathname === "/api/ai/status"
              ? {
                  codex: { state: "connected", model: "test-model", response: "READY" },
                  deepseek: { state: "unconfigured" },
                  deepseekModels: [],
                }
              : url.pathname === "/api/ai/models"
                ? {
                    provider: "codex",
                    defaultModel: "test-model",
                    models: [{ id: "test-model", name: "模拟模型" }],
                  }
                : {};
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      }
      const file = path.join(
        process.cwd(),
        "dist",
        url.pathname === "/analysis-preview" ? "index.html" : url.pathname.slice(1),
      );
      const body = await readFile(file);
      return route.fulfill({
        contentType: file.endsWith(".js")
          ? "application/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html",
        body,
      });
    });
    await page.goto("http://cbg-capture.test/analysis-preview");
    const start = page.getByRole("button", { name: "开始分析并等待采集" });
    await expect(start).toBeEnabled();
    await start.click();
    await expect(page.getByText("等待新角色", { exact: true })).toBeVisible();
    await expect(page.getByText("正在等待首个角色资料采集完整", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "暂停资料采集" })).toHaveCount(0);
    await expect(page.getByText("正在采集并核验角色资料", { exact: false })).toHaveCount(0);
    const pause = page.getByRole("button", { name: "暂停分析", exact: true });
    await expect(pause).toBeEnabled();
    await page.screenshot({
      path: testInfo.outputPath("analysis-waits-for-capture.png"),
      fullPage: false,
    });
    await pause.click();
    await expect(pause).toBeHidden();
    expect(startCalls).toBe(1);
    expect(pauseCalls).toBe(1);
    expect(crawlMutations).toBe(0);
    expect(store.run(runId!)).toMatchObject({ status: "paused", total: 0, completed: 0 });
    const analysisRuns = Number(crawl.db.prepare("SELECT count(*) n FROM analysis_runs").get()!.n);
    expect(analysisRuns).toBe(1);
    const evidence = testInfo.outputPath("evidence.json");
    await writeFile(
      evidence,
      JSON.stringify(
        {
          fixture: true,
          repeat:
            "vp run build && vp exec playwright test tests/e2e/capture-preparation.pw.ts --workers=1 --output=data/capture-preparation-e2e",
          completeRecords: store.counts().complete,
          startCalls,
          pauseCalls,
          crawlMutations,
          analysisRuns,
        },
        null,
        2,
      ),
    );
    await testInfo.attach("分析与采集独立验证结果", {
      path: evidence,
      contentType: "application/json",
    });
  } finally {
    crawl.close();
  }
});
