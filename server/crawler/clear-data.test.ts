import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { analysisRecord, analysisResponse } from "../../tests/fixtures/analysis";
import { AnalysisStore } from "../analysis/store";
import { DEFAULT_SETTINGS } from "../analysis/profile";
import { CrawlStore } from "./store";

// Failure cases: an acquired lock is missed before the delete transaction; a
// failed delete leaves partial data; per-product confirmations or derived records
// survive; settings disappear; or a reopened empty database cannot collect again.
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
});

const businessTables = [
  "listings",
  "role_tabs",
  "role_parameters",
  "role_sources",
  "role_source_history",
  "crawl_state",
  "crawl_lock",
  "analysis_runs",
  "analysis_tasks",
  "analysis_attempts",
  "analysis_lock",
  "recommendation_views",
  "analysis_school_formula_confirmations",
  "analysis_source_matches",
  "analysis_capture_checks",
  "record_versions",
];

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "cbg-clear-data-"));
  directories.push(directory);
  const filename = path.join(directory, "cbg.sqlite");
  const crawl = new CrawlStore(filename);
  const record = analysisRecord("clear-role");
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!, {
    key: record.listing.key,
    time: record.listing.sellingTime!,
    order: "selling_time DESC",
    page: 2,
    savedAt: new Date().toISOString(),
  });
  crawl.save(record.listing, record.detail!);
  const analysis = new AnalysisStore(crawl.db);
  const run = analysis.createRun("codex", "fixture-model", true);
  const task = crawl.db.prepare("SELECT id FROM analysis_tasks WHERE run_id=?").get(run)!;
  crawl.db
    .prepare("UPDATE analysis_tasks SET status='completed',result_json=?,completed_at=? WHERE id=?")
    .run(JSON.stringify(analysisResponse(record)), new Date().toISOString(), task.id);
  crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(run);
  crawl.db
    .prepare("INSERT INTO analysis_attempts(id,task_id,state,created_at) VALUES(?,?,'completed',?)")
    .run("clear-attempt", task.id, new Date().toISOString());
  analysis.markRecommendationViewed(record.listing.key);
  crawl.db
    .prepare("INSERT INTO analysis_capture_checks VALUES(?,?,1,NULL,NULL,NULL,NULL,0)")
    .run(run, record.listing.key);
  crawl.db.exec(`CREATE TABLE analysis_school_formula_confirmations (
    listing_key TEXT PRIMARY KEY, levels_json TEXT NOT NULL, note TEXT NOT NULL, confirmed_at TEXT NOT NULL
  );
  CREATE TABLE analysis_settings (id INTEGER PRIMARY KEY CHECK(id=1), settings_json TEXT NOT NULL);
  CREATE TABLE analysis_market (id INTEGER PRIMARY KEY, snapshot_json TEXT NOT NULL);`);
  crawl.db
    .prepare("INSERT INTO analysis_school_formula_confirmations VALUES(?,?,?,?)")
    .run(
      record.listing.key,
      "[160,160,160,160,160]",
      "fixture confirmation",
      new Date().toISOString(),
    );
  const settings = JSON.stringify({ ...DEFAULT_SETTINGS, budget: 100, settingsVersion: 2 });
  crawl.db.prepare("INSERT INTO analysis_settings VALUES(1,?)").run(settings);
  const market = JSON.stringify({ fetchedAt: new Date().toISOString(), servers: [] });
  crawl.db.prepare("INSERT INTO analysis_market VALUES(1,?)").run(market);
  return { filename, crawl, analysis, record, settings, market };
}

it("清理后业务表及关联记录为空，重开保留设置和行情且能重新采集分析", () => {
  const x = fixture();
  for (const table of businessTables.filter((table) => !table.endsWith("_lock")))
    expect(Number(x.crawl.db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n)).toBeGreaterThan(
      0,
    );
  x.crawl.clear();
  for (const table of businessTables)
    expect(x.crawl.db.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0);
  x.crawl.close();
  const reopened = new CrawlStore(x.filename);
  try {
    expect(reopened.count()).toBe(0);
    expect(reopened.checkpoint()).toBeUndefined();
    expect(
      reopened.db.prepare("SELECT settings_json FROM analysis_settings").get()?.settings_json,
    ).toBe(x.settings);
    expect(
      reopened.db.prepare("SELECT snapshot_json FROM analysis_market").get()?.snapshot_json,
    ).toBe(x.market);
    const analysis = new AnalysisStore(reopened.db);
    expect(analysis.overview().results.total).toBe(0);
    expect(analysis.overview().ranking).toHaveLength(0);
    reopened.observe(x.record.listing);
    expect(reopened.save(x.record.listing, x.record.detail!)).toBe(true);
    const nextRun = analysis.createRun("codex", "fixture-model", true);
    expect(reopened.count()).toBe(1);
    expect(
      reopened.db.prepare("SELECT count(*) n FROM analysis_tasks WHERE run_id=?").get(nextRun)?.n,
    ).toBe(1);
    expect(
      reopened.db.prepare("SELECT count(*) n FROM analysis_school_formula_confirmations").get()?.n,
    ).toBe(0);
  } finally {
    reopened.close();
  }
});

it.each(["crawl", "analysis"] as const)("%s 锁由另一连接在清理事务前取得时仍拒绝删除", (kind) => {
  const x = fixture();
  const other = new CrawlStore(x.filename);
  const execute = x.crawl.db.exec.bind(x.crawl.db);
  let interleaved = false;
  vi.spyOn(x.crawl.db, "exec").mockImplementation((sql) => {
    if (!interleaved && sql.includes("BEGIN IMMEDIATE")) {
      interleaved = true;
      if (kind === "crawl") expect(other.acquire("other-service")).toBe(true);
      else expect(new AnalysisStore(other.db).acquire("other-service")).toBe(true);
    }
    return execute(sql);
  });
  try {
    expect(() => x.crawl.clear()).toThrow("请先暂停");
    expect(interleaved).toBe(true);
    expect(x.crawl.count()).toBe(1);
    expect(x.crawl.db.prepare("SELECT count(*) n FROM analysis_tasks").get()?.n).toBe(1);
    expect(x.crawl.db.prepare("SELECT count(*) n FROM recommendation_views").get()?.n).toBe(1);
    expect(
      x.crawl.db.prepare("SELECT count(*) n FROM analysis_school_formula_confirmations").get()?.n,
    ).toBe(1);
  } finally {
    other.close();
    x.crawl.close();
  }
});

it("删除中途故障时回滚已删记录，解除故障后可正常重试", () => {
  const x = fixture();
  x.crawl.db.exec(`CREATE TRIGGER fail_clear BEFORE DELETE ON role_tabs BEGIN
    SELECT RAISE(ABORT,'fixture clear failure');
  END;`);
  try {
    expect(() => x.crawl.clear()).toThrow("fixture clear failure");
    expect(x.crawl.count()).toBe(1);
    expect(x.crawl.db.prepare("SELECT count(*) n FROM analysis_runs").get()?.n).toBe(1);
    expect(x.crawl.db.prepare("SELECT count(*) n FROM analysis_tasks").get()?.n).toBe(1);
    expect(x.crawl.db.prepare("SELECT count(*) n FROM analysis_attempts").get()?.n).toBe(1);
    expect(x.crawl.db.prepare("SELECT count(*) n FROM recommendation_views").get()?.n).toBe(1);
    x.crawl.db.exec("DROP TRIGGER fail_clear");
    x.crawl.clear();
    expect(x.crawl.count()).toBe(0);
  } finally {
    x.crawl.close();
  }
});
