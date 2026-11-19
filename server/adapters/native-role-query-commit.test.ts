import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ExtensionNativeRuntime } from "./extension-native";
import type { ActionPlan, SemanticTarget } from "./contracts";
import type { RoleDiagnosticField } from "../query-health/role-list-diagnostics";

const fixtures: { close(): Promise<void> }[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  vi.useRealTimers();
});

function fixture() {
  const db = new DatabaseSync(":memory:"),
    writes: any[] = [],
    operations: Promise<unknown>[] = [];
  let sequence = 0;
  let dispatchGate: Promise<void> | undefined;
  const runtime = new ExtensionNativeRuntime({
    db,
    socketPath: "/private/tmp/not-started-role-query-commit.sock",
    stopEpoch: () => 0,
    onRisk: () => {},
    runAction: async (_plan, dispatch) => {
      await dispatchGate;
      return dispatch();
    },
  });
  const internals = runtime as any;
  internals.socket = {
    destroyed: false,
    destroy: () => {},
    write: (line: string) => {
      const message = JSON.parse(line);
      writes.push(message);
      if (message.kind === "activity")
        queueMicrotask(() =>
          internals.receive({
            kind: "input-result",
            actionId: message.actionId,
            activityId: message.activity.activityId,
            ok: true,
            active: message.command !== "end",
          }),
        );
      else if (message.kind === "resume" || message.command === "locate")
        queueMicrotask(() =>
          internals.receive({
            kind: "input-result",
            actionId: message.actionId || message.plan?.actionId,
            ok: true,
            location: { needsScroll: false },
          }),
        );
      else if (message.command === "execute")
        queueMicrotask(() =>
          internals.receive({
            kind: "input-result",
            actionId: message.plan.actionId,
            ok: true,
            posted: true,
          }),
        );
    },
  };
  const state: Record<string, any> = {
    pageId: "role-list",
    pageGeneration: 1,
    observedAt: new Date().toISOString(),
    url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
    title: "role query fixture",
    revision: "before",
    visible: true,
    loading: false,
    access: "normal",
    empty: true,
    listing: { page: 1, totalPages: 2, order: "selling_time DESC", serverType: "1,2,3", items: [] },
    listingCommitted: true,
    queryArgs: { page: 1, order_by: "selling_time DESC", server_type: "1,2,3", price_min: "100" },
    roleQueryControls: { price_min: { value: "120", min: "", max: "", step: "any" } },
    business: [],
  };
  const receive = (kind: string, payload: unknown) =>
    internals.receive({
      version: 1,
      connectionEpoch: "role-query-connection",
      messageId: `message-${++sequence}`,
      sequence,
      kind,
      payload,
    });
  const plan = () =>
    writes.filter((message) => message.command === "execute").at(-1)?.plan as ActionPlan;
  const frame = async (overrides: Record<string, unknown> = {}) => {
    Object.assign(state, overrides);
    await receive("snapshot", {
      ...structuredClone(state),
      observedAt: new Date().toISOString(),
      actionContext: plan(),
      listingCommit: plan() ? { actionId: plan().actionId, sequence } : null,
      ...overrides,
    });
  };
  const f = {
    db,
    runtime,
    writes,
    state,
    frame,
    plan,
    bind: async () => {
      await receive("status", { bound: true, pageId: state.pageId, pageGeneration: 1 });
      await frame();
    },
    start: (target: SemanticTarget = { kind: "query" }, page = 1) => {
      const operation = runtime.query(target, { kind: "page", page });
      operations.push(operation);
      return operation;
    },
    gate: (promise: Promise<void>) => {
      dispatchGate = promise;
    },
    completed: () =>
      db.prepare("SELECT count(*) n FROM access_bridge_commands WHERE state='completed'").get()!.n,
    close: async () => {
      await runtime.stop("test finished");
      await Promise.allSettled(operations);
      db.close();
    },
  };
  fixtures.push(f);
  return f;
}

it("keeps a same-action DOM commit with old MAIN arguments pending until the consistent snapshot", async () => {
  const f = fixture();
  await f.bind();
  let settled = false;
  const query = f.start().then((snapshot) => {
    settled = true;
    return snapshot;
  });
  await vi.advanceTimersByTimeAsync(1);
  await f.frame({ revision: "rev7" }); // controls=120, QueryArgs=100, current action committed.
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBe(false);
  expect(f.completed()).toBe(0);
  await f.frame({ revision: "rev8", queryArgs: { ...f.state.queryArgs, price_min: "120" } });
  expect((await query).revision).toBe("rev8");
  expect(f.completed()).toBe(1);
  expect(f.writes.filter((message) => message.command === "execute")).toHaveLength(1);
});

