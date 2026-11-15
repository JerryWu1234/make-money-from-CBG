import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AccessGovernor } from "../access";
import { CrawlStore } from "../crawler/store";
import { ExtensionNativeRuntime } from "./extension-native";
import { bindNativeCrawlSource } from "./native-query-health";
import { nativeWorkflowScope, withNativeWorkflow } from "./native-workflow";
import type { ActionPlan, NativeNavigationReceipt, PageSnapshot } from "./contracts";
import type { HeadCheckpoint } from "../crawler/types";

const stores: CrawlStore[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

/** Production query/execute/bridge decoding; only the Chrome worker/host transport is simulated. */
async function fixture() {
  const store = new CrawlStore(":memory:");
  stores.push(store);
  expect(store.acquire("native-navigation")).toBe(true);
  const crawlLease = store.crawlLease("native-navigation");
  const governor = new AccessGovernor(store.db);
  const state = governor.read();
  governor.updatePolicy(
    {
      ...state.policy,
      version: state.policy.version + 1,
      minIntervalMs: 0,
      maxActionsPerWindow: 1000,
    },
    state.revision,
  );
  const owner = governor.acquireOwner("native-navigation-test");
  const plans: ActionPlan[] = [];
  const adapter = new ExtensionNativeRuntime({
    db: store.db,
    socketPath: `/private/tmp/cbg-navigation-${randomUUID()}.sock`,
    stopEpoch: () => governor.read().stopEpoch,
    onRisk: (reason) => {
      governor.reportRisk({ reason });
    },
    runAction: (plan, dispatch, signal) => {
      const scope = nativeWorkflowScope();
      const context = {
        ...owner,
        ...scope?.context(plan),
        ...plan,
        sourceKind: scope?.context(plan)?.sourceKind || "extension-native",
        crawlLease,
      };
      governor.registerPage(context);
      return governor.runAction(context, dispatch, signal);
    },
  });
  const internals = adapter as any;
  internals.socket = {
    destroyed: false,
    write: (value: string) => {
      const message = JSON.parse(value);
      if (message.kind === "command" && message.command === "execute") plans.push(message.plan);
      if (message.kind === "resume" || message.command === "locate")
        void Promise.resolve().then(() =>
          internals.receive({
            kind: "input-result",
            actionId: message.actionId || message.plan.actionId,
            ok: true,
            posted: false,
            location: { needsScroll: false },
          }),
        );
    },
  };
  let sequence = 0;
  const receive = (kind: string, payload: unknown) =>
    internals.receive({
      version: 1,
      connectionEpoch: "navigation-connection",
      messageId: `navigation-${++sequence}`,
      sequence,
      kind,
      payload,
    });
  const binding = { tabId: 7, windowId: 9, bindingEpoch: "owned-binding" };
  const url = "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role";
  const payload = (pageId = "before-document", pageGeneration = 1, plan?: ActionPlan) => ({
    pageId,
    pageGeneration,
    observedAt: new Date().toISOString(),
    url,
    title: "角色列表 fixture",
    revision: plan ? "after-reload" : "before-reload",
    visible: true,
    loading: false,
    access: "normal",
    empty: false,
    listingCommitted: true,
    queryArgs: { server_type: "1,2,3", price_min: "100", page: 1, order_by: "selling_time DESC" },
    listing: {
      page: 1,
      totalPages: 3,
      serverType: "1,2,3",
      order: "selling_time DESC",
      items: [{ href: "/equip?s=1&eid=fixture", attrs: { data_price: "100" }, summary: {} }],
    },
    business: [
      { kind: "jsonp", endpoint: "/cgi-bin/recommend.py", status: 200, success: true, count: 1 },
    ],
    actionContext: plan,
  });
  await receive("status", {
    bound: true,
    pageId: "before-document",
    pageGeneration: 1,
    ...binding,
  });
  await receive("snapshot", payload());
  for (let attempt = 0; attempt < 20 && adapter.status().stopped; attempt++)
    await Promise.resolve();
  expect(adapter.status().stopped).toBe(false);
  const wrapped = bindNativeCrawlSource(
    adapter,
    governor,
    owner,
    new AbortController().signal,
    crawlLease,
    await adapter.snapshot(),
  );
  store.setProgressContext(wrapped.context);
  let changeSnapshot: (value: PageSnapshot) => void = () => {};
  let opening: NativeNavigationReceipt | undefined;
  const originalSnapshot = adapter.snapshot.bind(adapter);
  vi.spyOn(adapter, "snapshot").mockImplementation(async (pageId) => {
    const value = structuredClone(await originalSnapshot(pageId));
    if (
      plans.length &&
      store.db
        .prepare("SELECT state FROM access_bridge_commands WHERE action_id=?")
        .get(plans.at(-1)!.actionId)?.state === "completed"
    )
      changeSnapshot(value);
    return value;
  });
  const nextPlan = async (beforeCount: number) => {
    for (let attempt = 0; attempt < 100 && plans.length === beforeCount; attempt++)
      await Promise.resolve();
    expect(plans.length).toBe(beforeCount + 1);
    return plans.at(-1)!;
  };
  const deliver = async (
    plan: ActionPlan,
    pageId: string,
    pageGeneration: number,
    nextBinding = binding,
    extra: Record<string, unknown> = {},
    status: Record<string, unknown> = {},
  ) => {
    await internals.receive({
      kind: "input-result",
      actionId: plan.actionId,
      ok: true,
      posted: true,
      state: "input_posted_result_unconfirmed",
    });
    await receive("status", {
      navigated: true,
      actionId: plan.actionId,
      pageId,
      pageGeneration,
      url,
      ...nextBinding,
      ...status,
    });
    await receive("snapshot", { ...payload(pageId, pageGeneration, plan), ...extra });
  };
  const openDetail = async () => {
    const current = wrapped.context()!;
    const context = { ...current, queryId: randomUUID() };
    governor.registerQuery(context, { accepted: false });
    adapter.beginQuery(context.runId, context.queryId);
    const beforeCount = plans.length;
    const operation = withNativeWorkflow(
      new AbortController().signal,
      () =>
        adapter.query(
          { kind: "listing-detail", serverId: "1", eid: "fixture" },
          { kind: "detail", serverId: "1", eid: "fixture" },
        ),
      { context: () => context, crawlLease },
    );
    const plan = await nextPlan(beforeCount);
    expect(plan.target.kind).toBe("listing-detail");
    await deliver(
      plan,
      "owned-detail",
      1,
      { ...binding, tabId: 8 },
      {
        url: "https://xyq.cbg.163.com/equip?s=1&eid=fixture",
        revision: "detail-open",
        listing: undefined,
        queryArgs: undefined,
        listingCommitted: false,
        productIdentity: { serverId: "1", eid: "fixture" },
        productState: "selling",
      },
    );
    await operation;
    opening = adapter.navigationReceipt(plan.queryId, plan.actionId);
    expect(opening).toBeDefined();
  };
  const refresh = async () => {
    let beforeCount = plans.length;
    const operation = wrapped.source.refresh!("selling_time DESC");
    let failure: unknown;
    // Attach the rejection handler before delivering fixture messages.
    const settled = operation.then(
      (value) => ({ value }),
      (error) => {
        failure = error;
        return { error };
      },
    );
    let plan = await nextPlan(beforeCount);
    if (plan.target.kind === "return-to-list") {
      expect(opening).toBeDefined();
      await deliver(
        plan,
        "before-document",
        1,
        binding,
        { revision: "return-parent" },
        {
          ownedReturn: { openedBy: opening!.plan, parent: opening!.from, child: opening!.to },
        },
      );
      beforeCount = plans.length;
      for (let attempt = 0; attempt < 100 && plans.length === beforeCount && !failure; attempt++)
        await Promise.resolve();
      if (failure) throw failure;
      plan = await nextPlan(beforeCount);
    }
    expect(plan?.target.kind).toBe("refresh-list");
    expect(
      store.db.prepare("SELECT accepted FROM access_queries WHERE query_id=?").get(plan.queryId)
        ?.accepted,
    ).toBe(0);
    await deliver(plan, "after-document", 1);
    const result = await settled;
    if ("error" in result) throw result.error;
    return result.value;
  };
  return {
    store,
    governor,
    adapter,
    plans,
    wrapped,
    refresh,
    openDetail,
    writeCheckpoint: (value: HeadCheckpoint) =>
      store.withCrawlLease("native-navigation", () => store.setHeadCheckpoint(value)),
    markComplete: () =>
      store.withCrawlLease("native-navigation", () => store.markBackfillComplete()),
    changeSnapshot: (mutate: typeof changeSnapshot) => {
      changeSnapshot = mutate;
    },
  };
}

it("a real refresh query/execute follows its locally confirmed new document without changing queryId", async () => {
  const x = await fixture();
  await x.wrapped.source.prepare();
  const earlier = x.wrapped.context()!;
  await x.refresh();
  const proof = x.wrapped.context()!;
  const plan = x.plans[0];
  expect(proof).toMatchObject({
    pageId: "after-document",
    pageGeneration: 1,
    queryId: plan.queryId,
    actionId: plan.actionId,
    crawlLease: earlier.crawlLease,
  });
  expect(proof.queryId).not.toBe(earlier.queryId);
  expect(x.adapter.navigationReceipt(proof.queryId, plan.actionId)).toMatchObject({
    plan,
    from: { pageId: "before-document", tabId: 7, windowId: 9 },
    to: { pageId: "after-document", tabId: 7, windowId: 9 },
    revision: "after-reload",
  });
  expect(() => x.governor.withProgress(proof, () => {})).not.toThrow();
  expect(() => x.governor.withProgress(earlier, () => {})).toThrow();
  expect(
    x.store.db
      .prepare("SELECT result,accepted FROM query_health_results WHERE query_id=?")
      .get(proof.queryId),
  ).toEqual({ result: "data", accepted: 1 });
});

it("an owned child detail returns through its verified parent before a fresh list refresh query", async () => {
  const x = await fixture();
  await x.wrapped.source.prepare();
  await x.openDetail();
  await x.refresh();
  expect(x.plans.map((plan) => plan.target.kind)).toEqual([
    "listing-detail",
    "return-to-list",
    "refresh-list",
  ]);
  expect(new Set(x.plans.map((plan) => plan.queryId)).size).toBe(3);
  const returned = x.adapter.navigationReceipt(x.plans[1].queryId, x.plans[1].actionId)!;
  expect(returned.ownedReturn).toMatchObject({
    openedBy: x.plans[0],
    parent: { pageId: "before-document", tabId: 7 },
    child: { pageId: "owned-detail", tabId: 8 },
  });
  for (const plan of x.plans.slice(1))
    expect(
      x.store.db
        .prepare("SELECT result,accepted FROM query_health_results WHERE query_id=?")
        .get(plan.queryId),
    ).toEqual({ result: "data", accepted: 1 });
  expect(x.wrapped.context()).toMatchObject({
    queryId: x.plans[2].queryId,
    pageId: "after-document",
  });
  expect(() => x.governor.withProgress(x.wrapped.context()!, () => {})).not.toThrow();
});

it.each([
  "missing-chain",
  "wrong-parent",
  "wrong-child",
  "wrong-opening",
  "old-stop",
  "missing-opening",
  "unconfirmed-permit",
])(
  "an owned child return with %s evidence cannot dispatch refresh or advance progress",
  async (change) => {
    const x = await fixture();
    await x.wrapped.source.prepare();
    const checkpoint = {
      time: "2026-11-15T00:00:00.000Z",
      keys: ["before"],
      order: "selling_time DESC",
    };
    x.writeCheckpoint(checkpoint);
    await x.openDetail();
    if (change === "unconfirmed-permit")
      x.store.db
        .prepare(
          "UPDATE access_permits SET status='unknown' WHERE json_extract(context_json,'$.actionId')=?",
        )
        .run(x.plans[0].actionId);
    const get = x.adapter.navigationReceipt.bind(x.adapter);
    vi.spyOn(x.adapter, "navigationReceipt").mockImplementation((queryId, actionId) => {
      const original = get(queryId, actionId);
      if (!original) return undefined;
      if (change === "missing-opening" && original.plan.target.kind === "listing-detail")
        return undefined;
      const receipt = structuredClone(original);
      if (receipt.plan.target.kind === "return-to-list") {
        if (change === "missing-chain") delete receipt.ownedReturn;
        if (change === "wrong-parent") receipt.ownedReturn!.parent.pageId = "unowned-parent";
        if (change === "wrong-child") receipt.ownedReturn!.child.tabId++;
        if (change === "wrong-opening") receipt.ownedReturn!.openedBy.actionId = "unowned-opening";
        if (change === "old-stop") receipt.ownedReturn!.openedBy.stopEpoch++;
      }
      return receipt;
    });
    await expect(x.refresh()).rejects.toThrow("健康核验");
    expect(x.plans.map((plan) => plan.target.kind)).toEqual(["listing-detail", "return-to-list"]);
    expect(
      x.store.db
        .prepare("SELECT result,accepted FROM query_health_results WHERE query_id=?")
        .get(x.plans[1].queryId),
    ).toEqual({ result: "unknown", accepted: 0 });
    expect(() => x.writeCheckpoint({ ...checkpoint, keys: ["after"] })).toThrow("健康核验");
    expect(x.store.headCheckpoint()).toEqual(checkpoint);
  },
);

it.each([
  "missing",
  "wrong-action",
  "tab",
  "window",
  "binding",
  "connection",
  "url",
  "target",
  "unposted",
])(
  "a new document with %s navigation authority remains unknown and cannot advance the cursor",
  async (change) => {
    const x = await fixture();
    await x.wrapped.source.prepare();
    const checkpoint = {
      time: "2026-11-15T00:00:00.000Z",
      keys: ["before"],
      order: "selling_time DESC",
    };
    x.writeCheckpoint(checkpoint);
    const get = x.adapter.navigationReceipt.bind(x.adapter);
    vi.spyOn(x.adapter, "navigationReceipt").mockImplementation((queryId, actionId) => {
      const original = get(queryId, actionId);
      if (!original || change === "missing") return undefined;
      const receipt: NativeNavigationReceipt = structuredClone(original);
      if (change === "wrong-action") receipt.plan.actionId = "unowned";
      if (change === "tab") receipt.to.tabId++;
      if (change === "window") receipt.to.windowId++;
      if (change === "binding") receipt.to.bindingEpoch = "unowned";
      if (change === "connection") receipt.to.connectionEpoch = "unowned";
      if (change === "url") receipt.to.url += "&unrequested=1";
      if (change === "target") receipt.plan.target = { kind: "next-page", currentPage: 0 };
      if (change === "unposted") receipt.inputConfirmedAt = receipt.dispatchedAt - 1;
      return receipt;
    });
    await expect(x.refresh()).rejects.toThrow("健康核验");
    const proof = x.wrapped.context()!;
    expect(
      x.store.db
        .prepare("SELECT result,accepted FROM query_health_results WHERE query_id=?")
        .get(proof.queryId),
    ).toEqual({ result: "unknown", accepted: 0 });
    expect(() => x.writeCheckpoint({ ...checkpoint, keys: ["after"] })).toThrow("健康核验");
    expect(() => x.markComplete()).toThrow("健康核验");
    expect(x.store.headCheckpoint()).toEqual(checkpoint);
    expect(x.store.backfillComplete()).toBe(false);
  },
);

it.each(["conditions", "page", "action", "stop", "session", "run", "generation", "commit"])(
  "an otherwise confirmed refresh with changed %s evidence remains unknown",
  async (change) => {
    const x = await fixture();
    x.changeSnapshot((value) => {
      if (change === "conditions") value.queryArgs!.extra = "narrow";
      if (change === "page") {
        value.queryArgs!.page = 2;
        value.listing!.page = 2;
      }
      if (change === "action") value.context.actionId = "old-action";
      if (change === "stop") value.context.stopEpoch++;
      if (change === "session") value.context.browserSessionEpoch = "other-session";
      if (change === "run") value.context.runId = "other-run";
      if (change === "generation") value.context.pageGeneration++;
      if (change === "commit") value.listingCommitted = false;
    });
    await expect(x.refresh()).rejects.toThrow("健康核验");
    expect(
      x.store.db
        .prepare("SELECT result,accepted FROM query_health_results WHERE query_id=?")
        .get(x.plans[0].queryId),
    ).toEqual({ result: "unknown", accepted: 0 });
    expect(() => x.governor.withProgress(x.wrapped.context()!, () => {})).toThrow();
  },
);
