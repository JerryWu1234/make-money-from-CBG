import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import type { CrawlStatus, SavedRoleRecord } from "../../server/crawler/types";
import { ScanScheduleStore } from "../../server/crawler/schedule-store";
import { AnalysisStore } from "../../server/analysis/store";
import { createProfile, DEFAULT_SETTINGS } from "../../server/analysis/profile";
import {
  calculateValuation,
  compareListingPrice,
} from "../../server/analysis/valuation-calculator";
import { analysisRecord, analysisResponse } from "../fixtures/analysis";
import { browserStatus } from "../fixtures/saved-role";

// Failure cases: cancel/Escape deletes records; an active lock permits deletion or
// disables the schedule; repeated confirmation submits twice; stale second-page
// responses restore deleted rows; browser storage/settings/files are removed;
// reopening SQLite restores old records; a new capture cannot be saved afterward;
// or a delayed configure/enable chain can overlap clearing and re-enable a plan.
// The browser, file SQLite and production stores/clear() are real. The HTTP adapter,
// captured roles, AI responses and displayed activity are fixtures, not the live API.
const origin = "http://cbg-sqlite-cleanup.test";
const browserMarker = "sqlite-cleanup-preserved-browser-data";
const businessTables = [
  "listings",
  "role_tabs",
  "role_parameters",
  "role_sources",
  "role_source_history",
  "crawl_state",
  "recommendation_views",
  "analysis_runs",
  "analysis_tasks",
  "analysis_attempts",
  "analysis_source_matches",
  "analysis_capture_checks",
  "analysis_school_formula_confirmations",
];

