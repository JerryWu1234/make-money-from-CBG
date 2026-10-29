import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import { analysisRecord, analysisResponse } from "../fixtures/analysis";
import { browserStatus, crawlStatus } from "../fixtures/saved-role";

// Failure cases: cancel or Escape deletes data; deletion leaves a database behind;
// cleanup affects cookies, localStorage, another origin, or server-side records;
// a blocked request reports success or allows duplicate actions; or releasing the
// other connection never finishes deletion. Browser databases below are real,
// but both origins, HTTP responses, and saved business records are test fixtures.
const origin = "http://cbg-indexeddb.test";
const otherOrigin = "http://cbg-indexeddb-other.test";
const storageMarker = "indexeddb-cleanup-preserve";

async function mount(page: Page) {
  const crawl = new CrawlStore(":memory:");
  const record = analysisRecord("preserved-server-record");
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
  const store = new AnalysisStore(crawl.db);
  const batch = store.createRun("codex", "fixture-model", true);
  crawl.db
    .prepare("UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=?")
    .run(JSON.stringify(analysisResponse(record)), new Date().toISOString());
  crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(batch);
  const mutations: string[] = [];
  const businessState = () => ({
    listings: crawl.count(),
    analysisResults: store.overview().results.total,
    analysisRuns: store.overview().runs.length,
  });
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (![origin, otherOrigin].includes(url.origin)) return route.abort();
    if (url.pathname === "/holder")
      return route.fulfill({ contentType: "text/html", body: "<p>IndexedDB fixture holder</p>" });
    if (url.origin !== origin) return route.abort();
    if (route.request().method() !== "GET") {
      mutations.push(url.pathname);
      return route.fulfill({ status: 500, json: { error: "IndexedDB cleanup must stay local" } });
    }
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      switch (url.pathname) {
        case "/api/runtime/settings":
          body = { saveScreenshots: false };
          break;
        case "/api/browser/settings":
          body = { mode: "daily", connected: true, busy: false };
          break;
        case "/api/browser/status":
          body = browserStatus;
          break;
        case "/api/crawl/settings":
          body = { analyzeEquipment: false };
          break;
        case "/api/crawl/status":
          body = {
            ...crawlStatus(false, true),
            totalSaved: crawl.count(),
            recent: crawl.recent(),
          };
          break;
        case "/api/crawl/records":
          body = crawl.records(Number(url.searchParams.get("page") || 1), 20, "complete");
          break;
        case "/api/scan/status":
          body = {
            config: {
              scheduleType: "daily",
              daily: { startTime: "09:00" },
              days: [],
              maxDurationMinutes: null,
            },
            mode: "disabled",
            state: "disabled",
            message: "未启用",
            timezone: "Asia/Shanghai",
          };
          break;
        case "/api/ai/status":
          body = {
            codex: { state: "connected", model: "fixture-model", response: "READY" },
            deepseek: { state: "unconfigured" },
          };
          break;
        case "/api/ai/models":
          body = {
            provider: "codex",
            defaultModel: "fixture-model",
            models: [{ id: "fixture-model", name: "模拟模型" }],
          };
          break;
        case "/api/analysis/progress":
        case "/api/analysis/status":
          body = store.overview({
            page: Number(url.searchParams.get("page") || 1),
            resultsPage: Number(url.searchParams.get("resultsPage") || 1),
            includeRanking: url.searchParams.get("includeRanking") === "true",
          });
          break;
        default:
          throw new Error("未模拟接口：" + url.pathname);
      }
      return route.fulfill({ json: body });
    }
    const file = path.join(
      "dist",
      url.pathname === "/" || url.pathname === "/analysis-preview" ? "index.html" : url.pathname,
    );
    return route.fulfill({
      body: await readFile(file),
      contentType: file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
    });
  });
  await page.goto(origin);
  return { crawl, mutations, businessState };
}

async function seedDatabases(page: Page, names: string[]) {
  await page.evaluate(async (databases) => {
    for (const name of databases) {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open(name, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("records", { keyPath: "id" });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("records", "readwrite");
          transaction.objectStore("records").put({ id: "seed", value: name });
          transaction.onerror = () => {
            db.close();
            reject(transaction.error);
          };
          transaction.oncomplete = () => {
            db.close();
            resolve();
          };
        };
      });
    }
  }, names);
}

async function browserState(page: Page) {
  return page.evaluate(async (marker) => {
    const names = (await indexedDB.databases())
      .map(({ name }) => name)
      .filter((name): name is string => typeof name === "string")
      .sort();
    const databases: { name: string; records: unknown[] }[] = [];
    for (const name of names) {
      const records = await new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction("records", "readonly");
          const read = transaction.objectStore("records").getAll();
          read.onerror = () => reject(read.error);
          transaction.oncomplete = () => {
            db.close();
            resolve(read.result);
          };
        };
      });
      databases.push({ name, records });
    }
    return { databases, localStorage: localStorage.getItem(marker), cookie: document.cookie };
  }, storageMarker);
}

