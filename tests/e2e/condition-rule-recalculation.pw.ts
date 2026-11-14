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
import { validateDirectConditionResults } from "../../server/analysis/direct-condition-review";
import type { ConditionGroup } from "../../server/analysis/conditions";
import type { ValuationResult } from "../../server/analysis/valuation-types";
import { analysisRecord, analysisResponse } from "../fixtures/analysis";

// Only AI output and browser network are fixtures. Source quotes, arithmetic,
// comparisons, persisted archives and rendered per-condition results are real.
test("逐商品判断宝石30段、人物当前修炼26，并展示可核对过程", async ({ page }, testInfo) => {
  const crawl = new CrawlStore(testInfo.outputPath("direct-condition-review.sqlite"));
  try {
    const record = analysisRecord("direct-condition-review");
    record.listing.name = "46957901";
    record.listing.price = "999";
    const roleIndex = record.detail!.tabs.findIndex((tab) => tab.name === "人物/修炼");
    const role = record.detail!.tabs[roleIndex];
    role.tables = [
      [
        ["攻击修炼：", "12/20"],
        ["防御修炼：", "7/20"],
        ["法术修炼：", "0/20"],
        ["抗法修炼：", "7/20"],
        ["猎术修炼：", "100"],
      ],
    ];
    const gearIndex = record.detail!.tabs.findIndex((tab) => tab.name === "道具/法宝");
    const gear = record.detail!.tabs[gearIndex];
    const gemLevels = [7, 5, 6, 4, 4, 4];
    gear.items = gemLevels.map((level, index) => ({
      index,
      name: `测试人物装备${index + 1}`,
      kind: "equipment" as const,
      location: `role_using_equip_${index + 1}`,
      category: `人物装备 · ${["头盔", "衣服", "鞋子", "饰品", "腰带", "武器"][index]}`,
      description: `等级100\n锻炼等级 ${level}\n镶嵌宝石 黑宝石`,
    }));
    gear.items.push({
      index: 6,
      name: "星辉石不混入",
      kind: "equipment",
      category: "人物装备 · 戒指",
      location: "role_using_equip_187",
      description: "等级100\n精炼等级3",
    });
    const conditions: ConditionGroup = {
      id: "G1",
      operator: "and",
      evaluation: "sequence",
      children: [
        {
          id: "C1",
          text: "",
          price: { comparison: "none", adjustment: "none", unit: "amount", value: 0 },
        },
        { id: "C2", text: "总宝石数量大于等于20", join: "and" },
        { id: "C3", text: "角色修为大于等于27", join: "and" },
      ],
    };
    // Verified arithmetic corrects the old contradictory model boolean.
    const contradiction = {
      id: "C2",
      sourceText: "召唤兽数量大于8",
      matched: true,
      reason: "实际仅3只，不大于8",
      observations: [0, 1, 2].map((index) => ({
        label: `召唤兽${index + 1}`,
        path: `/detail/tabs/${record.detail!.tabs.findIndex((tab) => tab.name === "召唤兽/孩子")}/pets/${index}/name`,
        quote: record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!.pets![index].name,
        numericValue: null,
      })),
      calculation: { operation: "count", inputs: [0, 1, 2], result: 3 },
      comparison: { operator: "gt", target: 8 },
    };
    const corrected = validateDirectConditionResults(
      [contradiction],
      {
        id: "G1",
        operator: "and",
        evaluation: "sequence",
        children: [{ id: "C2", text: contradiction.sourceText }],
      },
      record,
      { asking: 999, bare: 1024.5 },
    );
    expect(corrected.results.find((entry) => entry.id === "C2")).toMatchObject({
      status: "unmet",
      matched: false,
      modelMatched: true,
    });
    expect(corrected.results.find((entry) => entry.id === "C2")?.reason).toContain("已按算式校正");
    crawl.observe(record.listing);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
    const template = await readFile(PROMPT_FILE, "utf8");
    const promptFile = testInfo.outputPath("valuation.md");
    await writeFile(promptFile, template);
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
    store.followsCapture = () => false;
    const oldRunId = store.createRun("codex", "fixture-model", false, profile);
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
          { id: "C2", status: "unknown", reason: "旧目录没有宝石数量字段" },
          { id: "C3", status: "unknown", reason: "旧目录没有角色修为字段" },
          { id: "G1", status: "unknown", reason: "旧条件尚未判断" },
        ],
      },
    } as ValuationResult;
    const oldSource = JSON.stringify({ ...analysisResponse(record), valuation: value });
    crawl.db
      .prepare(
        "UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=? WHERE run_id=?",
      )
      .run(oldSource, new Date().toISOString(), oldRunId);
    crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(oldRunId);
    let conditionCalls = 0;
    const rawResults = [
      {
        id: "C2",
        sourceText: "总宝石数量大于等于20",
        matched: true,
        reason: "按人物装备宝石段数合计，排除灵饰星辉石",
        observations: gemLevels.map((level, index) => ({
          label: `人物装备${index + 1}宝石段数`,
          path: `/detail/tabs/${gearIndex}/items/${index}/description`,
          quote: `锻炼等级 ${level}`,
          numericValue: level,
        })),
        calculation: { operation: "sum", inputs: [0, 1, 2, 3, 4, 5], result: 30 },
        comparison: { operator: "gte", target: 20 },
      },
      {
        id: "C3",
        sourceText: "角色修为大于等于27",
        matched: false,
        reason: "四项当前修炼等级求和，不使用分母上限或猎术",
        observations: [12, 7, 0, 7].map((level, index) => ({
          label: ["攻击修炼", "防御修炼", "法术修炼", "抗法修炼"][index],
          path: `/detail/tabs/${roleIndex}/tables/0/${index}/1`,
          quote: `${level}/20`,
          numericValue: level,
        })),
        calculation: { operation: "sum", inputs: [0, 1, 2, 3], result: 26 },
        comparison: { operator: "gte", target: 27 },
      },
    ];
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
          throw new Error("逐商品判断不应调用文字解析接口");
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
        case "/api/analysis/start": {
          conditionCalls++;
          const review = validateDirectConditionResults(rawResults, conditions, record, {
            asking: 999,
            bare: 1024.5,
          });
          const runId = store.createRun("codex", "fixture-model", true, profile);
          const result = {
            ...analysisResponse(record),
            valuation: { ...value, condition_review: review },
          };
          crawl.db
            .prepare(
              "UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=? WHERE run_id=?",
            )
            .run(JSON.stringify(result), new Date().toISOString(), runId);
          crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(runId);
          body = store.run(runId);
          break;
        }
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
    await expect(settings.getByLabel("C2条件", { exact: true })).toHaveValue(
      "总宝石数量大于等于20",
    );
    await expect(settings.getByLabel("C3条件", { exact: true })).toHaveValue("角色修为大于等于27");
    await settings.screenshot({ path: testInfo.outputPath("direct-conditions-settings.png") });
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(settings).not.toBeVisible();
    expect(conditionCalls).toBe(0);
    await page
      .getByRole("button", {
        name: /^(开始分析已有商品|分析新增或已更新商品|按新规则开始分析|按新模型开始分析)$/,
      })
      .click();
    await expect.poll(() => conditionCalls).toBe(1);
    await page.getByRole("tab", { name: /^推荐榜/ }).click();
    await expect(page.getByRole("tabpanel", { name: "推荐榜" }).getByRole("article")).toHaveCount(
      0,
    );
    await page.getByRole("tab", { name: /^全部商品/ }).click();
    await page.getByRole("button", { name: "查看分析", exact: true }).click();
    const review = page.getByLabel("条件匹配");
    await expect(review).toContainText("条件 2 总宝石数量大于等于20：满足");
    await expect(review).toContainText("true");
    await expect(review).toContainText("条件 3 角色修为大于等于27：不满足");
    await expect(review).toContainText("false");
    await expect(review).toContainText("30");
    await expect(review).toContainText("26");
    await expect(review).not.toContainText("旧目录");
    await expect(review).not.toContainText("历史条件记录");
    await review
      .getByText(/查看采集依据/)
      .first()
      .click();
    await review.scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 1100, height: 1400 });
    await page
      .getByRole("dialog", { name: "46957901", exact: true })
      .screenshot({ path: testInfo.outputPath("direct-condition-process.png") });
    expect(
      String(
        crawl.db.prepare("SELECT result_json FROM analysis_tasks WHERE run_id=?").get(oldRunId)!
          .result_json,
      ),
    ).toBe(oldSource);
    expect(conditionCalls).toBe(1);
  } finally {
    crawl.close();
  }
});
