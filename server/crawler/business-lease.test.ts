import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vite-plus/test";
import { AccessGovernor, type AccessContext } from "../access";
import { CrawlStore } from "./store";
import { valuationRecord } from "../../tests/fixtures/analysis";
import {
  bindQuerySubject,
  beginObservedQuery,
  finishObservedQuery,
  querySubjectContext,
  successfulQueryEvidence,
} from "../query-health/runtime";

function connectedWorkers() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-worker-fence-"));
  const first = new CrawlStore(path.join(directory, "cbg.sqlite")),
    second = new CrawlStore(first.filename);
  const record = valuationRecord("worker-fence");
  first.observe(record.listing);
  first.acquire("old-worker");
  const gate = new AccessGovernor(first.db),
    owner = gate.acquireOwner("shared-service");
  const context: AccessContext = {
    ...owner,
    runId: "old-worker",
    queryId: "old-list",
    pageId: "list",
    pageGeneration: 1,
    browserSessionEpoch: "session",
    stopEpoch: 0,
    sourceKind: "crawl-list",
    crawlLease: first.crawlLease("old-worker"),
  };
  gate.registerPage(context);
  gate.registerQuery(context, { accepted: true });
  first.setProgressContext(context);
  return {
    first,
    second,
    gate,
    owner,
    context,
    record,
    close: () => {
      first.close();
      second.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

it("T03 service owner remains live but final authorization rejects a replaced business lease", () => {
  const x = connectedWorkers();
  try {
    const permit = x.gate.reserve(x.context);
    expect(x.second.acquire("new-worker", Date.now() + 120001)).toBe(true);
    expect(() => x.gate.renewOwner(x.owner)).not.toThrow();
    expect(() => x.gate.authorize(permit.permitId, x.context)).toThrow("业务租约");
    expect(x.gate.permit(permit.permitId)).toMatchObject({
      status: "reserved",
      authorizedAt: null,
    });
    // A separately scoped market action does not inherit the old crawl lease.
    const market = {
      ...x.context,
      crawlLease: undefined,
      sourceKind: "market",
      queryId: "market",
      pageId: "market",
    };
    x.gate.registerPage(market);
    const marketPermit = x.gate.reserve(market);
    expect(x.gate.authorize(marketPermit.permitId, market).authorized).toBe(true);
    x.gate.complete(marketPermit.permitId, x.owner);
  } finally {
    x.close();
  }
});

it("T10 暂停后不能新增待复核页或撤销旧复核页，也不能改变补采完成状态", () => {
  const x = connectedWorkers();
  try {
    x.first.withCrawlLease("old-worker", () => {
      x.first.deferPageReview("selling_time DESC", 2, "before");
      x.first.markBackfillComplete();
      const completeBefore = x.first.backfillComplete();
      x.gate.reportRisk({ reason: "frequency" });
      const before = x.first.pageReviews();
      expect(() => x.first.deferPageReview("selling_time DESC", 3, "after")).toThrow();
      expect(() => x.first.resolvePageReview("selling_time DESC", 2)).toThrow();
      expect(x.first.pageReviews()).toEqual(before);
      expect(x.first.backfillComplete()).toBe(completeBefore);
    });
  } finally {
    x.close();
  }
});

it("T03/T17 old workers cannot change retry, failure, tombstone, or current source after a newer complete", () => {
  const x = connectedWorkers();
  try {
    x.first.withCrawlLease("old-worker", () => {
      x.first.beginRetry(x.record.listing.key);
      expect(x.second.acquire("new-worker", Date.now() + 120001)).toBe(true);
      const newerGate = new AccessGovernor(x.second.db);
      const proof = {
        ...x.context,
        runId: "new-worker",
        queryId: "new-detail",
        pageId: "detail",
        sourceKind: "crawl-detail",
        crawlLease: x.second.crawlLease("new-worker"),
      };
      newerGate.registerPage(proof);
      newerGate.registerQuery(proof, { accepted: true });
      x.second.setProgressContext(proof);
      x.second.withCrawlLease("new-worker", () => {
        x.second.beginRetry(x.record.listing.key);
        expect(x.second.save(x.record.listing, { ...x.record.detail!, accessContext: proof })).toBe(
          true,
        );
      });
      const before = x.first.detail(x.record.listing.key);
      const source = x.first.db
        .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
        .get(x.record.listing.key)?.source_gzip;
      expect(() => x.first.beginRetry(x.record.listing.key, true)).toThrow("业务租约");
      expect(x.first.fail(x.record.listing.key, "late local failure")).toBe(false);
      expect(x.first.markUnavailable(x.record.listing.key, "late tombstone", x.context)).toBe(
        false,
      );
      expect(
        x.first.savePartial(x.record.listing, { ...x.record.detail!, raw: { stale: true } }),
      ).toBe(false);
      expect(x.first.detail(x.record.listing.key)).toEqual(before);
      expect(
        x.first.db
          .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
          .get(x.record.listing.key)?.source_gzip,
      ).toEqual(source);
      expect(x.first.db.prepare("SELECT count(*) AS n FROM crawl_attempt_errors").get()?.n).toBe(2);
    });
  } finally {
    x.close();
  }
});

it("T10 paused local failure archives without replacing partial; tombstone requires accepted current detail proof", () => {
  const x = connectedWorkers();
  try {
    x.first.withCrawlLease("old-worker", () => {
      x.first.beginRetry(x.record.listing.key);
      const partial = { ...x.record.detail!, raw: { paused: true } };
      x.first.savePartial(x.record.listing, partial);
      expect(x.first.markUnavailable(x.record.listing.key, "missing proof")).toBe(false);
      const detailProof = {
        ...x.context,
        queryId: "availability",
        pageId: "detail",
        sourceKind: "crawl-detail",
      };
      x.gate.registerPage(detailProof);
      x.gate.registerQuery(detailProof, { accepted: false });
      expect(x.first.markUnavailable(x.record.listing.key, "unaccepted", detailProof)).toBe(false);
      const before = x.first.detail(x.record.listing.key);
      new AccessGovernor(x.second.db).reportRisk({ reason: "frequency" });
      expect(x.first.fail(x.record.listing.key, "late failure during pause")).toBe(false);
      expect(x.first.markUnavailable(x.record.listing.key, "late terminal", detailProof)).toBe(
        false,
      );
      expect(() => x.first.beginRetry(x.record.listing.key)).toThrow();
      expect(x.first.detail(x.record.listing.key)).toEqual(before);
    });
  } finally {
    x.close();
  }
});

it("accepted current official availability can publish a tombstone while preserving its saved source", async () => {
  const x = connectedWorkers();
  try {
    await x.first.withCrawlLease("old-worker", async () => {
      x.first.beginRetry(x.record.listing.key);
      x.first.savePartial(x.record.listing, x.record.detail!);
      const before = x.first.detail(x.record.listing.key) as { detail: unknown };
      const proof = {
        ...x.context,
        queryId: "availability",
        pageId: "detail",
        sourceKind: "crawl-detail",
      };
      x.gate.registerPage(proof);
      x.gate.registerQuery(proof, { accepted: true });
      expect(
        x.first.markUnavailable(x.record.listing.key, "a list query is not a tombstone", proof),
      ).toBe(false);
      const subject = {};
      bindQuerySubject(subject, x.gate, proof);
      const query = beginObservedQuery(subject, {
        category: "role-availability",
        server: x.record.listing.serverId,
        serverAge: "",
        conditions: { eid: x.record.listing.eid, ordersn: x.record.listing.ordersn },
        page: 1,
        sort: "detail",
      });
      await finishObservedQuery(subject, query, successfulQueryEvidence(1));
      expect(
        x.first.markUnavailable(
          x.record.listing.key,
          "official HTTP 410",
          querySubjectContext(subject),
        ),
      ).toBe(true);
      expect(x.first.detail(x.record.listing.key)).toMatchObject({
        status: "unavailable",
        detail: before.detail,
      });
    });
  } finally {
    x.close();
  }
});

it("T03 业务租约接管后旧worker不能推进完成标记，同服务owner不会掩盖旧fence", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-business-lease-"));
  const first = new CrawlStore(path.join(directory, "cbg.sqlite")),
    second = new CrawlStore(first.filename);
  try {
    const now = Date.now();
    first.acquire("old-crawl", now);
    const gate = new AccessGovernor(first.db),
      serviceOwner = gate.acquireOwner("same-service");
    const proof: AccessContext = {
      ...serviceOwner,
      runId: "old-crawl",
      queryId: "old-query",
      pageId: "page",
      pageGeneration: 1,
      browserSessionEpoch: "session",
      stopEpoch: 0,
      sourceKind: "crawl-list",
    };
    gate.registerPage(proof);
    gate.registerQuery(proof, { accepted: true });
    first.setProgressContext(proof);
    first.withCrawlLease("old-crawl", () => {
      expect(second.acquire("new-crawl", now + 120001)).toBe(true);
      expect(() => first.markBackfillComplete()).toThrow("业务租约");
      expect(first.backfillComplete()).toBe(false);
    });
    expect(first.db.prepare("SELECT fence FROM crawl_lock").get()?.fence).toBe(2);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("T17 晚到partial在BEGIN前有新complete提交时只归档，不覆盖当前完整资料", async () => {
  const { analysisRecord } = await import("../../tests/fixtures/analysis");
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-partial-race-"));
  const first = new CrawlStore(path.join(directory, "cbg.sqlite")),
    second = new CrawlStore(first.filename);
  try {
    const record = analysisRecord("race"),
      latest = { ...record.detail!, collectedAt: new Date().toISOString() };
    first.observe(record.listing);
    const original = first.db.exec.bind(first.db);
    let inserted = false;
    first.db.exec = (sql: string) => {
      if (sql === "BEGIN IMMEDIATE" && !inserted) {
        inserted = true;
        second.save(record.listing, latest);
      }
      return original(sql);
    };
    const partial = {
      ...record.detail!,
      collectedAt: new Date(Date.now() - 1000).toISOString(),
      raw: { old: true },
    };
    expect(first.savePartial(record.listing, partial)).toBe(false);
    expect(first.detail(record.listing.key)).toMatchObject({
      status: "complete",
      detail: { collectedAt: latest.collectedAt },
    });
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