async function fixture(page: Page, testInfo: TestInfo) {
  const directory = testInfo.outputPath("database");
  await mkdir(directory, { recursive: true });
  const database = path.join(directory, "cbg.sqlite");
  const logFile = path.join(directory, "preserved-run.log");
  await writeFile(logFile, "fixture run log remains\n");
  let crawl = new CrawlStore(database);
  let analysis = new AnalysisStore(crawl.db);
  let schedule = new ScanScheduleStore(database);
  const profile = createProfile("fixture");
  const addRecord = (key: string) => {
    const record = analysisRecord(key);
    record.listing.price = "1000";
    const equipment = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    equipment.items = [];
    equipment.text = "没有装备";
    record.detail!.equipmentCapture!.emptyProof = "explicit-text";
    const pets = record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
    pets.pets = [];
    pets.petCount = 0;
    crawl.observe(record.listing);
    expect(
      crawl.save(record.listing, record.detail!, {
        key,
        time: record.listing.sellingTime,
        order: "selling_time DESC",
        page: 2,
        savedAt: new Date().toISOString(),
      }),
    ).toBe(true);
    return record;
  };
  const keys = Array.from({ length: 21 }, (_, index) => `sqlite-role-${index + 1}`);
  keys.forEach(addRecord);
  const archived = crawl.detail(keys[0]) as SavedRoleRecord;
  archived.detail!.tabs[0].text += "\n模拟资料更新，保留原文历史";
  crawl.save(archived.listing, archived.detail!);
  const batch = analysis.createRun("codex", "fixture-model", true);
  for (const key of keys) {
    const record = crawl.detail(key) as SavedRoleRecord;
    const result = {
      ...analysisResponse(record),
      score: 80,
      valuation: {
        ...calculateValuation(record, profile),
        ...compareListingPrice(1200, 1000),
        asset_scope: "body",
        bare_role_value: 1200,
        model_value: 1200,
        decision: "PASS",
      },
    };
    const task = crawl.db.prepare("SELECT id FROM analysis_tasks WHERE listing_key=?").get(key)!;
    crawl.db
      .prepare(
        "UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=? WHERE id=?",
      )
      .run(JSON.stringify(result), new Date().toISOString(), task.id);
    crawl.db
      .prepare(
        "INSERT INTO analysis_attempts(id,task_id,state,created_at,raw_response) VALUES(?,?,'completed',?,?)",
      )
      .run(`proof-${key}`, task.id, new Date().toISOString(), "模拟调用原文，仅验证清理");
  }
  crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(batch);
  analysis.markRecommendationViewed(keys[0]);
  crawl.db.exec(
    "CREATE TABLE IF NOT EXISTS analysis_settings (id INTEGER PRIMARY KEY, settings_json TEXT NOT NULL); CREATE TABLE analysis_market (id INTEGER PRIMARY KEY, snapshot_json TEXT NOT NULL)",
  );
  crawl.db
    .prepare("INSERT INTO analysis_settings VALUES(1,?)")
    .run(JSON.stringify({ ...DEFAULT_SETTINGS, settingsVersion: 2 }));
  crawl.db
    .prepare("INSERT INTO analysis_market VALUES(1,?)")
    .run(JSON.stringify({ fetchedAt: new Date().toISOString(), servers: [] }));
  schedule.setMode("enabled");
  schedule.setNextRunAt(Date.now() + 3600000);
  let clearRequests = 0;
  let clearSuccesses = 0;
  let clearGate: Promise<void> | null = null;
  let running = false;
  const status = (): CrawlStatus => ({
    running,
    phase: running ? "collecting" : "idle",
    message: crawl.count() ? "模拟资料已保存" : "历史采集数据已清空，可重新开始采集。",
    page: 0,
    totalPages: 0,
    saved: 0,
    skipped: 0,
    totalSaved: crawl.count(),
    database,
    checkpoint: crawl.checkpoint(),
  });
  const summary = () => {
    const overview = analysis.overview({ showViewed: true });
    return {
      tables: Object.fromEntries(
        businessTables.map((table) => [
          table,
          crawl.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
            ? Number(crawl.db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n)
            : 0,
        ]),
      ),
      records: overview.records.total,
      results: overview.results.total,
      ranking: overview.rankingPagination?.total,
      checkpoint: crawl.checkpoint() || null,
      settings: crawl.db.prepare("SELECT settings_json FROM analysis_settings WHERE id=1").get()
        ?.settings_json,
      market: crawl.db.prepare("SELECT snapshot_json FROM analysis_market WHERE id=1").get()
        ?.snapshot_json,
      scheduleConfig: schedule.read().config,
      scheduleMode: schedule.read().mode,
    };
  };
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === "/api/crawl/clear") {
      expect(route.request().method()).toBe("POST");
      expect(route.request().postDataJSON()).toEqual({});
      clearRequests++;
      if (clearGate) await clearGate;
      try {
        crawl.clear();
        schedule.setMode("disabled");
        clearSuccesses++;
        return route.fulfill({ json: status() });
      } catch (error) {
        return route.fulfill({
          status: 409,
          json: { error: String(error instanceof Error ? error.message : error) },
        });
      }
    }
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      switch (url.pathname) {
        case "/api/browser/status":
          body = browserStatus;
          break;
        case "/api/browser/settings":
          body = { mode: "daily", connected: true, busy: false };
          break;
        case "/api/runtime/settings":
          body = { saveScreenshots: false };
          break;
        case "/api/crawl/settings":
          body = { analyzeEquipment: false };
          break;
        case "/api/crawl/status":
          body = { ...status(), recent: crawl.recent() };
          break;
        case "/api/crawl/records":
          body = crawl.records(Number(url.searchParams.get("page") || 1), 20, "complete");
          break;
        case "/api/crawl/detail":
          body = crawl.detail(url.searchParams.get("key")!);
          break;
        case "/api/scan/status":
          body = {
            ...schedule.read(),
            state: schedule.read().mode === "enabled" ? "scheduled" : "disabled",
            message: "模拟定时计划",
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
          body = {
            ...analysis.overview({
              page: Number(url.searchParams.get("page") || 1),
              resultsPage: Number(url.searchParams.get("resultsPage") || 1),
              rankingPage: Number(url.searchParams.get("rankingPage") || 1),
              includeRanking: url.searchParams.get("includeRanking") !== "false",
              showViewed: url.searchParams.get("showViewed") === "true",
            }),
            captureActivity: { running, phase: running ? "collecting" : "idle" },
          };
          break;
        case "/api/analysis/detail":
          body = analysis.detail(url.searchParams.get("taskId")!);
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
  return {
    database,
    logFile,
    summary,
    addRecord,
    overview: () => analysis.overview({ resultsPage: 2, showViewed: true }),
    scheduleStatus: () => ({
      ...schedule.read(),
      state: schedule.read().mode === "enabled" ? "scheduled" : "disabled",
      message: "模拟定时计划",
      timezone: "Asia/Shanghai",
    }),
    configureSchedule(config: Parameters<ScanScheduleStore["setConfig"]>[0]) {
      schedule.setConfig(config);
    },
    setScheduleEnabled(enabled: boolean) {
      schedule.setMode(enabled ? "enabled" : "disabled");
    },
    get clearRequests() {
      return clearRequests;
    },
    get clearSuccesses() {
      return clearSuccesses;
    },
    blockAnalysis() {
      expect(analysis.acquire("external-analysis-fixture")).toBe(true);
    },
    releaseAnalysis() {
      analysis.release("external-analysis-fixture");
    },
    holdClear() {
      let release!: () => void;
      clearGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        clearGate = null;
        release();
      };
    },
    setRunning(value: boolean) {
      running = value;
    },
    reopen() {
      schedule.close();
      crawl.close();
      crawl = new CrawlStore(database);
      analysis = new AnalysisStore(crawl.db);
      schedule = new ScanScheduleStore(database);
    },
    close() {
      schedule.close();
      crawl.close();
    },
  };
}