it.each(["", "0", "100.50"])(
  "accepts a legal submitted value %j without conflating zero and empty",
  async (value) => {
    const f = fixture();
    f.state.roleQueryControls.price_min.value = value;
    await f.bind();
    const query = f.start();
    await vi.advanceTimersByTimeAsync(1);
    const queryArgs = { ...f.state.queryArgs };
    if (value === "") delete queryArgs.price_min;
    else queryArgs.price_min = Number(value);
    await f.frame({ revision: "matching", queryArgs });
    expect((await query).revision).toBe("matching");
    expect(f.completed()).toBe(1);
  },
);

it.each([
  ["", 0],
  ["0", ""],
  ["120", undefined],
  ["120", null],
  ["120", true],
  ["120", "120x"],
  ["120", "-120"],
])(
  "does not complete submitted %j from missing or invalid MAIN value %j",
  async (submitted, actual) => {
    const f = fixture();
    f.state.roleQueryControls.price_min.value = submitted;
    await f.bind();
    const query = f.start();
    const rejected = expect(query).rejects.toThrow("未自动重放");
    await vi.advanceTimersByTimeAsync(1);
    const queryArgs = { ...f.state.queryArgs, price_min: actual };
    if (actual === undefined) delete queryArgs.price_min;
    await f.frame({ revision: "mismatch", queryArgs });
    await vi.advanceTimersByTimeAsync(12_001);
    await rejected;
    expect(f.completed()).toBe(0);
    expect(f.writes.filter((message) => message.command === "execute")).toHaveLength(1);
  },
);

