import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import {
  CodexPool,
  type CodexPoolEvent,
  type CodexPoolTransport,
} from "../../server/ai/codex-pool";
import { CrawlStore } from "../../server/crawler/store";
import type { SavedRoleRecord } from "../../server/crawler/types";
import { AnalysisRunner, type AnalysisClient } from "../../server/analysis/runner";
import { AnalysisStore } from "../../server/analysis/store";
import { createProfile, PROMPT_FILE } from "../../server/analysis/profile";
import { calculateValuation } from "../../server/analysis/valuation-calculator";
import { valuationRecord } from "../fixtures/analysis";
import { acquireCodexRuntime } from "../../scripts/codex-runtime.mjs";
import { CodexLifecycle } from "../../server/ai/codex-lifecycle";

// Failure cases: more than 10 in-flight requests, cross-role context or results,
// releasing a successful response before its result commits, lost pause/restart
// progress, or reusing a failed thread when retrying after a terminal 429.
// Runtime threads are temporary; analysis results remain durable in SQLite.
class FixtureTransport implements CodexPoolTransport {
  readonly listeners = new Set<(event: CodexPoolEvent) => void>();
  readonly pending = new Map<string, { threadId: string; key: string }>();
  readonly threadSelections: Array<{ method: string; threadId: string; modelProvider: unknown }> =
    [];
  readonly started: Array<{ threadId: string; turnId: string; key: string }> = [];
  readonly released: Array<{ threadId: string; turnId: string; key: string; state: string }> = [];
  readonly rejected: string[] = [];
  readonly terminalStates = new Map<string, string>();
  readonly workspaces: string[] = [];
  readonly rateLimited: Array<{ threadId: string; key: string; at: number }> = [];
  readonly lifecycleRequests: Array<{
    method: string;
    receivedAt: number;
    startedAt?: number;
    finishedAt?: number;
  }> = [];
  readonly interrupts: Array<{ key: string; duringLifecycle: boolean }> = [];
  private lifecycle = Promise.resolve();
  private lifecycleBusy = false;
  private nextThread = 0;
  private nextTurn = 0;
  closed = false;

  constructor(
    readonly crawl: CrawlStore,
    readonly profile: ReturnType<typeof createProfile>,
    readonly label: string,
    readonly rateLimitKey?: string,
    readonly histories = new Map<string, string[]>(),
    readonly lifecycleDelayMs = 0,
    readonly runtimeDirectory?: string,
  ) {}

