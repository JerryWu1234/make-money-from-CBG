import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "@playwright/test";
import { prepareAnalysisClient, shutdownAiConnections } from "../../server/ai-connection";
import { CodexPool, type CodexPoolTransport } from "../../server/ai/codex-pool";
import { AnalysisRunner, type AnalysisClient } from "../../server/analysis/runner";
import { AnalysisStore } from "../../server/analysis/store";
import type { AnalysisProfile } from "../../server/analysis/valuation-types";
import { CrawlStore } from "../../server/crawler/store";
import type { Listing, RoleDetail } from "../../server/crawler/types";

// Isolation failures: accidentally writing production data, selecting fewer than
// the requested distinct real roles, using asset search or mocks, ignoring a saved cooldown,
// competing with production analysis, reusing old results, losing a result after
// reopen, cross-role output, requests failing or pausing, and reporting lifecycle
// or cooldown overlap as simultaneous model inference. Multiple waves must retain
// backoff, use distinct runs, and validate every wave rather than only the last.
// A model override must not change the frozen business input or production defaults.
// Tier diagnostics must not silently skip the override, change other RPC methods,
// mix models, lose native errors, or leave a prototype patch in later tests.
// Keep receipts on failure.
test("真实已采集角色：10路分析、保存结果并重新打开核验", async () => {
  test.skip(process.env.CBG_LIVE_E2E !== "1", "需明确授权真实 Codex 请求");
  test.setTimeout(20 * 60_000);
  const waveCount = Number(process.env.CBG_LIVE_SPEED_WAVES || "1");
  expect(Number.isInteger(waveCount) && waveCount >= 1 && waveCount <= 2).toBe(true);
  const roleCount = Number(process.env.CBG_LIVE_SPEED_ROLE_COUNT || "10");
  expect(Number.isInteger(roleCount) && roleCount >= 1 && roleCount <= 10).toBe(true);
  const concurrency = Number(process.env.CBG_LIVE_SPEED_CONCURRENCY || "10");
  expect(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 10).toBe(true);
  const requestedTier = process.env.CBG_LIVE_SPEED_TIER;
  expect(requestedTier === undefined || ["default", "inherit"].includes(requestedTier)).toBe(true);
  const repository = path.resolve(import.meta.dirname, "../..");
  const sourcePath = path.join(repository, "data/cbg.sqlite");
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  const active = source
    .prepare("SELECT COUNT(*) n FROM analysis_runs WHERE status='running'")
    .get();
  expect(Number(active?.n), "先暂停生产分析，避免争用同一账号").toBe(0);
  const previous = source
    .prepare(`SELECT r.id,r.profile_json,r.model FROM analysis_runs r
    WHERE r.provider='codex' AND r.profile_json IS NOT NULL AND
    (SELECT COUNT(DISTINCT t.listing_key) FROM analysis_tasks t WHERE t.run_id=r.id
      AND t.status='completed' AND t.result_json IS NOT NULL)>=?
    ORDER BY r.created_at DESC LIMIT 1`)
    .get(roleCount);
  expect(previous, `需要同一真实批次中至少${roleCount}份已完成角色及冻结参数`).toBeTruthy();
  const selectedModel = process.env.CBG_LIVE_SPEED_MODEL || String(previous!.model);
  const profile = JSON.parse(String(previous!.profile_json)) as AnalysisProfile;
  expect(!!profile.equipmentSearch || !!profile.petSearch || !!profile.petGearSearch).toBe(false);
  const records = source
    .prepare(`SELECT listing_key,source_listing_json,source_detail_json FROM analysis_tasks
    WHERE run_id=? AND status='completed' AND result_json IS NOT NULL
    GROUP BY listing_key ORDER BY completed_at DESC LIMIT ?`)
    .all(previous!.id!, roleCount);
  const baseline = source
    .prepare(`SELECT t.listing_key,a.created_at,a.finished_at,a.usage_json,
    a.request_hash,a.request_text,a.error FROM analysis_attempts a JOIN analysis_tasks t ON t.id=a.task_id
    WHERE t.run_id=? AND a.state='completed' ORDER BY a.created_at DESC`)
    .all(previous!.id!)
    .filter((row) => records.some((record) => record.listing_key === row.listing_key));
  const backoff = source
    .prepare("SELECT state_json FROM analysis_provider_backoff WHERE provider='codex'")
    .get();
  source.close();
  expect(records).toHaveLength(roleCount);
  const root = path.join(repository, "data");
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "analysis-speed-"));
  const testedSources = await Promise.all(
    [
      "server/ai/codex-pool.ts",
      "server/ai/codex-provider.ts",
      "tests/live/codex-analysis-speed.live.ts",
    ].map(async (file) => ({
      file,
      sha256: createHash("sha256")
        .update(await readFile(path.join(repository, file)))
        .digest("hex"),
    })),
  );
  await writeFile(
    path.join(directory, "patch.diff"),
    execFileSync("git", ["diff", "--", "server/ai/codex-pool.ts", "server/ai/codex-provider.ts"], {
      cwd: repository,
    }),
  );
  const database = path.join(directory, "results.sqlite");
  const crawl = new CrawlStore(database);
  const store = new AnalysisStore(crawl.db);
  for (const row of records) {
    const listing = JSON.parse(String(row.source_listing_json)) as Listing;
    const detail = JSON.parse(String(row.source_detail_json)) as RoleDetail;
    expect(listing.key).toBe(row.listing_key);
    crawl.observe(listing);
    crawl.save(listing, detail);
  }
  if (backoff) {
    // Retain both the remaining cooldown and the provider's recovery concurrency.
    crawl.db
      .prepare("INSERT INTO analysis_provider_backoff(provider,state_json) VALUES('codex',?)")
      .run(backoff.state_json!);
    const delay = JSON.parse(String(backoff.state_json)).retryAt - Date.now();
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  }
  const waves: Array<{
    wave: number;
    runId: string;
    startedAt: string;
    finishedAt?: string;
    status?: string;
    error?: string;
    backoffBefore: ReturnType<AnalysisStore["providerBackoff"]>;
    backoffAfter?: ReturnType<AnalysisStore["providerBackoff"]>;
  }> = [];
  const calls: Array<{
    wave: number;
    key: string;
    startedAt: string;
    finishedAt?: string;
    error?: string;
  }> = [];
  let activeCalls = 0,
    peakCalls = 0;
  const measure =
    (analyze: AnalysisClient["analyze"]): AnalysisClient["analyze"] =>
    async (...args) => {
      const call = {
        wave: waves.length,
        key: args[0].match(/商品 ID：([^。\n]+)/)?.[1] || "unknown",
        startedAt: new Date().toISOString(),
      } as (typeof calls)[number];
      calls.push(call);
      peakCalls = Math.max(peakCalls, ++activeCalls);
      try {
        return await analyze(...args);
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        call.finishedAt = new Date().toISOString();
        activeCalls--;
      }
    };
  const runner = new AnalysisRunner(store, async (provider, model) => {
    const client = await prepareAnalysisClient(provider, model);
    return {
      ...client,
      analyze: measure(client.analyze),
      createSessionPool(count: number) {
        const pool = client.createSessionPool!(count);
        return {
          async acquire(signal: AbortSignal) {
            const session = await pool.acquire(signal);
            return { ...session, analyze: measure((...args) => session.analyze(...args)) };
          },
          close: () => pool.close(),
        };
      },
    };
  });
  const startedAt = new Date().toISOString();
  const prototype = CodexPool.prototype as unknown as {
    rpc: (this: unknown) => Promise<CodexPoolTransport>;
  };
  const originalRpc = prototype.rpc;
  const rpcMetadata: Array<Record<string, unknown>> = [];
  const terminalErrors: Array<Record<string, unknown>> = [];
  const observed = new Set<CodexPoolTransport>();
  const observers: Array<() => void> = [];
  const sanitize = (value: unknown): unknown =>
    JSON.parse(
      JSON.stringify(value ?? null).replace(
        /Bearer\s+[^"\s]+|sk-[\w-]+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gi,
        "[redacted]",
      ),
    );
  let runId = "",
    failure = "";
  try {
    if (requestedTier) {
      // Forward real RPCs; only the per-turn tier differs between diagnostic arms.
      prototype.rpc = async function () {
        const transport = await originalRpc.call(this);
        if (!observed.has(transport)) {
          observed.add(transport);
          observers.push(
            transport.subscribe((event) => {
              const params = event.params as
                | {
                    threadId?: unknown;
                    turnId?: unknown;
                    willRetry?: unknown;
                    error?: Record<string, unknown>;
                    turn?: { id?: unknown; status?: unknown; error?: Record<string, unknown> };
                  }
                | undefined;
              const error =
                event.method === "error" && params?.willRetry === false
                  ? params.error
                  : event.method === "turn/completed" && params?.turn?.status === "failed"
                    ? params.turn.error
                    : undefined;
              if (error)
                terminalErrors.push({
                  at: new Date().toISOString(),
                  method: event.method,
                  threadId: params?.threadId,
                  turnId: params?.turnId ?? params?.turn?.id,
                  error: sanitize({
                    message: error.message,
                    codexErrorInfo: error.codexErrorInfo,
                    additionalDetails: error.additionalDetails,
                  }),
                });
            }),
          );
        }
        return {
          ...transport,
          async request(method, params) {
            const input =
              method === "turn/start" && requestedTier === "default"
                ? { ...params, serviceTierForTurn: "default" }
                : params;
            const tracked = ["thread/start", "thread/resume", "turn/start"].includes(method);
            const entry: Record<string, unknown> = {
              at: new Date().toISOString(),
              method,
              threadId: params.threadId,
              model: params.model,
              serviceTier: params.serviceTier,
              serviceTierForTurn: input.serviceTierForTurn,
              effort: params.effort,
            };
            if (tracked) rpcMetadata.push(entry);
            const response = await transport.request(method, input);
            if (method === "thread/start" || method === "thread/resume") {
              expect(params.model).toBe(selectedModel);
              const result = response as Record<string, unknown>;
              entry.returnedModel = result.model;
              entry.returnedServiceTier = result.serviceTier;
              expect(result.model).toBe(selectedModel);
            }
            return response;
          },
        };
      };
    }
    for (let index = 0; index < waveCount; index++) {
      const wave: (typeof waves)[number] = {
        wave: index + 1,
        runId: "",
        startedAt: new Date().toISOString(),
        backoffBefore: store.providerBackoff("codex"),
      };
      waves.push(wave);
      try {
        runId = await runner.start(
          "codex",
          true,
          profile,
          false,
          selectedModel,
          1,
          undefined,
          concurrency,
        );
        wave.runId = runId;
        expect(new Set(waves.map((item) => item.runId)).size).toBe(waves.length);
        // This private dataset is fixed: it never waits for new capture arrivals.
        crawl.db.prepare("UPDATE analysis_runs SET follow_capture='0' WHERE id=?").run(runId);
        await runner.settled();
        const run = store.run(runId);
        expect(run).toMatchObject({
          status: "completed",
          completed: roleCount,
          failed: 0,
          concurrency,
        });
        const saved = crawl.db
          .prepare("SELECT listing_key,result_json,reused FROM analysis_tasks WHERE run_id=?")
          .all(runId);
        expect(new Set(saved.map((row) => row.listing_key)).size).toBe(roleCount);
        for (const row of saved) {
          expect(row.reused).toBe(0);
          expect(JSON.parse(String(row.result_json))).toBeTruthy();
        }
        const actualRequests = crawl.db
          .prepare(`SELECT t.listing_key,a.request_text FROM analysis_attempts a
          JOIN analysis_tasks t ON t.id=a.task_id WHERE t.run_id=? AND a.state='completed'`)
          .all(runId);
        for (const row of actualRequests)
          expect(row.request_text, `业务请求应与生产基线一致：${String(row.listing_key)}`).toBe(
            baseline.find((item) => item.listing_key === row.listing_key)?.request_text,
          );
        const reopened = new DatabaseSync(database, { readOnly: true });
        try {
          const persisted = reopened
            .prepare(
              "SELECT listing_key,result_json FROM analysis_tasks WHERE run_id=? AND status='completed'",
            )
            .all(runId);
          expect(persisted).toHaveLength(roleCount);
          expect(new Set(persisted.map((row) => row.listing_key)).size).toBe(roleCount);
        } finally {
          reopened.close();
        }
      } catch (error) {
        wave.error = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        wave.finishedAt = new Date().toISOString();
        wave.status = wave.runId ? store.run(wave.runId)?.status : "not_started";
        wave.backoffAfter = store.providerBackoff("codex");
      }
    }
    if (requestedTier) {
      const turns = rpcMetadata.filter((entry) => entry.method === "turn/start");
      expect(turns.length).toBeGreaterThanOrEqual(roleCount * waveCount);
      expect(
        turns.every((entry) =>
          requestedTier === "default"
            ? entry.serviceTierForTurn === "default"
            : entry.serviceTierForTurn === undefined,
        ),
      ).toBe(true);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    try {
      await runner.shutdown();
      const tasks = crawl.db
        .prepare(
          "SELECT id,run_id,listing_key,status,reused,result_json,error FROM analysis_tasks ORDER BY rowid",
        )
        .all();
      const attempts = crawl.db
        .prepare(`SELECT a.id,t.run_id,t.listing_key,a.state,a.created_at,a.finished_at,a.usage_json,a.error
      FROM analysis_attempts a JOIN analysis_tasks t ON t.id=a.task_id ORDER BY a.created_at`)
        .all();
      const finishedAt = new Date().toISOString();
      const receipt = {
        kind: "real-codex-ten-role-analysis",
        commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        testedSources,
        patchFile: "patch.diff",
        sourcePath,
        sourceRunId: previous!.id,
        runId,
        runIds: waves.map((wave) => wave.runId).filter(Boolean),
        waveCount,
        roleCount,
        waves,
        model: selectedModel,
        baselineModel: previous!.model,
        requestedTier: requestedTier ?? "production",
        rpcMetadata,
        terminalErrors,
        startedAt,
        finishedAt,
        durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
        configuredConcurrency: concurrency,
        peakAnalyzeCalls: peakCalls,
        overlapLimit:
          "Includes session lifecycle and cooldown; not a model inference concurrency measurement.",
        productionBackoff: backoff?.state_json || null,
        failure,
        calls,
        baseline,
        attempts,
        tasks,
        repeat: `Pause production analysis, then run CBG_LIVE_E2E=1 CBG_LIVE_SPEED_MODEL=${selectedModel} ${requestedTier ? `CBG_LIVE_SPEED_TIER=${requestedTier} ` : ""}CBG_LIVE_SPEED_WAVES=${waveCount} CBG_LIVE_SPEED_ROLE_COUNT=${roleCount} CBG_LIVE_SPEED_CONCURRENCY=${concurrency} vp exec playwright test tests/live/codex-analysis-speed.live.ts --config playwright.live.config.ts. Each invocation creates a new private dataset.`,
        limits: [
          "Replays real saved captures; does not repeat website collection.",
          "Uses real account and model requests; no mocks.",
          "Production records and results are not changed.",
        ],
      };
      await writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
      await writeFile(path.join(directory, "profile.json"), JSON.stringify(profile, null, 2));
      crawl.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      await writeFile(
        path.join(directory, "results.sql"),
        execFileSync(
          "sqlite3",
          [database, ".dump analysis_runs", ".dump analysis_tasks", ".dump analysis_attempts"],
          { maxBuffer: 32 * 1024 * 1024 },
        ),
      );
      crawl.close();
      await shutdownAiConnections();
      console.log("CBG_ANALYSIS_SPEED_RECEIPT", path.join(directory, "receipt.json"));
    } finally {
      for (const unsubscribe of observers) unsubscribe();
      prototype.rpc = originalRpc;
    }
  }
});
