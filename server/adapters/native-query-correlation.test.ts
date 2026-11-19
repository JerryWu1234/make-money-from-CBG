import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AccessGovernor } from "../access";
import { CrawlStore } from "../crawler/store";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { ExtensionNativeRuntime } from "./extension-native";
import { bindNativeCrawlSource } from "./native-query-health";
import { nativeWorkflowScope } from "./native-workflow";
import type { ActionPlan, PageSnapshot } from "./contracts";

const stores: CrawlStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

/** Real wrapper, raw CrawlSource and ActionPlan construction; only the semantic UI is in memory. */
function fixture() {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  expect(store.acquire("native-crawl")).toBe(true);
  const crawlLease = store.crawlLease("native-crawl");
  const governor = new AccessGovernor(store.db);
  const policy = governor.read();
  governor.updatePolicy(
    {
      ...policy.policy,
      version: policy.policy.version + 1,
      minIntervalMs: 0,
      maxActionsPerWindow: 1000,
    },
    policy.revision,
  );
  const owner = governor.acquireOwner("native-correlation");
  const record = valuationRecord("native-correlation");
  const snapshot: PageSnapshot = {
    context: {
      schemaVersion: 1,
      runId: "native-run",
      queryId: "initial-observation",
      actionId: null,
      pageId: "native-list",
      pageGeneration: 1,
      browserSessionEpoch: "native-session",
      stopEpoch: 0,
      observedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      sourceKind: "extension-native",
    },
    url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
    title: "角色语义页面",
    revision: "1",
    visible: true,
    loading: false,
    access: "normal",
    empty: false,
    listingCommitted: true,
    queryArgs: { server_type: "1,2,3", price_min: "100", page: 1, order_by: "selling_time DESC" },
    listing: { page: 1, totalPages: 3, order: "selling_time DESC", items: [record.listing] },
    business: [
      { kind: "jsonp", endpoint: "/cgi-bin/recommend.py", status: 200, success: true, count: 1 },
    ],
  };
  const plans: ActionPlan[] = [];
  let mutate: (value: PageSnapshot, plan: ActionPlan) => void = () => {};
  const adapter = new ExtensionNativeRuntime({
    db: store.db,
    socketPath: `/private/tmp/cbg-correlation-${randomUUID()}.sock`,
    stopEpoch: () => governor.read().stopEpoch,
    onRisk: () => {},
    runAction: async (_plan, dispatch) => dispatch(),
  });
  // This suite intentionally mocks execute() below: only query identity is under test.
  vi.spyOn(adapter.activity, "begin").mockImplementation(async () => ({
    lease: {
      activityId: "mock-query-workflow",
      authorizationEpoch: 1,
      stopEpoch: 0,
      browserSessionEpoch: "native-session",
      expiresAt: Date.now() + 15000,
      progressExpiresAt: Date.now() + 60000,
      progressSequence: 0,
    },
    signal: new AbortController().signal,
    close: async () => {},
  }));
  // query() and createCrawlSource() remain the production implementations, including beginQuery.
  (adapter as unknown as { sessionEpoch: string }).sessionEpoch = "native-session";
  vi.spyOn(adapter, "snapshot").mockImplementation(async () => structuredClone(snapshot));
  vi.spyOn(
    adapter as unknown as { request: (value: unknown) => Promise<unknown> },
    "request",
  ).mockImplementation(async () => ({ ok: true, location: { needsScroll: false } }));
  vi.spyOn(adapter, "execute").mockImplementation(async (plan, signal) => {
    const scoped = nativeWorkflowScope()!.context(plan)!;
    expect(plan.queryId).toBe(scoped.queryId);
    expect(plan.runId).toBe(scoped.runId);
    expect(scoped.crawlLease).toEqual(crawlLease);
    expect(
      store.db.prepare("SELECT accepted FROM access_queries WHERE query_id=?").get(plan.queryId)
        ?.accepted,
    ).toBe(0);
    const context = { ...scoped, ...plan };
    return governor.runAction(
      context,
      async () => {
        plans.push(structuredClone(plan));
        governor.recordRequest(context, { endpoint: "/cgi-bin/recommend.py", status: 200 });
        snapshot.context = { ...snapshot.context, ...plan };
        if (plan.target.kind === "sort") {
          snapshot.queryArgs!.order_by = plan.target.value;
          snapshot.queryArgs!.page = 1;
        } else if (plan.target.kind === "next-page") {
          snapshot.queryArgs!.page = plan.target.currentPage + 1;
        } else if (plan.target.kind === "jump-page") snapshot.queryArgs!.page = plan.target.page;
        else if (plan.target.kind === "refresh-list") snapshot.queryArgs!.page = 1;
        else throw new Error("unsupported fixture semantic action");
        snapshot.listing!.page = Number(snapshot.queryArgs!.page);
        snapshot.listing!.order = String(snapshot.queryArgs!.order_by);
        snapshot.revision = String(Number(snapshot.revision) + 1);
        snapshot.listingCommit = { actionId: plan.actionId, sequence: Number(snapshot.revision) };
        mutate(snapshot, plan);
        return structuredClone(snapshot);
      },
      signal,
    );
  });
  const wrapped = bindNativeCrawlSource(
    adapter,
    governor,
    owner,
    new AbortController().signal,
    crawlLease,
    structuredClone(snapshot),
  );
  store.setProgressContext(wrapped.context);
  return {
    store,
    governor,
    snapshot,
    plans,
    wrapped,
    setMutation: (value: typeof mutate) => {
      mutate = value;
    },
  };
}

