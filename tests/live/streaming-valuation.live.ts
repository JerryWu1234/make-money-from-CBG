import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createServer } from "vite-plus";
import { CrawlStore } from "../../server/crawler/store";
import type {
  Listing,
  ListingPage,
  CrawlStatus,
  SavedRoleRecord,
} from "../../server/crawler/types";
import type { OpenCbgResult } from "../../server/types";
import type { AnalysisDetail, AnalysisOverview, AnalysisRun } from "../../server/analysis/types";

// Isolated workflow failures are listed in docs/live-valuation-e2e.md.
// No website, quote, capture detail, or AI response is mocked in this test.
test("真实官网按顺序采集10个角色，第1个采齐即分析，后续自动入队并保存10份报价", async ({
  page,
  request,
}) => {
  test.skip(process.env.CBG_LIVE_E2E !== "1", "需显式授权真实官网与 Codex 请求");
  const repository = path.resolve(import.meta.dirname, "../..");
  const originalDirectory = process.cwd();
  const root = path.join(repository, "data/live-valuation-e2e");
  await mkdir(root, { recursive: true });
  const resume = process.env.CBG_LIVE_RUN_DIR;
  const directory = resume
    ? path.resolve(repository, resume)
    : await mkdtemp(path.join(root, "run-"));
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith("run-"))
    throw new Error("续跑目录必须是本项目的 run-* 目录");
  if (!resume) {
    await mkdir(path.join(directory, "prompts"));
    await copyFile(
      path.join(repository, "prompts/role-valuation.md"),
      path.join(directory, "prompts/role-valuation.md"),
    );
  }
  const baseURL = "http://127.0.0.1:5187";
  const kind = "real-cbg-codex-streaming-e2e";
  const prior = resume
    ? JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"))
    : null;
  if (prior && (prior.kind !== kind || prior.roleCount !== 10 || prior.analysisStartsAfter !== 1))
    throw new Error("不能将其他测试的数据当作本轮10角色续跑");
  const manifest = {
    version: 1,
    kind,
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    startedAt: new Date().toISOString(),
    finishedAt: "",
    state: "running",
    resumed: !!resume,
    roleCount: 10,
    analysisStartsAfter: 1,
    testMinimumAskingPrice: null,
    baseURL,
    runId: prior?.runId || "",
    productKeys: prior?.productKeys || ([] as string[]),
    error: "",
    files: [] as { name: string; sha256: string }[],
  };
  const save = async (name: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2));
    await writeFile(path.join(directory, name), bytes, { mode: 0o600 });
    if (name === "manifest.json") return;
    const entry = { name, sha256: createHash("sha256").update(bytes).digest("hex") };
    const index = manifest.files.findIndex((item) => item.name === name);
    if (index < 0) manifest.files.push(entry);
    else manifest.files[index] = entry;
  };
  const timeline: { at: string; event: string; data: unknown }[] = resume
    ? JSON.parse(await readFile(path.join(directory, "timeline.json"), "utf8"))
    : [];
  let eventWrites = Promise.resolve();
  const event = (name: string, data: unknown) => {
    timeline.push({ at: new Date().toISOString(), event: name, data });
    eventWrites = eventWrites.then(() => save("timeline.json", timeline));
    return eventWrites;
  };
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 2000));
  let attentionTail = Promise.resolve();
  const attention = (stage: string, message: string) => {
    const waiting = attentionTail.then(async () => {
      const id = randomUUID();
      await save("attention.json", { id, state: "waiting", stage, message, baseURL });
      console.log(`CBG_LIVE_ATTENTION ${stage}: ${message}\n${directory}`);
      for (;;) {
        if (stopping) throw new Error("测试已停止，人工等待断点保留");
        try {
          const reply = JSON.parse(await readFile(path.join(directory, "continue.json"), "utf8"));
          if (reply.id === id && reply.confirmedAt) break;
        } catch {}
        await pause();
      }
      await save("attention.json", { id, state: "confirmed", stage });
    });
    attentionTail = waiting.catch(() => {});
    return waiting;
  };
  const api = async <T>(route: string, body?: unknown): Promise<T> => {
    const response =
      body === undefined
        ? await request.get(baseURL + route, { timeout: 30000 })
        : await request.post(baseURL + route, { data: body, timeout: 300000 });
    const result = await response.json();
    if (!response.ok()) throw new Error(result.error || `${route}: ${response.status()}`);
    return result as T;
  };
  const signatures = new Map<string, string>();
  const progress = async (stage: string, data: unknown) => {
    const signature = JSON.stringify(data);
    if (signatures.get(stage) === signature) return;
    signatures.set(stage, signature);
    await save(`progress-${stage}.json`, { at: new Date().toISOString(), data });
    console.log(`CBG_LIVE_PROGRESS ${stage}: ${signature}`);
  };
  let selected: Listing[] = resume
    ? JSON.parse(await readFile(path.join(directory, "selection.json"), "utf8")).roles
    : [];
  const ready = (record: SavedRoleRecord) =>
    record.status === "complete" &&
    record.detail?.equipmentCapture?.complete &&
    record.detail.petCapture?.complete &&
    !record.detail.valuation?.issues.length;
  let captureFinished = false;
  let producerFailure: unknown;
  let stopping = false;
  let producer: Promise<void> | undefined;
  console.log(`CBG_LIVE_RUN ${directory}\n${baseURL}`);
  process.chdir(directory);
  const server = await createServer({
    root: repository,
    configFile: path.join(repository, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 5187, strictPort: true, open: false },
  });
  try {
    await server.listen();
    await save("manifest.json", manifest);
    if (!resume) {
      await save("selection.json", { roles: [] });
      await save("timeline.json", []);
    }
    if (!resume) {
      const cleared = await api<CrawlStatus>("/api/crawl/clear", {});
      const empty = await api<AnalysisOverview>("/api/analysis/status?provider=codex");
      expect(cleared.totalSaved).toBe(0);
      expect(empty.counts.total).toBe(0);
      expect(empty.run).toBeNull();
      await save("reset.json", {
        clearedAt: new Date().toISOString(),
        savedRoles: cleared.totalSaved,
        analysisRoles: empty.counts.total,
        run: empty.run,
      });
    }
    for (;;) {
      const connected = await api<{ state: string; response?: string; error?: string }>(
        "/api/ai/verify",
        { provider: "codex" },
      );
      if (connected.state === "connected" && connected.response === "READY") break;
      await attention("codex", connected.error || "请完成 Codex 连接后继续。");
    }
    const models = await api<{ defaultModel: string }>("/api/ai/models?provider=codex");
    expect(models.defaultModel).toBe("gpt-6-luna");
    await save("default-model.json", {
      ...models,
      requestedReasoning: "max",
      requestedServiceTier: "fast",
    });
    const previousRecords = await Promise.all(
      selected.map((item) =>
        api<SavedRoleRecord>(`/api/crawl/detail?key=${encodeURIComponent(item.key)}`),
      ),
    );
    const alreadyCaptured = selected.length === 10 && previousRecords.every(ready);
    let listPage: any;
    let listings: any;
    let liveList: ListingPage | undefined;
    let rowIndex = 0;
    if (!alreadyCaptured) {
      await page.goto(baseURL);
      await page.locator("#open-cbg-btn").click();
      for (;;) {
        const state = await api<OpenCbgResult>("/api/browser/status");
        await progress("query", {
          step: state.workflowStep,
          login: state.loginStatus,
          message: state.message,
        });
        if (state.workflowStep === "completed" && state.isLoggedIn) break;
        if (state.qrCodeUrl || state.workflowStep === "error") {
          await attention(
            "query",
            state.qrCodeUrl
              ? "请在助手页面扫码并完成手机确认；有效登录将直接复用。"
              : state.message,
          );
          const fresh = await api<OpenCbgResult>("/api/browser/status");
          if (!fresh.running && fresh.workflowStep !== "completed")
            await api("/api/browser/open", {});
        }
        await pause();
      }
      const session = await server.ssrLoadModule("/server/session.ts");
      listPage = session.getCbgPage();
      expect(listPage).toBeTruthy();
      listings = await server.ssrLoadModule("/server/crawler/page.ts");
      liveList = await listings.readListings(listPage);
      await save(`list-page-${liveList!.page}.json`, liveList);
    }
    const startAnalysis = async () => {
      const overview = await api<AnalysisOverview>("/api/analysis/status?provider=codex");
      const run = overview.run;
      let next: AnalysisRun;
      if (!run) {
        expect(overview.counts.complete).toBe(1);
        next = await api<AnalysisRun>("/api/analysis/start", { provider: "codex" });
        expect(next.model).toBe("gpt-6-luna");
        expect(next.total).toBe(1);
        await event("analysis_started", {
          capturedCount: overview.counts.complete,
          runId: next.id,
          model: next.model,
          createdAt: next.createdAt,
        });
      } else if (run.status === "paused" || run.status === "completed")
        next = await api<AnalysisRun>("/api/analysis/retry", { runId: run.id });
      else next = run;
      manifest.runId = next.id;
      await save("manifest.json", manifest);
    };
    const capture = async () => {
      for (let index = 0; index < 10 && !stopping; index++) {
        let item = selected[index];
        if (!item) {
          for (;;) {
            if (rowIndex < liveList!.items.length) {
              const row = liveList!.items[rowIndex++];
              if (selected.some((known) => known.key === row.key)) continue;
              item = await listings.hoverListing(listPage, row, new AbortController().signal);
              expect(item!.key).toBe(row.key);
              expect(item!.serverAge).toBe("older");
              break;
            }
            expect(liveList!.page).toBeLessThan(liveList!.totalPages);
            liveList = await listings.gotoPage(
              listPage,
              liveList!.page + 1,
              new AbortController().signal,
            );
            rowIndex = 0;
            await save(`list-page-${liveList!.page}.json`, liveList);
          }
          selected.push(item!);
          manifest.productKeys = selected.map((role) => role.key);
          const store = new CrawlStore(path.join(directory, "data/cbg.sqlite"));
          try {
            store.observe(item!);
          } finally {
            store.close();
          }
          await save("selection.json", { roles: selected });
          await save("manifest.json", manifest);
          await event("selected", {
            ordinal: index + 1,
            key: item!.key,
            name: item!.name,
            listPage: liveList!.page,
          });
        }
        let record = await api<SavedRoleRecord>(
          `/api/crawl/detail?key=${encodeURIComponent(item!.key)}`,
        );
        while (!ready(record) && !stopping) {
          const before = await api<AnalysisOverview>("/api/analysis/status?provider=codex");
          await api("/api/crawl/backfill", { keys: [item!.key] });
          const collector = await server.ssrLoadModule("/server/crawler/controller.ts");
          await event("capture_started", {
            ordinal: index + 1,
            key: item!.key,
            analysisActive: !!before.activeRun,
            analysisRun: before.activeRun?.id || null,
            analysisPhase: before.activeRun?.phase,
            startedAt: collector.crawlActivity()?.startedAt,
          });
          let deadline = Date.now() + 20 * 60000;
          for (;;) {
            if (stopping) return;
            const status = await api<CrawlStatus>("/api/crawl/status");
            await progress("capture", {
              ordinal: index + 1,
              name: item!.name,
              phase: status.phase,
              message: status.detailProgress || status.message,
              saved: status.totalSaved,
            });
            if (!status.running) break;
            if (Date.now() > deadline) {
              await api("/api/crawl/stop", {});
              await attention(
                "capture",
                `角色 ${item!.name} 采集超过20分钟，断点保留；请检查后继续。`,
              );
              deadline = Date.now() + 20 * 60000;
            }
            await pause();
          }
          record = await api<SavedRoleRecord>(
            `/api/crawl/detail?key=${encodeURIComponent(item!.key)}`,
          );
          if (!ready(record))
            await attention(
              "capture",
              `第${index + 1}个角色 ${item!.name} 资料尚未完整：${record.error || "请检查当前官网页面"}；修复后重试同一角色，不换样本。`,
            );
        }
        if (stopping) return;
        await save(`capture-${index + 1}.json`, record);
        await event("capture_completed", {
          ordinal: index + 1,
          key: item!.key,
          collectedAt: record.detail!.collectedAt,
        });
        if (index === 0) {
          await startAnalysis();
          await page.goto(baseURL + "/analysis-preview");
        }
      }
      captureFinished = true;
      await event("capture_finished", { count: selected.length });
    };
    producer = capture().catch((error) => {
      producerFailure = error;
      captureFinished = true;
    });
    let deadline = Date.now() + 180 * 60000;
    for (;;) {
      if (producerFailure) throw producerFailure;
      const overview = await api<AnalysisOverview>("/api/analysis/status?provider=codex");
      const run = overview.run;
      await progress(
        "analysis",
        run
          ? {
              id: run.id,
              status: run.status,
              phase: run.phase,
              current: run.current,
              total: run.total,
              completed: run.completed,
              failed: run.failed,
              waitingPricing: run.waitingPricing,
              captured: overview.counts.complete,
            }
          : { state: "等待第1个采齐", captured: overview.counts.complete },
      );
      if (run) {
        manifest.runId = run.id;
        expect(run.model).toBe("gpt-6-luna");
        if (run.status === "paused") {
          await save("repair-overview.json", overview);
          await attention(
            "analysis",
            run.error || run.pauseNotice || "分析已暂停，断点已保留；处理后继续。",
          );
          await api("/api/analysis/retry", { runId: run.id });
          deadline = Date.now() + 180 * 60000;
        } else if (run.status === "completed") {
          if (run.failed || run.waitingPricing) {
            await save("repair-overview.json", overview);
            await attention(
              "repair",
              "查价或分析仍有错误，服务与采集、报价断点保留；修复后继续，10份报价齐全才结束。",
            );
            await api("/api/analysis/retry", { runId: run.id });
            deadline = Date.now() + 180 * 60000;
          } else if (captureFinished && run.completed === 10) break;
          else if (overview.counts.complete > run.total)
            await api("/api/analysis/resume", { runId: run.id });
        }
      }
      if (Date.now() > deadline) {
        await api("/api/analysis/pause", { runId: manifest.runId });
        await attention("analysis", "分析超过180分钟，保留全部断点；请检查后继续。");
        deadline = Date.now() + 180 * 60000;
      }
      await pause();
    }
    await producer;
    expect(selected).toHaveLength(10);
    expect(new Set(selected.map((item) => item.key)).size).toBe(10);
    const start = timeline.find((item) => item.event === "analysis_started")!;
    const first = timeline.find(
      (item) =>
        item.event === "capture_completed" && (item.data as { ordinal: number }).ordinal === 1,
    )!;
    const second = timeline.find(
      (item) =>
        item.event === "capture_started" && (item.data as { ordinal: number }).ordinal === 2,
    )!;
    expect(start).toBeTruthy();
    expect(first.at <= start.at && start.at <= second.at).toBe(true);
    expect(second.data).toMatchObject({ analysisActive: true, analysisRun: manifest.runId });
    const overview = await api<AnalysisOverview>("/api/analysis/status?provider=codex");
    await save("analysis-overview.json", overview);
    expect(overview.counts).toEqual({ total: 10, complete: 10, waitingDetail: 0 });
    expect(overview.run).toMatchObject({
      total: 10,
      completed: 10,
      failed: 0,
      waitingPricing: 0,
      reused: 0,
    });
    const quotes = [];
    for (const [index, item] of selected.entries()) {
      const row = overview.records.items.find((record) => record.key === item.key)!;
      expect(row.taskId).toBeTruthy();
      const detail = await api<AnalysisDetail>(
        `/api/analysis/detail?taskId=${encodeURIComponent(row.taskId!)}`,
      );
      await save(`analysis-${index + 1}.json`, detail);
      expect(detail.state).toBe("completed");
      expect(detail.runId).toBe(manifest.runId);
      expect(detail.model).toBe("gpt-6-luna");
      expect(detail.equipmentPricing?.searchComplete).toBe(true);
      expect(detail.petPricing?.searchComplete).toBe(true);
      expect(
        detail.attempts.some(
          (attempt) => attempt.state === "completed" && attempt.rawResponse && attempt.requestHash,
        ),
      ).toBe(true);
      const value = detail.result!.valuation!;
      const quote = value.model_value ?? value.estimated_value;
      expect(typeof quote).toBe("number");
      expect(quote).toBeGreaterThanOrEqual(0);
      expect(value.estimate_missing_count || 0).toBe(0);
      quotes.push({
        ordinal: index + 1,
        role: item.name,
        server: item.serverName,
        asking: value.asking_price,
        reference: quote,
        range: value.estimated_value_range,
        excluded: value.excluded_assets,
      });
    }
    await save("quotations.json", quotes);
    await page.reload();
    await page.getByRole("tab", { name: /^分析记录/ }).click();
    await expect(page.getByLabel("分析页面概览")).toContainText("10 件已有结果");
    const screenshot = await page.screenshot({
      path: path.join(directory, "final-results.png"),
      fullPage: true,
      mask: [page.locator(".analysis-agent-account + small")],
      maskColor: "#20394b",
    });
    manifest.files.push({
      name: "final-results.png",
      sha256: createHash("sha256").update(screenshot).digest("hex"),
    });
    manifest.state = "passed";
  } catch (error) {
    manifest.state = "incomplete";
    manifest.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    stopping = true;
    await request.post(baseURL + "/api/crawl/stop", { data: {}, timeout: 30000 }).catch(() => {});
    await request
      .post(baseURL + "/api/analysis/pause", { data: {}, timeout: 30000 })
      .catch(() => {});
    await producer?.catch(() => {});
    await eventWrites;
    manifest.finishedAt = new Date().toISOString();
    await save("manifest.json", manifest);
    await server.close();
    process.chdir(originalDirectory);
    console.log(`CBG_LIVE_RESULT ${manifest.state}: ${directory}/manifest.json`);
  }
});