  subscribe(listener: (event: CodexPoolEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method: string, params: unknown) {
    if (method === "turn/completed") {
      const turn = (params as { turn: { id: string; status: string } }).turn;
      this.terminalStates.set(turn.id, turn.status);
    }
    for (const listener of this.listeners) listener({ method, params });
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.lifecycleDelayMs && ["thread/start", "thread/unsubscribe"].includes(method)) {
      const entry: (typeof this.lifecycleRequests)[number] = {
        method,
        receivedAt: Date.now(),
      };
      this.lifecycleRequests.push(entry);
      const operation = this.lifecycle.then(async () => {
        entry.startedAt = Date.now();
        this.lifecycleBusy = true;
        try {
          await new Promise((resolve) => setTimeout(resolve, this.lifecycleDelayMs));
          return await this.respond(method, params);
        } finally {
          entry.finishedAt = Date.now();
          this.lifecycleBusy = false;
        }
      });
      this.lifecycle = operation.then(
        () => {},
        () => {},
      );
      return await new Promise((resolve, reject) => {
        // Scale the incident's 5-second work / 20-second RPC deadline by 1:10.
        const timer = setTimeout(
          () => reject(new Error(`Codex ${method} 响应超时`)),
          this.lifecycleDelayMs * 4,
        );
        operation.then(
          (result) => {
            clearTimeout(timer);
            resolve(result);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
      });
    }
    return await this.respond(method, params);
  }

  private async respond(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "thread/start") {
      expect(params.modelProvider).toBe("openai_http");
      expect(params.ephemeral).toBe(true);
      const id = `${this.label}-thread-${++this.nextThread}`;
      const workspace = String(params.cwd);
      this.workspaces.push(workspace);
      await writeFile(path.join(workspace, "fixture-request.tmp"), id);
      if (this.runtimeDirectory) {
        await mkdir(path.join(this.runtimeDirectory, "cache"), { recursive: true });
        await writeFile(path.join(this.runtimeDirectory, "cache", "fixture-runtime.json"), id);
        await writeFile(path.join(this.runtimeDirectory, "logs_2.sqlite"), "fixture-runtime-log");
      }
      this.histories.set(id, []);
      this.threadSelections.push({ method, threadId: id, modelProvider: params.modelProvider });
      return { thread: { id, ephemeral: true } };
    }
    if (method === "turn/start") {
      const threadId = String(params.threadId);
      const history = this.histories.get(threadId);
      if (
        !history ||
        history.length ||
        [...this.pending.values()].some((turn) => turn.threadId === threadId)
      )
        throw new Error("session 包含上一角色历史或正在处理另一角色");
      const prompt = (params.input as Array<{ text: string }>)[0]?.text || "";
      const key = prompt.match(/商品 ID：([^。\n]+)[。\n]/)?.[1];
      if (!key || !params.outputSchema) throw new Error("角色身份或结构化输出缺失");
      const turnId = `${this.label}-turn-${++this.nextTurn}`;
      history.push(turnId);
      this.pending.set(turnId, { threadId, key });
      this.started.push({ threadId, turnId, key });
      // Exercise app-server notifications arriving before the RPC response.
      this.emit("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
      if (key === this.rateLimitKey && !this.rateLimited.length) {
        this.rateLimited.push({ threadId, key, at: Date.now() });
        this.pending.delete(turnId);
        this.emit("turn/completed", {
          threadId,
          turn: { id: turnId, status: "failed", error: { message: "429 Too Many Requests" } },
        });
      }
      return { turn: { id: turnId, status: "inProgress" } };
    }
    if (method === "thread/unsubscribe") {
      const threadId = String(params.threadId);
      const turn = this.started.find((item) => item.threadId === threadId);
      const row =
        turn &&
        this.crawl.db
          .prepare(`SELECT a.state,a.finished_at,t.result_json FROM analysis_attempts a
          JOIN analysis_tasks t ON t.id=a.task_id WHERE t.listing_key=? ORDER BY a.rowid DESC LIMIT 1`)
          .get(turn.key);
      const status = turn && this.terminalStates.get(turn.turnId);
      if (
        turn &&
        (!status ||
          this.pending.has(turn.turnId) ||
          (status === "completed" &&
            (!row || row.state !== "completed" || !row.finished_at || !row.result_json)))
      ) {
        this.rejected.push(turn.turnId);
        throw new Error("角色结果未保存或请求尚未终止，不能释放临时会话");
      }
      if (turn)
        this.released.push({ threadId, turnId: turn.turnId, key: turn.key, state: status! });
      this.histories.delete(threadId);
      return { status: "unsubscribed" };
    }
    if (method === "turn/interrupt") {
      const turnId = String(params.turnId),
        turn = this.pending.get(turnId);
      if (turn) {
        this.interrupts.push({ key: turn.key, duringLifecycle: this.lifecycleBusy });
        this.pending.delete(turnId);
        queueMicrotask(() =>
          this.emit("turn/completed", {
            threadId: turn.threadId,
            turn: { id: turnId, status: "interrupted" },
          }),
        );
      }
      return {};
    }
    throw new Error(`未模拟 RPC：${method}`);
  }

  finishAll() {
    for (const [turnId, turn] of [...this.pending].reverse()) {
      const record = this.crawl.detail(turn.key) as SavedRoleRecord;
      const response = JSON.stringify({
        decision: calculateValuation(record, this.profile).decision,
        reason: `模拟核对角色 ${turn.key} 的原文。`,
        extracted_facts: [],
      });
      this.pending.delete(turnId);
      this.emit("item/completed", {
        threadId: turn.threadId,
        turnId,
        item: { type: "agentMessage", id: `answer-${turnId}`, text: response },
      });
      this.emit("thread/tokenUsage/updated", {
        threadId: turn.threadId,
        turnId,
        tokenUsage: {
          last: {
            inputTokens: 11,
            cachedInputTokens: 2,
            outputTokens: 4,
            reasoningOutputTokens: 1,
          },
        },
      });
      this.emit("turn/completed", {
        threadId: turn.threadId,
        turn: { id: turnId, status: "completed" },
      });
    }
  }

  async close() {
    this.closed = true;
  }
}

function barrier() {
  let release!: () => void;
  let enter!: () => void;
  return {
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    started: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    release: () => release(),
    enter: () => enter(),
  };
}

async function sharedCleanupFixture(
  testInfo: TestInfo,
  crawl: () => CrawlStore,
  transports: FixtureTransport[],
) {
  const root = testInfo.outputPath("isolated-runtime");
  const projectRoot = path.join(root, "project");
  const userHome = path.join(root, "user");
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(userHome, { recursive: true }),
  ]);
  let authActive = false;
  let authCalls = 0;
  let sweeping = false;
  let failNext = false;
  let sweepBlock: ReturnType<typeof barrier> | undefined;
  const blocks: ReturnType<typeof barrier>[] = [];
  const sweeps: Array<{ removed: string[]; savedResults: number }> = [];
  const failures: string[] = [];
  const lease = await acquireCodexRuntime({
    projectRoot,
    userHome,
    checkWriters: async () => {
      expect(
        transports.every((transport) => transport.closed && transport.pending.size === 0),
      ).toBe(true);
      expect(authActive).toBe(false);
    },
  });
  await lease.clean();
  await writeFile(path.join(lease.directory, "auth.json"), "fixture-login-preserved");
  const lifecycle = new CodexLifecycle({
    cleanup: async () => {
      sweeping = true;
      try {
        expect(
          transports.every((transport) => transport.closed && transport.pending.size === 0),
        ).toBe(true);
        expect(authActive).toBe(false);
        const block = sweepBlock;
        sweepBlock = undefined;
        block?.enter();
        await block?.wait;
        if (failNext) {
          failNext = false;
          failures.push("fixture cleanup I/O failure");
          throw new Error("fixture cleanup I/O failure");
        }
        const removed = await lease.sweep();
        const savedResults = Number(
          crawl()
            .db.prepare("SELECT count(*) n FROM analysis_tasks WHERE result_json IS NOT NULL")
            .get()?.n,
        );
        sweeps.push({ removed, savedResults });
      } finally {
        sweeping = false;
      }
    },
  });
  lifecycle.registerShutdown(async () => {
    authActive = false;
  });
  const operation = (block?: ReturnType<typeof barrier>) =>
    lifecycle.withOperation(async () => {
      expect(sweeping).toBe(false);
      authCalls++;
      authActive = true;
      await writeFile(path.join(lease.directory, "models_cache.json"), "fixture-model-catalog");
      block?.enter();
      await block?.wait;
      return "READY";
    });
  return {
    lifecycle,
    directory: lease.directory,
    sweeps,
    failures,
    get authCalls() {
      return authCalls;
    },
    get sweeping() {
      return sweeping;
    },
    operation,
    blockNextSweep() {
      const block = barrier();
      blocks.push(block);
      sweepBlock = block;
      return block;
    },
    holdOperation() {
      const block = barrier();
      blocks.push(block);
      const done = operation(block);
      return { ...block, done };
    },
    failNextSweep() {
      failNext = true;
    },
    unblock() {
      for (const block of blocks) block.release();
    },
    async close() {
      for (const block of blocks) block.release();
      try {
        await lifecycle.requestCleanup();
      } finally {
        await lease.release();
      }
    },
  };
}

