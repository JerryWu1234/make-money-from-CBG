import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { AnalysisRunner } from "../../server/analysis/runner";
import { AnalysisStore } from "../../server/analysis/store";
import { createProfile, PROMPT_FILE } from "../../server/analysis/profile";
import { calculateValuation } from "../../server/analysis/valuation-calculator";
import { crawl } from "../../server/crawler/runner";
import { CrawlStore } from "../../server/crawler/store";
import type {
  CrawlSource,
  CrawlStatus,
  Listing,
  ListingPage,
  SavedRoleRecord,
} from "../../server/crawler/types";
import { valuationRecord } from "../fixtures/analysis";
import { browserStatus } from "../fixtures/saved-role";

const failureModes = [
  "新号排队时仍派发老号、没有新号待派时空着名额，或新号出现后打断老号在途任务",
  "只查看首页或遇到一个旧商品就停止，漏掉跨页、同秒新增商品",
  "跨页重复商品重复入库，详情或报价串到另一个商品",
  "暂停后仍然落库，重启后首页检查进度覆盖历史回补进度",
  "分析默认10未按7新3老分配，空侧不能借位，或旧任务一直没有名额",
  "分析暂停后丢失已完成报价，恢复后遗漏排队商品",
];

// 本地列表和 AI 是受控模拟；采集/分析 runner、SQLite、React 页面均使用真实实现。
test("新老双队列：持续发现→跨页去重→暂停重启→7/3分析借位→保留全部报价", async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(180_000);
  const database = testInfo.outputPath("fresh-history.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  let store = new CrawlStore(database);
  let analysisStore: AnalysisStore | undefined;
  let analysisRunner: AnalysisRunner | undefined;
  let batch = "";
  let control: AbortController | undefined;
  let completion: Promise<void> | undefined;
  const profile = createProfile(
    await readFile(PROMPT_FILE, "utf8"),
    {
      servers: [
        {
          serverId: "367",
          age: "older",
          rank: 13,
          goldPrice: 218.29,
          goldUnit: 30000000,
          baselineUnitConfirmed: true,
        },
      ],
    },
    false,
  );
  const records = new Map<string, SavedRoleRecord>();
  for (const key of [
    ...Array.from({ length: 9 }, (_, i) => `n${i + 1}`),
    ...Array.from({ length: 6 }, (_, i) => `o${i + 1}`),
  ]) {
    const record = valuationRecord(key);
    const time = key.startsWith("n")
      ? key === "n9"
        ? "2026-10-23T02:02:00.000Z"
        : Number(key.slice(1)) > 2
          ? "2026-10-23T02:01:00.000Z"
          : "2026-10-23T02:00:00.000Z"
      : `2026-10-22T02:00:0${6 - Number(key.slice(1))}.000Z`;
    Object.assign(record.listing, {
      price: String((key.startsWith("n") ? 600 : 700) + Number(key.slice(1))),
      sellingTime: time,
      orderTime: time,
    });
    record.detail!.equipmentCapture!.emptyProof = "explicit-text";
    record.detail!.tabs.push(
      {
        name: "道具/法宝",
        text: "没有装备",
        fields: [],
        tables: [],
        elements: [],
        tooltips: [],
        items: [],
        equipmentEmptyProof: "official-containers",
      },
      {
        name: "召唤兽/孩子",
        text: "召唤兽(0/10)",
        fields: [],
        tables: [],
        elements: [],
        tooltips: [],
        pets: [],
        petCount: 0,
      },
    );
    record.detail!.valuation = {
      version: 1,
      fields: [],
      issues: [],
      source: {
        eid: record.listing.eid,
        serverId: "367",
        askingPrice: record.listing.price,
        fixtureKey: key,
      },
    };
    records.set(key, record);
  }
  let listKeys = [
    ["n1", "n2"],
    ["o1", "o2", "o3"],
    // 先保留一个重复的历史待采项；其余历史商品在下一次列表更新中出现。
    ["o3"],
  ];
  const listPage = await context.newPage();
  const analysisPage = await context.newPage();
  let status: CrawlStatus = {
    running: false,
    phase: "idle",
    message: "本地模拟列表已就绪",
    page: 0,
    totalPages: 0,
    saved: 0,
    skipped: 0,
    totalSaved: 0,
    database,
  };
  const captureGates = new Map<string, () => void>();
  const capturedCalls: string[] = [];
  const activeCapture = new Map<string, "new" | "old">();
  const allowedCapture = new Set<string>();
  const captureConfigurations: number[] = [];
  const captureStates: Array<{ new: number; old: number }> = [];
  const captureQueuedStates: Array<{ new: number; old: number }> = [];
  const analysisGates = new Map<string, () => void>();
  const analysisCalls: string[] = [];
  const allowedAnalysis = new Set<string>();
  const activeAnalysis = new Map<string, "new" | "old">();
  const analysisStates: Array<{ new: number; old: number }> = [];
  const analysisConfigurations: number[] = [];
  const countLanes = (active: Map<string, "new" | "old">) => ({
    new: [...active.values()].filter((lane) => lane === "new").length,
    old: [...active.values()].filter((lane) => lane === "old").length,
  });
  const gate = async (
    key: string,
    gates: Map<string, () => void>,
    allowed: Set<string>,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    if (allowed.has(key)) return;
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        gates.delete(key);
        reject(signal.reason);
      };
      gates.set(key, () => {
        signal.removeEventListener("abort", abort);
        gates.delete(key);
        resolve();
      });
      signal.addEventListener("abort", abort, { once: true });
    });
  };
  const release = (key: string, gates: Map<string, () => void>, allowed: Set<string>) => {
    allowed.add(key);
    gates.get(key)?.();
  };
  const renderList = async () => {
    const pages = listKeys.map((keys) => keys.map((key) => records.get(key)!.listing));
    await listPage.evaluate((pages) => {
      const state = window as unknown as { fixturePages: Listing[][] };
      state.fixturePages = pages;
      document.querySelector("main")!.textContent = pages
        .map(
          (items, index) =>
            `第 ${index + 1} 页：${items.map((item) => `${item.name} ¥${item.price}`).join("、")}`,
        )
        .join("\n");
    }, pages);
  };
  const source = (signal: AbortSignal): CrawlSource => {
    const read = (number: number) =>
      listPage.evaluate((number): ListingPage => {
        const pages = (window as unknown as { fixturePages: Listing[][] }).fixturePages;
        return {
          page: number,
          totalPages: pages.length,
          order: "selling_time DESC",
          items: pages[number - 1] || [],
        };
      }, number);
    return {
      prepare: async () => read(1),
      page: read,
      onShelf: async () => true,
      hover: async (item) => item,
      detail: async (item) => {
        const lane = store.captureLane(item.key);
        capturedCalls.push(item.key);
        activeCapture.set(item.key, lane);
        captureStates.push(countLanes(activeCapture));
        try {
          await gate(item.key, captureGates, allowedCapture, signal);
          return structuredClone(records.get(item.key)!.detail!);
        } finally {
          activeCapture.delete(item.key);
        }
      },
    };
  };
  const overview = () => ({
    ...status,
    totalSaved: store.count(),
    checkpoint: store.checkpoint(),
    recent: store.recent(),
  });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-flow.test") return route.abort();
    if (url.pathname === "/fixture-list")
      return route.fulfill({
        contentType: "text/html",
        body: "<meta charset=utf-8><h1>本地受控列表（模拟数据）</h1><main style='white-space:pre-wrap'></main>",
      });
    if (url.pathname === "/api/runtime/settings")
      return route.fulfill({ json: { saveScreenshots: false } });
    if (url.pathname === "/api/browser/settings")
      return route.fulfill({ json: { mode: "daily", connected: true, busy: false } });
    if (url.pathname.startsWith("/api/")) {
      const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
      let body: unknown;
      switch (url.pathname) {
        case "/api/browser/status":
          body = browserStatus;
          break;
        case "/api/crawl/settings":
          body = { analyzeEquipment: false };
          break;
        case "/api/crawl/status":
          body = overview();
          break;
        case "/api/crawl/records":
          body = store.records(Number(url.searchParams.get("page") || 1), 20);
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
        case "/api/crawl/start": {
          control = new AbortController();
          captureConfigurations.push(input.concurrency);
          const signal = control.signal;
          status = { ...status, running: true, phase: "locating", saved: 0, skipped: 0 };
          completion = crawl(
            source(signal),
            store,
            signal,
            (update) => {
              status = { ...status, ...update };
              if (update.newQueued !== undefined && update.oldQueued !== undefined)
                captureQueuedStates.push({ new: update.newQueued, old: update.oldQueued });
              analysisRunner?.appendCaptured();
            },
            { concurrency: input.concurrency, watch: true, headIntervalMs: 100 },
          ).catch((error: unknown) => {
            status = {
              ...status,
              running: false,
              phase: signal.aborted ? "paused" : "error",
              message: String(error),
            };
          });
          body = overview();
          break;
        }
        case "/api/crawl/stop":
          control!.abort(new Error("用户暂停采集"));
          await completion;
          body = overview();
          break;
        case "/api/ai/status":
          body = {
            codex: { state: "connected", model: "test-model", response: "READY" },
            deepseek: { state: "unconfigured" },
            deepseekModels: [],
          };
          break;
        case "/api/ai/models":
          body = {
            provider: "codex",
            defaultModel: "test-model",
            models: [{ id: "test-model", name: "模拟模型" }],
          };
          break;
        case "/api/analysis/status":
          body = { ...analysisStore!.overview({ runId: batch || undefined }), profile };
          break;
        case "/api/analysis/start":
          analysisConfigurations.push(input.concurrency);
          batch = await analysisRunner!.start(
            input.provider,
            false,
            profile,
            false,
            undefined,
            1,
            undefined,
            input.concurrency,
          );
          body = analysisStore!.run(batch);
          break;
        case "/api/analysis/pause":
          await analysisRunner!.pause(input.runId);
          body = analysisStore!.run(batch);
          break;
        case "/api/analysis/resume":
          analysisConfigurations.push(input.concurrency);
          await analysisRunner!.resume(input.runId, false, input.concurrency);
          body = analysisStore!.run(batch);
          break;
        default:
          throw new Error("未模拟接口：" + url.pathname);
      }
      return route.fulfill({ json: body });
    }
    const file = path.join(
      "dist",
      ["/", "/analysis-preview"].includes(url.pathname) ? "index.html" : url.pathname,
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
  try {
    await listPage.goto("http://cbg-flow.test/fixture-list");
    await renderList();
    await page.goto("http://cbg-flow.test/");
    const crawlCount = page.getByRole("spinbutton", { name: "并发抓取数" });
    const startCapture = page.getByRole("button", { name: /开始采集详情|继续采集 \/ 检查新增/ });
    await expect(crawlCount).toHaveValue("10");
    await crawlCount.fill("4");
    await startCapture.click();
    await expect.poll(() => countLanes(activeCapture)).toEqual({ new: 2, old: 2 });
    await expect(crawlCount).toBeDisabled();
    await expect(page.getByLabel("采集双队列状态")).toContainText("新号在途 2 · 老号在途 2");
    expect(status.captureStrategy).toBe("new-first");
    await expect(page.getByText(/首页下次检查：/)).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("capture-new-priority-old-fill.png"),
      fullPage: true,
    });
    listKeys = [
      ["n3", "n4", "n5"],
      ["n6", "n7", "n8", "n1", "n2"],
      ["o1", "o2", "o3"],
      ["o3", "o4", "o5", "o6"],
    ];
    await renderList();
    const discoveredNew = () =>
      store.db.prepare("SELECT count(*) n FROM listings WHERE capture_lane='new'").get()!.n;
    await expect.poll(discoveredNew).toBe(6);
    await expect
      .poll(() => ({ new: status.newQueued, old: status.oldQueued }))
      .toEqual({
        new: 4,
        old: 1,
      });
    expect([...activeCapture.keys()]).toEqual(expect.arrayContaining(["o1", "o2"]));
    await expect(page.getByLabel("采集双队列状态")).toContainText("新号排队 4");
    // 已在途老号继续；有新号排队时，空出的名额优先给新号。
    release("n1", captureGates, allowedCapture);
    await expect.poll(() => activeCapture.has("n3")).toBe(true);
    await expect.poll(discoveredNew).toBe(7);
    expect([...activeCapture.keys()]).toEqual(expect.arrayContaining(["o1", "o2"]));
    release("n2", captureGates, allowedCapture);
    await expect.poll(() => activeCapture.has("n4")).toBe(true);
    await expect.poll(discoveredNew).toBe(8);
    expect([...activeCapture.keys()]).toEqual(expect.arrayContaining(["o1", "o2"]));
    release("n3", captureGates, allowedCapture);
    await expect.poll(() => activeCapture.has("n5")).toBe(true);
    expect([...activeCapture.keys()]).toEqual(expect.arrayContaining(["o1", "o2"]));
    expect(capturedCalls).not.toContain("o3");
    for (let number = 1; number <= 8; number++) release(`n${number}`, captureGates, allowedCapture);
    await expect.poll(() => store.count()).toBe(8);
    release("o1", captureGates, allowedCapture);
    await expect.poll(() => store.count()).toBe(9);
    await expect.poll(() => activeCapture.has("o3")).toBe(true);
    await page.getByRole("button", { name: "暂停采集", exact: true }).click();
    await expect(crawlCount).toBeEnabled();
    expect(activeCapture.size).toBe(0);
    const progressBeforeRestart = {
      head: store.headCheckpoint(),
      history: store.checkpoint(),
      count: store.count(),
    };
    expect(progressBeforeRestart.head).toBeDefined();
    expect(progressBeforeRestart.history).toBeDefined();
    store.close();
    store = new CrawlStore(database);
    expect({
      head: store.headCheckpoint(),
      history: store.checkpoint(),
      count: store.count(),
    }).toEqual(progressBeforeRestart);
    listKeys[0].unshift("n9");
    await renderList();
    for (let number = 1; number <= 6; number++) release(`o${number}`, captureGates, allowedCapture);
    release("n9", captureGates, allowedCapture);
    await page.reload();
    await expect(crawlCount).toHaveValue("10");
    await crawlCount.fill("4");
    await startCapture.click();
    await expect.poll(() => store.count()).toBe(15);
    await expect.poll(() => store.backfillComplete()).toBe(true);
    await page.getByRole("button", { name: "暂停采集", exact: true }).click();
    const progressAfterRestart = {
      head: store.headCheckpoint(),
      history: store.checkpoint(),
      count: store.count(),
    };
    expect(store.retryItems()).toHaveLength(0);
    expect(capturedCalls.filter((key) => key === "n1")).toHaveLength(1);
    expect(capturedCalls.filter((key) => key === "o3")).toHaveLength(2);
    for (const [key, record] of records) {
      const saved = store.detail(key) as SavedRoleRecord;
      expect(saved.status).toBe("complete");
      expect(saved.detail!.valuation!.source.fixtureKey).toBe(key);
      expect(saved.listing.price).toBe(record.listing.price);
      expect(store.captureLane(key)).toBe(key.startsWith("n") ? "new" : "old");
    }
    await listPage.screenshot({ path: testInfo.outputPath("local-list.png"), fullPage: true });
    analysisStore = new AnalysisStore(store.db);
    analysisRunner = new AnalysisRunner(analysisStore, async () => ({
      model: "test-model",
      analyze: async (prompt, _schema, signal) => {
        const key = prompt.match(/商品 ID：([^。\n]+)[。\n]/)![1];
        analysisCalls.push(key);
        activeAnalysis.set(key, store.captureLane(key));
        analysisStates.push(countLanes(activeAnalysis));
        try {
          await gate(key, analysisGates, allowedAnalysis, signal);
          return {
            text: JSON.stringify({
              decision: calculateValuation(store.detail(key) as SavedRoleRecord, profile).decision,
              reason: `本地模拟AI核对${key}原文；金额由真实裸号公式复算。`,
              extracted_facts: [],
            }),
          };
        } finally {
          activeAnalysis.delete(key);
        }
      },
    }));
    await analysisPage.goto("http://cbg-flow.test/analysis-preview");
    const analysisCount = analysisPage.getByRole("spinbutton", { name: "分析并发数" });
    await expect(analysisCount).toHaveValue("10");
    await analysisPage.getByRole("button", { name: "开始分析已有商品" }).click();
    await expect.poll(() => countLanes(activeAnalysis)).toEqual({ new: 7, old: 3 });
    await expect(analysisCount).toBeDisabled();
    await expect(analysisPage.getByLabel("分析双队列状态")).toContainText(
      "新号在途 7（配额 7） · 老号在途 3（配额 3）",
    );
    await analysisPage.screenshot({
      path: testInfo.outputPath("analysis-seven-plus-three.png"),
      fullPage: true,
    });
    for (let number = 1; number <= 9; number++)
      release(`n${number}`, analysisGates, allowedAnalysis);
    await expect.poll(() => analysisStore!.run(batch)!.completed).toBe(9);
    await expect.poll(() => countLanes(activeAnalysis)).toEqual({ new: 0, old: 6 });
    await expect(analysisPage.getByLabel("分析双队列状态")).toContainText(
      "老号在途 6（配额 3，借用 3 个空闲名额）",
    );
    await analysisPage.screenshot({
      path: testInfo.outputPath("analysis-borrowed-slots.png"),
      fullPage: true,
    });
    await analysisPage.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect(analysisCount).toBeEnabled();
    expect(analysisStore.run(batch)).toMatchObject({
      status: "paused",
      completed: 9,
      queued: 6,
      runningCount: 0,
    });
    const preservedQuotes = analysisStore
      .overview({ runId: batch })
      .results.items.map(({ result }) => ({ key: result.productKey, valuation: result.valuation }));
    await analysisPage.reload();
    await analysisPage.getByRole("button", { name: "继续分析" }).click();
    await expect.poll(() => activeAnalysis.size).toBe(6);
    for (let number = 1; number <= 6; number++)
      release(`o${number}`, analysisGates, allowedAnalysis);
    await expect.poll(() => analysisStore!.run(batch)!.completed).toBe(15);
    await expect(analysisPage.getByText(/现有角色已处理完，等待新角色/)).toBeVisible();
    await analysisPage.getByRole("button", { name: "暂停分析", exact: true }).click();
    const run = analysisStore.run(batch)!;
    expect(run).toMatchObject({
      status: "paused",
      failed: 0,
      queued: 0,
      completed: 15,
      runningCount: 0,
    });
    const results = analysisStore.overview({ runId: batch }).results.items.map(({ result }) => {
      const record = store.detail(result.productKey) as SavedRoleRecord;
      expect(result.valuation!.asking_price).toBe(Number(record.listing.price));
      expect(result.valuation!.bare_role_value).toBeGreaterThan(0);
      expect(record.detail!.valuation!.source.fixtureKey).toBe(result.productKey);
      return { key: result.productKey, valuation: result.valuation };
    });
    expect(results).toHaveLength(15);
    expect(results).toEqual(expect.arrayContaining(preservedQuotes));
    expect(analysisCalls.filter((key) => key.startsWith("n"))).toHaveLength(9);
    expect(captureConfigurations).toEqual([4, 4]);
    expect(Math.max(...captureStates.map((state) => state.new + state.old))).toBe(4);
    expect(Math.max(...captureQueuedStates.map((state) => state.new))).toBe(4);
    expect(Math.max(...captureQueuedStates.map((state) => state.old))).toBeLessThanOrEqual(4);
    expect(
      Math.max(...captureQueuedStates.map((state) => state.new + state.old)),
    ).toBeLessThanOrEqual(8);
    expect(Math.max(...analysisStates.map((state) => state.new + state.old))).toBe(10);
    await analysisPage.screenshot({
      path: testInfo.outputPath("fifteen-final-quotes.png"),
      fullPage: true,
    });
    const evidence = testInfo.outputPath("evidence.json");
    await writeFile(
      evidence,
      JSON.stringify(
        {
          fixture: true,
          failureModes,
          repeat:
            "vp run build && vp exec playwright test tests/e2e/fresh-history-flow.pw.ts --workers=1 --output=data/fresh-history-e2e",
          database: path.basename(database),
          captureConfigurations,
          analysisConfigurations,
          captureStates,
          captureQueuedStates,
          analysisStates,
          capturedCalls,
          analysisCalls,
          listKeys,
          progressBeforeRestart,
          progressAfterRestart,
          preservedQuotes,
          run,
          results,
        },
        null,
        2,
      ),
    );
    store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    await testInfo.attach("双队列完整链路证据", {
      path: evidence,
      contentType: "application/json",
    });
    await testInfo.attach("可复查SQLite数据库", {
      path: database,
      contentType: "application/vnd.sqlite3",
    });
  } finally {
    control?.abort(new Error("测试清理"));
    await completion;
    await analysisRunner?.shutdown();
    await listPage.close();
    await analysisPage.close();
    store.close();
  }
});
