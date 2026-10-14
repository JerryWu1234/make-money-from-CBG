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
import { CALCULATION_VERSION } from "../../server/analysis/profile";
import type { AnalysisDetail, AnalysisOverview } from "../../server/analysis/types";

test("真实官网清空数据、获取 2 个挂牌不少于3000元的角色、Codex 分析与报价持久化", async ({
  page,
  request,
}) => {
  test.skip(process.env.CBG_LIVE_E2E !== "1", "需显式授权真实官网与 Codex 请求");
  const repository = path.resolve(import.meta.dirname, "../..");
  const originalDirectory = process.cwd();
  const root = path.join(repository, "data/live-valuation-e2e");
  await mkdir(root, { recursive: true });
  const resumeDirectory = process.env.CBG_LIVE_RUN_DIR;
  const directory = resumeDirectory
    ? path.resolve(repository, resumeDirectory)
    : await mkdtemp(path.join(root, "run-"));
  if (path.dirname(directory) !== root || !path.basename(directory).startsWith("run-"))
    throw new Error("只能续跑本项目 data/live-valuation-e2e/run-* 内的测试数据");
  if (!resumeDirectory) {
    await mkdir(path.join(directory, "prompts"));
    await copyFile(
      path.join(repository, "prompts/role-valuation.md"),
      path.join(directory, "prompts/role-valuation.md"),
    );
  }
  const baseURL = "http://127.0.0.1:5187";
  const files: Array<{ name: string; sha256: string }> = [];
  const manifest = {
    version: 1,
    kind: "real-cbg-codex-e2e",
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim(),
    startedAt: new Date().toISOString(),
    finishedAt: "",
    state: "running",
    resumed: Boolean(resumeDirectory),
    baseURL,
    testMinimumAskingPrice: 3000,
    productKeys: [] as string[],
    runId: "",
    error: "",
    files,
  };
  const save = async (name: string, value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value, null, 2));
    await writeFile(path.join(directory, name), bytes, { mode: 0o600 });
    const entry = { name, sha256: createHash("sha256").update(bytes).digest("hex") };
    const index = files.findIndex((file) => file.name === name);
    if (index < 0) files.push(entry);
    else files[index] = entry;
  };
  const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 2000));
  const attention = async (stage: string, message: string) => {
    const id = randomUUID();
    await save("attention.json", { id, state: "waiting", stage, message, baseURL });
    console.log(`CBG_LIVE_ATTENTION ${stage}: ${message}\n${directory}`);
    for (;;) {
      try {
        const confirmation = JSON.parse(
          await readFile(path.join(directory, "continue.json"), "utf8"),
        );
        if (confirmation.id === id && confirmation.confirmedAt) break;
      } catch {
        // The operator writes confirmation only after the user completes the current step.
      }
      await pause();
    }
    await save("attention.json", { id, state: "confirmed", stage });
  };
  const api = async <T>(route: string, body?: unknown): Promise<T> => {
    const response =
      body === undefined
        ? await request.get(baseURL + route, { timeout: 30_000 })
        : await request.post(baseURL + route, { data: body, timeout: 300_000 });
    const value = await response.json();
    if (!response.ok()) throw new Error(value?.error || `${route}: HTTP ${response.status()}`);
    return value as T;
  };
  let lastProgress = "";
  const progress = async (stage: string, value: unknown) => {
    const signature = JSON.stringify(value);
    if (signature === lastProgress) return;
    lastProgress = signature;
    await save("progress.json", { stage, updatedAt: new Date().toISOString(), value });
    console.log(`CBG_LIVE_PROGRESS ${stage}: ${signature}`);
  };
  console.log(`CBG_LIVE_RUN ${directory}\n扫码/确认页面：${baseURL}`);
  process.chdir(directory);
  const server = await createServer({
    root: repository,
    configFile: path.join(repository, "vite.config.ts"),
    server: { host: "127.0.0.1", port: 5187, strictPort: true, open: false },
  });
  try {
    await server.listen();
    if (!resumeDirectory) {
      const cleared = await api<CrawlStatus>("/api/crawl/clear", {});
      const empty = await api<AnalysisOverview>("/api/analysis/status?provider=codex");
      expect(cleared.totalSaved).toBe(0);
      expect(empty.counts.total).toBe(0);
      expect(empty.run).toBeNull();
      await save("reset.json", {
        clearedAt: new Date().toISOString(),
        database: path.join(directory, "data/cbg.sqlite"),
        savedRoles: cleared.totalSaved,
        analysisRoles: empty.counts.total,
        run: empty.run,
      });
    }
    const priorSelection = resumeDirectory
      ? (JSON.parse(await readFile(path.join(directory, "selection.json"), "utf8")) as {
          roles: Listing[];
        })
      : null;
    const priorRecords = priorSelection
      ? await Promise.all(
          priorSelection.roles.map((item) =>
            api<SavedRoleRecord>(`/api/crawl/detail?key=${encodeURIComponent(item.key)}`),
          ),
        )
      : [];
    const capturesReady =
      priorRecords.length === 2 &&
      priorRecords.every(
        (record) =>
          record.status === "complete" &&
          record.detail?.equipmentCapture?.complete &&
          record.detail?.petCapture?.complete &&
          !record.detail.valuation?.issues.length,
      );
    let selected = priorSelection?.roles || [];
    if (!capturesReady) {
      await page.goto(baseURL, { waitUntil: "domcontentloaded" });
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
            state.qrCodeUrl ? "请在助手页面扫码并在手机确认，完成后同意继续。" : state.message,
          );
          const fresh = await api<OpenCbgResult>("/api/browser/status");
          if (!fresh.running && fresh.workflowStep !== "completed")
            await api("/api/browser/open", {});
        }
        await pause();
      }

      // Fresh capture reads only the app-owned hidden work page.
      const session = await server.ssrLoadModule("/server/session.ts");
      const listPage = session.getCbgPage();
      expect(listPage, "助手应拥有当前官网角色列表工作页").toBeTruthy();
      const listings = await server.ssrLoadModule("/server/crawler/page.ts");
      let liveList = (await listings.readListings(listPage)) as ListingPage;
      selected = priorSelection?.roles || [];
      if (!priorSelection) {
        const signal = new AbortController().signal;
        for (;;) {
          for (const item of liveList.items) {
            if (Number(item.price) < 3000 || !Number.isFinite(Number(item.price))) continue;
            if (selected.some((saved) => saved.key === item.key)) continue;
            const fresh = (await listings.hoverListing(listPage, item, signal)) as Listing;
            expect(fresh.key).toBe(item.key);
            expect(fresh.serverAge).toBe("older");
            if (Number(fresh.price) < 3000 || !Number.isFinite(Number(fresh.price))) continue;
            selected.push(fresh);
            if (selected.length === 2) break;
          }
          if (selected.length === 2 || liveList.page >= liveList.totalPages) break;
          liveList = (await listings.gotoPage(listPage, liveList.page + 1, signal)) as ListingPage;
        }
        expect(selected).toHaveLength(2);
      }
      if (!resumeDirectory) {
        const store = new CrawlStore(path.join(directory, "data/cbg.sqlite"));
        try {
          expect(store.count()).toBe(0);
          for (const item of selected) store.observe(item);
        } finally {
          store.db.close();
        }
        await save("selection.json", {
          page: liveList.page,
          roles: selected.map(({ key, url, name, price, serverId }) => ({
            key,
            url,
            name,
            price,
            serverId,
          })),
        });
      }
    }
    expect(selected).toHaveLength(2);
    expect(
      selected.every((item) => Number.isFinite(Number(item.price)) && Number(item.price) >= 3000),
    ).toBe(true);
    expect(new Set(selected.map((item) => item.key)).size).toBe(2);
    const store = new CrawlStore(path.join(directory, "data/cbg.sqlite"));
    try {
      expect(store.records(1, 20).total).toBe(2);
      for (const item of selected)
        expect((store.detail(item.key) as SavedRoleRecord | null)?.listing.key).toBe(item.key);
    } finally {
      store.db.close();
    }
    manifest.productKeys = selected.map((item) => item.key);
    if (!capturesReady) await api("/api/crawl/backfill", { keys: manifest.productKeys });
    else
      await progress("capture", {
        saved: 2,
        message: "复用已核验完整的两个角色，不重新查询列表。",
      });
    let captureDeadline = Date.now() + 20 * 60_000;
    for (;;) {
      const status = await api<CrawlStatus>("/api/crawl/status");
      await progress("capture", {
        phase: status.phase,
        saved: status.saved,
        failed: status.failed,
        current: status.current,
        message: status.detailProgress || status.message,
      });
      if (!status.running) {
        const records = await Promise.all(
          manifest.productKeys.map((key) =>
            api<SavedRoleRecord>(`/api/crawl/detail?key=${encodeURIComponent(key)}`),
          ),
        );
        for (const [index, record] of records.entries())
          await save(`capture-${index + 1}.json`, record);
        if (
          records.every(
            (record) =>
              record.status === "complete" &&
              record.detail?.equipmentCapture?.complete &&
              record.detail?.petCapture?.complete &&
              !record.detail.valuation?.issues.length,
          )
        )
          break;
        await attention(
          "capture",
          status.error ||
            status.lastItemError ||
            "仍有角色资料不完整，请检查官网状态后确认是否重试这 2 个角色。 ",
        );
        await api("/api/crawl/backfill", { keys: manifest.productKeys });
        captureDeadline = Date.now() + 20 * 60_000;
      } else if (Date.now() > captureDeadline) {
        await api("/api/crawl/stop", {});
        await attention("capture", "采集超过 20 分钟，已请求暂停；请检查页面后确认继续。");
        captureDeadline = Date.now() + 20 * 60_000;
      }
      await pause();
    }

    for (;;) {
      const connection = await api<{ state: string; response?: string; error?: string }>(
        "/api/ai/verify",
        { provider: "codex" },
      );
      if (connection.state === "connected" && connection.response === "READY") break;
      await attention("codex", connection.error || "请在助手的 Codex 连接弹窗完成登录后确认继续。");
    }
    await progress("codex", { state: "connected", response: "READY" });
    await page.goto(baseURL + "/analysis-preview", { waitUntil: "domcontentloaded" });
    const existing = (await api<AnalysisOverview>("/api/analysis/status?provider=codex")).run;
    if (existing && existing.calculationVersion !== CALCULATION_VERSION) {
      await api("/api/analysis/start", { provider: "codex", force: true });
    } else if (existing?.status === "paused") {
      await page.getByRole("button", { name: "继续分析", exact: true }).click();
    } else if (
      resumeDirectory &&
      existing?.status === "completed" &&
      (existing.waitingPricing || existing.failed)
    ) {
      await page.getByRole("button", { name: /^重试失败及待补齐的/ }).click();
    } else if (!existing) {
      await page.getByRole("button", { name: "开始分析已有商品", exact: true }).click();
    }
    let analysisDeadline = Date.now() + 90 * 60_000;
    for (;;) {
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
              completed: run.completed,
              failed: run.failed,
              waitingPricing: run.waitingPricing,
              progress: run.pricingProgress,
              error: run.error,
            }
          : { state: "starting" },
      );
      if (run) {
        manifest.runId = run.id;
        expect(run.total).toBe(2);
        if (run.status === "completed") {
          if (!run.waitingPricing && !run.failed) break;
          await save("repair-overview.json", overview);
          await attention(
            "repair",
            "仍有查价或分析错误，服务与逐件断点已保留。修复后确认续跑，未取得两个最终报价不结束测试。",
          );
          await api("/api/analysis/retry", { runId: run.id });
          analysisDeadline = Date.now() + 90 * 60_000;
        }
        if (run.status === "paused") {
          await attention(
            "analysis",
            run.error || run.pauseNotice || "分析已暂停，请处理登录或验证后确认继续。",
          );
          await api("/api/analysis/retry", { runId: run.id });
          analysisDeadline = Date.now() + 90 * 60_000;
        }
      }
      if (Date.now() > analysisDeadline) {
        await api("/api/analysis/pause", { runId: manifest.runId });
        await attention("analysis", "分析超过 90 分钟，已暂停；请检查进度后确认继续。");
        analysisDeadline = Date.now() + 90 * 60_000;
      }
      await pause();
    }
    const overview = await api<AnalysisOverview>("/api/analysis/status?provider=codex");
    await save("analysis-overview.json", overview);
    const details: AnalysisDetail[] = [];
    for (const [index, item] of overview.records.items.entries()) {
      expect(item.taskId).toBeTruthy();
      const detail = await api<AnalysisDetail>(
        `/api/analysis/detail?taskId=${encodeURIComponent(item.taskId!)}`,
      );
      await save(`analysis-${index + 1}.json`, detail);
      details.push(detail);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("tab", { name: /^分析记录/ }).click();
    const screenshot = path.join(directory, "final-results.png");
    await page.screenshot({
      path: screenshot,
      fullPage: true,
      mask: [page.locator(".analysis-agent-account + small")],
    });
    files.push({
      name: "final-results.png",
      sha256: createHash("sha256")
        .update(await readFile(screenshot))
        .digest("hex"),
    });
    expect(overview.counts).toEqual({ total: 2, complete: 2, waitingDetail: 0 });
    expect(overview.run?.completed).toBe(2);
    expect(overview.run?.failed).toBe(0);
    expect(overview.run?.reused).toBe(0);
    await expect(page.getByLabel("分析页面概览")).toContainText("2 件已有结果");
    for (const detail of details) {
      expect(detail.state).toBe("completed");
      expect(manifest.productKeys).toContain(detail.listing.key);
      expect(
        detail.attempts.some(
          (attempt) => attempt.state === "completed" && attempt.rawResponse && attempt.requestHash,
        ),
      ).toBe(true);
      expect(detail.equipmentPricing?.searchComplete).toBe(true);
      expect(detail.petPricing?.searchComplete).toBe(true);
      expect(detail.result?.valuation?.asking_price).toBeGreaterThanOrEqual(3000);
      const valuation = detail.result?.valuation;
      const quote = valuation?.model_value ?? valuation?.estimated_value;
      expect(
        quote,
        `${detail.listing.key} 缺少完整价格结果；详见产物中的 missing_fields`,
      ).toBeGreaterThan(0);
      if (valuation?.model_value != null) {
        expect(valuation.price_difference).toBeCloseTo(
          valuation.model_value - valuation.asking_price!,
          2,
        );
      }
    }
    manifest.state = "passed";
  } catch (error) {
    manifest.state = "incomplete";
    manifest.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    manifest.finishedAt = new Date().toISOString();
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest, null, 2), {
      mode: 0o600,
    });
    await request
      .post(baseURL + "/api/analysis/pause", { data: {}, timeout: 30_000 })
      .catch(() => {});
    await request.post(baseURL + "/api/crawl/stop", { data: {}, timeout: 30_000 }).catch(() => {});
    await server.close();
    process.chdir(originalDirectory);
    console.log(`CBG_LIVE_RESULT ${manifest.state}: ${path.join(directory, "manifest.json")}`);
  }
});
