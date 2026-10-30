import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { marketServers } from "./market";
import { loadProfile, PROMPT_FILE } from "./profile";
import { AnalysisRunner } from "./runner";
import { AnalysisStore } from "./store";

// Failure cases: expiration hides unchanged history, restart loses viewed state,
// unrelated servers mark an item expired, or history bypasses changed facts/settings
// and the existing prohibition on executing with expired market data.
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "cbg-history-ranking-"));
  directories.push(directory);
  const filename = join(directory, "cbg.sqlite");
  const crawl = new CrawlStore(filename);
  const record = analysisRecord("historical-role");
  record.listing.price = "1000";
  const equipment = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
  equipment.items = [];
  equipment.text = "没有装备";
  record.detail!.equipmentCapture!.emptyProof = "explicit-text";
  const pets = record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
  pets.pets = [];
  pets.petCount = 0;
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
  const fetchedAt = new Date().toISOString();
  const server = {
    serverId: record.listing.serverId,
    serverName: record.listing.serverName,
    source: "auto",
    age: "older",
    rank: 10,
    goldPrice: 210,
    goldUnit: 30000000,
    baselineUnitConfirmed: true,
    fetchedAt,
    sources: [],
  };
  crawl.db.exec(
    "CREATE TABLE analysis_market (id INTEGER PRIMARY KEY CHECK(id=1), snapshot_json TEXT NOT NULL)",
  );
  crawl.db
    .prepare("INSERT INTO analysis_market VALUES (1,?)")
    .run(JSON.stringify({ fetchedAt, servers: [server] }));
  const store = new AnalysisStore(crawl.db);
  const profile = loadProfile(crawl.db);
  const id = store.createRun("codex", "fixture-model", true, profile, true);
  crawl.db.prepare("UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=?").run(
    JSON.stringify({
      score: 80,
      valuation: { bare_role_value: 2000, decision: "PASS", price_difference_ratio: 1 },
    }),
    fetchedAt,
  );
  return { filename, crawl, store, record, profile, id, fetchedAt };
}

it("磁盘重启及行情过期后保留历史推荐和已查看状态，执行仍拒绝过期行情", async () => {
  const x = fixture();
  expect(x.store.overview({ currentProfile: x.profile }).ranking[0]).toMatchObject({
    key: x.record.listing.key,
    profileChanged: false,
    marketExpired: false,
  });
  x.store.markRecommendationViewed(x.record.listing.key);
  expect(x.store.overview({ currentProfile: x.profile }).ranking).toHaveLength(0);
  x.crawl.close();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(x.fetchedAt) + 25 * 3600000);
  const reopened = new CrawlStore(x.filename);
  const store = new AnalysisStore(reopened.db);
  const runner = new AnalysisRunner(store, vi.fn());
  try {
    expect(marketServers(reopened.db)).toEqual([]);
    expect(loadProfile(reopened.db).settings.servers).toEqual([]);
    const display = loadProfile(reopened.db, PROMPT_FILE, { allowExpiredMarket: true });
    expect(store.overview({ currentProfile: display }).ranking).toHaveLength(0);
    const visible = store.overview({ currentProfile: display, showViewed: true });
    expect(visible.rankingPagination?.total).toBe(1);
    expect(visible.ranking[0]).toMatchObject({
      key: x.record.listing.key,
      profileChanged: false,
      marketExpired: true,
      recommendationViewed: true,
    });
    expect(visible.run?.marketExpired).toBe(true);
    expect(store.detail(visible.ranking[0].taskId!, display)?.profileChanged).toBe(false);
    await expect(runner.resume(x.id)).rejects.toThrow("区服行情已过期");
  } finally {
    await runner.shutdown();
    reopened.close();
  }
});

it("历史展示仍排除真实参数或资料变化的旧推荐", () => {
  const x = fixture();
  try {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(x.fetchedAt) + 25 * 3600000);
    const read = () => loadProfile(x.crawl.db, PROMPT_FILE, { allowExpiredMarket: true });
    expect(x.store.overview({ currentProfile: read() }).ranking).toHaveLength(1);
    x.crawl.db
      .prepare("INSERT INTO analysis_settings VALUES(1,?)")
      .run(JSON.stringify({ ...x.profile.settings, budget: 100, settingsVersion: 2 }));
    expect(x.store.overview({ currentProfile: read() }).ranking).toHaveLength(0);
    x.crawl.db.prepare("DELETE FROM analysis_settings").run();
    expect(x.store.overview({ currentProfile: read() }).ranking).toHaveLength(1);
    x.record.listing.price = "900";
    x.crawl.observe(x.record.listing);
    x.crawl.save(x.record.listing, x.record.detail!);
    expect(x.store.overview({ currentProfile: read() }).ranking).toHaveLength(0);
  } finally {
    x.crawl.close();
  }
});

it("商品行情时效只取其自身区服，不被其他区服的过期行情误标", () => {
  const x = fixture();
  try {
    const row = x.crawl.db.prepare("SELECT profile_json FROM analysis_runs WHERE id=?").get(x.id)!;
    const saved = JSON.parse(String(row.profile_json));
    saved.marketSources.push({
      ...saved.marketSources[0],
      serverId: "999",
      fetchedAt: new Date(Date.now() - 25 * 3600000).toISOString(),
    });
    x.crawl.db
      .prepare("UPDATE analysis_runs SET profile_json=? WHERE id=?")
      .run(JSON.stringify(saved), x.id);
    expect(x.store.overview({ currentProfile: x.profile }).ranking[0]).toMatchObject({
      marketExpired: false,
    });
  } finally {
    x.crawl.close();
  }
});
