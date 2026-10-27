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

// Failure cases: more than ten recommendations are truncated; copy loses important fields;
// failed clipboard writes mark items viewed; failed view saves hide items; successful views
// disappear only temporarily and return after reload. Clipboard and API transport are simulated.
test("推荐榜显示更多商品，复制成功后持久标记，失败保留推荐", async ({ page }, testInfo) => {
  const database = testInfo.outputPath("recommendation-copy.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  const crawl = new CrawlStore(database);
  const store = new AnalysisStore(crawl.db);
  try {
    const keys = Array.from({ length: 12 }, (_, index) => `copy-${String(index).padStart(2, "0")}`);
    for (const key of keys) {
      const record = analysisRecord(key);
      record.listing.price = "1000";
      const gear = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
      gear.items = [];
      gear.text = "没有装备";
      record.detail!.equipmentCapture!.emptyProof = "explicit-text";
      const pets = record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
      pets.pets = [];
      pets.petCount = 0;
      crawl.observe(record.listing);
      expect(crawl.save(record.listing, record.detail!)).toBe(true);
    }
    const batch = store.createRun("codex", "fixture-model", true);
    for (const key of keys) {
      const record = crawl.detail(key) as SavedRoleRecord;
      const result = {
        ...analysisResponse(record),
        valuation: {
          ...calculateValuation(record, createProfile("fixture")),
          ...compareListingPrice(1200, Number(record.listing.price)),
          asset_scope: "body",
          bare_role_value: 1200,
          model_value: 1200,
        },
      };
      crawl.db
        .prepare(
          "UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=? WHERE listing_key=?",
        )
        .run(JSON.stringify(result), new Date().toISOString(), key);
    }
    crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(batch);
    expect(store.overview().ranking).toHaveLength(12);
    let failViewSave = false;
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          async writeText(value: string) {
            if (sessionStorage.getItem("reject-copy") === "yes") throw new Error("模拟复制失败");
            sessionStorage.setItem("copied-content", value);
          },
        },
      });
    });
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
        else if (url.pathname === "/api/analysis/recommendation/view") {
          if (failViewSave) return route.fulfill({ status: 500, json: { error: "模拟保存失败" } });
          body = store.markRecommendationViewed(route.request().postDataJSON().key);
        } else throw new Error("未模拟接口：" + url.pathname);
        return route.fulfill({ json: body });
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
    const cards = ranking.getByRole("article");
    const card = (key: string) => cards.filter({ hasText: `角色${key}` });
    const viewedRows = () =>
      crawl.db.prepare("SELECT listing_key FROM recommendation_views ORDER BY listing_key").all();
    await expect(cards).toHaveCount(12);
    await expect(card("copy-11")).toBeVisible();

    await page.evaluate(() => sessionStorage.setItem("reject-copy", "yes"));
    await card("copy-00").getByRole("button", { name: "一键复制" }).click();
    await expect(ranking).toContainText("复制失败");
    await expect(card("copy-00")).toBeVisible();
    expect(viewedRows()).toEqual([]);

    await page.evaluate(() => sessionStorage.removeItem("reject-copy"));
    failViewSave = true;
    await card("copy-01").getByRole("button", { name: "一键复制" }).click();
    await expect(ranking).toContainText("已复制，但未能保存已查看状态");
    await expect(card("copy-01")).toBeVisible();
    expect(viewedRows()).toEqual([]);
    failViewSave = false;

    await card("copy-02").getByRole("button", { name: "一键复制" }).click();
    await expect(ranking).toContainText("已复制，并标记为已查看");
    await expect(cards).toHaveCount(11);
    const copied = await page.evaluate(() => sessionStorage.getItem("copied-content"));
    expect(copied).toContain("角色：角色copy-02");
    expect(copied).toContain("区服：测试服");
    expect(copied).toContain("挂牌价格：");
    expect(copied).toContain("裸号预估价：");
    expect(copied).toContain("商品链接：https://xyq.cbg.163.com/equip?s=367&eid=item-copy-02");
    expect(viewedRows()).toEqual([{ listing_key: "copy-02" }]);
    await page.reload();
    await page.getByRole("tab", { name: /推荐榜/ }).click();
    await expect(cards).toHaveCount(11);
    await expect(card("copy-02")).toHaveCount(0);
    await ranking.getByRole("checkbox", { name: "显示已查看的推荐" }).check();
    await expect(cards).toHaveCount(12);
    await expect(card("copy-02")).toContainText("已查看");
    await page.screenshot({
      path: testInfo.outputPath("recommendations-viewed.png"),
      fullPage: true,
    });
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          simulated: { listings: true, apiTransport: true, clipboard: true },
          real: "SQLite persistence and rendered UI",
          initialRecommendations: 12,
          copied,
          viewed: viewedRows(),
          failureCases: ["clipboard rejected", "view save rejected"],
          repeat:
            "vp run build && vp exec playwright test tests/e2e/recommendation-copy.pw.ts --workers=1",
        },
        null,
        2,
      ),
    );
  } finally {
    crawl.close();
  }
});
