import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { AccessGovernor } from "../access";
import { CrawlStore } from "../crawler/store";
import { ExtensionNativeRuntime } from "./extension-native";
import { bindNativeCrawlSource } from "./native-query-health";
import { nativeWorkflowScope, withNativeWorkflow } from "./native-workflow";
import type { ActionPlan } from "./contracts";

type Message = Record<string, any>;
type Trace = { channel: "service" | "helper" | "extension"; message: Message };
const stores: CrawlStore[] = [];
const adapters: ExtensionNativeRuntime[] = [];
afterEach(async () => {
  for (const adapter of adapters.splice(0)) await adapter.stop("isolated test finished");
  for (const store of stores.splice(0)) store.close();
  vi.useRealTimers();
});
const drain = async () => {
  for (let index = 0; index < 150; index++) await Promise.resolve();
};

/** Real governor/query/execute and the actual host authority modules; no Chrome, helper or OS input. */
async function fixture(holdRotation = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
  const store = new CrawlStore(":memory:");
  stores.push(store);
  expect(store.acquire("diagnostic-crawl")).toBe(true);
  const crawlLease = store.crawlLease("diagnostic-crawl");
  const governor = new AccessGovernor(store.db);
  const state = governor.read();
  governor.updatePolicy(
    {
      ...state.policy,
      version: state.policy.version + 1,
      minIntervalMs: 0,
      maxActionsPerWindow: 1000,
      canaryEnabled: true,
    },
    state.revision,
  );
  const owner = governor.acquireOwner("diagnostic-review");
  const trace: Trace[] = [];
  let adapter!: ExtensionNativeRuntime;
  let internals: any;
  let receiveSequence = 0;
  let revision = 0;
  let emptyNarrow = false;
  let unknownInput = false;
  let helperResume: Message | undefined;
  let extensionResume: Message | undefined;
  let assertion: Message | undefined;
  let holdFreshSnapshot = false;
  let freshBinding: Message | undefined;
  let holdOldEnd = false;
  let oldEnd: Message | undefined;
  const controls: Record<string, string> = {
    price_min: "",
    price_max: "",
    level_min: "",
    level_max: "",
  };
  let args: Record<string, string | number> = {
    server_type: "1,2,3",
    page: 1,
    order_by: "selling_time DESC",
  };
  const receive = (kind: string, payload: unknown) =>
    internals.receive({
      version: 1,
      connectionEpoch: "diagnostic-connection",
      messageId: `diagnostic-${++receiveSequence}`,
      sequence: receiveSequence,
      kind,
      payload,
    });
  const snapshot = (plan?: ActionPlan, bindingContext?: Message) => {
    const empty = emptyNarrow && !!args.price_min;
    return {
      pageId: "diagnostic-page",
      pageGeneration: 1,
      observedAt: new Date().toISOString(),
      url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
      title: "isolated role diagnostic",
      revision: `revision-${++revision}`,
      visible: true,
      loading: false,
      authenticated: true,
      access: "normal",
      empty,
      queryArgs: { ...args },
      formValues: { ...controls },
      roleQueryControls: Object.fromEntries(
        Object.entries(controls).map(([key, value]) => [
          key,
          { value, min: "0", step: key.startsWith("price_") ? "0.01" : "1" },
        ]),
      ),
      listingCommitted: true,
      ...(plan
        ? { actionContext: plan, listingCommit: { actionId: plan.actionId, sequence: revision } }
        : {}),
      ...(bindingContext ? { bindingContext } : {}),
      listing: {
        page: Number(args.page),
        totalPages: 2,
        order: args.order_by,
        serverType: "1,2,3",
        items: empty
          ? []
          : [{ href: "/equip?s=1&eid=diagnostic-role", attrs: { data_price: "100" }, summary: {} }],
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
  };
  const helper = Object.assign(new EventEmitter(), {
    stdin: {
      write: (line: string) => {
        const message: Message = JSON.parse(line);
        trace.push({ channel: "helper", message });
        if (holdRotation && message.command === "resume" && message.stopEpoch > 0)
          helperResume = message;
        else if (
          holdOldEnd &&
          message.command === "activity-end" &&
          message.activity.stopEpoch === 0
        ) {
          oldEnd = message;
          holdOldEnd = false;
        } else if (
          holdRotation &&
          message.command === "activity-begin" &&
          message.activity.stopEpoch > 0
        )
          assertion = message;
        else queueMicrotask(() => acknowledgeHelper(message));
      },
    },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => {},
  });
  const hostSocket = Object.assign(new EventEmitter(), {
    write: (line: string) => {
      const message = JSON.parse(line);
      if (["input-result", "host-status"].includes(message.kind))
        queueMicrotask(() => void internals.receive(message));
    },
    destroy: () => {},
  });
  const chromeInput = new EventEmitter();
  const helperResult = (value: Message) =>
    helper.stdout.emit("data", Buffer.from(JSON.stringify(value) + "\n"));
  const chromeResult = (value: Message) => {
    const body = Buffer.from(JSON.stringify(value)),
      header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    chromeInput.emit("data", Buffer.concat([header, body]));
  };
  const acknowledgeHelper = (message: Message) => {
    if (message.command.startsWith("activity-"))
      helperResult({
        ok: true,
        actionId: message.actionId,
        activityId: message.activity.activityId,
        awake: message.command !== "activity-end",
      });
    else if (message.command === "resume" || message.command === "status")
      helperResult({ ok: true, actionId: message.actionId });
    else if (message.command === "execute") {
      const plan = message.plan as ActionPlan;
      helperResult({ ok: true, actionId: plan.actionId, posted: true });
      if (unknownInput) return;
      if (plan.target.kind === "query-field") controls[plan.target.field] = plan.target.value;
      else if (plan.target.kind === "query") {
        args = { server_type: "1,2,3", page: 1, order_by: "selling_time DESC" };
        for (const [key, value] of Object.entries(controls)) if (value) args[key] = value;
      } else if (plan.target.kind === "sort") {
        args.order_by = plan.target.value;
        args.page = 1;
      } else if (plan.target.kind === "jump-page") args.page = plan.target.page;
      queueMicrotask(() => void receive("snapshot", snapshot(plan)));
    }
  };
  const acknowledgeExtension = (message: Message) => {
    if (message.command === "resume") {
      chromeResult({ kind: "command-result", actionId: message.actionId, ok: true, posted: false });
      if (holdFreshSnapshot && message.context.stopEpoch > 0) freshBinding = message.context;
      else queueMicrotask(() => void receive("snapshot", snapshot(undefined, message.context)));
    } else if (message.command === "locate")
      chromeResult({
        kind: "command-result",
        actionId: message.plan.actionId,
        ok: true,
        posted: false,
        location: { needsScroll: false },
      });
    else if (message.command === "execute")
      chromeResult({
        kind: "command-proof",
        actionId: message.plan.actionId,
        proof: {
          actionId: message.plan.actionId,
          pageId: message.plan.pageId,
          pageGeneration: message.plan.pageGeneration,
          semantic: message.plan.target,
        },
      });
  };
  const directory = new URL("../../native/cbg-access/", import.meta.url);
  const vmSource = [
    readFileSync(new URL("command-authority.mjs", directory), "utf8").replaceAll(
      "export class ",
      "class ",
    ),
    readFileSync(new URL("activity-authority.mjs", directory), "utf8")
      .replaceAll("export class ", "class ")
      .replaceAll("export const ", "const "),
    readFileSync(new URL("host.mjs", directory), "utf8")
      .replace(/^#!.*\n/, "")
      .replace(/^import .*?;\n/gm, "")
      .replaceAll("import.meta.url", JSON.stringify(new URL("host.mjs", directory).href)),
    "globalThis.hostAuthority={authority,activities};",
  ].join("\n");
  const world: Message = {
    Buffer,
    path,
    fileURLToPath,
    randomUUID,
    Date,
    fs: {
      statSync: () => ({ mode: 0o600, uid: 501 }),
      readFileSync: () =>
        JSON.stringify({
          extensionId: "a".repeat(32),
          socketPath: "/private/tmp/unstarted-diagnostic-host.sock",
        }),
    },
    os: { homedir: () => "/private/tmp/isolated-diagnostic-host" },
    net: { connect: () => hostSocket },
    spawn: () => helper,
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    process: {
      argv: ["node", "host", `chrome-extension://${"a".repeat(32)}/`],
      getuid: () => 501,
      stdin: chromeInput,
      stdout: {
        write: (buffer: Buffer) => {
          const message: Message = JSON.parse(buffer.subarray(4).toString());
          trace.push({ channel: "extension", message });
          if (holdRotation && message.command === "resume" && message.context.stopEpoch > 0)
            extensionResume = message;
          else queueMicrotask(() => acknowledgeExtension(message));
        },
      },
      stderr: { write: () => {} },
      on: () => {},
      exit: () => {},
    },
  };
  runInNewContext(vmSource, world);
  helperResult({ kind: "input-ready", version: 1 });
  adapter = new ExtensionNativeRuntime({
    db: store.db,
    socketPath: `/private/tmp/unstarted-native-diagnostic-${randomUUID()}.sock`,
    stopEpoch: () => governor.read().stopEpoch,
    accessReady: () => governor.read().state === "ready",
    onRisk: (reason, evidence) => {
      governor.reportRisk({ reason, evidence });
    },
    runAction: (plan, dispatch, signal) => {
      const scoped = nativeWorkflowScope()?.context(plan);
      const context = {
        ...owner,
        ...scoped,
        ...plan,
        sourceKind: scoped?.sourceKind || "extension-native",
        crawlLease,
      };
      governor.registerPage(context);
      return governor.runAction(context, dispatch, signal);
    },
  });
  adapters.push(adapter);
  internals = adapter as any;
  internals.socket = {
    destroyed: false,
    write: (line: string) => {
      const message = JSON.parse(line);
      trace.push({ channel: "service", message });
      hostSocket.emit("data", Buffer.from(line));
    },
  };
  await receive("status", {
    bound: true,
    pageId: "diagnostic-page",
    pageGeneration: 1,
    tabId: 7,
    windowId: 9,
    bindingEpoch: "diagnostic-binding",
  });
  await drain();
  await receive("snapshot", snapshot());
  const initial = await adapter.snapshot();
  const wrapped = bindNativeCrawlSource(
    adapter,
    governor,
    owner,
    new AbortController().signal,
    crawlLease,
    initial,
  );
  await wrapped.source.prepare();
  args.price_min = "100.50";
  controls.price_min = "100.50";
  await receive("snapshot", snapshot());
  await wrapped.source.prepare();
  emptyNarrow = true;
  await receive("snapshot", snapshot());
  const helperInputs = () =>
    trace.filter(({ channel, message }) => channel === "helper" && message.command === "execute");
  return {
    adapter,
    internals,
    governor,
    store,
    wrapped,
    trace,
    host: world.hostAuthority,
    helperInputs,
    start: () => wrapped.source.prepare(),
    drain,
    helperResume: () => helperResume,
    extensionResume: () => extensionResume,
    assertion: () => assertion,
    ackHelperResume: () => {
      expect(helperResume).toBeDefined();
      acknowledgeHelper(helperResume!);
      helperResume = undefined;
    },
    ackExtensionResume: () => {
      expect(extensionResume).toBeDefined();
      acknowledgeExtension(extensionResume!);
      extensionResume = undefined;
    },
    ackAssertion: () => {
      expect(assertion).toBeDefined();
      acknowledgeHelper(assertion!);
      assertion = undefined;
      holdRotation = false;
    },
    denyAssertion: () => {
      expect(assertion).toBeDefined();
      helperResult({
        ok: false,
        actionId: assertion!.actionId,
        activityId: assertion!.activity.activityId,
        awake: false,
        error: "isolated-assertion-denied",
      });
      assertion = undefined;
    },
    deferOldEnd: () => {
      holdOldEnd = true;
    },
    oldEnd: () => oldEnd,
    ackOldEnd: () => {
      expect(oldEnd).toBeDefined();
      acknowledgeHelper(oldEnd!);
      oldEnd = undefined;
    },
    deferFreshSnapshot: () => {
      holdFreshSnapshot = true;
    },
    deliverFreshSnapshot: async () => {
      expect(freshBinding).toBeDefined();
      const binding = freshBinding;
      freshBinding = undefined;
      holdFreshSnapshot = false;
      await receive("snapshot", snapshot(undefined, binding));
    },
    unknown: () => {
      unknownInput = true;
    },
  };
}

it("native anomaly waits for old end, both new-epoch resume ACKs and the new assertion before query/execute; Canary stays manual", async () => {
  const f = await fixture(true);
  f.deferOldEnd();
  const operation = f.start();
  const rejected = expect(operation).rejects.toThrow("健康核验");
  await drain();
  expect(f.oldEnd()).toBeDefined();
  expect(f.governor.read().state).toBe("ready");
  expect(f.governor.read().stopEpoch).toBe(0);
  expect(f.helperResume()).toBeUndefined();
  expect(f.helperInputs()).toHaveLength(0);
  f.ackOldEnd();
  await drain();
  expect(f.governor.read().state).toBe("suspect");
  expect(f.helperResume()?.stopEpoch).toBe(1);
  expect(f.extensionResume()?.context.stopEpoch).toBe(1);
  expect(f.host.activities.current).toBeNull();
  expect(f.helperInputs()).toHaveLength(0);
  f.ackHelperResume();
  await drain();
  expect(f.assertion()).toBeUndefined();
  expect(f.helperInputs()).toHaveLength(0);
  f.ackExtensionResume();
  await drain();
  expect(f.assertion()?.activity.stopEpoch).toBe(1);
  expect(f.helperInputs()).toHaveLength(0);
  f.ackAssertion();
  await rejected;
  const inputs = f.helperInputs().map(({ message }) => message.plan as ActionPlan);
  expect(inputs.length).toBeGreaterThan(0);
  expect(inputs.every((plan) => plan.stopEpoch === 1 && plan.activity?.stopEpoch === 1)).toBe(true);
  expect(new Set(inputs.map((plan) => plan.actionId)).size).toBe(inputs.length);
  const stages = f.trace
    .filter(({ channel }) => channel === "helper")
    .map(({ message }) => message.command);
  const rotation = stages.indexOf("resume", stages.indexOf("activity-end") + 1);
  expect(stages.slice(rotation - 1, rotation + 2)).toEqual([
    "activity-end",
    "resume",
    "activity-begin",
  ]);
  expect(f.governor.read().state).toBe("needs_action");
  expect(f.host.activities.current).toBeNull();
  expect(
    f.store.db
      .prepare(
        "SELECT COUNT(*) AS n FROM query_health_results WHERE purpose!='ordinary' AND accepted=1",
      )
      .get()?.n,
  ).toBe(0);
  expect(
    f.store.db
      .prepare(
        "SELECT purpose,result FROM query_health_results WHERE purpose!='ordinary' ORDER BY rowid",
      )
      .all(),
  ).toEqual([
    { purpose: "target_review", result: "empty" },
    { purpose: "canary", result: "data" },
    { purpose: "restoration", result: "empty" },
  ]);
  expect(() => f.governor.withProgress(f.wrapped.context()!, () => {})).toThrow();
});

it("manual stop while the new epoch is awaiting ACK cannot authorize or replay input", async () => {
  const f = await fixture(true);
  const operation = f.start();
  const rejected = expect(operation).rejects.toThrow();
  await drain();
  expect(f.helperResume()).toBeDefined();
  f.governor.reportRisk({ reason: "manual_stop", state: "needs_action" });
  await f.adapter.stop("external manual stop");
  f.ackHelperResume();
  f.ackExtensionResume();
  await drain();
  await rejected;
  expect(f.helperInputs()).toHaveLength(0);
  expect(f.assertion()).toBeUndefined();
  expect(f.host.activities.current).toBeNull();
  expect(f.host.authority.stopped).toBe(true);
  expect(f.governor.read().state).toBe("needs_action");
  expect(f.governor.read().stopEpoch).toBeGreaterThanOrEqual(2);
  expect(f.governor.read().reasons.some((reason) => reason.code === "manual_stop")).toBe(true);
  expect(f.governor.read().queryDiagnostic).toBeUndefined();
});

it("an ordinary query cannot use a diagnostic epoch rotation", async () => {
  const f = await fixture();
  let context = f.wrapped.context()!;
  const baselineResumes = f.trace.filter(
    ({ channel, message }) => channel === "service" && message.kind === "resume",
  ).length;
  await expect(
    withNativeWorkflow(
      new AbortController().signal,
      async () => {
        const risk = f.governor.reportRisk({ reason: "query_suspect", state: "suspect", context });
        context = {
          ...context,
          queryId: "ordinary-after-risk",
          stopEpoch: risk.stopEpoch,
          purpose: "ordinary",
        };
        f.governor.registerQuery(context, { accepted: false });
        f.adapter.beginQuery(context.runId, context.queryId);
        await f.adapter.query({ kind: "query" }, { kind: "page", page: 1 });
      },
      { activity: f.adapter.activity, context: () => context },
    ),
  ).rejects.toThrow();
  expect(
    f.trace.filter(({ channel, message }) => channel === "service" && message.kind === "resume"),
  ).toHaveLength(baselineResumes);
  expect(f.helperInputs()).toHaveLength(0);
});

it("an unconfirmed posted diagnostic input is not replayed or continued into Canary", async () => {
  const f = await fixture();
  f.unknown();
  const operation = f.start();
  const rejected = expect(operation).rejects.toThrow();
  await drain();
  expect(f.helperInputs()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(12001);
  await rejected;
  await vi.advanceTimersByTimeAsync(30000);
  expect(f.helperInputs()).toHaveLength(1);
  expect(f.adapter.status().unknownActions).toBe(1);
  expect(f.governor.read().state).toBe("needs_action");
  expect(f.host.activities.current).toBeNull();
  expect(
    f.store.db
      .prepare("SELECT COUNT(*) AS n FROM query_health_results WHERE purpose='canary'")
      .get()?.n,
  ).toBe(0);
});

it("a denied new-epoch assertion never posts diagnostic input and archives a manual outcome", async () => {
  const f = await fixture(true);
  const operation = f.start();
  const rejected = expect(operation).rejects.toThrow();
  await drain();
  f.ackExtensionResume();
  f.ackHelperResume();
  await drain();
  expect(f.assertion()).toBeDefined();
  f.denyAssertion();
  await rejected;
  expect(f.helperInputs()).toHaveLength(0);
  expect(f.host.activities.current).toBeNull();
  expect(f.governor.read().state).toBe("needs_action");
  expect(f.governor.read().queryDiagnostic).toBeUndefined();
  expect(
    JSON.parse(
      String(
        f.store.db.prepare("SELECT outcome_json FROM query_diagnostic_events").get()?.outcome_json,
      ),
    ).code,
  ).toBe("diagnostic_failed");
  expect(f.adapter.status().unknownActions).toBe(0);
});

it("a late diagnostic suspension from a completed workflow cannot end the next workflow", async () => {
  const f = await fixture();
  let releaseLate!: () => void;
  const triggerLate = new Promise<void>((resolve) => {
    releaseLate = resolve;
  });
  let late!: Promise<void>;
  const scope = { activity: f.adapter.activity, context: f.wrapped.context };
  await withNativeWorkflow(
    new AbortController().signal,
    async () => {
      late = triggerLate.then(() => f.adapter.suspendDiagnosticActivity());
    },
    scope,
  );
  let nextReady!: () => void, releaseNext!: () => void;
  const ready = new Promise<void>((resolve) => {
    nextReady = resolve;
  });
  const nextHold = new Promise<void>((resolve) => {
    releaseNext = resolve;
  });
  const next = withNativeWorkflow(
    new AbortController().signal,
    async () => {
      nextReady();
      await nextHold;
    },
    scope,
  );
  await ready;
  const lease = { ...f.internals.workflowActivity.lease };
  const rejected = expect(late).rejects.toThrow();
  releaseLate();
  try {
    await rejected;
    expect(f.host.activities.accepts(lease, f.host.authority)).toBe(true);
    expect(f.internals.workflowActivity.suspended).not.toBe(true);
  } finally {
    releaseNext();
    await next;
  }
});

it("a diagnostic rotation holds its new awake assertion and heartbeat while fresh binding evidence is delayed", async () => {
  const f = await fixture(true);
  f.deferFreshSnapshot();
  const operation = f.start();
  const rejected = expect(operation).rejects.toThrow("健康核验");
  await drain();
  f.ackHelperResume();
  f.ackExtensionResume();
  await drain();
  expect(f.assertion()?.activity.stopEpoch).toBe(1);
  f.ackAssertion();
  await drain();
  expect(f.host.activities.current?.granted).toBe(true);
  expect(f.helperInputs()).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.host.activities.current?.granted).toBe(true);
  expect(
    f.trace.some(
      ({ channel, message }) =>
        channel === "helper" &&
        message.command === "activity-renew" &&
        message.activity.stopEpoch === 1,
    ),
  ).toBe(true);
  expect(f.helperInputs()).toHaveLength(0);
  await f.deliverFreshSnapshot();
  await rejected;
  expect(f.governor.read().state).toBe("needs_action");
  expect(f.host.activities.current).toBeNull();
});