async function fixture(
  page: Page,
  testInfo: TestInfo,
  count: number,
  options: {
    rateLimitKey?: string;
    lifecycleDelayMs?: number;
    sharedCleanup?: boolean;
    finiteBatch?: boolean;
  } = {},
) {
  const database = testInfo.outputPath("analysis.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  let crawl = new CrawlStore(database);
  const keys = Array.from(
    { length: count },
    (_, index) => `role-${String(index + 1).padStart(2, "0")}`,
  );
  for (const [index, key] of keys.entries()) {
    const record = valuationRecord(key);
    record.listing.price = String(500 + index);
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
    crawl.observe(record.listing);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
  }
  let store = new AnalysisStore(crawl.db);
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
  const transports: FixtureTransport[] = [];
  const shared = options.sharedCleanup
    ? await sharedCleanupFixture(testInfo, () => crawl, transports)
    : undefined;
  const client: AnalysisClient = {
    model: "fixture-codex",
    analyze: async () => {
      throw new Error("应使用独立临时会话");
    },
    createSessionPool(size) {
      const batch = shared?.lifecycle.beginBatch();
      const transport = new FixtureTransport(
        crawl,
        profile,
        `run-${transports.length + 1}`,
        options.rateLimitKey,
        undefined,
        options.lifecycleDelayMs,
        shared?.directory,
      );
      transports.push(transport);
      const pool = new CodexPool(size, "fixture-codex", async () => transport);
      return {
        async acquire(signal) {
          const scope = await batch;
          const lease = scope
            ? await scope.run(() => pool.acquire(signal))
            : await pool.acquire(signal);
          return {
            analyze: (prompt, schema, requestSignal, options) =>
              scope
                ? scope.run(() => lease.run(prompt, schema, requestSignal, options))
                : lease.run(prompt, schema, requestSignal, options),
            release: (persisted) => lease.release(persisted),
          };
        },
        async close() {
          await pool.close();
          await (await batch)?.finish();
        },
      };
    },
  };
  let runner = new AnalysisRunner(store, async () => client);
  let batch = "";
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-session-pool.test") return route.abort();
    if (url.pathname === "/api/runtime/settings")
      return route.fulfill({ json: { saveScreenshots: false } });
    if (url.pathname === "/api/browser/settings")
      return route.fulfill({ json: { mode: "daily", connected: true, busy: false } });
    if (url.pathname.startsWith("/api/")) {
      const input = route.request().method() === "POST" ? route.request().postDataJSON() : {};
      let body: unknown;
      switch (url.pathname) {
        case "/api/ai/status":
          await shared?.operation();
          body = {
            codex: { state: "connected", model: "fixture-codex", response: "READY" },
            deepseek: { state: "unconfigured" },
            deepseekModels: [],
          };
          break;
        case "/api/ai/models":
          await shared?.operation();
          body = {
            provider: "codex",
            defaultModel: "fixture-codex",
            models: [{ id: "fixture-codex", name: "模拟模型" }],
          };
          break;
        case "/api/analysis/progress":
        case "/api/analysis/status":
          body = { ...store.overview({ runId: batch || undefined }), profile };
          break;
        case "/api/analysis/start":
          batch = await runner.start(
            input.provider,
            false,
            profile,
            options.finiteBatch || false,
            undefined,
            count,
            undefined,
            input.concurrency,
          );
          body = store.run(batch);
          break;
        case "/api/analysis/pause":
          await runner.pause(input.runId);
          body = store.run(batch);
          break;
        case "/api/analysis/resume":
          await runner.resume(input.runId, false, input.concurrency);
          body = store.run(batch);
          break;
        case "/api/analysis/retry":
          await runner.resume(input.runId, true, input.concurrency);
          body = store.run(batch);
          break;
        default:
          throw new Error("未模拟接口：" + url.pathname);
      }
      return route.fulfill({ json: body });
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
  await page.goto("http://cbg-session-pool.test/analysis-preview");
  return {
    get crawl() {
      return crawl;
    },
    get store() {
      return store;
    },
    profile,
    get runner() {
      return runner;
    },
    transports,
    keys,
    database,
    shared,
    batch: () => batch,
    async restart(runId: string) {
      await runner.shutdown();
      crawl.close();
      crawl = new CrawlStore(database);
      store = new AnalysisStore(crawl.db);
      runner = new AnalysisRunner(store, async () => client);
      batch = runId;
      await page.reload();
    },
    async close() {
      shared?.unblock();
      await runner.shutdown();
      await shared?.close();
      crawl.close();
    },
  };
}

async function saveEvidence(testInfo: TestInfo, name: string, data: unknown) {
  const file = testInfo.outputPath("evidence.json");
  await writeFile(
    file,
    JSON.stringify(
      {
        fixture: true,
        repeat:
          "vp run build && vp exec playwright test tests/e2e/codex-session-pool.pw.ts --workers=1 --trace=on",
        ...(data as object),
      },
      null,
      2,
    ),
  );
  await testInfo.attach(name, { path: file, contentType: "application/json" });
}

test("30 个角色使用独立临时会话，最多 10 并发且结果落库后才释放", async ({ page }, testInfo) => {
  const x = await fixture(page, testInfo, 30);
  try {
    await page.getByRole("button", { name: "开始分析已有商品" }).click();
    await expect.poll(() => x.transports[0]?.pending.size).toBe(10);
    const transport = x.transports[0]!;
    await page.screenshot({
      path: testInfo.outputPath("ten-sessions-running.png"),
      fullPage: true,
    });
    for (let wave = 1; wave <= 3; wave++) {
      expect(transport.pending.size).toBe(10);
      transport.finishAll();
      await expect.poll(() => x.store.run(x.batch())!.completed).toBe(wave * 10);
      await expect.poll(() => transport.released.length).toBe(wave * 10);
      if (wave < 3) await expect.poll(() => transport.pending.size).toBe(10);
    }
    expect(transport.histories.size).toBe(0);
    await expect
      .poll(() => transport.workspaces.every((directory) => !existsSync(directory)))
      .toBe(true);
    expect(new Set(transport.started.map((item) => item.threadId)).size).toBe(30);
    expect(transport.started).toHaveLength(30);
    expect(new Set(transport.started.map((item) => item.key)).size).toBe(30);
    expect(transport.released.every((item) => item.state === "completed")).toBe(true);
    expect(transport.rejected).toEqual([]);
    expect([...transport.histories.values()].every((history) => history.length === 0)).toBe(true);
    const rows = x.crawl.db
      .prepare(
        "SELECT listing_key,result_json FROM analysis_tasks WHERE run_id=? ORDER BY listing_key",
      )
      .all(x.batch());
    expect(rows).toHaveLength(30);
    const results = rows.map((row, index) => {
      const result = JSON.parse(String(row.result_json));
      expect(result.productKey).toBe(row.listing_key);
      expect(result.valuation.asking_price).toBe(500 + index);
      expect(result.valuation.bare_role_value).toBeGreaterThan(0);
      expect(result.valuation.ai_explanation).toContain(String(row.listing_key));
      return {
        key: row.listing_key,
        asking: result.valuation.asking_price,
        bare: result.valuation.bare_role_value,
      };
    });
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(x.batch())!.status).toBe("paused");
    await page.reload();
    await page.screenshot({ path: testInfo.outputPath("thirty-results.png"), fullPage: true });
    await saveEvidence(testInfo, "30 角色临时会话验证", {
      database: x.database,
      sessionCount: transport.threadSelections.length,
      started: transport.started,
      released: transport.released,
      results,
      run: x.store.run(x.batch()),
      lifecycle: "每次请求独立临时会话，最多10个在途请求；成功结果保存后释放。",
    });
  } finally {
    await x.close();
  }
});

test("慢会话清理：10并发→保留首批→清理中暂停→重启继续→30个结果落库", async ({ page }, testInfo) => {
  const x = await fixture(page, testInfo, 30, { lifecycleDelayMs: 500 });
  try {
    await page.getByRole("button", { name: "开始分析已有商品" }).click();
    await expect.poll(() => x.transports[0]?.pending.size, { timeout: 15_000 }).toBe(10);
    const first = x.transports[0]!;
    await page.screenshot({ path: testInfo.outputPath("slow-ten-running.png"), fullPage: true });
    first.finishAll();
    await expect.poll(() => x.store.run(x.batch())!.completed).toBe(10);
    const saved = x.crawl.db
      .prepare(
        "SELECT listing_key,result_json FROM analysis_tasks WHERE run_id=? AND status='completed' ORDER BY listing_key",
      )
      .all(x.batch());
    // Fresh requests start while the remaining lifecycle work is still queued.
    await expect.poll(() => first.started.length, { timeout: 15_000 }).toBeGreaterThan(10);
    expect(first.lifecycleRequests.some((entry) => !entry.finishedAt)).toBe(true);
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(x.batch())!.status).toBe("paused");
    expect(first.interrupts.some((entry) => entry.duringLifecycle)).toBe(true);
    expect(x.store.run(x.batch())).toMatchObject({ completed: 10, queued: 20, failed: 0 });
    await expect.poll(() => first.closed, { timeout: 15_000 }).toBe(true);
    expect(first.pending.size).toBe(0);
    expect(first.rejected).toEqual([]);
    await x.restart(x.batch());
    await page.getByRole("button", { name: "继续分析", exact: true }).click();
    await expect.poll(() => x.transports[1]?.pending.size, { timeout: 15_000 }).toBe(10);
    const second = x.transports[1]!;
    expect(second.started.every((turn) => !saved.some((row) => row.listing_key === turn.key))).toBe(
      true,
    );
    for (let completed = 20; completed <= 30; completed += 10) {
      expect(second.pending.size).toBe(10);
      second.finishAll();
      await expect.poll(() => x.store.run(x.batch())!.completed).toBe(completed);
      await expect.poll(() => second.released.length, { timeout: 15_000 }).toBe(completed - 10);
      if (completed < 30)
        await expect.poll(() => second.pending.size, { timeout: 15_000 }).toBe(10);
    }
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(x.batch())!.status).toBe("paused");
    await expect.poll(() => second.closed, { timeout: 15_000 }).toBe(true);
    expect(x.store.run(x.batch())).toMatchObject({ completed: 30, queued: 0, failed: 0 });
    const rows = x.crawl.db
      .prepare(
        "SELECT listing_key,result_json FROM analysis_tasks WHERE run_id=? ORDER BY listing_key",
      )
      .all(x.batch());
    expect(rows).toHaveLength(30);
    for (const [index, row] of rows.entries()) {
      const result = JSON.parse(String(row.result_json));
      expect(result.productKey).toBe(row.listing_key);
      expect(result.valuation.asking_price).toBe(500 + index);
      expect(result.valuation.ai_explanation).toContain(String(row.listing_key));
    }
    for (const row of saved)
      expect(rows.find((result) => result.listing_key === row.listing_key)?.result_json).toBe(
        row.result_json,
      );
    expect(second.started).toHaveLength(20);
    expect(new Set(second.started.map((turn) => turn.key)).size).toBe(20);
    expect(first.histories.size).toBe(0);
    expect(second.histories.size).toBe(0);
    expect(second.rejected).toEqual([]);
    expect([...second.histories.values()].every((history) => history.length === 0)).toBe(true);
    const duplicateCompletions = x.crawl.db
      .prepare(
        `SELECT t.listing_key,count(*) AS count FROM analysis_attempts a
         JOIN analysis_tasks t ON t.id=a.task_id
         WHERE t.run_id=? AND a.state='completed' GROUP BY t.listing_key HAVING count(*)<>1`,
      )
      .all(x.batch());
    expect(duplicateCompletions).toEqual([]);
    await page.reload();
    await page.screenshot({ path: testInfo.outputPath("slow-thirty-saved.png"), fullPage: true });
    const snapshot = testInfo.outputPath("analysis-final.sqlite");
    x.crawl.db.exec("VACUUM INTO '" + snapshot.replaceAll("'", "''") + "'");
    await testInfo.attach("慢会话流程最终数据库", {
      path: snapshot,
      contentType: "application/vnd.sqlite3",
    });
    await saveEvidence(testInfo, "慢会话暂停重启完整流程", {
      database: snapshot,
      timing: { scale: "1:10", lifecycleWorkMs: 500, responseTimeoutMs: 2000 },
      first: {
        started: first.started,
        released: first.released,
        interrupts: first.interrupts,
        lifecycleRequests: first.lifecycleRequests,
      },
      second: {
        started: second.started,
        released: second.released,
        lifecycleRequests: second.lifecycleRequests,
      },
      savedKeys: saved.map((row) => row.listing_key),
      results: rows.map((row) => ({ key: row.listing_key, status: "completed" })),
      run: x.store.run(x.batch()),
      scope: "真实页面、分析队列、Codex会话池与SQLite重开；模拟串行慢RPC及AI回复，不调用真实AI。",
    });
  } finally {
    await x.close();
  }
});