it("native prepare, page and refresh accept the same pre-dispatch queryId as their actual plans, permits and requests", async () => {
  const x = fixture();
  const accepted: string[] = [];
  for (const run of [
    () => x.wrapped.source.prepare("expire_time DESC"),
    () => x.wrapped.source.page(2),
    () => x.wrapped.source.refresh!("expire_time DESC"),
  ]) {
    await run();
    const proof = x.wrapped.context()!;
    const plan = x.plans.at(-1)!;
    expect(proof.queryId).toBe(plan.queryId);
    expect(proof.crawlLease).toEqual({ owner: "native-crawl", fence: 1 });
    expect(() => x.governor.withProgress(proof, () => {})).not.toThrow();
    const result = x.store.db
      .prepare("SELECT identity_json,accepted FROM query_health_results WHERE query_id=?")
      .get(plan.queryId)!;
    expect(result.accepted).toBe(1);
    expect(JSON.parse(String(result.identity_json))).toMatchObject({
      category: "role",
      conditions: { server_type: "1,2,3", price_min: "100" },
      page: x.snapshot.listing!.page,
      sort: "expire_time DESC",
    });
    for (const table of ["access_permits", "access_requests"]) {
      const rows = x.store.db
        .prepare(`SELECT context_json FROM ${table} WHERE json_extract(context_json,'$.queryId')=?`)
        .all(plan.queryId);
      expect(rows).toHaveLength(1);
      expect(JSON.parse(String(rows[0].context_json))).toMatchObject({
        queryId: proof.queryId,
        actionId: plan.actionId,
        crawlLease: proof.crawlLease,
      });
    }
    accepted.push(proof.queryId);
  }
  expect(new Set(accepted).size).toBe(3);
  expect(x.plans.map((plan) => plan.target.kind)).toEqual(["sort", "next-page", "refresh-list"]);
});

it("an explicit same-page recheck has a fresh queryId and no fabricated action", async () => {
  const x = fixture();
  await x.wrapped.source.prepare();
  const first = x.wrapped.context()!.queryId;
  await x.wrapped.source.page(1);
  const proof = x.wrapped.context()!;
  expect(proof.queryId).not.toBe(first);
  expect(proof.queryId).not.toBe("initial-observation");
  expect(proof.actionId).toBeUndefined();
  expect(x.plans).toEqual([]);
  expect(x.store.db.prepare("SELECT COUNT(*) AS n FROM access_permits").get()?.n).toBe(0);
  expect(() => x.governor.withProgress(proof, () => {})).not.toThrow();
});

it("tail-page extra conditions stay unknown and the live store resolver cannot reuse the earlier accepted proof", async () => {
  const x = fixture();
  await x.store.withCrawlLease("native-crawl", async () => {
    await x.wrapped.source.prepare();
    const prior = x.wrapped.context()!.queryId;
    const checkpoint = {
      time: "2026-11-15T00:00:00.000Z",
      keys: ["before"],
      order: "selling_time DESC",
    };
    x.store.setHeadCheckpoint(checkpoint);
    x.setMutation((snapshot) => {
      snapshot.queryArgs!.unrequested_extra = "narrow";
      snapshot.listing!.items = [];
      snapshot.empty = true;
      snapshot.business![0].count = 0;
    });
    await expect(x.wrapped.source.page(3)).rejects.toThrow("健康核验");
    const proof = x.wrapped.context()!;
    expect(proof.queryId).not.toBe(prior);
    expect(proof.queryId).toBe(x.plans[0].queryId);
    expect(
      x.store.db
        .prepare("SELECT result,accepted FROM query_health_results WHERE query_id=?")
        .get(proof.queryId),
    ).toEqual({ result: "unknown", accepted: 0 });
    expect(() => x.store.setHeadCheckpoint({ ...checkpoint, keys: ["after"] })).toThrow("健康核验");
    expect(() => x.store.markBackfillComplete()).toThrow("健康核验");
    expect(x.store.headCheckpoint()).toEqual(checkpoint);
    expect(x.store.backfillComplete()).toBe(false);
  });
});

it.each(["query", "page", "sort", "document", "tab", "session", "run", "commit"] as const)(
  "native action result with mismatched %s cannot accept its pre-dispatch proof",
  async (change) => {
    const x = fixture();
    x.setMutation((snapshot) => {
      if (change === "query") snapshot.context.queryId = "stale-query";
      if (change === "page") {
        snapshot.queryArgs!.page = 3;
        snapshot.listing!.page = 3;
      }
      if (change === "sort") {
        snapshot.queryArgs!.order_by = "expire_time DESC";
        snapshot.listing!.order = "expire_time DESC";
      }
      if (change === "document") snapshot.context.pageGeneration++;
      if (change === "tab") snapshot.context.pageId = "another-tab";
      if (change === "session") snapshot.context.browserSessionEpoch = "another-session";
      if (change === "run") snapshot.context.runId = "another-run";
      if (change === "commit") snapshot.listingCommitted = false;
    });
    await expect(x.wrapped.source.page(2)).rejects.toThrow("健康核验");
    const queryId = x.plans[0].queryId;
    expect(x.wrapped.context()!.queryId).toBe(queryId);
    expect(
      x.store.db
        .prepare("SELECT result,accepted FROM query_health_results WHERE query_id=?")
        .get(queryId),
    ).toEqual({ result: "unknown", accepted: 0 });
    expect(() => x.governor.withProgress(x.wrapped.context()!, () => {})).toThrow();
  },
);
