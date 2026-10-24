import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import type { SavedRoleRecord } from "../../server/crawler/types";
import { AnalysisRunner } from "../../server/analysis/runner";
import { AnalysisStore } from "../../server/analysis/store";
import type { AnalysisOverview } from "../../server/analysis/types";
import { CALCULATION_VERSION, createProfile, PROMPT_FILE } from "../../server/analysis/profile";
import { analysisRecord, analysisResponse } from "../fixtures/analysis";

test("真实分析页面与队列：首次连接、暂停继续、刷新、原文、分页", async ({ page }, testInfo) => {
  const crawl = new CrawlStore(":memory:");
  for (const key of ["a", "b", ...Array.from({ length: 23 }, (_, i) => `k${i + 3}`)]) {
    const record = analysisRecord(key);
    crawl.observe(record.listing);
    if (key === "a" || key === "b") crawl.save(record.listing, record.detail!);
  }
  const store = new AnalysisStore(crawl.db);
  // This legacy finite-batch UI regression keeps its manual increment controls.
  // The continuous queue and waiting UI are exercised separately below.
  store.followsCapture = () => false;
  let automatic = false;
  let calls = 0;
  let starts = 0;
  let verified = false;
  let settingsChangedByCollection = false;
  const runner = new AnalysisRunner(store, async (_provider, model) => ({
    model: model || "test-model",
    analyze: async (prompt, _schema, signal) => {
      calls++;
      const key = prompt.match(/商品 ID：([^。]+)。/)![1];
      if (key === "b" && !automatic)
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      return {
        text: JSON.stringify(
          analysisResponse(crawl.detail(key) as SavedRoleRecord, key === "a" ? 90 : 80),
        ),
      };
    },
  }));
  try {
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://cbg-ui.test") return route.abort();
      if (url.pathname.startsWith("/api/")) {
        let body: unknown;
        const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
        switch (url.pathname) {
          case "/api/ai/status":
            body = {
              codex: { state: "configured", account: { plan: "Plus" } },
              deepseek: {
                state: verified ? "connected" : "unconfigured",
                model: "deepseek-flash",
                response: verified ? "READY" : undefined,
              },
              deepseekModels: [{ id: "deepseek-flash", name: "DeepSeek 测试模型" }],
            };
            break;
          case "/api/ai/models":
            body =
              url.searchParams.get("provider") === "codex"
                ? {
                    provider: "codex",
                    defaultModel: "test-model",
                    models: [{ id: "test-model", name: "Codex 测试模型" }],
                  }
                : {
                    provider: "deepseek",
                    defaultModel: "deepseek-flash",
                    models: [
                      { id: "deepseek-flash", name: "DeepSeek 测试模型" },
                      { id: "deepseek-v4-pro", name: "DeepSeek Pro 测试模型" },
                    ],
                  };
            break;
          case "/api/ai/verify":
            expect(input.provider).toBe("deepseek");
            expect(input.apiKey).toBe("fixture-only-key");
            verified = true;
            body = { state: "connected", model: "deepseek-flash", response: "READY" };
            break;
          case "/api/analysis/status":
            body = {
              ...store.overview({
                provider: url.searchParams.get("provider") as "codex" | "deepseek",
                runId: url.searchParams.get("runId") || undefined,
                page: Number(url.searchParams.get("page") || 1),
                resultsPage: Number(url.searchParams.get("resultsPage") || 1),
                search: url.searchParams.get("search") || undefined,
                filter: url.searchParams.get("filter") || undefined,
              }),
              ...(settingsChangedByCollection
                ? {
                    profile: {
                      hash: "new-server-market",
                      version: "role-valuation-v1",
                      promptHash: "unchanged-prompt",
                      calculationCompatible: true,
                      calculationVersion: CALCULATION_VERSION,
                    },
                  }
                : {}),
            };
            break;
          case "/api/analysis/start":
            starts++;
            expect(input.model).toBe("deepseek-v4-pro");
            body = store.run(
              await runner.start(input.provider, input.force, undefined, false, input.model),
            );
            break;
          case "/api/analysis/pause":
            await runner.pause(input.runId);
            body = store.run(input.runId);
            break;
          case "/api/analysis/resume":
            automatic = true;
            await runner.resume(input.runId);
            body = store.run(input.runId);
            break;
          case "/api/analysis/detail":
            body = store.detail(url.searchParams.get("taskId")!);
            break;
          case "/api/analysis/input": {
            const detail = store.detail(url.searchParams.get("taskId")!)!;
            return route.fulfill({
              contentType: "text/plain; charset=utf-8",
              headers: { "Content-Disposition": 'attachment; filename="product.txt"' },
              body: detail.inputText,
            });
          }
          default:
            throw new Error(`未模拟接口：${url.pathname}`);
        }
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
    await page.goto("http://cbg-ui.test/analysis-preview");
    await expect(page.getByLabel("分析模型")).toHaveValue("");
    await page.getByLabel("分析 Agent").selectOption("deepseek");
    await page.getByLabel("分析模型").selectOption("deepseek-v4-pro");
    await page.getByRole("button", { name: "开始分析已有商品" }).click();
    const connect = page.getByRole("dialog", { name: "连接 DeepSeek" });
    await connect.getByLabel("API Key").fill("fixture-only-key");
    await connect.getByRole("button", { name: "保存并验证" }).click();
    await expect(connect).not.toBeVisible();
    await expect(page.getByRole("button", { name: "暂停分析" })).toBeVisible();
    await expect(page.getByRole("tabpanel", { name: "分析记录" })).toContainText("角色a");
    await expect(
      page
        .getByRole("tabpanel", { name: "分析记录" })
        .getByRole("heading", { name: "评分字段依据" }),
    ).toHaveCount(0);
    await expect(page.getByLabel("分析批次")).toHaveCount(0);
    await expect(page.getByLabel("试分析数量")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /先分析|全部重新分析/ })).toHaveCount(0);
    expect(calls).toBe(2);
    expect(store.overview().run?.model).toBe("deepseek-v4-pro");
    await expect(page.getByLabel("分析 Agent")).toBeDisabled();
    await expect(page.getByLabel("分析模型")).toBeDisabled();
    await page.reload();
    await expect(page.getByRole("button", { name: "暂停分析" })).toBeVisible();
    await expect(page.getByLabel("分析模型")).toHaveValue("deepseek-v4-pro");
    expect(calls).toBe(2);
    expect(starts).toBe(1);
    await page.getByRole("button", { name: "暂停分析" }).click();
    await expect(page.getByRole("button", { name: "继续分析" })).toBeEnabled();
    expect(store.activeRun()).toBeNull();
    const pausedRunId = store.overview().run!.id;
    settingsChangedByCollection = true;
    await page.reload();
    await expect(page.getByRole("button", { name: "继续分析", exact: true })).toBeEnabled();
    await expect(
      page.getByText("本批次的 Prompt 或参数与当前设置不同，重新分析将使用当前设置。"),
    ).not.toBeVisible();
    await page.getByLabel("分析模型").selectOption("deepseek-flash");
    await expect(page.getByRole("button", { name: "按新模型开始分析" })).toBeEnabled();
    expect(calls).toBe(2);
    await page.getByLabel("分析模型").selectOption("deepseek-v4-pro");
    await page.getByRole("button", { name: "继续分析" }).click();
    await expect(page.getByRole("button", { name: "分析新增或已更新商品" })).toBeEnabled();
    expect(calls).toBe(3);
    expect(store.overview().run?.id).toBe(pausedRunId);
    expect(store.overview().runs).toHaveLength(1);
    expect(store.overview().run?.model).toBe("deepseek-v4-pro");
    await page.getByRole("tab", { name: /推荐榜/ }).click();
    await expect(page.getByRole("tabpanel", { name: "推荐榜" }).getByRole("article")).toHaveCount(
      0,
    );
    await page.screenshot({
      path: testInfo.outputPath("analysis-completed-fixture.png"),
      fullPage: true,
    });
    await page.getByRole("tab", { name: /全部商品/ }).click();
    await page.getByRole("button", { name: "查看分析", exact: true }).first().click();
    const drawer = page.getByRole("dialog", { name: "角色a" });
    await expect(drawer.getByRole("heading", { name: "评分字段依据" })).toBeVisible();
    await drawer.getByText("查看完整商品原文", { exact: true }).click();
    await expect(
      drawer.locator("details").filter({ hasText: "查看完整商品原文" }).locator("pre"),
    ).toContainText("宝宝8");
    const downloaded = page.waitForEvent("download");
    await drawer.getByRole("link", { name: "下载商品原文 TXT" }).click();
    const file = await downloaded;
    expect(await readFile((await file.path())!, "utf8")).toContain("宝宝8");
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await page.getByRole("tab", { name: "全部商品" }).click();
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(20);
    await page.getByRole("button", { name: "下一页" }).click();
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(5);
    await page.getByRole("searchbox", { name: "搜索商品" }).fill("角色b");
    await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(1);
    await page.getByRole("tab", { name: "分析记录" }).click();
    await expect(page.getByRole("tabpanel", { name: "分析记录" }).getByRole("article")).toHaveCount(
      2,
    );
    await page.getByRole("button", { name: "分析新增或已更新商品", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "分析新增或已更新商品", exact: true }),
    ).toBeEnabled();
    expect(calls).toBe(3);
    expect(store.overview().runs).toHaveLength(1);
    const startsBeforeRefresh = starts;
    await page.reload();
    await expect(page.getByLabel("分析模型")).toHaveValue("");
    await expect(page.getByRole("tabpanel", { name: "分析记录" }).getByRole("article")).toHaveCount(
      2,
    );
    expect(starts).toBe(startsBeforeRefresh);
    expect(calls).toBe(3);
    expect(store.overview().run?.model).toBe("deepseek-v4-pro");
    await page.getByLabel("分析模型").selectOption("deepseek-v4-pro");
    // Collection saves six new complete goods; the next analysis handles only these six.
    for (const key of ["c", "d", "e", "f", "g", "h"]) {
      const record = analysisRecord(key);
      crawl.observe(record.listing);
      crawl.save(record.listing, record.detail!);
    }
    await page.getByRole("button", { name: "分析新增或已更新商品", exact: true }).click();
    const records = page.getByRole("tabpanel", { name: "分析记录" });
    await expect(records.getByRole("article")).toHaveCount(8);
    await expect(records.locator(".analysis-result-number")).toHaveText([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
    ]);
    await expect(records.getByRole("heading", { name: "评分字段依据" })).toHaveCount(0);
    await records.screenshot({ path: testInfo.outputPath("analysis-results-list-desktop.png") });
    const firstResult = records.getByRole("button", { name: /查看分析详情/ }).first();
    await firstResult.focus();
    await page.keyboard.press("Enter");
    const firstDetail = page.locator(".analysis-detail-dialog");
    await expect(firstDetail).toBeVisible();
    await expect(firstDetail.getByRole("heading", { name: "评分字段依据" })).toBeVisible();
    const bounds = await firstDetail.boundingBox();
    expect(bounds!.x).toBeGreaterThan(0);
    expect(Math.abs(bounds!.x * 2 + bounds!.width - 1100)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: testInfo.outputPath("analysis-result-dialog.png") });
    await page.keyboard.press("Escape");
    await expect(firstDetail).not.toBeVisible();
    await expect(firstResult).toBeFocused();
    await firstResult.click();
    await expect(firstDetail).toBeVisible();
    await page.mouse.click(4, 4);
    await expect(firstDetail).not.toBeVisible();
    await expect(firstResult).toBeFocused();
    expect(calls).toBe(9);
    expect(store.overview().run).toMatchObject({ total: 6, completed: 6 });
    await page.getByRole("button", { name: "分析新增或已更新商品", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "分析新增或已更新商品", exact: true }),
    ).toBeEnabled();
    expect(calls).toBe(9);
    expect(store.overview().runs).toHaveLength(2);
    const changed = crawl.detail("a") as SavedRoleRecord;
    changed.listing.price = "333";
    crawl.observe(changed.listing);
    await page.getByRole("button", { name: "分析新增或已更新商品", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "分析新增或已更新商品", exact: true }),
    ).toBeEnabled();
    expect(calls).toBe(10);
    expect(store.overview().run).toMatchObject({ total: 1, completed: 1 });
    await expect(records.getByRole("article")).toHaveCount(8);
    await records
      .getByRole("article", { name: /角色b/ })
      .getByRole("button", { name: /查看分析详情/ })
      .click();
    const savedCall = page.getByRole("dialog", { name: "角色b" });
    await expect(savedCall).toContainText("中断");
    await page.keyboard.press("Escape");
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
      "fixture-only-key",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: /分析记录/ }).click();
    await page.screenshot({
      path: testInfo.outputPath("analysis-eight-results-mobile-fixture.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await firstResult.click();
    await expect(firstDetail).toBeVisible();
    await expect(firstDetail.getByRole("heading", { name: "评分字段依据" })).toBeVisible();
    expect(
      await firstDetail.evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("analysis-result-dialog-mobile.png") });
    const content = firstDetail.locator(".analysis-modal-content");
    await content.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    expect(await content.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(firstDetail.getByRole("button", { name: "关闭分析详情" })).toBeInViewport();
    await firstDetail.getByRole("button", { name: "关闭分析详情" }).click();
    await expect(firstDetail).not.toBeVisible();
  } finally {
    await runner.shutdown();
    crawl.close();
  }
});

