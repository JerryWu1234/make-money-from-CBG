import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import {
  calculateValuation,
  compareListingPrice,
} from "../../server/analysis/valuation-calculator";
import { createProfile } from "../../server/analysis/profile";
import { analysisRecord, analysisResponse } from "../fixtures/analysis";
import type { SavedRoleRecord } from "../../server/crawler/types";

// Failure cases: backend filter omitted, tier boundary excluded, manual products automatically
// included, viewed products reappear, showing all overrides eligibility,
// refresh loses view history, stale results remain, missing inventory summary, bare-role
// discounts require assets, or wild/future pet skills appear as usable assets.
// All records are simulated; SQLite and UI are real.
test("推荐榜裸号折价与原差额阶梯→查看不隐藏→确认隐藏→全部商品与详情→刷新→过期结果移出", async ({
  page,
}, testInfo) => {
  const database = testInfo.outputPath("recommendation.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  const crawl = new CrawlStore(database);
  const store = new AnalysisStore(crawl.db);
  try {
    for (const key of [
      "gem",
      "pet",
      "wild",
      "far",
      "manual",
      "wide",
      "bare-discount",
      "bare-equal",
      "bare-over",
    ]) {
      const r = analysisRecord(key);
      r.listing.price =
        key === "manual" ? "20000" : key === "gem" ? "2000" : key === "far" ? "3000" : "1000";
      r.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items =
        key === "gem" || key === "far" || key === "manual" || key === "wide"
          ? Array.from({ length: 3 }, (_, index) => ({
              index,
              name: "测试头盔" + index,
              kind: "equipment",
              category: "人物装备 · 头盔",
              description:
                "等级 100\n防御 +60\n锻炼等级 5\n宝石：月亮石" +
                (index === 0 ? "\n特技：罗汉金钟\n套装效果：附加状态变身" : ""),
            }))
          : [];
      if (key === "gem")
        r.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items!.push({
          index: 3,
          name: "测试戒指",
          kind: "equipment",
          category: "灵饰 · 戒指",
          kindId: "61",
          description: "等级 100\n伤害 +20\n精炼等级 3\n特效：超级简易",
        });
      const pets = r.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
      pets.pets =
        key === "pet" || key === "wild"
          ? [
              {
                index: 1,
                name: "画魂",
                fields: [
                  { name: "类型", value: "画魂" },
                  { name: "等级", value: "165" },
                  { name: "是否宝宝", value: key === "pet" ? "是" : "否" },
                ],
                skills: [
                  { index: 0, name: "须弥真言" },
                  { index: 1, name: "高级魔之心" },
                  {
                    index: 2,
                    name: "进化后技能",
                    skillObservation: {
                      rawName: "进化后技能",
                      type: "evolution",
                      state: "future",
                    },
                  },
                ],
                equipment: [],
                innerSkills: [],
              },
            ]
          : [];
      if (key === "pet") {
        const baby = pets.pets![0];
        pets.pets!.push(
          {
            ...baby,
            index: 2,
            fields: baby.fields.map((f) => (f.name === "是否宝宝" ? { ...f, value: "否" } : f)),
          },
          {
            ...baby,
            index: 3,
            fields: baby.fields.map((f) => (f.name === "等级" ? { ...f, value: "0" } : f)),
          },
        );
      }
      pets.petCount = pets.pets.length;
      if (key === "pet" || key === "wild" || key.startsWith("bare-")) {
        r.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.text = "没有装备";
        r.detail!.equipmentCapture!.emptyProof = "explicit-text";
      }
      crawl.observe(r.listing);
      expect(crawl.save(r.listing, r.detail!)).toBe(true);
    }
    const batch = store.createRun("codex", "fixture-model", true);
    for (const [key, bare] of Object.entries({
      gem: 1800,
      pet: 900,
      wild: 1000,
      far: 2799.99,
      manual: 18500,
      wide: 849.99,
      "bare-discount": 1200,
      "bare-equal": 1000,
      "bare-over": 999.99,
    })) {
      const r = crawl.detail(key) as SavedRoleRecord;
      const result = {
        ...analysisResponse(r),
        valuation: {
          ...calculateValuation(r, createProfile("fixture")),
          ...compareListingPrice(bare, Number(r.listing.price)),
          asset_scope: "body",
          bare_role_value: bare,
          model_value: bare,
        },
      };
      crawl.db
        .prepare(
          "UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=? WHERE listing_key=?",
        )
        .run(JSON.stringify(result), new Date().toISOString(), key);
    }
    crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(batch);
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://cbg-recommendation.test") return route.abort();
      if (url.pathname === "/api/runtime/settings")
        return route.fulfill({ json: { saveScreenshots: false } });
      if (url.pathname === "/api/browser/settings")
        return route.fulfill({ json: { mode: "daily", connected: true, busy: false } });
      if (url.pathname.startsWith("/api/")) {
        let body: unknown;
        if (url.pathname === "/api/ai/status")
          body = {
            codex: { state: "connected", model: "fixture-model", response: "READY" },
            deepseek: { state: "unconfigured" },
          };
        else if (url.pathname === "/api/ai/models")
          body = {
            provider: "codex",
            defaultModel: "fixture-model",
            models: [{ id: "fixture-model", name: "测试模型" }],
          };
        else if (
          url.pathname === "/api/analysis/status" ||
          url.pathname === "/api/analysis/progress"
        )
          body = store.overview({
            summary: true,
            showViewed: url.searchParams.get("showViewed") === "true",
          });
        else if (url.pathname === "/api/analysis/recommendation/view")
          body = store.markRecommendationViewed(route.request().postDataJSON().key);
        else if (url.pathname === "/api/analysis/detail")
          body = store.detail(url.searchParams.get("taskId")!);
        else throw new Error("未模拟接口：" + url.pathname);
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
      }
      const filename = path.join(
        "dist",
        url.pathname === "/analysis-preview" ? "index.html" : url.pathname,
      );
      return route.fulfill({
        contentType: filename.endsWith(".js")
          ? "application/javascript"
          : filename.endsWith(".css")
            ? "text/css"
            : "text/html",
        body: await readFile(filename),
      });
    });
    await page.goto("http://cbg-recommendation.test/analysis-preview");
    await page.getByRole("tab", { name: /推荐榜/ }).click();
    const ranking = page.getByRole("tabpanel", { name: "推荐榜" });
    await expect(ranking.getByRole("article")).toHaveCount(4);
    await expect(ranking).toContainText("角色gem");
    await expect(ranking).toContainText("角色pet");
    await expect(ranking).not.toContainText("角色wild");
    await expect(ranking).not.toContainText("角色far");
    await expect(ranking).toContainText("角色wide");
    await expect(ranking).toContainText("角色bare-discount");
    await expect(ranking).not.toContainText("角色bare-equal");
    await expect(ranking).not.toContainText("角色bare-over");
    await expect(ranking).toContainText("不限制差额百分比");
    await expect(ranking).toContainText("相差不超过 10 级");
    await expect(ranking.getByRole("region", { name: "人工复核" })).toHaveCount(0);
    await expect(ranking).not.toContainText("角色manual");
    await expect(ranking).toContainText("差额超过1000元不展示");
    await expect(ranking.getByRole("article").filter({ hasText: "角色manual" })).toHaveCount(0);
    const gearCard = ranking.getByRole("article").filter({ hasText: "角色gem" });
    const petCard = ranking.getByRole("article").filter({ hasText: "角色pet" });
    const bareCard = ranking.getByRole("article").filter({ hasText: "角色bare-discount" });
    await expect(bareCard).toContainText("挂牌低于裸号预估价");
    await expect(bareCard).toContainText("裸号预估价 ¥1,200.00");
    await expect(bareCard).toContainText("0 类配置");
    await bareCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("bare-role-discount.png"), fullPage: true });
    await expect(gearCard.getByLabel("装备和宝宝简要信息")).toContainText("装备 3件 · 灵饰 1件");
    await expect(gearCard).toContainText("带宝石/星辉石 4件");
    await expect(gearCard).toContainText("特技：罗汉金钟");
    await expect(gearCard).toContainText("套装：附加状态变身");
    await expect(gearCard).toContainText("星辉石3段");
    await expect(petCard).toContainText("非野生宝宝 1只");
    await expect(petCard).toContainText("画魂 / 165级 / 2技能：");
    await expect(petCard).toContainText("须弥真言");
    await expect(petCard).toContainText("高级魔之心");
    await expect(petCard).toContainText("野生1只（不计入）");
    await expect(petCard).toContainText("0级1只（不计入）");
    await expect(petCard).not.toContainText("进化后技能");
    await page.screenshot({
      path: testInfo.outputPath("asset-summary-desktop.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(gearCard.getByLabel("装备和宝宝简要信息")).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await gearCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("asset-summary-mobile.png") });
    await page.setViewportSize({ width: 1100, height: 1000 });
    await ranking.getByText("查看配置条件（每类只计一次）").click();
    await expect(ranking).toContainText("每类只计一次");
    await page.screenshot({ path: testInfo.outputPath("eligible-ranking.png"), fullPage: true });
    const showViewed = ranking.getByRole("checkbox", { name: "显示已隐藏的推荐" });
    await expect(showViewed).not.toBeChecked();
    await ranking
      .getByRole("article")
      .filter({ hasText: "角色gem" })
      .getByRole("button", { name: "查看分析依据 →" })
      .click();
    await expect(page.getByRole("dialog", { name: "角色gem" })).toBeVisible();
    await page.getByRole("button", { name: "关闭分析详情" }).click();
    await expect(ranking.getByRole("article")).toHaveCount(4);
    await expect(gearCard).toBeVisible();
    expect(crawl.db.prepare("SELECT listing_key FROM recommendation_views").all()).toEqual([]);
    await page.reload();
    await page.getByRole("tab", { name: /推荐榜/ }).click();
    await expect(gearCard).toBeVisible();
    await gearCard.getByRole("button", { name: "确认隐藏" }).click();
    await expect(ranking.getByRole("article")).toHaveCount(3);
    await expect(gearCard).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("viewed-hidden.png"), fullPage: true });
    await showViewed.check();
    await expect(ranking.getByRole("article")).toHaveCount(4);
    await expect(ranking).not.toContainText("角色manual");
    await expect(ranking.getByRole("article").filter({ hasText: "角色gem" })).toContainText(
      "已隐藏",
    );
    await page.screenshot({ path: testInfo.outputPath("viewed-shown.png"), fullPage: true });
    await showViewed.uncheck();
    await expect(ranking.getByRole("article")).toHaveCount(3);
    await page.getByRole("tab", { name: /全部商品/ }).click();
    await expect(page.getByRole("tabpanel", { name: "全部商品" }).getByRole("row")).toHaveCount(10);
    await page
      .getByRole("row")
      .filter({ hasText: "角色gem" })
      .getByRole("button", { name: "查看分析", exact: true })
      .click();
    await expect(page.getByRole("dialog", { name: "角色gem" })).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: /推荐榜/ }).click();
    await expect(showViewed).not.toBeChecked();
    await expect(ranking.getByRole("article")).toHaveCount(3);
    await expect(gearCard).toHaveCount(0);
    await showViewed.check();
    await expect(ranking.getByRole("article")).toHaveCount(4);
    const changed = crawl.detail("gem") as SavedRoleRecord;
    changed.listing.price = "2100";
    crawl.observe(changed.listing);
    await expect(ranking.getByRole("article")).toHaveCount(3, { timeout: 10000 });
    await expect(ranking).toContainText("角色pet");
    await page.screenshot({ path: testInfo.outputPath("stale-excluded.png"), fullPage: true });
    const evidence = testInfo.outputPath("evidence.json");
    await writeFile(
      evidence,
      JSON.stringify(
        {
          simulated: true,
          inventorySummaries: store
            .overview({ showViewed: true })
            .ranking.map(({ key, assetSummary }) => ({ key, assetSummary })),
          inventoryDisplay:
            "Observed gear/pets only; wild and level-zero pets separately labelled; future skills excluded; desktop and 390px mobile verified",
          eligible: ["gem", "pet", "wide", "bare-discount"],
          bareRoleDiscount: {
            listing: 1000,
            bareRoleEstimate: 1200,
            inventoryFactors: 0,
            reason: "挂牌低于裸号预估价",
          },
          excluded: {
            wild: "野生宝宝",
            far: "差额200.01元，仅1类配置不足",
            "bare-equal": "空号挂牌1000元，裸号预估1000元，未严格低于",
            "bare-over": "空号挂牌1000元，裸号预估999.99元，未满足折价或原配置规则",
          },
          aboveLimitExcluded: !store
            .overview({ showViewed: true })
            .ranking.some((r) => r.key === "manual"),
          viewed: crawl.db.prepare("SELECT listing_key FROM recommendation_views").all(),
          afterSourceChanged: store.overview().ranking.map((r) => r.key),
          database,
          repeat:
            "vp run build && vp exec playwright test tests/e2e/recommendation.pw.ts --workers=1",
        },
        null,
        2,
      ),
    );
    await testInfo.attach("推荐榜筛选证据", { path: evidence, contentType: "application/json" });
  } finally {
    crawl.close();
  }
});
