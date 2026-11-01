import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { CrawlStore } from "../../server/crawler/store";
import { AnalysisStore } from "../../server/analysis/store";
import { loadProfile } from "../../server/analysis/profile";
import {
  calculateValuation,
  compareListingPrice,
} from "../../server/analysis/valuation-calculator";
import type { AnalysisOverview } from "../../server/analysis/types";
import type { SavedRoleRecord } from "../../server/crawler/types";
import { analysisRecord, analysisResponse } from "../fixtures/analysis";

// Failure cases: viewed state is only in memory; process restart loses results;
// expiry erases the comparison profile and empties the ranking; stale results lack
// a warning; showing viewed products stops working; or a reload is mistaken for
// a backend restart. Production SQLite/store/profile run in separate processes.
// The HTTP adapter, captured role, and completed AI result are fixtures.
test("历史榜单：确认隐藏落库→后端进程重启→行情过期后再次重启→显示历史推荐", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const directory = testInfo.outputPath("service");
  await mkdir(directory, { recursive: true });
  const database = path.join(directory, "ranking.sqlite");
  const now = Date.now();
  const crawl = new CrawlStore(database);
  try {
    const record = analysisRecord("restart-role");
    record.listing.price = "1000";
    const equipment = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    equipment.items = [];
    equipment.text = "没有装备";
    record.detail!.equipmentCapture!.emptyProof = "explicit-text";
    const pets = record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
    pets.pets = [];
    pets.petCount = 0;
    crawl.observe(record.listing);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
    const server = {
      serverId: record.listing.serverId,
      serverName: "重启测试服",
      source: "auto",
      age: "older",
      rank: 10,
      goldPrice: 210,
      goldUnit: 30000000,
      baselineUnitConfirmed: true,
      fetchedAt: new Date(now).toISOString(),
      sources: ["https://fixture.invalid/market"],
    };
    crawl.db.exec(
      "CREATE TABLE analysis_market (id INTEGER PRIMARY KEY CHECK(id=1), snapshot_json TEXT NOT NULL)",
    );
    crawl.db
      .prepare("INSERT INTO analysis_market VALUES(1,?)")
      .run(JSON.stringify({ fetchedAt: new Date(now).toISOString(), servers: [server] }));
    const store = new AnalysisStore(crawl.db);
    const profile = loadProfile(crawl.db);
    const batch = store.createRun("codex", "fixture-model", true, profile);
    const saved = crawl.detail(record.listing.key) as SavedRoleRecord;
    const result = {
      ...analysisResponse(saved),
      valuation: {
        ...calculateValuation(saved, profile),
        ...compareListingPrice(1200, 1000),
        asset_scope: "body",
        bare_role_value: 1200,
        model_value: 1200,
      },
    };
    crawl.db
      .prepare(
        "UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=? WHERE listing_key=?",
      )
      .run(JSON.stringify(result), new Date(now).toISOString(), record.listing.key);
    crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(batch);
    expect(store.overview({ currentProfile: profile }).ranking).toHaveLength(1);
  } finally {
    crawl.close();
  }

  const processes: { pid: number; now: number }[] = [];
  let backend: { child: ChildProcess; port: number; stop: () => Promise<void> } | undefined;
  let base = "";
  const start = async (clock: number, port = 0) => {
    const child = spawn(
      process.execPath,
      [
        path.resolve("tests/fixtures/historical-ranking-service.mjs"),
        database,
        String(clock),
        String(port),
      ],
      { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    let errors = "";
    child.stderr!.on("data", (chunk) => {
      errors += String(chunk);
    });
    try {
      const ready = await new Promise<{ pid: number; port: number; now: number }>(
        (resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Fixture backend startup timed out: " + errors)),
            30_000,
          );
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            reject(new Error(`Fixture backend exited ${code}: ${errors}`));
          });
          child.stdout!.on("data", (chunk) => {
            output += String(chunk);
            for (const line of output.split("\n")) {
              if (!line.startsWith('{"event":"ready"')) continue;
              clearTimeout(timer);
              resolve(JSON.parse(line));
            }
          });
        },
      );
      processes.push({ pid: ready.pid, now: ready.now });
      base = `http://127.0.0.1:${ready.port}`;
      return {
        child,
        port: ready.port,
        stop: async () => {
          const exited = once(child, "exit");
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
          try {
            await exited;
          } finally {
            clearTimeout(timer);
          }
          await writeFile(testInfo.outputPath(`backend-${ready.pid}.log`), output + errors);
        },
      };
    } catch (error) {
      child.kill("SIGKILL");
      throw error;
    }
  };
  const snapshot = async (client: APIRequestContext, showViewed: boolean) => {
    const response = await client.get(
      `${base}/api/analysis/status?provider=codex&showViewed=${showViewed}&scope=complete`,
    );
    expect(response.ok()).toBe(true);
    const overview = (await response.json()) as AnalysisOverview;
    return {
      rankingKeys: overview.ranking.map((item) => item.key),
      rankingTotal: overview.rankingPagination?.total,
      records: overview.records.total,
      results: overview.results.total,
      marketExpired: overview.run?.marketExpired,
      items: overview.ranking.map(
        ({ key, marketExpired, profileChanged, recommendationViewed }) => ({
          key,
          marketExpired,
          profileChanged,
          recommendationViewed,
        }),
      ),
    };
  };
  try {
    backend = await start(now);
    await page.context().route("**/*", (route) => {
      if (new URL(route.request().url()).origin !== base) return route.abort();
      return route.continue();
    });
    await page.goto(base + "/analysis-preview");
    await page.getByRole("tab", { name: /推荐榜/ }).click();
    const ranking = page.getByRole("tabpanel", { name: "推荐榜" });
    await expect(ranking.getByRole("article")).toHaveCount(1);
    const before = await snapshot(request, true);
    expect(before.rankingKeys).toEqual(["restart-role"]);
    expect(before.marketExpired).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("before-restart.png"), fullPage: true });
    await ranking.getByRole("button", { name: "查看分析依据 →" }).click();
    await expect(page.getByRole("dialog", { name: "角色restart-role" })).toBeVisible();
    await page.getByRole("button", { name: "关闭分析详情" }).click();
    await expect(ranking.getByRole("article")).toHaveCount(1);
    expect((await snapshot(request, true)).items[0].recommendationViewed).toBe(false);
    await ranking.getByRole("button", { name: "确认隐藏" }).click();
    await expect(ranking.getByRole("article")).toHaveCount(0);
    const viewed = await snapshot(request, true);
    expect(viewed.items[0].recommendationViewed).toBe(true);

    const port = backend.port;
    await backend.stop();
    backend = undefined;
    backend = await start(now, port);
    await page.reload();
    await page.getByRole("tab", { name: /推荐榜/ }).click();
    const showViewed = ranking.getByRole("checkbox", { name: "显示已隐藏的推荐" });
    await expect(ranking.getByRole("article")).toHaveCount(0);
    await showViewed.check();
    await expect(ranking.getByRole("article")).toHaveCount(1);
    const afterFreshRestart = await snapshot(request, true);
    expect(afterFreshRestart.rankingKeys).toEqual(before.rankingKeys);
    expect(afterFreshRestart.items[0].recommendationViewed).toBe(true);
    expect(afterFreshRestart.marketExpired).toBe(false);
    await page.screenshot({ path: testInfo.outputPath("after-fresh-restart.png"), fullPage: true });

    await backend.stop();
    backend = undefined;
    backend = await start(now + 25 * 60 * 60 * 1000, port);
    await page.reload();
    await page.getByRole("tab", { name: /推荐榜/ }).click();
    await expect(showViewed).not.toBeChecked();
    await expect(ranking.getByRole("article")).toHaveCount(0);
    const hidden = await snapshot(request, false);
    expect(hidden.rankingTotal).toBe(0);
    await showViewed.check();
    await expect(ranking.getByRole("article")).toHaveCount(1);
    await expect(ranking.getByRole("article")).toContainText(
      "历史结果 · 行情已过期，请刷新后重新分析",
    );
    const afterExpiredRestart = await snapshot(request, true);
    expect(afterExpiredRestart.rankingKeys).toEqual(before.rankingKeys);
    expect(afterExpiredRestart.records).toBe(before.records);
    expect(afterExpiredRestart.results).toBe(before.results);
    expect(afterExpiredRestart.marketExpired).toBe(true);
    expect(afterExpiredRestart.items[0]).toMatchObject({
      marketExpired: true,
      profileChanged: false,
      recommendationViewed: true,
    });
    expect(new Set(processes.map(({ pid }) => pid)).size).toBe(3);
    await page.screenshot({
      path: testInfo.outputPath("after-expired-restart.png"),
      fullPage: true,
    });
    await page.getByRole("region", { name: "商品分析结果" }).screenshot({
      path: testInfo.outputPath("historical-ranking-panel.png"),
    });
    const evidence = testInfo.outputPath("evidence.json");
    await writeFile(
      evidence,
      JSON.stringify(
        {
          fixture: true,
          scope:
            "Real child-process restarts and file SQLite; production AnalysisStore/loadProfile; fixture HTTP adapter, role, market, and AI result; no real website or AI requests",
          processes,
          before,
          viewed,
          afterFreshRestart,
          hidden,
          afterExpiredRestart,
          repeat:
            "vp run build && vp exec playwright test tests/e2e/historical-ranking-restart.pw.ts --workers=1 --trace=on",
        },
        null,
        2,
      ),
    );
    await testInfo.attach("历史榜单重启证据", { path: evidence, contentType: "application/json" });
  } finally {
    await backend?.stop();
  }
});