test("中途暂停并继续，已保存角色保留，未完成角色重新分析", async ({ page }, testInfo) => {
  const x = await fixture(page, testInfo, 12, { sharedCleanup: true });
  try {
    await page.getByRole("button", { name: "开始分析已有商品" }).click();
    await expect.poll(() => x.transports[0]?.pending.size).toBe(10);
    const first = x.transports[0]!;
    const completedTurn = first.pending.keys().next().value as string;
    const savedKey = first.pending.get(completedTurn)!.key;
    // Finish one role so the remaining nine in-flight turns exercise interruption.
    const otherTurns = [...first.pending].filter(([id]) => id !== completedTurn);
    for (const [id] of otherTurns) first.pending.delete(id);
    first.finishAll();
    for (const [id, turn] of otherTurns) first.pending.set(id, turn);
    await expect.poll(() => x.store.run(x.batch())!.completed).toBe(1);
    expect(existsSync(path.join(x.shared!.directory, "cache", "fixture-runtime.json"))).toBe(true);
    expect(x.shared!.sweeps).toHaveLength(0);
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(x.batch())!.status).toBe("paused");
    await expect.poll(() => x.shared!.sweeps.length).toBe(1);
    expect(existsSync(path.join(x.shared!.directory, "cache", "fixture-runtime.json"))).toBe(false);
    expect(x.store.run(x.batch())).toMatchObject({ completed: 1, queued: 11 });
    expect(first.rejected).toEqual([]);
    expect(first.released.some((item) => item.state === "interrupted")).toBe(true);
    await page.getByRole("button", { name: "继续分析" }).click();
    await expect.poll(() => x.transports[1]?.pending.size).toBe(10);
    const second = x.transports[1]!;
    expect(second.started.some((item) => item.key === savedKey)).toBe(false);
    second.finishAll();
    await expect.poll(() => x.store.run(x.batch())!.completed).toBe(11);
    await expect.poll(() => second.pending.size).toBe(1);
    second.finishAll();
    await expect.poll(() => x.store.run(x.batch())!.completed).toBe(12);
    await expect.poll(() => second.released.length).toBe(11);
    expect(second.rejected).toEqual([]);
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(x.batch())!.status).toBe("paused");
    await page.screenshot({
      path: testInfo.outputPath("pause-resume-completed.png"),
      fullPage: true,
    });
    await saveEvidence(testInfo, "暂停续跑会话验证", {
      database: x.database,
      savedKey,
      first: { started: first.started, released: first.released },
      second: { started: second.started, released: second.released },
      run: x.store.run(x.batch()),
      lifecycle: "暂停关闭首个池；继续分析建立新池，保留已保存结果。",
    });
  } finally {
    await x.close();
  }
});

