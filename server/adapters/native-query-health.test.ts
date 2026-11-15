import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vite-plus/test";
import { AccessGovernor } from "../access";
import { bindNativeCrawlSource } from "./native-query-health";
import type { ExtensionNativeRuntime } from "./extension-native";
import type { PageSnapshot } from "./contracts";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { nativeWorkflowScope, withNativeWorkflow } from "./native-workflow";
const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function fixture(empty = false, canary = false) {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const governor = new AccessGovernor(db);
  if (canary) {
    const state = governor.read();
    governor.updatePolicy(
      {
        ...state.policy,
        version: 2,
        minIntervalMs: 0,
        maxActionsPerWindow: 1000,
        canaryEnabled: true,
      },
      state.revision,
    );
  }
  const owner = governor.acquireOwner("native-wrapper");
  const crawlLease = { owner: "native-crawl", fence: 1 };
  db.exec(
    "CREATE TABLE crawl_lock(id INTEGER PRIMARY KEY,owner TEXT,fence INTEGER,expires_at INTEGER)",
  );
  db.prepare("INSERT INTO crawl_lock VALUES(1,?,?,?)").run(
    crawlLease.owner,
    crawlLease.fence,
    Date.now() + 120000,
  );
  const record = valuationRecord("native-health");
  const snapshot: PageSnapshot = {
    context: {
      schemaVersion: 1,
      runId: "native",
      queryId: "initial",
      pageId: "list-tab",
      pageGeneration: 1,
      browserSessionEpoch: "session",
      actionId: null,
      stopEpoch: 0,
      observedAt: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      sourceKind: "extension-native",
    },
    url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py",
    title: "角色",
    revision: "1",
    visible: true,
    loading: false,
    access: "normal",
    empty,
    listingCommitted: true,
    queryArgs: { server_type: "1,2,3", order_by: "selling_time DESC", page: 1 },
    formValues: { price_min: "", price_max: "", level_min: "", level_max: "" },
    listing: {
      page: 1,
      totalPages: 1,
      order: "selling_time DESC",
      items: empty ? [] : [record.listing],
    },
    business: [
      {
        kind: "jsonp",
        endpoint: "/cgi-bin/recommend.py",
        status: 200,
        success: true,
        count: empty ? 0 : 1,
      },
    ],
  };
  const operations: string[] = [];
  const diagnosticActions: unknown[] = [];
  let emptyNarrow = false;
  const render = () => {
    const noItems = emptyNarrow && !!snapshot.queryArgs?.price_min;
    snapshot.empty = noItems;
    snapshot.listing!.items = noItems ? [] : [record.listing];
    snapshot.listing!.page = Number(snapshot.queryArgs!.page);
    snapshot.listing!.order = String(snapshot.queryArgs!.order_by);
    snapshot.business![0].count = noItems ? 0 : 1;
  };
  const adapter = {
    snapshot: async () => structuredClone(snapshot),
    beginQuery: (_run: string, query: string) => {
      snapshot.context.queryId = query;
    },
    query: async (target: import("./contracts").SemanticTarget) => {
      const context = nativeWorkflowScope()?.context();
      if (!context) throw new Error("Missing native workflow context in fixture");
      return governor.runAction({ ...context, actionId: randomUUID() }, async () => {
        diagnosticActions.push(structuredClone(target));
        if (target.kind === "query-field") snapshot.formValues![target.field] = target.value;
        else if (target.kind === "query") {
          snapshot.queryArgs = { server_type: "1,2,3", page: 1, order_by: "selling_time DESC" };
          for (const [key, value] of Object.entries(snapshot.formValues!))
            if (value) snapshot.queryArgs[key] = value;
          render();
        } else if (target.kind === "sort") {
          snapshot.queryArgs!.order_by = target.value;
          snapshot.queryArgs!.page = 1;
          render();
        } else if (target.kind === "jump-page") {
          snapshot.queryArgs!.page = target.page;
          render();
        } else throw new Error("fixture unsupported action");
        snapshot.revision = String(Number(snapshot.revision) + 1);
        return structuredClone(snapshot);
      });
    },
    createCrawlSource: () => ({
      prepare: async () => snapshot.listing!,
      page: async () => snapshot.listing!,
      hover: async () => {
        operations.push("hover");
        return record.listing;
      },
      onShelf: async () => {
        operations.push("anchor");
        return true;
      },
      detail: async () => {
        snapshot.context.pageId = "detail-tab";
        snapshot.context.pageGeneration++;
        snapshot.detail = record.detail!;
        snapshot.productIdentity = { serverId: record.listing.serverId, eid: record.listing.eid };
        return structuredClone(record.detail!);
      },
    }),
  } as unknown as ExtensionNativeRuntime;
  const wrapped = bindNativeCrawlSource(
    adapter,
    governor,
    owner,
    new AbortController().signal,
    crawlLease,
    snapshot,
  );
  return {
    db,
    governor,
    record,
    snapshot,
    wrapped,
    operations,
    diagnosticActions,
    emptyTarget: () => {
      emptyNarrow = true;
      render();
    },
  };
}
it("native listing/current detail produce independent accepted proofs through the common health store", async () => {
  const x = fixture();
  expect(await x.wrapped.source.prepare()).toEqual(x.snapshot.listing);
  const listingProof = x.wrapped.context()!;
  expect(() => x.governor.withProgress(listingProof, () => {})).not.toThrow();
  const detail = await x.wrapped.source.detail(x.record.listing);
  expect(detail.accessContext?.pageId).toBe("detail-tab");
  expect(detail.accessContext?.queryId).not.toBe(listingProof.queryId);
  expect(() => x.governor.withProgress(detail.accessContext!, () => {})).not.toThrow();
  expect(x.wrapped.context()?.pageId).toBe("list-tab");
});
it("R-N6 anchor checks and hover wait for the same native workflow as market forms", async () => {
  const x = fixture();
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const market = withNativeWorkflow(new AbortController().signal, async () => {
    x.operations.push("market-start");
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    x.operations.push("market-end");
  });
  await ready;
  const anchor = x.wrapped.source.onShelf(x.record.listing);
  const hover = x.wrapped.source.hover(x.record.listing);
  await Promise.resolve();
  await Promise.resolve();
  expect(x.operations).toEqual(["market-start"]);
  release();
  await market;
  await expect(anchor).resolves.toBe(true);
  await hover;
  expect(x.operations).toEqual(["market-start", "market-end", "anchor", "hover"]);
});
it("native normal empty needs actual current condition and endpoint commit evidence", async () => {
  const x = fixture(true);
  await expect(x.wrapped.source.prepare()).resolves.toMatchObject({ items: [] });
  const y = fixture(true);
  y.snapshot.business = [];
  await expect(y.wrapped.source.prepare()).rejects.toThrow("健康核验");
  expect(() => y.governor.withProgress(y.wrapped.context()!, () => {})).toThrow();
  const z = fixture();
  delete z.snapshot.queryArgs;
  await expect(z.wrapped.source.prepare()).rejects.toThrow("条件身份");
});

