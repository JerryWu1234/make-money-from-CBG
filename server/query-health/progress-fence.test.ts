import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { AccessGovernor, type AccessContext } from "../access";
import { CrawlStore } from "../crawler/store";
import { valuationRecord } from "../../tests/fixtures/analysis";

it("T03/T10 another connection pauses before list progress writes; no checkpoint/watermark/end/review/seen advances", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-query-fence-"));
  const filename = path.join(directory, "cbg.sqlite");
  const crawl = new CrawlStore(filename);
  const otherDb = new DatabaseSync(filename);
  try {
    const record = valuationRecord("fence");
    crawl.observe(record.listing);
    crawl.deferPageReview("selling_time DESC", 1, "before");
    const gate = new AccessGovernor(crawl.db);
    const owner = gate.acquireOwner("worker");
    const context: AccessContext = {
      ...owner,
      runId: "run",
      queryId: "list-query",
      pageId: "list",
      pageGeneration: 1,
      browserSessionEpoch: "session",
      stopEpoch: 0,
      sourceKind: "crawl-list",
    };
    gate.registerPage(context);
    gate.registerQuery(context, { accepted: true });
    crawl.setProgressContext(context);
    expect(crawl.acquire("crawl-test")).toBe(true);
    crawl.withCrawlLease("crawl-test", () => {
      const oldHead = {
        time: record.listing.sellingTime || new Date().toISOString(),
        keys: [record.listing.key],
        order: "selling_time DESC",
      };
      crawl.setHeadCheckpoint(oldHead);
      const other = new AccessGovernor(otherDb);
      other.reportRisk({ reason: "frequency" });
      expect(() => crawl.setHeadCheckpoint({ ...oldHead, keys: ["367:new"] })).toThrow();
      expect(() => crawl.resolvePageReview("selling_time DESC", 1)).toThrow();
      expect(() => crawl.markBackfillComplete()).toThrow();
      expect(() =>
        crawl.observe({ ...record.listing, key: "367:untrusted", eid: "untrusted" }),
      ).toThrow();
      expect(crawl.headCheckpoint()).toEqual(oldHead);
      expect(crawl.pageReviews()).toHaveLength(1);
      expect(crawl.backfillComplete()).toBe(false);
      expect(crawl.hasListing("367:untrusted")).toBe(false);
      expect(
        crawl.save(record.listing, record.detail!, {
          key: record.listing.key,
          order: oldHead.order,
          page: 1,
          time: null,
          savedAt: "now",
        }),
      ).toBe(false);
      expect(crawl.checkpoint()).toBeUndefined();
      expect(
        crawl.db.prepare("SELECT status FROM listings WHERE key=?").get(record.listing.key)?.status,
      ).toBe("pending");
      expect(crawl.db.prepare("SELECT count(*) AS n FROM role_source_history").get()?.n).toBe(1);
    });
  } finally {
    otherDb.close();
    crawl.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("retry before list prepare uses its independently accepted detail proof; stale detail only archives", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    const record = valuationRecord("retry-fence");
    crawl.observe(record.listing);
    const gate = new AccessGovernor(crawl.db);
    const owner = gate.acquireOwner("worker");
    const initial: AccessContext = {
      ...owner,
      runId: "run",
      queryId: "not-prepared",
      pageId: "list",
      pageGeneration: 1,
      browserSessionEpoch: "session",
      stopEpoch: 0,
      sourceKind: "crawl-list",
    };
    gate.registerPage(initial);
    crawl.setProgressContext(initial);
    expect(crawl.acquire("crawl-test")).toBe(true);
    crawl.withCrawlLease("crawl-test", () => {
      expect(() => crawl.beginRetry(record.listing.key)).not.toThrow();
      const detailContext = {
        ...initial,
        queryId: "detail-query",
        pageId: "detail",
        sourceKind: "crawl-detail",
      };
      gate.registerPage(detailContext);
      gate.registerQuery(detailContext, { accepted: true });
      const detail = { ...record.detail!, accessContext: detailContext };
      expect(crawl.save(record.listing, detail)).toBe(true);
      gate.reportRisk({ reason: "verification" });
      expect(crawl.save(record.listing, { ...detail, collectedAt: new Date().toISOString() })).toBe(
        false,
      );
      expect(
        crawl.db.prepare("SELECT status FROM listings WHERE key=?").get(record.listing.key)?.status,
      ).toBe("complete");
    });
  } finally {
    crawl.close();
  }
});