// Failure cases: recovering an older queue repeats saved roles, discards the
// disconnected attempt, skips the unfinished role, or loses saved results after reopening SQLite.
test("保存两件→Codex断网→重启恢复旧队列→跳过历史完成项→仅补完第三件", async ({
  page,
}, testInfo) => {
  const x = await fixture(page, testInfo, 3);
  try {
    await page.getByRole("spinbutton", { name: "分析并发数" }).fill("1");
    await page.getByRole("button", { name: "开始分析已有商品" }).click();
    await expect.poll(() => x.transports[0]?.pending.size).toBe(1);
    const originalRun = x.batch();
    // Persist a queue snapshot predating these completions, as may remain after interruption.
    const queued = x.store.createRun(
      "codex",
      "fixture-codex",
      false,
      x.profile,
      false,
      1,
      undefined,
      1,
    );
    x.crawl.db
      .prepare("UPDATE analysis_runs SET status='paused',error='Codex连接中断，待继续' WHERE id=?")
      .run(queued);
    const first = x.transports[0]!;
    for (let completed = 1; completed <= 2; completed++) {
      first.finishAll();
      await expect.poll(() => x.store.run(originalRun)!.completed).toBe(completed);
      await expect.poll(() => first.pending.size).toBe(1);
    }
    const [turnId, interrupted] = [...first.pending][0]!;
    expect(interrupted.key).toBe("role-03");
    first.pending.delete(turnId);
    first.emit("turn/completed", {
      threadId: interrupted.threadId,
      turn: { id: turnId, status: "failed", error: { message: "Codex network disconnected" } },
    });
    await expect.poll(() => x.store.run(originalRun)!.status).toBe("paused");
    expect(x.store.run(originalRun)).toMatchObject({ completed: 2, failed: 1 });
    await page.reload();
    await page.screenshot({
      path: testInfo.outputPath("network-disconnected-two-results.png"),
      fullPage: true,
    });
    const saved = x.crawl.db
      .prepare(
        "SELECT id,listing_key,result_json FROM analysis_tasks WHERE run_id=? AND status='completed' ORDER BY listing_key",
      )
      .all(originalRun);
    await x.restart(queued);
    expect(x.store.run(queued)).toMatchObject({ queued: 3, completed: 0 });
    await page.getByRole("button", { name: "继续分析", exact: true }).click();
    await expect.poll(() => x.store.run(queued)!.completed).toBe(2);
    await expect.poll(() => x.transports[1]?.pending.size).toBe(1);
    const second = x.transports[1]!;
    expect(second.started.map((turn) => turn.key)).toEqual(["role-03"]);
    expect(x.store.run(queued)).toMatchObject({ reused: 2, failed: 0 });
    second.finishAll();
    await expect.poll(() => x.store.run(queued)!.completed).toBe(3);
    await expect.poll(() => second.released.length).toBe(1);
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(queued)!.status).toBe("paused");
    const results = x.crawl.db
      .prepare(
        "SELECT listing_key,status,reused,result_json,source_task_id FROM analysis_tasks WHERE run_id=? ORDER BY listing_key",
      )
      .all(queued);
    expect(results).toHaveLength(3);
    for (const row of saved) {
      const reused = results.find((result) => result.listing_key === row.listing_key)!;
      expect(reused).toMatchObject({
        status: "completed",
        reused: 1,
        result_json: row.result_json,
        source_task_id: row.id,
      });
      expect(
        x.crawl.db.prepare("SELECT result_json FROM analysis_tasks WHERE id=?").get(row.id)!
          .result_json,
      ).toBe(row.result_json);
    }
    expect(results[2]).toMatchObject({ listing_key: "role-03", status: "completed", reused: 0 });
    expect(
      x.crawl.db
        .prepare(
          "SELECT state,raw_response FROM analysis_attempts WHERE task_id IN (SELECT id FROM analysis_tasks WHERE run_id=? AND listing_key='role-03')",
        )
        .get(originalRun),
    ).toMatchObject({ state: "failed", raw_response: null });
    await x.restart(queued);
    await page.getByRole("button", { name: "继续分析", exact: true }).click();
    await expect(page.getByRole("button", { name: "暂停分析", exact: true })).toBeVisible();
    await expect.poll(() => x.transports.length).toBe(3);
    expect(x.transports[2]!.started).toEqual([]);
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(queued)!.status).toBe("paused");
    await page.reload();
    await expect(
      page.getByRole("tabpanel", { name: "分析记录", exact: true }).getByRole("article"),
    ).toHaveCount(3);
    await page.screenshot({
      path: testInfo.outputPath("resumed-three-results.png"),
      fullPage: true,
    });
    expect(x.transports.every((transport) => transport.rejected.length === 0)).toBe(true);
    await saveEvidence(testInfo, "断网恢复旧队列跳过历史结果", {
      database: x.database,
      originalRun,
      resumedRun: queued,
      callsByPool: x.transports.map((transport) => transport.started),
      reusedSourceIds: saved.map((row) => row.id),
      results: results.map((row) => ({
        key: row.listing_key,
        status: row.status,
        reused: row.reused,
        sourceTaskId: row.source_task_id,
      })),
      run: x.store.run(queued),
      scope: "真实页面、队列、Codex会话池和SQLite重开；资料与Codex通知为模拟，不连接真实AI。",
    });
  } finally {
    await x.close();
  }
});

