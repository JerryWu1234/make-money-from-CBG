import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Route } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import type { AnalysisOverview } from "../../server/analysis/types";
import { analysisRecord } from "../fixtures/analysis";

test("采集准备前置：无完整记录也能自动采集，显示进度且可以暂停", async ({ page }, testInfo) => {
  const crawl = new CrawlStore(":memory:");
  const record = analysisRecord("a");
  record.detail!.equipmentCapture!.complete = false;
  record.detail!.equipmentCapture!.issues = ["模拟：武器属性未完整读取"];
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
  const store = new AnalysisStore(crawl.db);
  let preparation: AnalysisOverview["capturePreparation"];
  let starting: Route | undefined;
  let startCalls = 0,
    pauseCalls = 0;
  try {
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://cbg-capture.test") return route.abort();
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname === "/api/analysis/start") {
          startCalls++;
          preparation = {
            total: 1,
            completed: 0,
            current: "模拟角色a",
            message: "正在自动采集武器完整属性",
          };
          starting = route;
          return;
        }
        if (url.pathname === "/api/analysis/pause") {
          pauseCalls++;
          preparation = undefined;
          await starting?.fulfill({
            status: 409,
            contentType: "application/json",
            body: JSON.stringify({ error: "已暂停完整资料采集准备" }),
          });
          starting = undefined;
          return route.fulfill({ contentType: "application/json", body: "null" });
        }
        const body =
          url.pathname === "/api/analysis/status"
            ? { ...store.overview({}), ...(preparation ? { capturePreparation: preparation } : {}) }
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
    await expect(
      page.getByRole("status").filter({ hasText: "正在采集并核验角色资料" }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.getByText("完整采集中", { exact: true })).toBeVisible();
    const pause = page.getByRole("button", { name: "暂停资料采集" });
    await expect(pause).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("preparation-ui.png"), fullPage: false });
    await pause.click();
    await expect(pause).toBeHidden();
    expect(startCalls).toBe(1);
    expect(pauseCalls).toBe(1);
    expect(store.run("not-created")).toBeNull();
    const analysisRuns = Number(crawl.db.prepare("SELECT count(*) n FROM analysis_runs").get()!.n);
    expect(analysisRuns).toBe(0);
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
          preparationPaused: preparation === undefined,
          analysisRuns,
        },
        null,
        2,
      ),
    );
    await testInfo.attach("采集准备暂停验证结果", {
      path: evidence,
      contentType: "application/json",
    });
  } finally {
    await starting?.abort().catch(() => {});
    crawl.close();
  }
});