test("浏览器本地数据库：取消与Esc保留→确认清除→刷新仍为空，登录和业务记录保留", async ({
  page,
}, testInfo) => {
  const backend = await mount(page);
  const other = await page.context().newPage();
  try {
    await seedDatabases(page, ["fixture-cache", "fixture-search"]);
    await page.evaluate((key) => localStorage.setItem(key, "keep-local-setting"), storageMarker);
    await page.context().addCookies([{ name: storageMarker, value: "keep-login", url: origin }]);
    await other.goto(otherOrigin + "/holder");
    await seedDatabases(other, ["fixture-cache"]);
    const before = await browserState(page);
    const otherBefore = await browserState(other);
    const serverBefore = backend.businessState();
    expect(serverBefore).toEqual({ listings: 1, analysisResults: 1, analysisRuns: 1 });
    await expect(page.getByRole("region", { name: "已采集角色" })).toContainText(
      "角色preserved-server-record",
    );

    const clean = page.getByRole("button", { name: "清除本地 IndexedDB", exact: true });
    const dialog = page.getByRole("dialog", { name: "确认清除本地 IndexedDB" });
    await clean.click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("fixture-cache");
    await expect(dialog).toContainText("fixture-search");
    await dialog.screenshot({ path: testInfo.outputPath("cleanup-confirmation.png") });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await browserState(page)).toEqual(before);
    await clean.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    expect(await browserState(page)).toEqual(before);

    await clean.click();
    await dialog.getByRole("button", { name: "确认清除", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "已清除当前站点的 2 个" }),
    ).toBeVisible();
    const after = await browserState(page);
    expect(after.databases).toEqual([]);
    expect(after.localStorage).toBe(before.localStorage);
    expect(after.cookie).toBe(before.cookie);
    expect(await browserState(other)).toEqual(otherBefore);
    expect(backend.businessState()).toEqual(serverBefore);
    expect(backend.mutations).toEqual([]);
    await page.getByRole("group", { name: "本地 IndexedDB 数据" }).screenshot({
      path: testInfo.outputPath("cleanup-result-panel.png"),
    });
    await page.screenshot({ path: testInfo.outputPath("cleanup-success.png"), fullPage: true });

    await page.reload();
    expect(await browserState(page)).toEqual(after);
    await expect(page.getByRole("region", { name: "已采集角色" })).toContainText(
      "角色preserved-server-record",
    );
    await page.goto(origin + "/analysis-preview");
    await expect(clean).toBeVisible();
    await page.getByRole("tab", { name: "分析记录" }).click();
    await expect(page.getByRole("tabpanel", { name: "分析记录" })).toContainText(
      "角色preserved-server-record",
    );
    await clean.click();
    await expect(dialog).toContainText("当前站点没有 IndexedDB 数据库，无需清除。");
    await expect(dialog.getByRole("button", { name: "确认清除", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(backend.businessState()).toEqual(serverBefore);
    expect(backend.mutations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("analysis-entry-preserved.png"),
      fullPage: true,
    });
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          scope:
            "Real Chrome IndexedDB on isolated fixture origins; production UI and in-memory SQLite stores; intercepted HTTP; no real site or user database",
          before,
          after,
          otherOriginPreserved: await browserState(other),
          serverBefore,
          serverAfter: backend.businessState(),
          serverMutations: backend.mutations,
          cancelAndEscapePreserved: true,
          reloadStayedEmpty: true,
          entryPages: ["capture", "analysis"],
          repeat:
            "vp run build && vp exec playwright test tests/e2e/indexeddb-cleanup.pw.ts --workers=1 --trace=on",
        },
        null,
        2,
      ),
    );
  } finally {
    await other.close();
    await page.close();
    backend.crawl.close();
  }
});

test("其他页面占用数据库时保持等待，关闭连接后才报告清除成功", async ({ page }, testInfo) => {
  const backend = await mount(page);
  const holder = await page.context().newPage();
  try {
    await seedDatabases(page, ["locked-local-data"]);
    await holder.goto(origin + "/holder");
    const held = await holder.evaluateHandle(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("locked-local-data");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const value = { db, versionChanges: 0 };
      db.onversionchange = () => {
        value.versionChanges++;
      };
      return value;
    });
    const serverBefore = backend.businessState();
    await page.getByRole("button", { name: "清除本地 IndexedDB", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认清除本地 IndexedDB" });
    await dialog.getByRole("button", { name: "确认清除", exact: true }).click();
    await expect(dialog).toContainText("数据库「locked-local-data」仍被其他页面占用");
    await expect(dialog.getByRole("button", { name: "正在清除…", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    await expect(page.getByRole("status").filter({ hasText: "已清除当前站点" })).toHaveCount(0);
    await expect.poll(() => held.evaluate((value) => value.versionChanges)).toBeGreaterThan(0);
    expect(backend.businessState()).toEqual(serverBefore);
    await dialog.screenshot({ path: testInfo.outputPath("cleanup-blocked.png") });
    await held.evaluate((value) => value.db.close());
    await held.dispose();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "已清除当前站点的 1 个" }),
    ).toBeVisible();
    const after = await browserState(page);
    expect(after.databases).toEqual([]);
    expect(backend.businessState()).toEqual(serverBefore);
    expect(backend.mutations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("cleanup-unblocked-success.png"),
      fullPage: true,
    });
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          database: "locked-local-data",
          blockedBy: "real open IndexedDB connection in another page of the same isolated origin",
          escapedWhileBlocked: "dialog remained open; no success notice",
          releasedConnectionCompleted: true,
          after,
          serverBefore,
          serverAfter: backend.businessState(),
          serverMutations: backend.mutations,
          repeat:
            "vp run build && vp exec playwright test tests/e2e/indexeddb-cleanup.pw.ts --workers=1 --trace=on",
        },
        null,
        2,
      ),
    );
  } finally {
    await holder.close();
    await page.close();
    backend.crawl.close();
  }
});
