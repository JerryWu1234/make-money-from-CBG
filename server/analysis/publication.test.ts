import { expect, it } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";

it("正式商品与采集任务在 SQL 分页前分开，旧的全部记录读取仍可用", () => {
  const crawl = new CrawlStore(":memory:");
  const analysis = new AnalysisStore(crawl.db);
  try {
    for (let index = 0; index < 24; index++) {
      const record = analysisRecord(`complete-${String(index).padStart(2, "0")}`);
      crawl.observe(record.listing);
      expect(crawl.save(record.listing, record.detail!)).toBe(true);
    }
    for (const key of ["pending", "failed", "broken-complete"]) {
      crawl.observe(analysisRecord(key).listing);
    }
    crawl.fail("failed", "本轮完整性校验失败");
    crawl.db.prepare("UPDATE listings SET status='complete' WHERE key='broken-complete'").run();
    expect(crawl.records().total).toBe(27);
    const first = crawl.records(1, 20, "complete");
    const second = crawl.records(2, 20, "complete");
    expect(first).toMatchObject({ total: 24, totalPages: 2, scope: "complete" });
    expect(first.items).toHaveLength(20);
    expect(second.items).toHaveLength(4);
    expect([...first.items, ...second.items].every((item) => item.status === "complete")).toBe(
      true,
    );
    expect(new Set([...first.items, ...second.items].map((item) => item.key)).size).toBe(24);
    const tasks = crawl.records(1, 20, "tasks");
    expect(tasks).toMatchObject({ total: 3, totalPages: 1, scope: "tasks" });
    expect(tasks.items.find((item) => item.key === "broken-complete")?.published).toBe(false);
    expect(tasks.items.find((item) => item.key === "failed")?.error).toBe("本轮完整性校验失败");
    const overview = analysis.overview({ scope: "complete", page: 2 });
    expect(overview.counts).toMatchObject({ total: 24, complete: 24, waitingDetail: 0 });
    expect(overview.records).toMatchObject({ total: 24, totalPages: 2 });
    expect(overview.records.items).toHaveLength(4);
    expect(overview.captureTasks).toEqual({ total: 3, pending: 2, failed: 1 });
    expect(analysis.overview({ scope: "complete", search: "failed" }).records.total).toBe(0);
    expect(analysis.overview().counts.total).toBe(27);
  } finally {
    crawl.close();
  }
});

it("详情事务失败不发布商品或分析任务，完整提交才发布且仅追加一次", () => {
  const crawl = new CrawlStore(":memory:");
  const analysis = new AnalysisStore(crawl.db);
  const record = analysisRecord("candidate");
  const owner = "publication-fixture";
  try {
    crawl.observe(record.listing);
    analysis.acquire(owner);
    const runId = analysis.createRun("codex", "fixture-model");
    expect(analysis.appendCaptured(runId, owner)).toBe(0);
    expect(crawl.records(1, 20, "complete").total).toBe(0);
    crawl.db.exec(
      "CREATE TRIGGER reject_tabs BEFORE INSERT ON role_tabs BEGIN SELECT RAISE(ABORT,'fixture transaction failure'); END",
    );
    expect(() => crawl.save(record.listing, record.detail!)).toThrow("fixture transaction failure");
    expect(crawl.records(1, 20, "complete").total).toBe(0);
    expect(crawl.db.prepare("SELECT count(*) n FROM role_sources").get()!.n).toBe(0);
    expect(analysis.appendCaptured(runId, owner)).toBe(0);
    crawl.db.exec("DROP TRIGGER reject_tabs");
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
    expect(crawl.records(1, 20, "complete").total).toBe(1);
    expect(crawl.records(1, 20, "tasks").total).toBe(0);
    expect(analysis.appendCaptured(runId, owner)).toBe(1);
    expect(analysis.appendCaptured(runId, owner)).toBe(0);
    expect(analysis.run(runId)).toMatchObject({ total: 1, queued: 1 });
  } finally {
    crawl.close();
  }
});
