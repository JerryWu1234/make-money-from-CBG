import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import { AnalysisRunner } from "../../server/analysis/runner";
import { createProfile, PROMPT_FILE } from "../../server/analysis/profile";
import { calculateValuation } from "../../server/analysis/valuation-calculator";
import {
  searchEquipmentPrices,
  type EquipmentSource,
} from "../../server/analysis/equipment-pricing";
import { searchPetPricing } from "../../server/analysis/pet-pricing";
import { searchPetGearPricing } from "../../server/analysis/pet-gear-search";
import { valuationRecord } from "../fixtures/analysis";
import { buildProductDocument } from "../../server/analysis/product-document";

// Isolated workflow failure cases: empty samples block AI, other assets lose their price,
// excluded assets become zero-valued, zero-level/wild pets or their gear still query the market,
// dedicated/bound or unsupported-level equipment blocks the quote or queries invalid samples,
// or refresh searches/analyzes the same record again.
// A no-sample parent must skip its carried gear, keep unknown prices/reasons, and reach AI.
// Search responses and AI are synthetic; runner, source verification, storage and UI are real.
for (const rule of [
  "no-sample",
  "no-sample-large-input",
  "zero-level",
  "wild",
  "special-type",
] as const) {
  test(`资产查价直接分析 ${rule}：汇总、详情与刷新`, async ({ page }, testInfo) => {
    const crawl = new CrawlStore(":memory:");
    const record = valuationRecord("skip-workflow");
    const noSample = rule.startsWith("no-sample");
    if (rule === "no-sample-large-input")
      record.detail!.tabs[0].text += "\n【模拟长原文】" + "x".repeat(140 * 1024);
    const captured = {
      version: 1 as const,
      collectedAt: record.detail!.collectedAt,
      complete: true,
      issues: [],
    };
    record.detail!.equipmentCapture = captured;
    record.detail!.petCapture = captured;
    const description = "等级：100\n防御：50\n气血：250\n耐久：100\n修理失败：0";
    record.detail!.tabs.push({
      name: "道具/法宝",
      text: "",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [
        { index: 0, kind: "equipment", category: "腰带", name: "无样本腰带", description },
        { index: 1, kind: "equipment", category: "腰带", name: "有报价腰带", description },
        {
          index: 2,
          kind: "equipment",
          category: "腰带",
          name: "专用腰带",
          description: description + "\n玩家123专用",
        },
        {
          index: 3,
          kind: "equipment",
          category: "腰带",
          name: "不支持等级腰带",
          description: description.replace("等级：100", "等级：50"),
        },
      ],
    });
    record.detail!.tabs.push({
      name: "召唤兽/孩子",
      text: "",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      petCount: 1,
      pets: [
        {
          index: 0,
          name: rule === "special-type" ? "恶魔泡泡" : "泡泡",
          fields: Object.entries({
            类型: rule === "special-type" ? "恶魔泡泡" : "泡泡",
            等级: rule === "zero-level" ? "0" : "1",
            是否宝宝: rule === "wild" ? "否" : "是",
            成长: "1.2",
            攻击资质: "1200",
            防御资质: "1200",
            体力资质: "3000",
            法力资质: "1500",
            速度资质: "1000",
            躲闪资质: "1000",
          }).map(([name, value]) => ({ name, value })),
          skills: [],
          innerSkills: [],
          equipment:
            rule === "special-type"
              ? []
              : [
                  {
                    index: 0,
                    kind: "equipment",
                    name: "测试项圈",
                    description: "等级95\n速度+20\n耐久100",
                  },
                ],
        },
      ],
    });
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const inputBytes = Buffer.byteLength(buildProductDocument(record).text);
    if (rule === "no-sample-large-input") {
      expect(inputBytes).toBeGreaterThan(128 * 1024);
      expect(inputBytes).toBeLessThan(256 * 1024);
    }
    const store = new AnalysisStore(crawl.db);
    const profile = createProfile(
      await readFile(PROMPT_FILE, "utf8"),
      { servers: [{ serverId: record.listing.serverId, age: "three", rank: 10 }] },
      true,
      true,
    );
    const samplePrices = [100, 110, 120, 130, 140];
    const sampleAverage = 120;
    let equipmentCalls = 0,
      petCalls = 0,
      gearCalls = 0,
      aiCalls = 0;
    const source: EquipmentSource = {
      findCandidates: async (items) => {
        equipmentCalls++;
        expect(items.some((item) => ["专用腰带", "不支持等级腰带"].includes(item.name))).toBe(
          false,
        );
        return {
          queries: ["模拟条件，非真实行情"],
          searchItems: [
            { key: items[0].key, modes: [{ mode: "exact", exhausted: false }] },
            { key: items[1].key, modes: [{ mode: "exact", exhausted: false }] },
          ],
          items: [
            { key: items[0].key, candidates: [], searchState: "pending", samplingStopped: true },
            {
              key: items[1].key,
              searchState: "completed",
              candidates: samplePrices.map((price) => ({
                url: "https://xyq.cbg.163.com/equip/1/fixture-skip-" + price,
                title: "有报价腰带",
                price,
                priceType: "listing" as const,
                quote: "挂牌价：¥" + price,
                verified: false,
                reason: "",
                fetchedAt: null,
                sourceHash: null,
              })),
            },
          ],
        };
      },
      readSource: async (url) =>
        `<p>在售</p><h1>有报价腰带</h1><pre>${description}</pre><div>挂牌价：¥${url.match(/fixture-skip-(\d+)/)![1]}</div>`,
    };
    const runner = new AnalysisRunner(store, async () => ({
      model: "fixture-model",
      searchEquipment: (record, signal, settings, previous) =>
        searchEquipmentPrices(record, signal, source, settings, previous),
      searchPets: (record, signal, previous) =>
        searchPetPricing(
          record,
          signal,
          {
            findCandidates: async (items) => {
              petCalls++;
              return {
                queries: rule === "special-type" ? [] : ["模拟宝宝空结果"],
                searchItems: items.map((item) =>
                  rule === "special-type"
                    ? { key: item.key, reason: "official_non_saleable_type", name: item.name }
                    : { key: item.key, exhausted: false },
                ),
                items: items.map((item) => ({
                  key: item.key,
                  candidates: [],
                  searchState:
                    rule === "special-type" ? ("skipped" as const) : ("pending" as const),
                  ...(rule === "special-type"
                    ? { skipReason: "官网无独立交易筛选的特殊宝宝，未计入参考合计" }
                    : { samplingStopped: true }),
                })),
              };
            },
            readSource: async () => {
              throw new Error("空候选不应读取详情");
            },
          },
          previous,
        ),
      searchPetGear: (record, signal, previous, pets) => {
        gearCalls++;
        return searchPetGearPricing(record, signal, previous, pets);
      },
      analyze: async () => {
        aiCalls++;
        return {
          text: JSON.stringify({
            decision: "NEED_INFO",
            reason: "模拟分析：无样本项目跳过，只汇总已计价资产。",
            extracted_facts: [],
          }),
        };
      },
    }));
    try {
      await page.context().route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== "http://cbg-skip.test") return route.abort();
        if (url.pathname.startsWith("/api/")) {
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
                models: [{ id: "fixture-model", name: "测试模型" }],
              };
              break;
            case "/api/analysis/settings":
              body = { profile, promptFile: PROMPT_FILE, servers: [], market: [] };
              break;
            case "/api/analysis/status":
              body = store.overview({ provider: "codex", currentProfile: profile });
              break;
            case "/api/analysis/start":
              body = store.run(await runner.start("codex", true, profile));
              break;
            case "/api/analysis/detail":
              body = store.detail(url.searchParams.get("taskId")!, profile);
              break;
            default:
              throw new Error("未模拟接口：" + url.pathname);
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
      await page.goto("http://cbg-skip.test/analysis-preview");
      await page.getByRole("button", { name: "开始分析已有商品", exact: true }).click();
      const completed = page.getByRole("tabpanel", { name: "分析记录" });
      await expect(completed.getByRole("article")).toHaveCount(1);
      expect(store.overview().run).toMatchObject({ completed: 1, waitingPricing: 0, failed: 0 });
      const saved = store.overview().results.items[0];
      const result = saved.result.valuation!;
      const bare = calculateValuation(record, profile);
      expect(result.estimated_value).toBe(bare.model_value! + sampleAverage);
      expect(result.estimate_missing_count).toBe(0);
      expect(result).not.toHaveProperty("role_pricing");
      expect(result).not.toHaveProperty("special_asset_reference");
      expect(result.equipment_pricing?.items[1].candidates).toHaveLength(5);
      expect(result.excluded_assets).toHaveLength(4);
      expect(result.equipment_pricing?.items[3]).toMatchObject({
        status: "unsupported",
        searchState: "skipped",
        skipReason: "官网检索不支持的等级装备，未计入参考合计",
        referencePrice: null,
        candidates: [],
      });
      expect(result.equipment_pricing?.items[2]).toMatchObject({
        status: "untradable",
        searchState: "skipped",
        skipReason: "专用或绑定装备，未计入参考合计",
        referencePrice: null,
        candidates: [],
      });
      expect(result.equipment_pricing?.items[0]).toMatchObject({
        searchState: "skipped",
        referencePrice: null,
      });
      expect(result.equipment_pricing?.items[1].referencePrice).toBe(sampleAverage);
      expect(result.pet_pricing?.items[0]).toMatchObject({
        searchState: "skipped",
        referencePrice: null,
      });
      if (noSample) {
        expect(result.pet_pricing?.gearPricing).toMatchObject({
          searchComplete: true,
          total: null,
          knownTotal: 0,
          items: [
            {
              skippedWithPet: true,
              searchState: "skipped",
              searchStatus: "skipped",
              referencePrice: null,
              candidates: [],
              skipReason: expect.stringContaining("所属宝宝“泡泡”已跳过"),
            },
          ],
        });
      }
      await completed.getByRole("button", { name: /查看分析详情/ }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("region", { name: "整号市场参考", exact: true })).toHaveCount(
        0,
      );
      const breakdown = dialog.locator('dl[aria-label="价格组成"]');
      await expect(breakdown).toContainText(
        noSample ? "无样本，未计入参考合计" : "按规则跳过，未计入参考合计",
      );
      await expect(breakdown).not.toContainText("未定价");
      await expect(breakdown).not.toContainText("已算小计区间");
      await dialog.getByText("查看估值依据与查价记录", { exact: true }).click();
      for (const asset of ["装备", "宝宝"]) {
        const skipLabel =
          asset === "装备" || noSample
            ? "无样本，未计入参考合计"
            : rule === "zero-level"
              ? "0级宝宝，未计入参考合计"
              : rule === "special-type"
                ? "官网无独立交易筛选的特殊宝宝，未计入参考合计"
                : "野生宝宝，未计入参考合计";
        await expect(
          dialog.getByRole("region", {
            name: asset + (asset === "宝宝" && !noSample ? "查价" : "联网查价"),
            exact: true,
          }),
        ).toContainText(skipLabel);
      }
      await expect(dialog).toContainText("市场售价未知");
      if (noSample) await expect(dialog).toContainText("随身装备不再核验");
      await expect(dialog.getByRole("region", { name: "装备联网查价", exact: true })).toContainText(
        "专用或绑定装备，未计入参考合计",
      );
      await expect(dialog.getByRole("region", { name: "装备联网查价", exact: true })).toContainText(
        "官网检索不支持的等级装备，未计入参考合计",
      );
      if (!noSample)
        await expect(dialog.getByRole("region", { name: "宝宝查价", exact: true })).toContainText(
          "按规则跳过",
        );
      if (!noSample)
        await expect(dialog.getByRole("region", { name: "宝宝查价", exact: true })).toContainText(
          "未发起查价",
        );
      await expect(dialog).not.toContainText("还有未定价项目，总估值暂无法计算。");
      await dialog.screenshot({ path: testInfo.outputPath("no-sample-skip.png") });
      await page.reload();
      await expect(completed.getByRole("article")).toHaveCount(1);
      expect([equipmentCalls, petCalls, aiCalls]).toEqual([
        1,
        noSample || rule === "special-type" ? 1 : 0,
        1,
      ]);
      expect(gearCalls).toBe(noSample ? 1 : 0);
      await writeFile(
        testInfo.outputPath("no-sample-skip.json"),
        JSON.stringify(
          {
            scenario: "仅裸号本体、装备和宝宝估值的完整流程；模拟行情和AI，不代表真实市场验收",
            skipRule: rule,
            inputBytes,
            samplePrices,
            sampleAverage,
            calls: { equipmentCalls, petCalls, gearCalls, aiCalls },
            bareValue: bare.model_value,
            expectedValue: bare.model_value! + sampleAverage,
            detail: store.detail(saved.taskId, profile),
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
}