test("HTTP临时会话：保存首件→暂停→重启→创建新线程→保留原分析结果", async ({ page }, testInfo) => {
  const x = await fixture(page, testInfo, 3);
  try {
    await page.getByRole("spinbutton", { name: "分析并发数" }).fill("1");
    await page.getByRole("button", { name: "开始分析已有商品" }).click();
    await expect.poll(() => x.transports[0]?.pending.size).toBe(1);
    const runId = x.batch();
    const first = x.transports[0]!;
    const { key: savedKey, threadId } = first.started[0]!;
    expect(first.threadSelections[0]).toEqual({
      method: "thread/start",
      threadId,
      modelProvider: "openai_http",
    });
    first.finishAll();
    await expect.poll(() => x.store.run(runId)!.completed).toBe(1);
    await expect.poll(() => first.pending.size).toBe(1);
    const saved = x.crawl.db
      .prepare("SELECT id,result_json FROM analysis_tasks WHERE run_id=? AND listing_key=?")
      .get(runId, savedKey)!;
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(runId)!.status).toBe("paused");
    expect(x.store.run(runId)).toMatchObject({ completed: 1, queued: 2, failed: 0 });
    expect(first.closed).toBe(true);
    expect(first.histories.size).toBe(0);
    await page.screenshot({
      path: testInfo.outputPath("http-paused-one-saved.png"),
      fullPage: true,
    });

    await x.restart(runId);
    expect(x.store.run(runId)).toMatchObject({ completed: 1, queued: 2 });
    await page.getByRole("spinbutton", { name: "分析并发数" }).fill("1");
    await page.getByRole("button", { name: "继续分析", exact: true }).click();
    await expect.poll(() => x.transports[1]?.pending.size).toBe(1);
    const second = x.transports[1]!;
    expect(second.threadSelections[0]).toMatchObject({
      method: "thread/start",
      modelProvider: "openai_http",
    });
    expect(second.threadSelections[0]!.threadId).not.toBe(threadId);
    expect(second.started[0]!.key).not.toBe(savedKey);
    for (let completed = 2; completed <= 3; completed++) {
      second.finishAll();
      await expect.poll(() => x.store.run(runId)!.completed).toBe(completed);
      if (completed < 3) await expect.poll(() => second.pending.size).toBe(1);
    }
    await expect.poll(() => second.released.length).toBe(2);
    expect(second.started.map((turn) => turn.key).sort()).toEqual(
      x.keys.filter((key) => key !== savedKey).sort(),
    );
    expect(second.started.every((turn) => turn.threadId !== threadId)).toBe(true);
    expect(new Set(second.started.map((turn) => turn.threadId)).size).toBe(2);
    const savedAfter = x.crawl.db
      .prepare("SELECT id,result_json FROM analysis_tasks WHERE run_id=? AND listing_key=?")
      .get(runId, savedKey)!;
    expect(savedAfter).toEqual(saved);
    expect(
      x.crawl.db.prepare("SELECT count(*) n FROM analysis_attempts WHERE task_id=?").get(saved.id)
        ?.n,
    ).toBe(1);
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(runId)!.status).toBe("paused");
    await x.restart(runId);
    await page.getByRole("spinbutton", { name: "分析并发数" }).fill("1");
    await page.getByRole("button", { name: "继续分析", exact: true }).click();
    await expect(page.getByRole("button", { name: "暂停分析", exact: true })).toBeVisible();
    await expect.poll(() => x.transports.length).toBe(3);
    expect(x.transports[2]!.started).toEqual([]);
    expect(x.transports[2]!.threadSelections).toEqual([]);
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(runId)!.status).toBe("paused");
    await page.reload();
    await expect(
      page.getByRole("tabpanel", { name: "分析记录", exact: true }).getByRole("article"),
    ).toHaveCount(3);
    await page.screenshot({
      path: testInfo.outputPath("http-reopened-three-results.png"),
      fullPage: true,
    });
    expect(x.transports.every((transport) => transport.rejected.length === 0)).toBe(true);
    await saveEvidence(testInfo, "HTTP会话选择及重启续跑验证", {
      database: x.database,
      runId,
      savedKey,
      savedTaskId: saved.id,
      discardedThreadId: threadId,
      threadSelections: x.transports.map((transport) => transport.threadSelections),
      callsByPool: x.transports.map((transport) => transport.started),
      run: x.store.run(runId),
      scope:
        "真实页面、队列、会话池与临时SQLite；模拟Codex RPC，验证HTTP provider选择、临时会话及结果恢复，不代表真实网络HTTP验证。",
    });
  } finally {
    await x.close();
  }
});