async function seedBrowser(page: Page) {
  await page.evaluate(async (marker) => {
    localStorage.setItem(marker, "keep-setting");
    document.cookie = marker + "=keep-cookie; path=/";
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(marker, 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("records").put("keep-indexeddb", "marker");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
  }, browserMarker);
}

async function browserState(page: Page) {
  return page.evaluate(
    async (marker) => ({
      localStorage: localStorage.getItem(marker),
      cookie: document.cookie,
      databases: (await indexedDB.databases())
        .map(({ name }) => name)
        .sort((left, right) => (left ?? "").localeCompare(right ?? "")),
    }),
    browserMarker,
  );
}

function assertEmpty(value: ReturnType<Awaited<ReturnType<typeof fixture>>["summary"]>) {
  expect(value.records).toBe(0);
  expect(value.results).toBe(0);
  expect(value.ranking).toBe(0);
  expect(value.checkpoint).toBeNull();
  expect(Object.values(value.tables).every((count) => count === 0)).toBe(true);
}

test("SQLite清理：第二页取消/Esc保留→活动锁拒绝→确认清空→重开仍为空→重新采集", async ({
  page,
}, testInfo) => {
  const backend = await fixture(page, testInfo);
  try {
    await page.goto(origin + "/?recordsPage=2");
    await seedBrowser(page);
    const browserBefore = await browserState(page);
    const records = page.getByRole("region", { name: "已采集角色" });
    await expect(records).toContainText("第 2 / 2 页");
    await expect(records.locator("tbody tr")).toHaveCount(1);
    await records.locator("tbody button").click();
    await expect(page.locator(".role-drawer")).toBeVisible();
    await page.getByRole("button", { name: "关闭角色详情" }).click();
    const before = backend.summary();
    expect(before.records).toBe(21);
    expect(before.results).toBe(21);
    expect(before.ranking).toBe(21);
    expect(before.tables.recommendation_views).toBe(1);
    expect(before.tables.role_source_history).toBeGreaterThan(0);
    const clean = page.getByRole("button", { name: "清空 SQLite 数据", exact: true });
    const dialog = page.getByRole("dialog", { name: "确认清空 SQLite 数据" });
    await clean.click();
    await expect(dialog).toContainText("采集断点");
    await dialog.screenshot({ path: testInfo.outputPath("sqlite-confirmation.png") });
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    expect(backend.clearRequests).toBe(0);
    expect(backend.summary()).toEqual(before);
    await clean.click();
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    expect(backend.clearRequests).toBe(0);
    expect(backend.summary()).toEqual(before);

    backend.blockAnalysis();
    await clean.click();
    await dialog.getByRole("button", { name: "确认清空", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "请先暂停分析" })).toBeVisible();
    expect(backend.clearRequests).toBe(1);
    expect(backend.clearSuccesses).toBe(0);
    expect(backend.summary()).toEqual(before);
    backend.releaseAnalysis();

    const release = backend.holdClear();
    await clean.click();
    await dialog.getByRole("button", { name: "确认清空", exact: true }).click();
    await expect.poll(() => backend.clearRequests).toBe(2);
    await expect(dialog.getByRole("button", { name: "正在清空…", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    expect(backend.clearRequests).toBe(2);
    release();
    await expect(dialog).not.toBeVisible();
    await expect(
      page.getByRole("status").filter({ hasText: "SQLite 业务数据已清空。" }),
    ).toBeVisible();
    await expect(records).toContainText("共 0 条 · 第 1 / 1 页");
    await expect(records.locator("tbody tr")).toHaveCount(0);
    await expect(page.locator(".role-drawer")).toHaveCount(0);
    expect(new URL(page.url()).searchParams.has("recordsPage")).toBe(false);
    expect(new URL(page.url()).searchParams.has("record")).toBe(false);
    expect(backend.clearSuccesses).toBe(1);
    const after = backend.summary();
    assertEmpty(after);
    expect(after.settings).toBe(before.settings);
    expect(after.market).toBe(before.market);
    expect(after.scheduleConfig).toEqual(before.scheduleConfig);
    expect(after.scheduleMode).toBe("disabled");
    expect(await browserState(page)).toEqual(browserBefore);
    expect(await readFile(backend.logFile, "utf8")).toBe("fixture run log remains\n");
    await page.screenshot({ path: testInfo.outputPath("sqlite-cleared-list.png"), fullPage: true });
    await page
      .getByRole("group", { name: "SQLite 数据清理" })
      .screenshot({ path: testInfo.outputPath("sqlite-cleared-notice.png") });

    backend.reopen();
    const reopened = backend.summary();
    assertEmpty(reopened);
    await page.reload();
    await expect(records).toContainText("共 0 条 · 第 1 / 1 页");
    expect(await browserState(page)).toEqual(browserBefore);
    backend.addRecord("new-after-clear");
    await page.reload();
    await expect(records).toContainText("角色new-after-clear");
    expect(backend.summary().records).toBe(1);
    expect(backend.summary().results).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("sqlite-new-capture.png"), fullPage: true });
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          scope:
            "Real file SQLite and production CrawlStore.clear/AnalysisStore; fixture HTTP and role/AI data; no real user database or service",
          database: backend.database,
          before,
          after,
          reopened,
          final: backend.summary(),
          browserBefore,
          browserAfter: await browserState(page),
          clearRequests: backend.clearRequests,
          clearSuccesses: backend.clearSuccesses,
          cancelAndEscapeKeptData: true,
          activeLockRejected: true,
          repeat:
            "vp run build && vp exec playwright test tests/e2e/sqlite-cleanup.pw.ts --workers=1 --trace=on",
        },
        null,
        2,
      ),
    );
  } finally {
    await page.close();
    backend.close();
  }
});

