import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import { AnalysisRunner } from "../../server/analysis/runner";
import { createProfile, PROMPT_FILE } from "../../server/analysis/profile";
import { equipmentPricingPlan } from "../../server/analysis/equipment-pricing";
import { petInventory } from "../../server/analysis/pet-pricing";
import { finishPricingSearch } from "../../server/analysis/pricing-progress";
import { valuationRecord } from "../fixtures/analysis";

// Failure cases: a failed first role starts the next role; ordinary resume bypasses it;
// refresh loses the stop; explicit retry loses progress/order or cannot reach two quotes.
// Only market/AI responses are simulated. Runner, storage, controls and rendering are real.
test("并发1时查价失败立即停队，刷新后显式重试，按顺序完成两个报价", async ({ page }, testInfo) => {
  const crawl = new CrawlStore(":memory:");
  const records = ["stop-first", "stop-second"].map((key) => {
    const record = valuationRecord(key);
    record.detail!.equipmentCapture = {
      version: 1,
      collectedAt: record.detail!.collectedAt,
      complete: true,
      issues: [],
      emptyProof: "explicit-text",
    };
    record.detail!.tabs.push({
      name: "道具/法宝",
      text: "没有装备",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [],
    });
    record.detail!.petCapture = { ...record.detail!.equipmentCapture };
    record.detail!.tabs.push({
      name: "召唤兽/孩子",
      text: "无召唤兽",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      petCount: 0,
      pets: [],
    });
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    return record;
  });
  const store = new AnalysisStore(crawl.db);
  const profile = createProfile(
    await readFile(PROMPT_FILE, "utf8"),
    { servers: [{ serverId: records[0].listing.serverId, age: "three", rank: 10 }] },
    true,
    true,
  );
  const searches: string[] = [];
  let aiCalls = 0;
  const runner = new AnalysisRunner(store, async () => ({
    model: "fixture-model",
    searchEquipment: async (record) => {
      searches.push(record.listing.key);
      if (searches.length === 1) throw new Error("装备详情读取失败（模拟）");
      return finishPricingSearch(equipmentPricingPlan(record));
    },
    searchPets: async (record) =>
      finishPricingSearch({
        ...equipmentPricingPlan(record),
        ...petInventory(record),
        searchComplete: true,
      }),
    analyze: async () => {
      aiCalls++;
      return {
        text: JSON.stringify({
          decision: "BUY",
          reason: "模拟分析：已核验空装备和空宝宝，只汇总裸号规则值。",
          extracted_facts: [],
        }),
      };
    },
  }));
  try {
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://cbg-stop.test") return route.abort();
      if (url.pathname.startsWith("/api/")) {
        try {
          let body: unknown;
          const run = store.overview().run;
          const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
          switch (url.pathname) {
            case "/api/ai/status":
              body = {
                codex: { state: "configured", account: { plan: "Plus" } },
                deepseek: { state: "unconfigured" },
                deepseekModels: [],
              };
              break;
            case "/api/ai/models":
              body = {
                provider: "codex",
                defaultModel: "fixture-model",
                models: [{ id: "fixture-model", name: "测试模型" }],
              };
              break;
            case "/api/analysis/settings":
              body = { profile, promptFile: PROMPT_FILE, servers: [], market: [] };
              break;
            case "/api/analysis/status":
              body = { ...store.overview({ provider: "codex", currentProfile: profile }), profile };
              break;
            case "/api/analysis/start":
              body = store.run(
                await runner.start(
                  "codex",
                  true,
                  profile,
                  false,
                  undefined,
                  1,
                  undefined,
                  input.concurrency,
                ),
              );
              break;
            case "/api/analysis/resume":
              body = store.run(await runner.resume(run!.id, false, input.concurrency));
              break;
            case "/api/analysis/retry":
              body = store.run(await runner.resume(run!.id, true, input.concurrency));
              break;
            case "/api/analysis/detail":
              body = store.detail(url.searchParams.get("taskId")!, profile);
              break;
            default:
              throw new Error("未模拟接口：" + url.pathname);
          }
          return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
        } catch (error) {
          return route.fulfill({
            status: 400,
            contentType: "application/json",
            body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          });
        }
      }
      const file = path.join(
        "dist",
        url.pathname === "/analysis-preview" ? "index.html" : url.pathname,
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
    await page.goto("http://cbg-stop.test/analysis-preview");
    await page.getByRole("spinbutton", { name: "分析并发数" }).fill("1");
    await page.getByRole("button", { name: "开始分析已有商品", exact: true }).click();
    const retry = page.getByRole("button", { name: "重试失败及待补齐的 1 件", exact: true });
    await expect(retry).toBeVisible();
    const before = store.overview();
    expect(before.run).toMatchObject({
      status: "paused",
      waitingPricing: 1,
      queued: 1,
      completed: 0,
    });
    expect(searches).toEqual(["stop-first"]);
    expect(aiCalls).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("stopped.png"), fullPage: true });
    await page.reload();
    await expect(retry).toBeVisible();
    const resume = await page.evaluate(async (runId) => {
      const response = await fetch("/api/analysis/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      return { status: response.status, body: await response.json() };
    }, before.run!.id);
    expect(resume).toEqual({
      status: 400,
      body: { error: "请先重试失败或待补齐的商品，再继续分析" },
    });
    expect(searches).toEqual(["stop-first"]);
    await page.getByRole("spinbutton", { name: "分析并发数" }).fill("1");
    await retry.click();
    await expect.poll(() => store.overview().run?.completed).toBe(2);
    await writeFile(
      testInfo.outputPath("retry-state.json"),
      JSON.stringify(
        {
          overview: store.overview(),
          details: store
            .overview()
            .records.items.map((item) => (item.taskId ? store.detail(item.taskId) : null)),
        },
        null,
        2,
      ),
    );
    await expect(page.getByLabel("分析页面概览")).toContainText("2 件已有结果");
    expect(store.overview().run).toMatchObject({
      status: "running",
      phase: "waiting_capture",
      completed: 2,
      waitingPricing: 0,
      failed: 0,
    });
    expect(searches).toEqual(["stop-first", "stop-first", "stop-second"]);
    expect(aiCalls).toBe(2);
    const details = store.overview().results.items.map((item) => store.detail(item.taskId)!);
    for (const detail of details) {
      expect(typeof detail.result?.valuation?.model_value).toBe("number");
      expect(detail.result?.valuation?.estimate_missing_count ?? 0).toBe(0);
    }
    await page
      .getByRole("button", { name: /查看分析详情/ })
      .first()
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").screenshot({ path: testInfo.outputPath("quote-detail.png") });
    await page.reload();
    await expect(page.getByLabel("分析页面概览")).toContainText("2 件已有结果");
    expect(aiCalls).toBe(2);
    await page.screenshot({ path: testInfo.outputPath("two-quotes.png"), fullPage: true });
    await writeFile(
      testInfo.outputPath("stop-retry-proof.json"),
      JSON.stringify(
        {
          state: "passed",
          simulated: true,
          before,
          after: store.overview(),
          searches,
          aiCalls,
          details,
        },
        null,
        2,
      ),
    );
  } finally {
    await runner.shutdown();
    crawl.db.close();
  }
});