it("native role diagnostic uses bounded semantic UI actions and restores original filters/order/page without adopting Canary rows", async () => {
  const x = fixture(false, true);
  x.snapshot.listing!.order = "expire_time DESC";
  x.snapshot.queryArgs!.order_by = "expire_time DESC";
  await x.wrapped.source.prepare();
  x.snapshot.queryArgs!.price_min = "100";
  x.snapshot.queryArgs!.page = 2;
  x.snapshot.formValues!.price_min = "100";
  x.snapshot.listing!.page = 2;
  await x.wrapped.source.page(2);
  x.emptyTarget();
  await expect(x.wrapped.source.page(2)).rejects.toThrow("健康核验");
  expect(x.diagnosticActions).toEqual([
    { kind: "query" },
    { kind: "sort", value: "expire_time DESC" },
    { kind: "jump-page", page: 2 },
    { kind: "query-field", field: "price_min", value: "" },
    { kind: "query" },
    { kind: "sort", value: "expire_time DESC" },
    { kind: "query-field", field: "price_min", value: "100" },
    { kind: "query" },
    { kind: "sort", value: "expire_time DESC" },
    { kind: "jump-page", page: 2 },
  ]);
  expect(x.snapshot.queryArgs).toMatchObject({
    price_min: "100",
    page: 2,
    order_by: "expire_time DESC",
  });
  expect(x.snapshot.formValues?.price_min).toBe("100");
  expect(
    x.db
      .prepare(
        "SELECT purpose,result,accepted FROM query_health_results WHERE purpose!='ordinary' ORDER BY rowid",
      )
      .all(),
  ).toEqual([
    { purpose: "target_review", result: "empty", accepted: 0 },
    { purpose: "canary", result: "data", accepted: 0 },
    { purpose: "restoration", result: "empty", accepted: 0 },
  ]);
  expect(x.db.prepare("SELECT used_actions FROM access_diagnostic_plans").get()?.used_actions).toBe(
    10,
  );
  expect(x.governor.read().state).toBe("needs_action");
  expect(() => x.governor.withProgress(x.wrapped.context()!, () => {})).toThrow();
});
