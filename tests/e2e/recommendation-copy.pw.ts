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

// Failure cases: more than 50 recommendations are inaccessible; paging changes ordering;
// copying hides items; failed hide saves remove items; repeated confirmation submits twice;
// confirmed hidden products return after reload; removing the last page leaves an invalid page;
// old cards or page controls remain active during a delayed page request.
// Clipboard and API transport are simulated.
test("推荐榜复制保留条目，确认后隐藏并持久保存，分页始终有效", async ({ page }, testInfo) => {
  const database = testInfo.outputPath("recommendation-copy.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  const crawl = new CrawlStore(database);
  const store = new AnalysisStore(crawl.db);
  try {
    const keys = Array.from({ length: 52 }, (_, index) => `copy-${String(index).padStart(2, "0")}`);
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
    expect(store.overview().ranking).toHaveLength(20);
    let failViewSave = false;
    const hideRequests: string[] = [];
    let holdViewSave = false;
    let releaseViewSave!: () => void;
    const viewSaveWait = new Promise<void>((resolve) => {
      releaseViewSave = resolve;
    });
    let holdSecondPage = false;
    let secondPageStarted = false;
    let releaseSecondPage!: () => void;
    const secondPageWait = new Promise<void>((resolve) => {
      releaseSecondPage = resolve;
    });
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
        ) {
          if (
            holdSecondPage &&
            url.pathname === "/api/analysis/status" &&
            url.searchParams.get("rankingPage") === "2"
          ) {
            secondPageStarted = true;
            await secondPageWait;
            holdSecondPage = false;
          }
          const overview = store.overview({
            summary: true,
            showViewed: url.searchParams.get("showViewed") === "true",
            rankingPage: Number(url.searchParams.get("rankingPage") || 1),
          });
          // Simulate an old record whose response no longer has a product URL.
          overview.ranking = overview.ranking.map((item) =>
            item.key === "copy-00" ? { ...item, url: "" } : item,
          );
          body = overview;
        } else if (url.pathname === "/api/analysis/recommendation/view") {
          hideRequests.push(route.request().postDataJSON().key);
          if (failViewSave) return route.fulfill({ status: 500, json: { error: "模拟保存失败" } });
          if (holdViewSave) await viewSaveWait;
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
    await expect(cards).toHaveCount(20);
    await expect(ranking).toContainText("共 52 件");
    await expect(ranking).toContainText("第 1 / 3 页");
    await card("copy-00").getByRole("button", { name: "一键复制" }).click();
    await expect(ranking).toContainText("链接");
    await expect(card("copy-00")).toBeVisible();
    expect(viewedRows()).toEqual([]);
    expect(await page.evaluate(() => sessionStorage.getItem("copied-content"))).toBeNull();

    await page.evaluate(() => sessionStorage.setItem("reject-copy", "yes"));
    await card("copy-01").getByRole("button", { name: "一键复制" }).click();
    await expect(ranking).toContainText("复制失败");
    await expect(card("copy-01")).toBeVisible();
    expect(viewedRows()).toEqual([]);

    await page.evaluate(() => sessionStorage.removeItem("reject-copy"));
    failViewSave = true;
    await card("copy-02").getByRole("button", { name: "一键复制" }).click();
    await expect(ranking).toContainText("已复制");
    await expect(card("copy-02")).toBeVisible();
    expect(viewedRows()).toEqual([]);
    expect(hideRequests).toEqual([]);
    await card("copy-02").getByRole("button", { name: "确认隐藏" }).click();
    await expect(ranking).toContainText("隐藏失败");
    await expect(card("copy-02")).toBeVisible();
    expect(viewedRows()).toEqual([]);
    expect(hideRequests).toEqual(["copy-02"]);
    failViewSave = false;

    await card("copy-03").getByRole("button", { name: "一键复制" }).click();
    await expect(ranking).toContainText("已复制");
    await expect(cards).toHaveCount(20);
    await expect(card("copy-03")).toBeVisible();
    const copied = await page.evaluate(() => sessionStorage.getItem("copied-content"));
    expect(copied).toContain("角色：角色copy-03");
    expect(copied).toContain("区服：测试服");
    expect(copied).toContain("挂牌价格：");
    expect(copied).toContain("裸号预估价：");
    expect(copied).toContain("商品链接：https://xyq.cbg.163.com/equip?s=367&eid=item-copy-03");
    expect(viewedRows()).toEqual([]);
    expect(hideRequests).toEqual(["copy-02"]);
    await page.reload();
    await page.getByRole("tab", { name: /推荐榜/ }).click();
    await expect(card("copy-03")).toBeVisible();
    expect(viewedRows()).toEqual([]);

    holdViewSave = true;
    // Two clicks in the same event turn exercise the in-flight guard before React rerenders.
    await card("copy-03")
      .getByRole("button", { name: "确认隐藏" })
      .evaluate((element) => {
        (element as HTMLButtonElement).click();
        (element as HTMLButtonElement).click();
      });
    await expect(card("copy-03").getByRole("button", { name: "正在隐藏…" })).toBeDisabled();
    await expect(card("copy-02").getByRole("button", { name: "确认隐藏" })).toBeDisabled();
    await expect(card("copy-03")).toBeVisible();
    await expect.poll(() => hideRequests).toEqual(["copy-02", "copy-03"]);
    expect(viewedRows()).toEqual([]);
    holdViewSave = false;
    releaseViewSave();
    await expect(card("copy-03")).toHaveCount(0);
    await expect(cards).toHaveCount(20);
    expect(viewedRows()).toEqual([{ listing_key: "copy-03" }]);

    holdSecondPage = true;
    await ranking.getByRole("button", { name: "下一页" }).click();
    await expect.poll(() => secondPageStarted).toBe(true);
    await expect(ranking.getByText("正在加载推荐榜…")).toBeVisible();
    await expect(cards).toHaveCount(0);
    await expect(ranking.getByRole("button", { name: "上一页" })).toBeDisabled();
    await expect(ranking.getByRole("button", { name: "下一页" })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath("page-loading.png"), fullPage: true });
    releaseSecondPage();
    await expect(ranking).toContainText("第 2 / 3 页");
    await expect(cards).toHaveCount(20);
    await expect(card("copy-21")).toBeVisible();
    await expect(card("copy-00")).toHaveCount(0);
    await ranking.getByRole("button", { name: "下一页" }).click();
    await expect(ranking).toContainText("第 3 / 3 页");
    await expect(cards).toHaveCount(11);
    await expect(card("copy-51")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("third-page.png"), fullPage: true });

    // Another viewer hides most remaining items while this page is open.
    for (let n = 40; n <= 50; n++) store.markRecommendationViewed(`copy-${n}`);
    await card("copy-51").getByRole("button", { name: "确认隐藏" }).click();
    await expect(ranking).toContainText("第 2 / 2 页");
    await expect(ranking).toContainText("共 39 件");
    await expect(cards).toHaveCount(19);
    await page.reload();
    await page.getByRole("tab", { name: /推荐榜/ }).click();
    await expect(cards).toHaveCount(20);
    await expect(card("copy-03")).toHaveCount(0);
    await ranking.getByRole("checkbox", { name: "显示已隐藏的推荐" }).check();
    await expect(ranking).toContainText("共 52 件");
    await expect(ranking).toContainText("第 1 / 3 页");
    await expect(cards).toHaveCount(20);
    await expect(card("copy-03")).toContainText("已隐藏");
    await expect(
      card("copy-03").getByRole("button", { name: "已隐藏", exact: true }),
    ).toBeDisabled();
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
          initialRecommendations: 52,
          copied,
          viewed: viewedRows(),
          hideRequests,
          finalUnviewed: 39,
          observedPages: 3,
          failureCases: [
            "missing link",
            "clipboard rejected",
            "hide save rejected",
            "duplicate hide click while saving",
            "delayed page response",
          ],
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