for (const savedVersion of [undefined, CALCULATION_VERSION, "price-comparison-v9"]) {
  test(`暂停批次规则兼容性：${savedVersion || "无估值版本"}`, async ({ page }, testInfo) => {
    const crawl = new CrawlStore(":memory:");
    for (const key of ["a", "b", "c"]) {
      const record = analysisRecord(key);
      crawl.observe(record.listing);
      crawl.save(record.listing, record.detail!);
    }
    const store = new AnalysisStore(crawl.db);
    const profile = createProfile(await readFile(PROMPT_FILE, "utf8"), undefined, false);
    const owner = "rule-version-fixture";
    expect(store.acquire(owner)).toBe(true);
    const oldRunId = store.createRun(
      "codex",
      "test-model",
      true,
      savedVersion ? { ...profile, calculationVersion: savedVersion } : undefined,
    );
    const completed = store.next(oldRunId)!;
    store.finish(completed, store.begin(completed, owner), owner, {
      state: "completed",
      result: { ...analysisResponse(crawl.detail("a") as SavedRoleRecord), score: 80 },
    });
    const failed = store.next(oldRunId)!;
    store.finish(failed, store.begin(failed, owner), owner, {
      state: "failed",
      error: "模拟可重试失败",
    });
    store.setRun(oldRunId, "paused", null, owner);
    store.release(owner);
    const oldResult = store.detail(completed.id);
    let starts = 0,
      retries = 0;
    const obsolete = !!savedVersion && savedVersion !== CALCULATION_VERSION;
    const runner = new AnalysisRunner(store, async () => ({
      model: "test-model",
      analyze: async (_prompt, _schema, signal) => {
        signal.throwIfAborted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    }));
    try {
      await page.context().route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== "http://cbg-rule-version.test") return route.abort();
        if (url.pathname.startsWith("/api/")) {
          const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
          let body: unknown;
          switch (url.pathname) {
            case "/api/ai/status":
              body = {
                codex: { state: "configured" },
                deepseek: { state: "unconfigured" },
                deepseekModels: [],
              };
              break;
            case "/api/ai/models":
              body = {
                provider: "codex",
                defaultModel: "test-model",
                models: [{ id: "test-model", name: "测试模型" }],
              };
              break;
            case "/api/analysis/status":
              body = {
                ...store.overview({
                  provider: "codex",
                  runId: url.searchParams.get("runId") || undefined,
                }),
                profile: { ...profile, hash: "new-server-market" },
              };
              break;
            case "/api/analysis/start":
              starts++;
              body = store.run(
                await runner.start(input.provider, false, profile, false, input.model),
              );
              break;
            case "/api/analysis/retry":
              retries++;
              await runner.resume(input.runId, true);
              body = store.run(input.runId);
              break;
            default:
              throw new Error(`未模拟接口：${url.pathname}`);
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
      await page.goto("http://cbg-rule-version.test/analysis-preview");
      const primary = page.getByRole("button", {
        name: obsolete ? "按新规则开始分析" : "继续分析",
        exact: true,
      });
      await expect(primary).toBeEnabled();
      await expect(
        page.getByRole("button", { name: /^重试失败(?:及待补齐)?的 1 件$/ }),
      ).toHaveCount(obsolete ? 0 : 1);
      if (obsolete) {
        await expect(runner.resume(oldRunId, true)).rejects.toThrow("估值规则已更新");
        await expect(
          page.getByText("估值规则已更新，下次分析使用新规则，已有结果保留。", {
            exact: true,
          }),
        ).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("analysis-rule-upgrade-fixture.png") });
      }
      if (obsolete) await primary.click();
      else {
        await expect(runner.resume(oldRunId)).rejects.toThrow(
          "请先重试失败或待补齐的商品，再继续分析",
        );
        expect(store.activeRun()).toBeNull();
        expect(store.run(oldRunId)).toMatchObject({ completed: 1, failed: 1, queued: 1 });
        await page.getByRole("button", { name: /^重试失败(?:及待补齐)?的 1 件$/ }).click();
      }
      await expect(page.getByRole("button", { name: "暂停分析", exact: true })).toBeVisible();
      expect(starts).toBe(obsolete ? 1 : 0);
      expect(retries).toBe(obsolete ? 0 : 1);
      expect(store.overview().runs).toHaveLength(obsolete ? 2 : 1);
      const active = store.activeRun()!;
      if (obsolete) {
        expect(active.id).not.toBe(oldRunId);
        expect(active.calculationVersion).toBe(CALCULATION_VERSION);
        expect(store.run(oldRunId)).toMatchObject({
          status: "paused",
          completed: 1,
          failed: 1,
          queued: 1,
        });
      } else expect(active.id).toBe(oldRunId);
      expect(store.detail(completed.id)).toEqual(oldResult);
      await page.screenshot({
        path: testInfo.outputPath("analysis-rule-compatibility-fixture.png"),
        fullPage: true,
      });
    } finally {
      await runner.shutdown();
      crawl.close();
    }
  });
}

