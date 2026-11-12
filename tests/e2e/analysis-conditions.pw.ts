import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import { AnalysisRunner } from "../../server/analysis/runner";
import {
  createProfile,
  DEFAULT_SETTINGS,
  PROMPT_FILE,
  saveProfile,
  loadProfile,
} from "../../server/analysis/profile";
import { conditionNodes } from "../../server/analysis/conditions";
import { calculateValuation } from "../../server/analysis/valuation-calculator";
import { valuationRecord } from "../fixtures/analysis";

// Isolation failures: routes could bypass actual persistence/runner/validation; UI could
// lose group IDs, omit a result, show current conditions in history, or reuse stale results.
// Use actual SQLite stores, profile persistence and runner; only site data/AI/network are fixtures.
test("条件配置、分析、刷新与历史快照（模拟AI）", async ({ page }, testInfo) => {
  const crawl = new CrawlStore(testInfo.outputPath("conditions.sqlite"));
  const record = valuationRecord();
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
  const store = new AnalysisStore(crawl.db);
  store.followsCapture = () => false;
  const template = await readFile(PROMPT_FILE, "utf8");
  const promptFile = testInfo.outputPath("valuation.md");
  await writeFile(promptFile, template);
  let profile = createProfile(template, DEFAULT_SETTINGS);
  let calls = 0;
  const requests: unknown[] = [];
  const runner = new AnalysisRunner(store, async () => ({
    model: "fixture-model",
    analyze: async (prompt, schema) => {
      calls++;
      requests.push({ prompt, schema });
      expect(prompt).toContain("补充条件判断");
      const expected = calculateValuation(record, profile);
      return {
        text: JSON.stringify({
          decision: expected.decision,
          reason: expected.reason,
          extracted_facts: [],
          condition_results: conditionNodes(profile.settings.conditions!).map((node) => ({
            id: node.id,
            status:
              node.id === "C2"
                ? "unknown"
                : node.id === "C3"
                  ? "unmet"
                  : node.id === "C1"
                    ? "met"
                    : "unknown",
            reason: node.id === "C2" ? "模拟资料未提供完整配置，无法判断" : "模拟角色资料依据",
          })),
        }),
      };
    },
  }));
  try {
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://conditions.test") return route.abort();
      if (!url.pathname.startsWith("/api/")) {
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
      }
      const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
      let body: unknown = {};
      switch (url.pathname) {
        case "/api/runtime/settings":
          body = { saveScreenshots: false };
          break;
        case "/api/browser/settings":
          body = { mode: "daily", connected: true, busy: false };
          break;
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
            models: [{ id: "fixture-model", name: "模拟模型" }],
          };
          break;
        case "/api/analysis/settings":
          body = { profile, promptFile, servers: [] };
          break;
        case "/api/analysis/settings/save":
          profile = saveProfile(crawl.db, input, promptFile);
          body = { profile };
          break;
        case "/api/analysis/start":
          body = store.run(
            await runner.start("codex", input.force, profile, false, "fixture-model"),
          );
          break;
        case "/api/analysis/status":
        case "/api/analysis/progress":
          body = { ...store.overview({ currentProfile: profile }), profile };
          break;
        case "/api/analysis/detail":
          body = store.detail(url.searchParams.get("taskId")!, profile);
          break;
        default:
          throw new Error(`未模拟接口：${url.pathname}`);
      }
      return route.fulfill({ json: body });
    });
    await page.goto("http://conditions.test/analysis-preview");
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "估值与挂牌比较设置" });
    await settings.getByRole("button", { name: "添加分析条件" }).click();
    await settings.getByLabel("C1条件", { exact: true }).fill("等级为175");
    await settings.getByRole("button", { name: "增加条件组", exact: true }).click();
    await settings.getByLabel("C2条件", { exact: true }).fill("养成完整");
    const subgroup = settings.getByRole("group", { name: "G2 条件组" });
    await subgroup.getByRole("button", { name: "增加条件", exact: true }).click();
    await settings.getByLabel("C3条件", { exact: true }).fill("门派为化生寺");
    await page.screenshot({
      path: testInfo.outputPath("A1-conditions-settings.png"),
      fullPage: true,
    });
    await settings.getByRole("button", { name: /保存/ }).click();
    await expect(settings).not.toBeVisible();
    expect(loadProfile(crawl.db, promptFile).settings.conditions).toEqual(
      profile.settings.conditions,
    );
    await page.getByRole("button", { name: "开始分析已有商品", exact: true }).click();
    await expect.poll(() => store.overview().run?.completed).toBe(1);
    await page.getByRole("tab", { name: /^全部商品/ }).click();
    await page.getByRole("button", { name: "查看分析", exact: true }).first().click();
    await expect(page.getByText("C2 养成完整：无法判断", { exact: true })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("A3-condition-results.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByRole("tab", { name: /^全部商品/ }).click();
    await page.getByRole("button", { name: "查看分析", exact: true }).first().click();
    await expect(page.getByLabel("条件匹配")).toContainText("C3 门派为化生寺：不满足");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    await settings.getByLabel("C1条件", { exact: true }).fill("等级为109");
    await settings.getByRole("button", { name: /保存/ }).click();
    await page.getByRole("button", { name: "查看分析", exact: true }).first().click();
    await expect(page.getByLabel("条件匹配")).toContainText("C1 等级为175");
    const oldDetail = store.detail(store.overview().records.items[0].taskId!, profile);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: /分析新增或已更新商品|按新设置/ }).click();
    await expect.poll(() => calls).toBe(2);
    await expect.poll(() => store.overview().run?.completed).toBe(1);
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        { fixture: true, calls, requests, oldDetail, current: store.overview() },
        null,
        2,
      ),
    );
    await testInfo.attach("可复核请求与历史结果（模拟AI）", {
      path: testInfo.outputPath("evidence.json"),
      contentType: "application/json",
    });
  } finally {
    await runner.pause();
    crawl.close();
  }
});
