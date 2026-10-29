import { mkdir, readFile, writeFile } from "node:fs/promises";
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

// Failure cases: more than 10 sessions, a session handling two roles at once,
// stale role history, cross-role results, reset before commit, lost pause/resume
// progress, or a session reused before interrupted work actually ends.
class FixtureTransport implements CodexPoolTransport {
  readonly listeners = new Set<(event: CodexPoolEvent) => void>();
  readonly histories = new Map<string, string[]>();
  readonly pending = new Map<string, { threadId: string; key: string }>();
  readonly started: Array<{ threadId: string; turnId: string; key: string }> = [];
  readonly reverted: Array<{ threadId: string; turnId: string; key: string; state: string }> = [];
  readonly rejected: string[] = [];
  private nextThread = 0;
  private nextTurn = 0;
  closed = false;

  constructor(
    readonly crawl: CrawlStore,
    readonly profile: ReturnType<typeof createProfile>,
    readonly label: string,
  ) {}

  subscribe(listener: (event: CodexPoolEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(method: string, params: unknown) {
    for (const listener of this.listeners) listener({ method, params });
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "thread/start") {
      const id = `${this.label}-thread-${++this.nextThread}`;
      this.histories.set(id, []);
      return { thread: { id } };
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
      return { turn: { id: turnId, status: "inProgress" } };
    }
    if (method === "thread/revert") {
      const threadId = String(params.threadId),
        turnId = String(params.beforeTurnId);
      const turn = this.started.find(
        (item) => item.turnId === turnId && item.threadId === threadId,
      );
      const row =
        turn &&
        this.crawl.db
          .prepare(`SELECT a.state,a.finished_at,t.result_json FROM analysis_attempts a
          JOIN analysis_tasks t ON t.id=a.task_id WHERE t.listing_key=? ORDER BY a.rowid DESC LIMIT 1`)
          .get(turn.key);
      if (
        !turn ||
        !row ||
        row.state === "running" ||
        !row.finished_at ||
        this.pending.has(turnId)
      ) {
        this.rejected.push(turnId);
        throw new Error("角色结果或中断记录未保存，不能回退 session");
      }
      if (row.state === "completed" && !row.result_json) throw new Error("角色报价未保存");
      const history = this.histories.get(threadId)!;
      const index = history.indexOf(turnId);
      if (index < 0) throw new Error("回退的轮次不属于这个 session");
      history.splice(index);
      this.reverted.push({ threadId, turnId, key: turn.key, state: String(row.state) });
      return { thread: { id: threadId } };
    }
    if (method === "thread/turns/list")
      return { data: (this.histories.get(String(params.threadId)) || []).map((id) => ({ id })) };
    if (method === "turn/interrupt") {
      const turnId = String(params.turnId),
        turn = this.pending.get(turnId);
      if (turn) {
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

async function fixture(page: Page, testInfo: TestInfo, count: number) {
  const database = testInfo.outputPath("analysis.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  const crawl = new CrawlStore(database);
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
  const store = new AnalysisStore(crawl.db);
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
  const client: AnalysisClient = {
    model: "fixture-codex",
    analyze: async () => {
      throw new Error("应使用复用会话池");
    },
    createSessionPool(size) {
      const transport = new FixtureTransport(crawl, profile, `run-${transports.length + 1}`);
      transports.push(transport);
      const pool = new CodexPool(size, "fixture-codex", async () => transport);
      return {
        async acquire(signal) {
          const lease = await pool.acquire(signal);
          return {
            analyze: (prompt, schema, requestSignal, options) =>
              lease.run(prompt, schema, requestSignal, options),
            release: (persisted) => lease.release(persisted),
          };
        },
        close: () => pool.close(),
      };
    },
  };
  const runner = new AnalysisRunner(store, async () => client);
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
          body = {
            codex: { state: "connected", model: "fixture-codex", response: "READY" },
            deepseek: { state: "unconfigured" },
            deepseekModels: [],
          };
          break;
        case "/api/ai/models":
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
            false,
            undefined,
            1,
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
  return { crawl, store, profile, runner, transports, keys, database, batch: () => batch };
}

async function saveEvidence(testInfo: TestInfo, name: string, data: unknown) {
  const file = testInfo.outputPath("evidence.json");
  await writeFile(
    file,
    JSON.stringify(
      {
        fixture: true,
        repeat:
          "vp run build && vp exec playwright test tests/e2e/codex-session-pool.pw.ts --workers=1",
        ...(data as object),
      },
      null,
      2,
    ),
  );
  await testInfo.attach(name, { path: file, contentType: "application/json" });
}

test("30 个角色复用固定 10 个 session，结果落库后才回退", async ({ page }, testInfo) => {
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
      await expect.poll(() => transport.reverted.length).toBe(wave * 10);
      if (wave < 3) await expect.poll(() => transport.pending.size).toBe(10);
    }
    expect(transport.histories.size).toBe(10);
    expect(new Set(transport.started.map((item) => item.threadId)).size).toBe(10);
    expect(transport.started).toHaveLength(30);
    expect(new Set(transport.started.map((item) => item.key)).size).toBe(30);
    for (const threadId of transport.histories.keys())
      expect(transport.started.filter((item) => item.threadId === threadId)).toHaveLength(3);
    expect(transport.reverted.every((item) => item.state === "completed")).toBe(true);
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
    await saveEvidence(testInfo, "30 角色会话复用验证", {
      database: x.database,
      sessionCount: transport.histories.size,
      started: transport.started,
      reverted: transport.reverted,
      results,
      run: x.store.run(x.batch()),
      lifecycle: "每次连续分析运行固定10个session；暂停关闭池，继续后建立新池。",
    });
  } finally {
    await x.runner.shutdown();
    x.crawl.close();
  }
});

test("中途暂停并继续，已保存角色保留，未完成角色重新分析", async ({ page }, testInfo) => {
  const x = await fixture(page, testInfo, 12);
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
    await page.getByRole("button", { name: "暂停分析", exact: true }).click();
    await expect.poll(() => x.store.run(x.batch())!.status).toBe("paused");
    expect(x.store.run(x.batch())).toMatchObject({ completed: 1, queued: 11 });
    expect(first.rejected).toEqual([]);
    expect(first.reverted.some((item) => item.state === "interrupted")).toBe(true);
    await page.getByRole("button", { name: "继续分析" }).click();
    await expect.poll(() => x.transports[1]?.pending.size).toBe(10);
    const second = x.transports[1]!;
    expect(second.started.some((item) => item.key === savedKey)).toBe(false);
    second.finishAll();
    await expect.poll(() => x.store.run(x.batch())!.completed).toBe(11);
    await expect.poll(() => second.pending.size).toBe(1);
    second.finishAll();
    await expect.poll(() => x.store.run(x.batch())!.completed).toBe(12);
    await expect.poll(() => second.reverted.length).toBe(11);
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
      first: { started: first.started, reverted: first.reverted },
      second: { started: second.started, reverted: second.reverted },
      run: x.store.run(x.batch()),
      lifecycle: "暂停关闭首个池；继续分析建立新池，保留已保存结果。",
    });
  } finally {
    await x.runner.shutdown();
    x.crawl.close();
  }
});
