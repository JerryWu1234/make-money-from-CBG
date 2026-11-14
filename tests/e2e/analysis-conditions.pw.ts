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
import { calculateValuation } from "../../server/analysis/valuation-calculator";
import { valuationRecord } from "../fixtures/analysis";

// Isolation failures: routes could bypass actual persistence/runner/validation; UI could
// lose group IDs, omit a result, show current conditions in history, or reuse stale results.
// Condition evidence could omit listing attrs/summary or non-pricing tabs; a fixture AI
// could hide that omission by answering from the fixture instead of the actual request.
// Use actual SQLite stores, profile persistence and runner; only site data/AI/network are fixtures.
// Save failures to cover: blank condition blocked with visible ID; closing loses drafts;
// concurrent edits silently overwrite; reloading discards input; reopen reads stale in-memory data.
// A delayed recovery response must not leave inputs editable and overwrite new typing.
test("条件保存失败恢复、分析、刷新与历史快照（模拟AI）", async ({ page }, testInfo) => {
  const crawl = new CrawlStore(testInfo.outputPath("conditions.sqlite"));
  const record = valuationRecord();
  record.listing.attrs["速度"] = "850";
  record.listing.summary = { ...(record.listing.summary as object), 测试备注: "条件证据列表摘要" };
  record.detail!.tabs.push({
    name: "技能",
    text: "烹饪技巧：100",
    fields: [{ name: "烹饪技巧", value: "100" }],
    tables: [],
    elements: [],
    tooltips: [],
  });
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
  const store = new AnalysisStore(crawl.db);
  store.followsCapture = () => false;
  const template = await readFile(PROMPT_FILE, "utf8");
  const promptFile = testInfo.outputPath("valuation.md");
  await writeFile(promptFile, template);
  let profile = createProfile(template, {
    ...DEFAULT_SETTINGS,
    servers: [
      {
        serverId: record.listing.serverId,
        age: "three",
        rank: 10,
        goldPrice: null,
        goldUnit: null,
      },
    ],
  });
  profile = saveProfile(
    crawl.db,
    {
      template,
      settings: profile.settings,
      baseHash: createProfile(template).hash,
    },
    promptFile,
  );
  let recoveryGate: Promise<void> | undefined;
  let releaseRecovery: (() => void) | undefined;
  const clientRequests: Array<{ provider: string; model?: string }> = [];
  let calls = 0;
  const requests: unknown[] = [];
  const runner = new AnalysisRunner(store, async (provider, model) => {
    clientRequests.push({ provider, model });
    return {
      model: model || "fixture-model",
      analyze: async (prompt, schema) => {
        calls++;
        requests.push({ prompt, schema });
        expect(schema).toHaveProperty("properties.condition_results");
        expect(prompt).toContain("条件证据列表摘要");
        const expected = calculateValuation(record, profile);
        expect(expected.bare_role_value).toBeGreaterThan(0);
        const conditionResults = [];
        for (const node of profile.settings.conditions?.children || []) {
          if ("children" in node || node.price) continue;
          if (node.text.startsWith("养成")) {
            conditionResults.push({
              id: node.id,
              sourceText: node.text,
              matched: null,
              reason: "养成完整缺少可核实标准",
              observations: [],
              calculation: null,
              comparison: null,
            });
            continue;
          }
          const speed = node.text.startsWith("速度");
          const actual = speed ? 850 : 109;
          const target = Number(node.text.match(/\d+/)![0]);
          const levelIndex = record.detail!.tabs[0].fields.findIndex(
            (field) => field.name === "级别",
          );
          conditionResults.push({
            id: node.id,
            sourceText: node.text,
            matched: speed ? actual > target : actual >= target,
            reason: "根据本商品原始资料逐条判断",
            observations: [
              {
                label: speed ? "人物速度" : "人物等级",
                path: speed ? "/listing/attrs/速度" : `/detail/tabs/0/fields/${levelIndex}/value`,
                quote: String(actual),
                numericValue: actual,
              },
            ],
            calculation: { operation: "identity", inputs: [0], result: actual },
            comparison: { operator: speed ? "gt" : "gte", target },
          });
        }
        return {
          text: JSON.stringify({
            decision: expected.decision,
            reason: expected.reason,
            extracted_facts: [],
            condition_results: conditionResults,
          }),
        };
      },
    };
  });
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
            deepseek: { state: "configured", model: "fixture-deepseek-default" },
            deepseekModels: [],
          };
          break;
        case "/api/ai/models": {
          const selectedProvider = url.searchParams.get("provider") || "codex";
          body =
            selectedProvider === "deepseek"
              ? {
                  provider: "deepseek",
                  defaultModel: "fixture-deepseek-default",
                  models: [
                    { id: "fixture-deepseek-default", name: "模拟DeepSeek默认" },
                    { id: "fixture-deepseek-custom", name: "模拟DeepSeek自选" },
                  ],
                }
              : {
                  provider: "codex",
                  defaultModel: "fixture-model",
                  models: [{ id: "fixture-model", name: "模拟模型" }],
                };
          break;
        }
        case "/api/analysis/settings":
          if (recoveryGate) await recoveryGate;
          profile = loadProfile(crawl.db, promptFile);
          body = { profile, promptFile, servers: [] };
          break;
        case "/api/analysis/conditions/compile":
          throw new Error("简单条件界面不应请求手动解析接口");
        case "/api/analysis/settings/save":
          try {
            profile = saveProfile(crawl.db, input, promptFile);
            body = { profile };
          } catch (error) {
            return route.fulfill({ status: 400, json: { error: (error as Error).message } });
          }
          break;
        case "/api/analysis/start":
          profile = loadProfile(crawl.db, promptFile);
          body = store.run(
            await runner.start(input.provider, input.force, profile, false, input.model),
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
    await page.getByLabel("分析 Agent", { exact: true }).selectOption("deepseek");
    await expect(page.getByLabel("分析模型", { exact: true })).toBeEnabled();
    await page.getByLabel("分析模型", { exact: true }).selectOption("fixture-deepseek-custom");
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "估值与挂牌比较设置" });
    await expect(
      settings.getByText("未自定义时，默认：价格不限制。", { exact: true }),
    ).toBeVisible();
    await expect(settings.getByRole("button", { name: "增加条件组", exact: true })).toHaveCount(0);
    await settings.getByLabel("C1条件类型", { exact: true }).selectOption("text");
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(settings.getByRole("alert")).toContainText("C1 条件须填写");
    await expect(settings.getByRole("alert")).toBeInViewport();
    await settings.getByRole("button", { name: "保存设置", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("M1-save-error.png"), fullPage: true });
    await settings.getByLabel("C1条件", { exact: true }).fill("速度大于800");
    await settings.getByRole("button", { name: "关闭分析设置", exact: true }).click();
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    await expect(settings.getByLabel("C1条件", { exact: true })).toHaveValue("速度大于800");
    await expect(settings.getByText("已恢复未保存的输入。草稿仅在当前页面保留。")).toBeVisible();
    await settings.getByRole("button", { name: "添加条件", exact: true }).click();
    await settings.getByLabel("C2条件", { exact: true }).fill("养成完整");
    await settings.getByLabel("C2连接关系", { exact: true }).selectOption("or");
    await settings.getByRole("button", { name: "添加条件", exact: true }).click();
    await settings.getByLabel("C3条件", { exact: true }).fill("人物等级至少120级");
    await settings.getByRole("button", { name: "添加条件", exact: true }).click();
    await settings.getByLabel("C4条件类型", { exact: true }).selectOption("price");
    await settings.getByLabel("C4价格比较", { exact: true }).selectOption("lt");
    await settings.getByLabel("C4价格百分比", { exact: true }).fill("10");
    await expect(settings.getByText(/裸号估值 × 90%/)).toBeVisible();
    await settings.getByLabel("C4价格比较", { exact: true }).selectOption("gt");
    await expect(settings.getByLabel("C4价格百分比", { exact: true })).toHaveValue("10");
    await expect(settings.getByText(/裸号估值 × 110%/)).toBeVisible();
    await settings.getByLabel("C4价格比较", { exact: true }).selectOption("none");
    await expect(settings.getByLabel("C4价格百分比", { exact: true })).toHaveCount(0);
    await settings.getByLabel("C4价格比较", { exact: true }).selectOption("lt");
    await settings.getByLabel("C4价格百分比", { exact: true }).fill("10");
    await expect(settings.getByLabel("C4价格比较", { exact: true }).locator("option")).toHaveCount(
      3,
    );
    await expect(settings.getByLabel("C4估值调整", { exact: true })).toHaveCount(0);
    await expect(settings.getByText(/裸号估值 × 90%/)).toBeVisible();
    await expect(settings.getByRole("button", { name: "解析文字条件", exact: true })).toHaveCount(
      0,
    );
    expect(calls).toBe(0);
    profile = saveProfile(
      crawl.db,
      {
        template,
        settings: { ...profile.settings, sumAdvancedMounts: false },
        baseHash: profile.hash,
        baseConfigurationHash: profile.configurationHash,
      },
      promptFile,
    );
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(settings.getByRole("alert")).toContainText("分析设置已被修改");
    await settings.getByRole("button", { name: "保存设置", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("M3-conflict.png"), fullPage: true });
    await settings.getByRole("button", { name: "关闭分析设置", exact: true }).click();
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    await expect(settings.getByLabel("C1条件", { exact: true })).toHaveValue("速度大于800");
    recoveryGate = new Promise<void>((resolve) => {
      releaseRecovery = resolve;
    });
    await settings.getByRole("button", { name: "重新读取并保留输入", exact: true }).click();
    await expect(settings.getByLabel("C1条件", { exact: true })).toBeDisabled();
    await expect(settings.getByLabel("估值 Prompt 全文", { exact: true })).toBeDisabled();
    for (const control of await settings.locator("input, select, textarea, button").all())
      await expect(control).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("M3-recovery-loading.png"), fullPage: true });
    releaseRecovery!();
    recoveryGate = undefined;
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await expect(settings.getByLabel("C1条件", { exact: true })).toBeEnabled();
    await expect(settings.getByLabel("估值 Prompt 全文", { exact: true })).toBeEnabled();
    await settings.getByLabel("C1条件", { exact: true }).fill("速度大于800，使用已采集资料");
    await settings.getByRole("button", { name: "关闭分析设置", exact: true }).click();
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    await expect(settings.getByLabel("C1条件", { exact: true })).toHaveValue(
      "速度大于800，使用已采集资料",
    );
    await settings.getByLabel("C1条件", { exact: true }).fill("速度大于800");
    await expect(settings.getByLabel("C3条件", { exact: true })).toHaveValue("人物等级至少120级");
    await settings.getByRole("button", { name: "保存设置", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("M2-restored-draft.png"), fullPage: true });
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(settings).not.toBeVisible();
    expect(loadProfile(crawl.db, promptFile).settings.sumAdvancedMounts).toBe(false);
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    await expect(settings.getByLabel("C4价格百分比", { exact: true })).toHaveValue("10");
    await settings.locator(".analysis-price-condition").scrollIntoViewIfNeeded();
    await settings.locator(".analysis-price-condition").screenshot({
      path: testInfo.outputPath("price-percentage-desktop.png"),
    });
    await expect(settings.getByLabel("C1条件", { exact: true })).toHaveValue("速度大于800");
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await page.setViewportSize({ width: 1100, height: 1400 });
    await settings
      .getByLabel("入榜条件设置", { exact: true })
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    await settings.screenshot({ path: testInfo.outputPath("A1-conditions-settings.png") });
    await page.setViewportSize({ width: 390, height: 1000 });
    await settings.locator(".analysis-price-condition").scrollIntoViewIfNeeded();
    await settings.locator(".analysis-price-condition").screenshot({
      path: testInfo.outputPath("price-percentage-mobile.png"),
    });
    await settings.getByLabel("C2连接关系", { exact: true }).scrollIntoViewIfNeeded();
    expect(
      await settings
        .getByLabel("入榜条件设置", { exact: true })
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("A2-conditions-mobile.png") });
    await page.setViewportSize({ width: 1100, height: 1000 });
    await settings.getByRole("button", { name: "关闭分析设置", exact: true }).click();
    expect(loadProfile(crawl.db, promptFile).settings.conditions).toEqual(
      profile.settings.conditions,
    );
    expect(
      loadProfile(crawl.db, promptFile).settings.conditions?.children.find(
        (node) => node.id === "C4",
      ),
    ).toMatchObject({
      price: { comparison: "lt", adjustment: "minus", unit: "percent", value: 10 },
    });
    expect(calls).toBe(0);
    await page
      .getByRole("button", {
        name: /^(开始分析已有商品|分析新增或已更新商品|按新规则开始分析|按新模型开始分析)$/,
      })
      .click();
    await expect
      .poll(() => clientRequests[0])
      .toEqual({ provider: "deepseek", model: "fixture-deepseek-custom" });
    await expect.poll(() => store.overview().run?.completed).toBe(1);
    await page.getByRole("tab", { name: /^全部商品/ }).click();
    await page.getByRole("button", { name: "查看分析", exact: true }).first().click();
    await expect(page.getByText("条件 2 养成完整：无法判断", { exact: true })).toBeVisible();
    await expect(page.getByLabel("条件匹配")).toContainText("条件 1 速度大于800：满足");
    await expect(page.getByLabel("条件匹配")).toContainText("850");
    await expect(page.getByLabel("条件匹配")).toContainText("最终结果（从上到下计算）：不满足");
    await expect(page.getByLabel("条件匹配")).toContainText("条件 4 挂牌价比裸号估值低10%：满足");
    expect(store.overview().ranking).toHaveLength(0);
    await page.screenshot({
      path: testInfo.outputPath("A3-condition-results.png"),
      fullPage: true,
    });
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByRole("tab", { name: /^全部商品/ }).click();
    await page.getByRole("button", { name: "查看分析", exact: true }).first().click();
    await expect(page.getByLabel("条件匹配")).toContainText("条件 3 人物等级至少120级：不满足");
    await expect(page.getByLabel("条件匹配")).toContainText("109");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    crawl.db
      .prepare("UPDATE analysis_runs SET status='paused' WHERE id=?")
      .run(store.overview().run!.id);
    await settings.getByLabel("C1条件", { exact: true }).fill("速度大于900");
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    expect(calls).toBe(1);
    await page
      .getByRole("button", {
        name: /^(开始分析已有商品|分析新增或已更新商品|按新规则开始分析|按新模型开始分析)$/,
      })
      .click();
    await expect.poll(() => calls).toBe(2);
    await expect.poll(() => store.overview().run?.completed).toBe(1);
    await page.getByRole("tab", { name: /^全部商品/ }).click();
    await page.getByRole("button", { name: "查看分析", exact: true }).first().click();
    await expect(page.getByLabel("条件匹配")).toContainText("条件 1 速度大于900：不满足");
    expect(calls).toBe(2);
    const storedResult = crawl.db
      .prepare(
        "SELECT result_json FROM analysis_tasks WHERE listing_key=? AND status='completed' ORDER BY completed_at ASC LIMIT 1",
      )
      .get(record.listing.key)!;
    expect(String(storedResult.result_json)).toContain("速度大于800");
    expect(String(storedResult.result_json)).not.toContain("速度大于900");
    const oldDetail = store.detail(store.overview().records.items[0].taskId!, profile);
    await page.keyboard.press("Escape");
    await page.reload();
    await page.getByRole("tab", { name: /^全部商品/ }).click();
    await page.getByRole("button", { name: "查看分析", exact: true }).first().click();
    await expect(page.getByLabel("条件匹配")).toContainText("条件 1 速度大于900：不满足");
    expect(calls).toBe(2);
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          calls,
          clientRequests,
          requests,
          oldDetail,
          current: store.overview(),
        },
        null,
        2,
      ),
    );
    await testInfo.attach("可复核请求与历史结果（模拟AI）", {
      path: testInfo.outputPath("evidence.json"),
      contentType: "application/json",
    });
  } finally {
    releaseRecovery?.();
    await runner.pause();
    crawl.close();
  }
});