test("临时线程：保存首个角色→429冷却并刷新→新线程重试→保留全部分析结果", async ({
  page,
}, testInfo) => {
  const x = await fixture(page, testInfo, 3, { rateLimitKey: "role-02", sharedCleanup: true });
  try {
    await page.getByRole("spinbutton", { name: "分析并发数" }).fill("1");
    await page.getByRole("button", { name: "开始分析已有商品" }).click();
    await expect.poll(() => x.transports[0]?.pending.size).toBe(1);
    const transport = x.transports[0]!;
    const firstKey = transport.started[0]!.key;
    expect(firstKey).not.toBe("role-02");
    transport.finishAll();
    await expect.poll(() => x.store.run(x.batch())!.completed).toBe(1);
    await expect.poll(() => transport.rateLimited.length).toBe(1);
    const limited = transport.rateLimited[0]!;
    const firstResult = x.crawl.db
      .prepare("SELECT result_json FROM analysis_tasks WHERE listing_key=?")
      .get(firstKey)!.result_json;
    expect(transport.pending.size).toBe(0);
    expect(transport.started).toHaveLength(2);
    expect(x.shared!.sweeps).toHaveLength(0);
    expect(existsSync(path.join(x.shared!.directory, "cache", "fixture-runtime.json"))).toBe(true);
    await expect(page.getByLabel("AI限流恢复状态")).toContainText("限流冷却中");
    await page.reload();
    await expect(page.getByLabel("AI限流恢复状态")).toContainText("限流冷却中");
    await page.screenshot({
      path: testInfo.outputPath("ephemeral-429-cooldown.png"),
      fullPage: true,
    });
    expect(x.store.run(x.batch())).toMatchObject({ status: "running", completed: 1, failed: 0 });
    await expect.poll(() => transport.pending.size, { timeout: 45_000 }).toBe(1);
    const recoveredAt = Date.now();
    expect(recoveredAt - limited.at).toBeGreaterThanOrEqual(30_000);
    expect(transport.started[2]).toMatchObject({ key: "role-02" });
    expect(transport.started[2]!.threadId).not.toBe(limited.threadId);
    expect(transport.released).toHaveLength(2);
    expect(transport.released[1]?.state).toBe("failed");
    transport.finishAll();
    await expect.poll(() => x.store.run(x.batch())!.completed).toBe(2);
    await expect.poll(() => transport.pending.size).toBe(1);
    transport.finishAll();
    await expect.poll(() => x.store.run(x.batch())!.completed).toBe(3);
    await expect.poll(() => transport.released.length).toBe(4);
    expect(transport.histories.size).toBe(0);
    expect(transport.rateLimited).toHaveLength(1);
    expect(transport.rejected).toEqual([]);
    expect(
      x.crawl.db
        .prepare("SELECT result_json FROM analysis_tasks WHERE listing_key=?")
        .get(firstKey)!.result_json,
    ).toBe(firstResult);
    const tasks = x.crawl.db
      .prepare("SELECT listing_key,status,result_json FROM analysis_tasks ORDER BY listing_key")
      .all();
    expect(tasks).toHaveLength(3);
    for (const task of tasks) {
      expect(task.status).toBe("completed");
      expect(JSON.parse(String(task.result_json)).productKey).toBe(task.listing_key);
    }
    expect(new Set(transport.started.map((turn) => turn.threadId)).size).toBe(4);
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(x.batch())!.status).toBe("paused");
    await expect.poll(() => x.shared!.sweeps.length).toBe(1);
    expect(existsSync(path.join(x.shared!.directory, "cache", "fixture-runtime.json"))).toBe(false);
    await page.reload();
    await expect(
      page.getByRole("tabpanel", { name: "分析记录", exact: true }).getByRole("article"),
    ).toHaveCount(3);
    await page.screenshot({
      path: testInfo.outputPath("ephemeral-429-three-results.png"),
      fullPage: true,
    });
    await saveEvidence(testInfo, "临时线程429冷却重试验证", {
      database: x.database,
      firstKey,
      limited,
      recoveredAt,
      started: transport.started,
      released: transport.released,
      run: x.store.run(x.batch()),
      results: tasks.map((task) => ({ key: task.listing_key, status: task.status })),
      scope: "真实页面、分析队列、会话池和SQLite；模拟Codex RPC，不调用真实AI或账号。",
    });
  } finally {
    await x.close();
  }
});

