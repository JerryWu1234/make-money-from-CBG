import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import type { SavedRoleRecord } from "../../server/crawler/types";
import { AnalysisStore } from "../../server/analysis/store";
import { AnalysisRunner } from "../../server/analysis/runner";
import { createProfile, PROMPT_FILE } from "../../server/analysis/profile";
import { calculateValuation } from "../../server/analysis/valuation-calculator";
import { analysisRecord } from "../fixtures/analysis";

test("估值页面：保存Prompt、单件与3件试跑、待确认明细和规则留档", async ({ page }, testInfo) => {
  const crawl = new CrawlStore(":memory:");
  const keys = ["a", "b", "c", "d"];
  for (const key of keys) {
    const record = analysisRecord(key);
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
  }
  const store = new AnalysisStore(crawl.db);
  let profile = createProfile(await readFile(PROMPT_FILE, "utf8"));
  let calls = 0;
  const runner = new AnalysisRunner(store, async (_provider, model) => ({
    model: model || "fixture-model",
    analyze: async (prompt) => {
      calls++;
      const key = keys.find((key) => prompt.includes(`商品 ID：${key}。`))!;
      return {
        text: JSON.stringify(calculateValuation(crawl.detail(key) as SavedRoleRecord, profile)),
      };
    },
  }));
  try {
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://cbg-valuation.test") return route.abort();
      if (url.pathname.startsWith("/api/")) {
        const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
        let body: unknown;
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
              models: [
                { id: "fixture-model", name: "默认测试模型" },
                { id: "other-model", name: "另一个测试模型" },
              ],
            };
            break;
          case "/api/analysis/settings":
            body = {
              profile,
              promptFile: PROMPT_FILE,
              servers: [{ serverId: "1", serverName: "测试服务器" }],
            };
            break;
          case "/api/analysis/settings/save":
            expect(input.baseHash).toBe(profile.hash);
            profile = createProfile(input.template, input.settings);
            body = { profile };
            break;
          case "/api/analysis/status":
            body = {
              ...store.overview({
                provider: "codex",
                runId: url.searchParams.get("runId") || undefined,
              }),
              profile: {
                hash: profile.hash,
                version: profile.version,
                promptHash: profile.promptHash,
                calculationCompatible: profile.calculationCompatible,
              },
            };
            break;
          case "/api/analysis/start":
            expect(input.sample).toBe(true);
            expect(input.model).toBe("other-model");
            body = store.run(
              await runner.start(
                "codex",
                input.force || input.sample,
                profile,
                input.sample,
                input.model,
                input.sampleSize,
              ),
            );
            break;
          case "/api/analysis/detail":
            body = store.detail(url.searchParams.get("taskId")!);
            break;
          default:
            throw new Error("未模拟估值接口：" + url.pathname);
        }
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
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
    await page.goto("http://cbg-valuation.test/analysis-preview");
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    const settings = page.getByRole("dialog", { name: "裸号估值与购买设置" });
    await settings.getByLabel("最高买入系数 b", { exact: true }).fill("0.8");
    await settings.getByLabel("全部额外成本 F（元）", { exact: true }).fill("0");
    await settings.getByText("编辑完整 Prompt", { exact: true }).click();
    const prompt = settings.getByLabel("估值 Prompt 全文");
    await prompt.fill((await prompt.inputValue()) + "\n请简洁说明主要待确认项。");
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(settings).not.toBeVisible();
    await expect(
      page.getByText("设置已保存。新批次使用新设置，旧批次仍保留原来的 Prompt 和参数。"),
    ).toBeVisible();
    expect(calls).toBe(0);
    expect(profile.settings).toMatchObject({ b: 0.8, extraCost: 0 });
    await expect(page.getByLabel("分析模型")).toHaveValue("");
    await page.getByLabel("分析模型").selectOption("other-model");
    await page.getByRole("button", { name: "先分析 1 件", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "全部商品" })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: "角色a" });
    await expect(row).toContainText("待确认");
    await row.getByRole("button", { name: "查看分析", exact: true }).click();
    const result = page.getByRole("dialog", { name: "角色a" });
    await expect(result.getByText("裸号估值结论", { exact: true })).toBeVisible();
    await expect(result.getByRole("heading", { name: "估值明细", exact: true })).toBeVisible();
    await result.getByText("查看本次使用的 Prompt 模板", { exact: true }).click();
    await expect(result).toContainText("请简洁说明主要待确认项。");
    expect(calls).toBe(1);
    expect(store.overview().run).toMatchObject({ total: 1, completed: 1, model: "other-model" });
    await page.screenshot({ path: testInfo.outputPath("valuation-result.png"), fullPage: true });
    await result.getByRole("button", { name: "关闭分析详情" }).click();
    await page.getByLabel("试分析数量").selectOption("3");
    await page.getByRole("button", { name: "先分析 3 件", exact: true }).click();
    await expect(
      page.getByText("本批次完成：3 件成功，0 件失败，0 件复用已有结果。", { exact: true }),
    ).toBeVisible();
    expect(calls).toBe(4);
    expect(store.overview().run).toMatchObject({
      total: 3,
      completed: 3,
      failed: 0,
      model: "other-model",
    });
    await expect(page.getByRole("row").filter({ hasText: "角色d" })).toContainText("待分析");
    await page.screenshot({
      path: testInfo.outputPath("valuation-three-completed-fixture.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    await expect(settings.getByLabel("最高买入系数 b", { exact: true })).toHaveValue("0.8");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(settings.getByRole("button", { name: "关闭分析设置" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("valuation-settings-mobile.png"),
      fullPage: true,
    });
    await settings.getByRole("button", { name: "关闭分析设置" }).click();
  } finally {
    await runner.shutdown();
    crawl.db.close();
  }
});
