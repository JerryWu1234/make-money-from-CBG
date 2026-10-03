import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import type { SavedRoleRecord } from "../../server/crawler/types";
import { AnalysisStore } from "../../server/analysis/store";
import { AnalysisRunner } from "../../server/analysis/runner";
import { createProfile, PROMPT_FILE } from "../../server/analysis/profile";
import {
  calculateValuation,
  compareListingPrice,
  purchase,
} from "../../server/analysis/valuation-calculator";
import type { ValuationResult } from "../../server/analysis/valuation-types";
import {
  analysisRecord,
  equipmentPricingFixture,
  petPricingFixture,
  valuationRecord,
} from "../fixtures/analysis";

test("估值页面：纯挂牌差价、装备搜索依据、缺项与历史购买结果", async ({ page }, testInfo) => {
  const crawl = new CrawlStore(":memory:");
  const keys = ["a", "b", "c", "d"];
  for (const key of keys) {
    const record = key === "b" || key === "c" ? valuationRecord(key) : analysisRecord(key);
    if (key === "c") record.listing.price = "100000";
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
  }
  const store = new AnalysisStore(crawl.db);
  const automaticServer = {
    serverId: analysisRecord().listing.serverId,
    serverName: "测试服",
    age: "older" as const,
    rank: 13,
    goldPrice: 218.29,
    goldUnit: 30000000,
    baselineUnitConfirmed: true,
    source: "auto" as const,
    fetchedAt: new Date().toISOString(),
    sources: ["https://www.aimhxy.com/hot", "https://www.aimhxy.com/mhb"],
  };
  let profile = createProfile(
    await readFile(PROMPT_FILE, "utf8"),
    { servers: [automaticServer] },
    false,
  );
  let legacyView = false;
  let searchingView = false;
  let searchPhase: "equipment_search" | "pet_search" = "equipment_search";
  const displayed = (valuation: ValuationResult | undefined, key: string) => {
    if (!valuation) return valuation;
    if (legacyView) {
      const {
        comparison_mode: _mode,
        price_difference: _difference,
        price_difference_ratio: _ratio,
        ...legacy
      } = valuation;
      return {
        ...legacy,
        ...purchase(valuation.model_value, valuation.asking_price, {
          ...profile.settings,
          extraCost: 0,
        }),
      };
    }
    if (key !== "a" && key !== "b") return valuation;
    const pricing = equipmentPricingFixture(key === "a");
    const pets = key === "b" ? petPricingFixture() : undefined;
    const value =
      pricing.total !== null && valuation.bare_role_value != null
        ? valuation.bare_role_value + pricing.total + (pets?.total ?? 0)
        : null;
    return {
      ...valuation,
      ...compareListingPrice(value, valuation.asking_price),
      model_value: value,
      equipment_value: pricing.total,
      equipment_pricing: pricing,
      pet_value: pets?.total,
      pet_pricing: pets,
      price_comparison_scope: pets
        ? "裸号、人物装备/灵饰与宝宝；锦衣未计价"
        : "裸号及已核实装备参考价；召唤兽个体和锦衣未计价",
      reason:
        value === null
          ? "装备或裸号计价尚未完整，暂无法比较完整挂牌差异。"
          : `参考估值¥${value.toFixed(2)}，挂牌价¥${valuation.asking_price!.toFixed(2)}；差额¥${(value - valuation.asking_price!).toFixed(2)}。`,
    };
  };
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
              servers: [{ serverId: analysisRecord().listing.serverId, serverName: "测试服" }],
              market: [automaticServer],
            };
            break;
          case "/api/analysis/settings/save":
            expect(input.baseHash).toBe(profile.hash);
            profile = createProfile(input.template, input.settings, false);
            body = { profile };
            break;
          case "/api/analysis/status": {
            const overview = store.overview({
              provider: "codex",
              runId: url.searchParams.get("runId") || undefined,
            });
            body = {
              ...overview,
              ...(searchingView && overview.run
                ? {
                    run: { ...overview.run, status: "running", completed: 2, queued: 1 },
                    activeRun: {
                      ...overview.run,
                      status: "running",
                      completed: 2,
                      queued: 1,
                      current: "角色b",
                      phase: searchPhase,
                    },
                  }
                : {}),
              ranking: overview.ranking.map((item) => ({
                ...item,
                valuation: displayed(item.valuation, item.key),
              })),
              records: {
                ...overview.records,
                items: overview.records.items.map((item) => ({
                  ...item,
                  valuation: displayed(item.valuation, item.key),
                })),
              },
              profile: {
                hash: profile.hash,
                version: profile.version,
                promptHash: profile.promptHash,
                calculationCompatible: profile.calculationCompatible,
              },
            };
            break;
          }
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
          case "/api/analysis/detail": {
            const detail = store.detail(url.searchParams.get("taskId")!);
            body = detail?.result
              ? {
                  ...detail,
                  result: {
                    ...detail.result,
                    valuation: displayed(detail.result.valuation, detail.listing.key),
                  },
                }
              : detail;
            break;
          }
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
    const settings = page.getByRole("dialog", { name: "估值与挂牌比较设置" });
    await expect(settings.getByLabel("最高买入系数 b", { exact: true })).not.toBeVisible();
    await expect(settings.getByLabel("全部额外成本 F（元）", { exact: true })).not.toBeVisible();
    await expect(settings).toContainText("先核对装备和宝宝，再联网查价，比较挂牌差异");
    await settings.getByText("全服行情：自动匹配每件商品的区服", { exact: true }).click();
    await expect(settings.getByLabel("热度排名 r", { exact: true })).toHaveValue("13");
    await expect(settings.getByLabel("金价 G（元）", { exact: true })).toHaveValue("218.29");
    await expect(settings.getByLabel("报价单位 U（游戏币数）", { exact: true })).toHaveValue(
      "30000000",
    );
    await settings.getByRole("combobox", { name: "区服年代", exact: true }).selectOption("three");
    await settings.getByLabel("热度排名 r", { exact: true }).fill("10");
    await settings.getByText("编辑完整 Prompt", { exact: true }).click();
    const prompt = settings.getByLabel("估值 Prompt 全文");
    await prompt.fill((await prompt.inputValue()) + "\n请简洁说明主要待确认项。");
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await expect(settings).not.toBeVisible();
    await expect(
      page.getByText("设置已保存。新批次使用新设置，旧批次仍保留原来的 Prompt 和参数。"),
    ).toBeVisible();
    expect(calls).toBe(0);
    expect(profile.settings).toMatchObject({ b: 0.8, extraCost: null });
    await expect(page.getByLabel("分析模型")).toHaveValue("");
    await page.getByLabel("分析模型").selectOption("other-model");
    await page.getByRole("button", { name: "先分析 1 件", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "全部商品" })).toBeVisible();
    const row = page.getByRole("row").filter({ hasText: "角色a" });
    await expect(row).toContainText("暂无法比较");
    await expect(row).toContainText("分析完成 · 待补齐");
    await row.getByRole("button", { name: "查看分析", exact: true }).click();
    const result = page.getByRole("dialog", { name: "角色a" });
    await expect(result.getByText("估值与挂牌价比较", { exact: true })).toBeVisible();
    await expect(result.getByText("已算部分（非完整估值）", { exact: true })).toBeVisible();
    await expect(result.getByRole("heading", { name: "建议怎么补齐", exact: true })).toBeVisible();
    await expect(result.getByText("理想买入价", { exact: true })).not.toBeVisible();
    await expect(result.getByRole("heading", { name: "估值明细", exact: true })).toBeVisible();
    await expect(result.getByRole("heading", { name: "装备联网查价", exact: true })).toBeVisible();
    await expect(result).toContainText("已核实装备小计（非完整总价）");
    await expect(result).toContainText("未采到武器伤害属性，不能匹配报价");
    await expect(result).toContainText("未找到可靠报价");
    await expect(result).toContainText("已搜索，但没有找到属性匹配且有明确挂牌价的网页");
    await expect(result.getByText("估值与挂牌价差额", { exact: true })).not.toBeVisible();
    await result.screenshot({ path: testInfo.outputPath("valuation-result.png") });
    await result.getByText("查看本次使用的 Prompt 模板", { exact: true }).click();
    await expect(result).toContainText("请简洁说明主要待确认项。");
    expect(calls).toBe(1);
    expect(store.overview().run).toMatchObject({ total: 1, completed: 1, model: "other-model" });
    await result.getByRole("button", { name: "去补充分析设置", exact: true }).click();
    await expect(result).not.toBeVisible();
    await expect(settings).toBeVisible();
    await settings.getByRole("button", { name: "关闭分析设置" }).click();
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
    const buyRow = page.getByRole("row").filter({ hasText: "角色b" });
    await expect(buyRow.getByText("挂牌低于估值", { exact: true })).toBeVisible();
    await expect(buyRow).toContainText("裸号、装备和宝宝参考估值");
    await expect(buyRow).toContainText("差额");
    await expect(page.getByRole("row").filter({ hasText: "角色c" })).toContainText("挂牌高于估值");
    await page.screenshot({
      path: testInfo.outputPath("valuation-three-completed-fixture.png"),
      fullPage: true,
    });
    await buyRow.getByRole("button", { name: "查看分析", exact: true }).click();
    const buyResult = page.getByRole("dialog", { name: "角色b" });
    await expect(buyResult.getByText("挂牌低于估值", { exact: true })).toBeVisible();
    await expect(buyResult.getByText("裸号参考估值", { exact: true })).toBeVisible();
    await expect(buyResult.getByText("估值与挂牌价差额", { exact: true })).toBeVisible();
    await expect(buyResult.getByText("差异比例（以挂牌价为基准）", { exact: true })).toBeVisible();
    await expect(
      buyResult.getByRole("heading", { name: "宝宝联网查价", exact: true }),
    ).toBeVisible();
    await expect(buyResult.getByText("宝宝挂牌参考价", { exact: true })).toBeVisible();
    await buyResult.getByText("模拟测试宝宝挂牌样本 · 已核实", { exact: true }).click();
    await expect(buyResult).toContainText("【模拟测试宝宝样本】画魂");
    await expect(buyResult.locator('a[href*="mock-pet-ui"]')).toHaveAttribute(
      "href",
      "https://xyq.cbg.163.com/equip?s=367&eid=mock-pet-ui",
    );
    await expect(buyResult.getByText("建议最高买入价", { exact: true })).not.toBeVisible();
    await expect(buyResult.getByText("暂无法计算", { exact: true })).not.toBeVisible();
    await expect(buyResult.getByText("理想买入价", { exact: true })).not.toBeVisible();
    await buyResult
      .getByRole("region", { name: "装备联网查价", exact: true })
      .getByText("查看搜索关键词", { exact: true })
      .click();
    await expect(buyResult).toContainText("梦幻西游 测试铠甲 120级 防御200 挂牌价格");
    await buyResult.getByText("模拟测试装备挂牌样本 · 已核实", { exact: true }).click();
    await expect(
      buyResult
        .getByRole("region", { name: "装备联网查价", exact: true })
        .getByRole("link", { name: "打开来源网页", exact: true }),
    ).toHaveAttribute("href", "https://xyq.cbg.163.com/equip?s=367&eid=mock-price-ui");
    await expect(buyResult).toContainText("网页挂牌价");
    await expect(buyResult).toContainText("读取时间");
    await expect(buyResult).toContainText("已核实挂牌样本：1条");
    await expect(buyResult).toContainText("仅1条挂牌样本，参考范围有限");
    await expect(buyResult).toContainText("耐久300/500，可正常修理");
    await expect(buyResult).toContainText("【模拟测试样本】测试铠甲");
    await buyResult.getByText("未匹配的模拟样本 · 未采用", { exact: true }).click();
    await expect(buyResult).toContainText("装备等级不同，不计入参考价");
    await buyResult.screenshot({
      path: testInfo.outputPath("valuation-buy-result.png"),
    });
    await buyResult.getByRole("button", { name: "关闭分析详情" }).click();
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    await expect(settings.getByLabel("最高买入系数 b", { exact: true })).not.toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(settings.getByRole("button", { name: "关闭分析设置" })).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("valuation-settings-mobile.png"),
      fullPage: true,
    });
    await settings.getByRole("button", { name: "关闭分析设置" }).click();
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.getByRole("button", { name: "分析设置", exact: true }).click();
    await settings.getByText("全服行情：自动匹配每件商品的区服", { exact: true }).click();
    await settings.getByRole("button", { name: "恢复本服自动行情" }).click();
    await expect(settings.getByRole("combobox", { name: "区服年代", exact: true })).toHaveValue(
      "older",
    );
    await expect(settings.getByLabel("热度排名 r", { exact: true })).toHaveValue("13");
    await settings.getByRole("button", { name: "保存设置", exact: true }).click();
    await page.getByRole("button", { name: "先分析 3 件", exact: true }).click();
    await expect(
      page.getByText("本批次完成：3 件成功，0 件失败，0 件复用已有结果。", { exact: true }),
    ).toBeVisible();
    const pricedWithoutFees = page.getByRole("row").filter({ hasText: "角色b" });
    await pricedWithoutFees.getByRole("button", { name: "查看分析", exact: true }).click();
    await expect(buyResult.getByText("裸号参考估值", { exact: true })).toBeVisible();
    await expect(buyResult.getByText("估值与挂牌价差额", { exact: true })).toBeVisible();
    await expect(
      buyResult.getByText("建议最高总成本（含费用）", { exact: true }),
    ).not.toBeVisible();
    await expect(buyResult.getByText("建议最高买入价", { exact: true })).not.toBeVisible();
    await expect(buyResult.getByText("暂无法计算", { exact: true })).not.toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      buyResult.getByRole("heading", { name: "装备联网查价", exact: true }),
    ).toBeVisible();
    await buyResult
      .getByRole("heading", { name: "装备联网查价", exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await buyResult.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    await buyResult.screenshot({ path: testInfo.outputPath("equipment-pricing-mobile.png") });
    await buyResult.getByRole("button", { name: "关闭分析详情" }).click();
    searchingView = true;
    await page.reload();
    await expect(page.getByText("正在联网查装备价格 · 角色b", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "正在查价…", exact: true })).toBeDisabled();
    searchPhase = "pet_search";
    await page.reload();
    await expect(page.getByText("正在联网查宝宝价格 · 角色b", { exact: true })).toBeVisible();
    searchingView = false;
    legacyView = true;
    await page.reload();
    await page.getByRole("tab", { name: /全部商品/ }).click();
    await page
      .getByRole("row")
      .filter({ hasText: "角色b" })
      .getByRole("button", { name: "查看分析", exact: true })
      .click();
    await expect(buyResult.getByText("裸号买入建议", { exact: true })).toBeVisible();
    await expect(buyResult.getByText("建议最高买入价", { exact: true })).toBeVisible();
    await expect(buyResult.getByText("购买总成本", { exact: true })).toBeVisible();
    await expect(buyResult.getByText("估值与挂牌价差额", { exact: true })).not.toBeVisible();
  } finally {
    await runner.shutdown();
    crawl.db.close();
  }
});