test("批后真实清理：等待在途认证→刷新请求排队→同进程第二批再次清理且结论保留", async ({
  page,
}, testInfo) => {
  const x = await fixture(page, testInfo, 2, { sharedCleanup: true, finiteBatch: true });
  const shared = x.shared!;
  try {
    await page.getByRole("button", { name: "开始分析已有商品" }).click();
    await expect.poll(() => x.transports[0]?.pending.size).toBe(2);
    const firstRun = x.batch();
    const auth = shared.holdOperation();
    await auth.started;
    const sweep = shared.blockNextSweep();
    x.transports[0]!.finishAll();
    await expect.poll(() => x.store.run(firstRun)!.completed).toBe(2);
    await expect.poll(() => x.transports[0]!.closed).toBe(true);
    expect(shared.sweeping).toBe(false);
    expect(shared.sweeps).toHaveLength(0);
    expect(existsSync(path.join(shared.directory, "cache", "fixture-runtime.json"))).toBe(true);
    const saved = x.crawl.db
      .prepare("SELECT id,result_json FROM analysis_tasks WHERE run_id=? ORDER BY id")
      .all(firstRun);

    auth.release();
    await auth.done;
    await sweep.started;
    const authCalls = shared.authCalls;
    const statusRequest = page.waitForRequest("**/api/ai/status");
    const refreshed = page.reload();
    await statusRequest;
    let lateOperationEntered = false;
    const lateOperation = shared.lifecycle.withOperation(async () => {
      lateOperationEntered = true;
      expect(shared.sweeping).toBe(false);
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lateOperationEntered).toBe(false);
    expect(shared.authCalls).toBe(authCalls);
    expect(shared.sweeping).toBe(true);

    sweep.release();
    await Promise.all([lateOperation, refreshed, x.runner.settled()]);
    await expect.poll(() => shared.sweeps.length).toBe(1);
    expect(lateOperationEntered).toBe(true);
    expect(shared.sweeps[0]).toMatchObject({ savedResults: 2 });
    expect(shared.sweeps[0]!.removed).toEqual(expect.arrayContaining(["cache", "logs_2.sqlite"]));
    expect(existsSync(path.join(shared.directory, "cache", "fixture-runtime.json"))).toBe(false);
    expect(await readFile(path.join(shared.directory, "auth.json"), "utf8")).toBe(
      "fixture-login-preserved",
    );
    expect(x.store.run(firstRun)).toMatchObject({ status: "completed", completed: 2, failed: 0 });

    const changed = x.crawl.detail("role-01") as SavedRoleRecord;
    changed.listing.price = "900";
    x.crawl.observe(changed.listing);
    expect(x.crawl.save(changed.listing, changed.detail!)).toBe(true);
    await page.getByRole("button", { name: "分析新增或已更新商品", exact: true }).click();
    await expect.poll(() => x.transports[1]?.pending.size).toBe(1);
    const secondRun = x.batch();
    expect(secondRun).not.toBe(firstRun);
    expect(x.transports[1]!.started.map((turn) => turn.key)).toEqual(["role-01"]);
    expect(existsSync(path.join(shared.directory, "cache", "fixture-runtime.json"))).toBe(true);
    x.transports[1]!.finishAll();
    await x.runner.settled();
    expect(shared.sweeps).toHaveLength(2);
    expect(shared.sweeps[1]!.removed).toEqual(expect.arrayContaining(["cache", "logs_2.sqlite"]));
    expect(existsSync(path.join(shared.directory, "cache", "fixture-runtime.json"))).toBe(false);
    for (const row of saved)
      expect(
        x.crawl.db.prepare("SELECT result_json FROM analysis_tasks WHERE id=?").get(row.id),
      ).toEqual({ result_json: row.result_json });
    expect(x.store.run(secondRun)).toMatchObject({ status: "completed", completed: 2, failed: 0 });
    expect(
      x.transports.every((transport) => transport.workspaces.every((dir) => !existsSync(dir))),
    ).toBe(true);
    await page.reload();
    await page.screenshot({
      path: testInfo.outputPath("batch-cleanup-results-retained.png"),
      fullPage: true,
    });
    await saveEvidence(testInfo, "批后清理与共享调用闸门", {
      runtimeDirectory: shared.directory,
      database: x.database,
      firstRun,
      secondRun,
      sweeps: shared.sweeps,
      completedResultsPreserved: saved.length,
      pendingOperationsDuringSweep: 0,
      scope:
        "真实生命周期闸门、运行目录清理、队列、SQLite及页面；模拟认证和Codex回复，无真实账号或模型请求。",
    });
  } finally {
    await x.close();
  }
});

test("批后清理失败不覆盖分析结论，下轮仍能重新清理", async ({ page }, testInfo) => {
  const x = await fixture(page, testInfo, 2, { sharedCleanup: true, finiteBatch: true });
  const shared = x.shared!;
  try {
    await page.getByRole("button", { name: "开始分析已有商品" }).click();
    await expect.poll(() => x.transports[0]?.pending.size).toBe(2);
    const firstRun = x.batch();
    shared.failNextSweep();
    x.transports[0]!.finishAll();
    await x.runner.settled();
    expect(shared.failures).toEqual(["fixture cleanup I/O failure"]);
    expect(shared.sweeps).toHaveLength(0);
    expect(x.store.run(firstRun)).toMatchObject({
      status: "completed",
      completed: 2,
      failed: 0,
      error: null,
    });
    const saved = x.crawl.db
      .prepare("SELECT id,result_json FROM analysis_tasks WHERE run_id=? ORDER BY id")
      .all(firstRun);
    expect(saved.every((row) => row.result_json)).toBe(true);
    expect(existsSync(path.join(shared.directory, "cache", "fixture-runtime.json"))).toBe(true);

    const changed = x.crawl.detail("role-01") as SavedRoleRecord;
    changed.listing.price = "950";
    x.crawl.observe(changed.listing);
    expect(x.crawl.save(changed.listing, changed.detail!)).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "分析新增或已更新商品", exact: true }).click();
    await expect.poll(() => x.transports[1]?.pending.size).toBe(1);
    x.transports[1]!.finishAll();
    await x.runner.settled();
    expect(shared.sweeps).toHaveLength(1);
    expect(existsSync(path.join(shared.directory, "cache", "fixture-runtime.json"))).toBe(false);
    expect(x.store.run(x.batch())).toMatchObject({ status: "completed", completed: 2, failed: 0 });
    for (const row of saved)
      expect(
        x.crawl.db.prepare("SELECT result_json FROM analysis_tasks WHERE id=?").get(row.id),
      ).toEqual({ result_json: row.result_json });
    await saveEvidence(testInfo, "清理故障后保留结论并恢复清理", {
      database: x.database,
      firstRun,
      secondRun: x.batch(),
      failures: shared.failures,
      sweeps: shared.sweeps,
      completedResultsPreserved: saved.length,
      scope: "真实生命周期闸门及运行清理；只在清理回调注入一次I/O故障，模拟Codex回复。",
    });
  } finally {
    await x.close();
  }
});
