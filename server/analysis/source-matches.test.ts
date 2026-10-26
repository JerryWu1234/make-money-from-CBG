import { expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { analysisRecord } from "../../tests/fixtures/analysis";

it("原文匹配只在实际输入变化时维护，跨连接、回滚、删除重建不发布旧结果", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "cbg-source-match-"));
  const filename = path.join(folder, "fixture.sqlite"),
    crawl = new CrawlStore(filename);
  let other: CrawlStore | undefined;
  try {
    const record = analysisRecord("matched");
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const store = new AnalysisStore(crawl.db),
      id = store.createRun("codex", "fixture", true);
    const match = () =>
      Number(
        crawl.db
          .prepare(
            "SELECT matches FROM analysis_source_matches WHERE task_id=(SELECT id FROM analysis_tasks WHERE run_id=?)",
          )
          .get(id)!.matches,
      );
    expect(match()).toBe(1);
    other = new CrawlStore(filename);
    other.db
      .prepare(
        "UPDATE listings SET listing_json=json_set(listing_json,'$.price','1234') WHERE key='matched'",
      )
      .run();
    expect(match()).toBe(0);
    other.db.exec(
      "UPDATE analysis_tasks SET source_listing_json=(SELECT listing_json FROM listings WHERE key='matched')",
    );
    expect(match()).toBe(1);
    crawl.db.exec("BEGIN; UPDATE listings SET detail_json='{}' WHERE key='matched'");
    expect(match()).toBe(0);
    crawl.db.exec("ROLLBACK");
    expect(match()).toBe(1);
    other.db.exec("DELETE FROM listings WHERE key='matched'");
    expect(match()).toBe(0);
    other.observe(record.listing);
    other.save(record.listing, record.detail!);
    expect(match()).toBe(0);
    other.db.exec("DELETE FROM analysis_tasks");
    expect(crawl.db.prepare("SELECT count(*) n FROM analysis_source_matches").get()!.n).toBe(0);
  } finally {
    other?.close();
    crawl.close();
    rmSync(folder, { recursive: true, force: true });
  }
});