it.each(["missing", "changed", "invalid", "wrong-action"])(
  "rejects a %s completion control or action",
  async (kind) => {
    const f = fixture();
    await f.bind();
    let settled = false;
    const query = f.start().then((snapshot) => {
      settled = true;
      return snapshot;
    });
    await vi.advanceTimersByTimeAsync(1);
    const controls =
      kind === "missing" ? {} : { price_min: { value: kind === "changed" ? "200" : "invalid" } };
    await f.frame({
      revision: "bad-control",
      queryArgs: { ...f.state.queryArgs, price_min: kind === "changed" ? "200" : "120" },
      ...(kind === "wrong-action"
        ? { actionContext: { ...f.plan(), actionId: "old" } }
        : { roleQueryControls: controls }),
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(f.completed()).toBe(0);
    await f.frame({
      revision: "valid",
      roleQueryControls: { price_min: { value: "120" } },
      queryArgs: { ...f.state.queryArgs, price_min: "120" },
    });
    expect((await query).revision).toBe("valid");
  },
);

it("captures controls at actual dispatch after governor queuing", async () => {
  const f = fixture();
  let release!: () => void;
  f.gate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  await f.bind();
  const query = f.start();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.writes.some((message) => message.command === "execute")).toBe(false);
  await f.frame({ revision: "queued-change", roleQueryControls: { price_min: { value: "130" } } });
  release();
  await vi.advanceTimersByTimeAsync(1);
  await f.frame({
    revision: "submitted-130",
    queryArgs: { ...f.state.queryArgs, price_min: "130" },
  });
  expect((await query).revision).toBe("submitted-130");
});

it.each(["price_min", "price_max", "level_min", "level_max"] as RoleDiagnosticField[])(
  "validates the actually observed %s field before input",
  async (field) => {
    const f = fixture();
    f.state.roleQueryControls = { [field]: { value: "not-a-number" } };
    await f.bind();
    await expect(f.start()).rejects.toThrow("实际值未核验");
    expect(f.writes.some((message) => message.command === "execute")).toBe(false);
  },
);

it.each(["serverid", "server_type"] as const)(
  "waits for the submitted visible %s dimension in both worlds",
  async (field) => {
    const f = fixture();
    const submitted = field === "serverid" ? "367" : "3,1,2";
    f.state.roleQueryDimensions = { [field]: submitted };
    await f.bind();
    let settled = false;
    const query = f.start().then((snapshot) => {
      settled = true;
      return snapshot;
    });
    await vi.advanceTimersByTimeAsync(1);
    await f.frame({
      revision: "dimension-mixed",
      queryArgs: {
        ...f.state.queryArgs,
        price_min: "120",
        [field]: field === "serverid" ? "299" : "1,2",
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(f.completed()).toBe(0);
    await f.frame({
      revision: "dimension-match",
      queryArgs: { ...f.state.queryArgs, [field]: field === "serverid" ? 367 : "1,2,3" },
    });
    expect((await query).revision).toBe("dimension-match");
  },
);

it.each([
  ["serverid", "0", ""],
  ["serverid", "", 0],
  ["serverid", "367", undefined],
  ["server_type", "1,2,3", undefined],
  ["server_type", "1,2,3", "1,1,2,3"],
  ["server_type", "1,2,3", "1,2,4"],
] as const)("rejects submitted dimension %s=%j from %j", async (field, submitted, actual) => {
  const f = fixture();
  f.state.roleQueryDimensions = { [field]: submitted };
  await f.bind();
  const query = f.start();
  const rejected = expect(query).rejects.toThrow("未自动重放");
  await vi.advanceTimersByTimeAsync(1);
  const queryArgs = { ...f.state.queryArgs, price_min: "120", [field]: actual };
  if (actual === undefined) delete queryArgs[field];
  await f.frame({ revision: "bad-dimension", queryArgs });
  await vi.advanceTimersByTimeAsync(12_001);
  await rejected;
  expect(f.completed()).toBe(0);
});

it.each(["serverid", "server_type"] as const)(
  "does not infer an unobserved %s control from prior QueryArgs",
  async (field) => {
    const f = fixture();
    f.state.queryArgs[field] = field === "serverid" ? "367" : "1,2,3";
    await f.bind();
    const query = f.start();
    await vi.advanceTimersByTimeAsync(1);
    await f.frame({
      revision: "no-dimension-control",
      queryArgs: { ...f.state.queryArgs, price_min: "120" },
    });
    expect((await query).revision).toBe("no-dimension-control");
  },
);

it("matches an explicitly empty server control with an omitted argument, without inventing zero", async () => {
  const f = fixture();
  f.state.roleQueryDimensions = { serverid: "" };
  await f.bind();
  const query = f.start();
  await vi.advanceTimersByTimeAsync(1);
  await f.frame({
    revision: "all-servers",
    queryArgs: { ...f.state.queryArgs, price_min: "120" },
  });
  expect((await query).revision).toBe("all-servers");
});

it.each(["serverid", "server_type"] as const)(
  "waits when a submitted %s control disappears from the completion snapshot",
  async (field) => {
    const f = fixture();
    const value = field === "serverid" ? "367" : "1,2,3";
    f.state.roleQueryDimensions = { [field]: value };
    await f.bind();
    let settled = false;
    const query = f.start().then((snapshot) => {
      settled = true;
      return snapshot;
    });
    await vi.advanceTimersByTimeAsync(1);
    await f.frame({
      revision: "missing-ui",
      roleQueryDimensions: {},
      queryArgs: { ...f.state.queryArgs, price_min: "120", [field]: value },
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(false);
    expect(f.completed()).toBe(0);
    await f.frame({ revision: "restored-ui", roleQueryDimensions: { [field]: value } });
    expect((await query).revision).toBe("restored-ui");
  },
);

it.each(["serverid", "server_type"] as const)(
  "rejects an unsupported submitted %s before input",
  async (field) => {
    const f = fixture();
    f.state.roleQueryDimensions = { [field]: "unsupported" };
    await f.bind();
    await expect(f.start()).rejects.toThrow("实际值未核验");
    expect(f.writes.some((message) => message.command === "execute")).toBe(false);
  },
);

it("leaves sorting based on the committed query when an unsubmitted form is dirty", async () => {
  const f = fixture();
  await f.bind();
  const query = f.start({ kind: "sort", value: "expire_time DESC" });
  await vi.advanceTimersByTimeAsync(1);
  await f.frame({ revision: "sorted", listing: { ...f.state.listing, order: "expire_time DESC" } });
  expect((await query).queryArgs?.price_min).toBe("100");
  expect(f.completed()).toBe(1);
});