test("保存并启用计划的请求未结束时禁止清空SQLite，完成后才恢复入口", async ({ page }, testInfo) => {
  const backend = await fixture(page, testInfo);
  let releaseConfigure!: () => void;
  let releaseEnable!: () => void;
  const configureGate = new Promise<void>((resolve) => {
    releaseConfigure = resolve;
  });
  const enableGate = new Promise<void>((resolve) => {
    releaseEnable = resolve;
  });
  let configured!: () => void;
  let enabling!: () => void;
  const configureStarted = new Promise<void>((resolve) => {
    configured = resolve;
  });
  const enableStarted = new Promise<void>((resolve) => {
    enabling = resolve;
  });
  const commands: string[] = [];
  try {
    backend.setScheduleEnabled(false);
    await page.route("**/api/scan/configure", async (route) => {
      commands.push("configure");
      configured();
      await configureGate;
      backend.configureSchedule(route.request().postDataJSON());
      await route.fulfill({ json: backend.scheduleStatus() });
    });
    await page.route("**/api/scan/enable", async (route) => {
      commands.push("enable");
      enabling();
      await enableGate;
      backend.setScheduleEnabled(true);
      await route.fulfill({ json: backend.scheduleStatus() });
    });
    await page.goto(origin);
    const clean = page.getByRole("button", { name: "清空 SQLite 数据", exact: true });
    await expect(clean).toBeEnabled();
    const before = backend.summary();
    await page.getByRole("radio", { name: "每天循环" }).check();
    await page.getByRole("button", { name: "启用计划", exact: true }).click();
    await configureStarted;
    await expect(clean).toBeDisabled();
    expect(backend.clearRequests).toBe(0);
    expect(backend.summary()).toEqual(before);
    await page.getByRole("group", { name: "SQLite 数据清理" }).screenshot({
      path: testInfo.outputPath("sqlite-disabled-during-configure.png"),
    });
    releaseConfigure();
    await enableStarted;
    await expect(clean).toBeDisabled();
    expect(backend.clearRequests).toBe(0);
    releaseEnable();
    await expect(page.getByRole("button", { name: "关闭计划", exact: true })).toBeEnabled();
    await expect(clean).toBeEnabled();
    expect(commands).toEqual(["configure", "enable"]);
    expect(backend.summary().scheduleMode).toBe("enabled");
    expect(backend.summary().tables).toEqual(before.tables);
    expect(backend.clearRequests).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath("sqlite-schedule-complete.png"),
      fullPage: true,
    });
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          scope:
            "Production schedule and cleanup components with delayed fixture configure/enable responses; real file SQLite; no live service",
          commands,
          clearRequests: backend.clearRequests,
          configureAndEnableBothDisabledCleanup: true,
          before,
          after: backend.summary(),
          repeat:
            "vp run build && vp exec playwright test tests/e2e/sqlite-cleanup.pw.ts --workers=1 --trace=on",
        },
        null,
        2,
      ),
    );
  } finally {
    releaseConfigure();
    releaseEnable();
    await page.close();
    backend.close();
  }
});

