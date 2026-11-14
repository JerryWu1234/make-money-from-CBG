import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import {
  createProfile,
  DEFAULT_SETTINGS,
  loadProfile,
  PROMPT_FILE,
  saveProfile,
} from "../../server/analysis/profile";
import { compareListingPrice } from "../../server/analysis/valuation-calculator";
import {
  describeRule,
  RULE_ENGINE_VERSION,
  type RuleExpression,
} from "../../server/analysis/condition-rule-types";
import type { ConditionGroup } from "../../server/analysis/conditions";
import { prepareConditionRules } from "../../server/analysis/condition-rule-cache";
import type { ValuationResult } from "../../server/analysis/valuation-types";
import { analysisRecord, analysisResponse } from "../fixtures/analysis";

// Reproduce the production false positive with complete source data, an old AI met result,
// and its contradictory reason. Automatic interpretation uses a fixture; cache,
// persistence/evaluation/UI are real. Saving alone never calls the model.
test("保存后开始分析自动判断，排除0装备3宝宝旧AI误入榜（不重新估值）", async ({
  page,
}, testInfo) => {
  const crawl = new CrawlStore(testInfo.outputPath("old-ai-false-positive.sqlite"));
  try {
    const record = analysisRecord("old-ai-false-positive");
    record.listing.name = "70391545";
    record.listing.price = "999";
    const gear = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    gear.items = [];
    gear.text = "没有装备";
    record.detail!.equipmentCapture!.emptyProof = "explicit-text";
    const pets = record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
    pets.pets = [0, 141, 5].map((level, index) => ({
      index,
      name: ["灵符女娲", "凤凰", "日游神"][index],
      fields: [
        { name: "等级", value: String(level) },
        { name: "是否宝宝", value: "是" },
      ],
      skills: [],
      equipment: [],
      innerSkills: [],
    }));
    pets.petCount = 3;
    crawl.observe(record.listing);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
    const template = await readFile(PROMPT_FILE, "utf8");
    const promptFile = testInfo.outputPath("valuation.md");
    await writeFile(promptFile, template);
    const text = "装备和宝宝加起来的数量大于8件";
    const conditions: ConditionGroup = {
      id: "G1",
      evaluation: "sequence",
      operator: "and",
      children: [
        {
          id: "C1",
          text: "",
          price: { comparison: "lte", adjustment: "none", unit: "amount", value: 0 },
        },
        { id: "C2", text, join: "and" },
      ],
    };
    let profile = saveProfile(
      crawl.db,
      {
        template,
        settings: { ...DEFAULT_SETTINGS, conditions },
        baseHash: createProfile(template).hash,
      },
      promptFile,
    );
    const store = new AnalysisStore(crawl.db);
    const runId = store.createRun("codex", "fixture-model", false, profile);
    const value = {
      ...compareListingPrice(1024.5, 999),
      asking_price: 999,
      model_value: 1024.5,
      bare_role_value: 1024.5,
      items: [],
      missing_fields: [],
      pending_rules: [],
      reason: "挂牌低于裸号参考估值",
      next_action: "",
      known_subtotal: 1024.5,
      calculation_version: profile.calculationVersion,
      asset_scope: "body",
      condition_review: {
        tree: conditions,
        results: [
          { id: "C1", status: "met", reason: "999小于1024.50" },
          { id: "C2", status: "met", reason: "装备容器为空，召唤兽3只；合计仅3，不大于8。" },
          { id: "G1", status: "met", reason: "旧AI错误满足状态" },
        ],
      },
    } as ValuationResult;
    const sourceResult = JSON.stringify({ ...analysisResponse(record), valuation: value });
    crawl.db
      .prepare(
        "UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=? WHERE run_id=?",
      )
      .run(sourceResult, new Date().toISOString(), runId);
    crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(runId);
    let compileCalls = 0;
    let analysisCalls = 0;
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://rules.test") return route.abort();
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
          profile = loadProfile(crawl.db, promptFile);
          body = { profile, promptFile, servers: [] };
          break;
        case "/api/analysis/conditions/compile":
          throw new Error("界面不应调用手动解析接口");
        case "/api/analysis/settings/save":
          profile = saveProfile(crawl.db, input, promptFile);
          body = { profile };
          break;
        case "/api/analysis/status":
        case "/api/analysis/progress":
          body = { ...store.overview({ currentProfile: profile }), profile };
          break;
        case "/api/analysis/detail":
          body = store.detail(url.searchParams.get("taskId")!, profile);
          break;
        case "/api/analysis/start":
          profile = await prepareConditionRules(
            crawl.db,
            {
              provider: input.provider,
              model: input.model,
              profileFile: promptFile,
            },
            async (entries) => {
              compileCalls++;
              const expression: RuleExpression = {
                op: "gt",
                args: [
                  { op: "count", collections: ["equipment", "jewelry", "petEquipment", "pets"] },
                  { op: "literal", value: 8 },
                ],
              };
              return entries.map((entry) => ({
                id: entry.id,
                rule: {
                  version: RULE_ENGINE_VERSION,
                  sourceText: entry.text,
                  status: "ready" as const,
                  expression,
                  explanation: describeRule(expression),
                  issues: [],
                },
              }));
            },
          );
          // Existing source-bound valuations can be recomputed locally; this fixture
          // deliberately has no product AI client. Controller coverage checks wiring.
          body = store.run(runId);
          break;
        default:
          throw new Error("未模拟接口：" + url.pathname);
      }
      return route.fulfill({ json: body });
    });
    await page.goto("http://rules.test/analysis-preview");
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "估值与挂牌比较设置" });
    await expect(settings.getByRole("button", { name: "解析文字条件", exact: true })).toHaveCount(
      0,
    );
    await expect(settings.getByLabel("C2条件", { exact: true })).toHaveValue(text);
    await settings.screenshot({ path: testInfo.outputPath("simple-conditions.png") });
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(settings).not.toBeVisible();
    expect(compileCalls).toBe(0);
    await page
      .getByRole("button", {
        name: /^(开始分析已有商品|分析新增或已更新商品|按新规则开始分析|按新模型开始分析)$/,
      })
      .click();
    await expect.poll(() => compileCalls).toBe(1);
    await page.getByRole("tab", { name: /^推荐榜/ }).click();
    await expect(page.getByRole("tabpanel", { name: "推荐榜" }).getByRole("article")).toHaveCount(
      0,
    );
    expect(store.overview({ currentProfile: profile }).ranking).toHaveLength(0);
    await page.getByRole("tab", { name: /^全部商品/ }).click();
    await page.getByRole("button", { name: "查看分析", exact: true }).click();
    const review = page.getByLabel("条件匹配");
    await expect(review).toContainText("条件 1 挂牌价小于或等于裸号估值：满足");
    await expect(review).toContainText(`条件 2 ${text}：不满足`);
    await expect(review).toContainText("3");
    await expect(review).toContainText("8");
    await review.scrollIntoViewIfNeeded();
    await page
      .getByRole("dialog", { name: "70391545", exact: true })
      .screenshot({ path: testInfo.outputPath("local-count-rejects-old-ai.png") });
    expect(compileCalls).toBe(1);
    expect(analysisCalls).toBe(0);
    expect(
      String(
        crawl.db.prepare("SELECT result_json FROM analysis_tasks WHERE run_id=?").get(runId)!
          .result_json,
      ),
    ).toBe(sourceResult);
  } finally {
    crawl.close();
  }
});