test("空库先启动等待：首个角色采齐自动分析，刷新保留等待，新角色自动接续且可暂停", async ({
  page,
}, testInfo) => {
  const crawl = new CrawlStore(":memory:");
  const store = new AnalysisStore(crawl.db);
  const add = (key: string, complete = true) => {
    const record = analysisRecord(key);
    crawl.observe(record.listing);
    if (complete) crawl.save(record.listing, record.detail!);
    return record;
  };
  let calls = 0;
  let connects = 0;
  let captureActivity: AnalysisOverview["captureActivity"];
  const runner = new AnalysisRunner(store, async () => {
    connects++;
    return {
      model: "waiting-fixture-model",
      analyze: async (prompt) => {
        calls++;
        const key = prompt.match(/商品 ID：([^。]+)。/)![1];
        return { text: JSON.stringify(analysisResponse(crawl.detail(key) as SavedRoleRecord)) };
      },
    };
  });
  try {
    await page.context().route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "http://cbg-waiting.test") return route.abort();
      if (url.pathname.startsWith("/api/")) {
        const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
        let body: unknown;
        switch (url.pathname) {
          case "/api/ai/status":
            body = {
              codex: { state: "configured" },
              deepseek: { state: "unconfigured" },
              deepseekModels: [],
            };
            break;
          case "/api/ai/models":
            body = {
              provider: "codex",
              defaultModel: "waiting-fixture-model",
              models: [{ id: "waiting-fixture-model", name: "等待状态测试模型" }],
            };
            break;
          case "/api/analysis/status":
            body = {
              ...store.overview({ scope: url.searchParams.get("scope") as "complete" }),
              ...(captureActivity ? { captureActivity } : {}),
            };
            break;
          case "/api/analysis/start":
            body = store.run(await runner.start("codex"));
            break;
          case "/api/analysis/pause":
            await runner.pause(input.runId);
            body = store.run(input.runId);
            break;
          case "/api/analysis/resume":
            body = store.run(await runner.resume(input.runId));
            break;
          default:
            throw new Error(`未模拟接口：${url.pathname}`);
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
    await page.goto("http://cbg-waiting.test/analysis-preview");
    const start = page.getByRole("button", { name: "开始分析并等待采集", exact: true });
    await expect(start).toBeEnabled();
    await start.click();
    const waiting = page.getByRole("button", { name: "等待新角色…", exact: true });
    await expect(waiting).toBeDisabled();
    await expect(page.getByText(/正在等待首个角色资料采集完整/)).toBeVisible();
    await expect(page.getByLabel("采集续采提示")).toContainText("当前没有正在执行的模型分析");
    await expect(page.getByRole("link", { name: "前往采集工作台抓取新角色" })).toHaveAttribute(
      "href",
      "/",
    );
    const id = store.activeRun()!.id;
    expect(store.activeRun()).toMatchObject({ total: 0, phase: "waiting_capture" });
    expect(calls).toBe(0);
    await page.reload();
    await expect(waiting).toBeDisabled();
    await expect(page.getByText(/正在等待首个角色资料采集完整/)).toBeVisible();
    expect(store.activeRun()!.id).toBe(id);
    const first = add("a", false);
    expect(runner.appendCaptured()).toBe(0);
    expect(calls).toBe(0);
    crawl.save(first.listing, first.detail!);
    await expect(page.getByRole("tabpanel", { name: "分析记录" }).getByRole("article")).toHaveCount(
      1,
    );
    await expect(page.getByText(/现有角色已处理完，等待新角色/)).toBeVisible();
    await expect(page.getByText("等待新角色资料采集完整", { exact: true })).toBeVisible();
    expect(calls).toBe(1);
    const pending = add("b", false);
    await page.reload();
    await expect(waiting).toBeDisabled();
    await expect(page.getByLabel("采集续采提示")).toContainText(
      "另有 1 项采集任务：1 件待采或采集中 · 0 件采集失败待重试。完整入库后才会成为商品并进入分析。",
    );
    await expect(page.getByRole("link", { name: "前往采集工作台查看任务" })).toHaveAttribute(
      "href",
      "/?recordsScope=tasks",
    );
    await expect(page.getByLabel("分析模型")).toHaveValue("waiting-fixture-model");
    expect(calls).toBe(1);
    expect(connects).toBe(1);
    captureActivity = { running: true, phase: "collecting", inFlight: 1 };
    await page.reload();
    await expect(page.getByLabel("采集续采提示")).toContainText(
      "1 件正在采集 · 0 件排队待采 · 0 件采集失败待重试",
    );
    captureActivity = { running: false, phase: "error" };
    await page.reload();
    await expect(page.getByLabel("采集续采提示")).toContainText(
      "采集已因错误停止，分析正在等待资料",
    );
    await expect(page.getByLabel("采集续采提示")).toContainText("0 件采集失败待重试");
    await page.screenshot({
      path: testInfo.outputPath("capture-stopped-with-pending.png"),
      fullPage: true,
    });
    captureActivity = { running: false, phase: "completed", roleLimit: 500, totalRoles: 500 };
    await page.reload();
    await expect(page.getByLabel("采集续采提示")).toContainText("已达到 500 个完整角色的采集目标");
    await expect(page.getByRole("link", { name: "前往采集工作台查看结果" })).toHaveAttribute(
      "href",
      "/",
    );
    await expect(page.getByRole("link", { name: "前往采集工作台查看任务" })).toHaveCount(0);
    captureActivity = undefined;
    crawl.fail(pending.listing.key, "详情页读取超时");
    await page.reload();
    await expect(page.getByLabel("采集续采提示")).toContainText(
      "另有 1 项采集任务：0 件待采或采集中 · 1 件采集失败待重试。完整入库后才会成为商品并进入分析。",
    );
    await expect(page.getByLabel("分析页面概览")).toContainText("完整商品");
    expect(calls).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath("waiting-for-new-roles.png"),
      fullPage: true,
    });
    crawl.save(pending.listing, pending.detail!);
    await expect(page.getByRole("tabpanel", { name: "分析记录" }).getByRole("article")).toHaveCount(
      2,
    );
    await expect(waiting).toBeDisabled();
    expect(store.activeRun()).toMatchObject({ id, completed: 2, phase: "waiting_capture" });
    await expect(page.getByRole("link", { name: "前往采集工作台补采" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "前往采集工作台抓取新角色" })).toBeVisible();
    expect(calls).toBe(2);
    expect(connects).toBe(1);
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect(page.getByRole("button", { name: "继续分析", exact: true })).toBeEnabled();
    add("c");
    await page.reload();
    await expect(page.getByRole("button", { name: "继续分析", exact: true })).toBeEnabled();
    expect(calls).toBe(2);
    await page.getByRole("button", { name: "继续分析", exact: true }).click();
    await expect(page.getByRole("tabpanel", { name: "分析记录" }).getByRole("article")).toHaveCount(
      3,
    );
    await expect(waiting).toBeDisabled();
    expect(store.activeRun()).toMatchObject({
      id,
      completed: 3,
      total: 3,
      phase: "waiting_capture",
    });
    expect(calls).toBe(3);
    await page.screenshot({ path: testInfo.outputPath("new-roles-resumed.png"), fullPage: true });
  } finally {
    await runner.shutdown();
    crawl.close();
  }
});