test("分析页SQLite清理：第二页分析详情→清空→榜单/商品/历史归零且刷新保留空状态", async ({
  page,
}, testInfo) => {
  const backend = await fixture(page, testInfo);
  try {
    await page.goto(origin + "/analysis-preview");
    await seedBrowser(page);
    const browserBefore = await browserState(page);
    await page.getByRole("tab", { name: "分析记录" }).click();
    const history = page.getByRole("tabpanel", { name: "分析记录" });
    await expect(history.getByRole("article")).toHaveCount(20);
    await history.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(history).toContainText("第 2 / 2 页");
    await expect(history.getByRole("article")).toHaveCount(1);
    await history.getByRole("button", { name: /查看分析详情/ }).click();
    await expect(page.locator(".analysis-detail-dialog")).toBeVisible();
    await page.getByRole("button", { name: "关闭分析详情" }).click();
    const before = backend.summary();
    let releaseOldReply!: () => void;
    let oldReplyStarted!: () => void;
    let oldReplyFinished!: () => void;
    const waitingOldReply = new Promise<void>((resolve) => {
      releaseOldReply = resolve;
    });
    const receivedOldReply = new Promise<void>((resolve) => {
      oldReplyStarted = resolve;
    });
    const completedOldReply = new Promise<void>((resolve) => {
      oldReplyFinished = resolve;
    });
    let delayNextOverview = true;
    await page.route("**/api/analysis/status?**", async (route) => {
      if (!delayNextOverview) return route.fallback();
      delayNextOverview = false;
      const oldBody = backend.overview();
      oldReplyStarted();
      await waitingOldReply;
      // The clear callback may have already cancelled this obsolete request.
      await route.fulfill({ json: oldBody }).catch(() => {});
      oldReplyFinished();
    });
    await page.getByRole("tab", { name: "推荐榜" }).click();
    await receivedOldReply;
    await page.getByRole("button", { name: "清空 SQLite 数据", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认清空 SQLite 数据" });
    await dialog.getByRole("button", { name: "确认清空", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "SQLite 业务数据已清空。" }),
    ).toBeVisible();
    await expect(page.locator(".analysis-detail-dialog")).toHaveCount(0);
    await expect(page.locator(".role-drawer")).toHaveCount(0);
    releaseOldReply();
    await completedOldReply;
    await page.getByRole("tab", { name: "分析记录" }).click();
    await expect(history.getByRole("article")).toHaveCount(0);
    await expect(history).not.toContainText("第 2");
    await page.getByRole("tab", { name: "推荐榜" }).click();
    await expect(page.getByRole("tabpanel", { name: "推荐榜" }).getByRole("article")).toHaveCount(
      0,
    );
    await page.getByRole("tab", { name: "全部商品" }).click();
    await expect(page.getByRole("tabpanel", { name: "全部商品" }).locator("tbody tr")).toHaveCount(
      0,
    );
    const after = backend.summary();
    assertEmpty(after);
    expect(after.settings).toBe(before.settings);
    expect(after.market).toBe(before.market);
    expect(after.scheduleMode).toBe("disabled");
    expect(await browserState(page)).toEqual(browserBefore);
    expect(backend.clearRequests).toBe(1);
    expect(backend.clearSuccesses).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath("sqlite-analysis-empty.png"),
      fullPage: true,
    });
    backend.reopen();
    await page.reload();
    await page.getByRole("tab", { name: "分析记录" }).click();
    await expect(page.getByRole("tabpanel", { name: "分析记录" }).getByRole("article")).toHaveCount(
      0,
    );
    assertEmpty(backend.summary());
    await page.screenshot({
      path: testInfo.outputPath("sqlite-analysis-reopened-empty.png"),
      fullPage: true,
    });
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          scope:
            "Real file SQLite and production stores/clear; fixture HTTP and captured/analysis data",
          database: backend.database,
          before,
          after,
          reopened: backend.summary(),
          browserBefore,
          browserAfter: await browserState(page),
          clearRequests: backend.clearRequests,
          obsoleteOverviewReplyReleasedAfterClear: true,
          reset: [
            "analysis detail",
            "collection detail",
            "results second page",
            "ranking",
            "all products",
            "history",
          ],
          repeat:
            "vp run build && vp exec playwright test tests/e2e/sqlite-cleanup.pw.ts --workers=1 --trace=on",
        },
        null,
        2,
      ),
    );
  } finally {
    await page.close();
    backend.close();
  }
});
