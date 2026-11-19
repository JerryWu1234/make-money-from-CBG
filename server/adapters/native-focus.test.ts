import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ExtensionNativeRuntime } from "./extension-native";

const fixtures: { close(): Promise<void> }[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-18T10:00:00Z"));
});
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  vi.useRealTimers();
});
function fixture() {
  const db = new DatabaseSync(":memory:"),
    writes: Record<string, any>[] = [],
    operations: Promise<unknown>[] = [];
  let epoch = 0,
    sequence = 0;
  const runAction = vi.fn();
  const runtime = new ExtensionNativeRuntime({
    db,
    socketPath: "/private/tmp/focus-not-started.sock",
    stopEpoch: () => epoch,
    accessReady: () => false,
    onRisk: () => {},
    runAction: async (plan, dispatch) => {
      runAction(plan);
      return dispatch();
    },
  });
  const state = runtime as any;
  const socket = {
    destroyed: false,
    write: (line: string) => writes.push(JSON.parse(line)),
    destroy() {
      this.destroyed = true;
    },
  };
  state.socket = socket;
  const binding = {
    pageId: "role-list",
    pageGeneration: 1,
    tabId: 11,
    windowId: 22,
    bindingEpoch: "binding",
    connectionEpoch: "connection",
  };
  const payload = (overrides: Record<string, unknown> = {}) => ({
    pageId: binding.pageId,
    pageGeneration: binding.pageGeneration,
    observedAt: new Date().toISOString(),
    url: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=role",
    title: "离线focus协议",
    revision: `frame-${sequence}`,
    visible: true,
    loading: false,
    access: "normal",
    authenticated: true,
    ...overrides,
  });
  const receive = (kind: string, payload: unknown) =>
    state.receive({
      version: 1,
      connectionEpoch: binding.connectionEpoch,
      messageId: `message-${++sequence}`,
      sequence,
      kind,
      payload,
    });
  const message = (command: string) =>
    writes.filter((row) => row.command === command || row.kind === command).at(-1)!;
  const ack = async (command: string, result: Record<string, unknown> = {}) => {
    const request = message(command);
    expect(request).toBeDefined();
    await state.receive({ kind: "input-result", actionId: request.actionId, ok: true, ...result });
  };
  const frame = (overrides: Record<string, unknown> = {}) =>
    receive("snapshot", payload(overrides));
  const assertNoInput = () => {
    expect(
      writes.some(
        (row) =>
          row.kind === "activity" || row.command === "execute" || row.kind === "command-proof",
      ),
    ).toBe(false);
    expect(runAction).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) n FROM access_bridge_commands").get()!.n).toBe(0);
  };
  const f = {
    runtime,
    state,
    writes,
    binding,
    payload,
    receive,
    frame,
    message,
    ack,
    assertNoInput,
    setEpoch(next: number) {
      epoch = next;
    },
    async bind() {
      await receive("status", { ...binding, bound: true });
      await ack("resume");
      await frame({ visible: false });
      writes.length = 0;
      await vi.advanceTimersByTimeAsync(10);
    },
    focus() {
      const operation = runtime.focusBoundPage();
      operation.catch(() => {});
      operations.push(operation);
      return operation;
    },
    async succeed() {
      const operation = f.focus();
      await ack("focus", { posted: false });
      await frame();
      await ack("observe");
      return operation;
    },
    async close() {
      await runtime.stop("fixture finished");
      await vi.advanceTimersByTimeAsync(10001);
      await Promise.allSettled(operations);
      db.close();
    },
  };
  fixtures.push(f);
  return f;
}

it("focus uses the exact bound identity, waits for a fresh visible authenticated frame and never grants input", async () => {
  const f = fixture();
  await f.bind();
  expect(f.runtime.status().stopped).toBe(true);
  const receipt = await f.succeed();
  expect(f.message("focus")).toMatchObject({
    kind: "command",
    command: "focus",
    context: { ...f.binding, url: f.payload().url },
  });
  expect(f.writes.filter((row) => row.kind === "command").map((row) => row.command)).toEqual([
    "focus",
    "observe",
  ]);
  expect(() => f.runtime.assertFocusedPage(receipt)).not.toThrow();
  expect(f.runtime.status().stopped).toBe(true);
  f.assertNoInput();
});
it("an unbound page cannot request focus", async () => {
  const f = fixture();
  await expect(f.focus()).rejects.toThrow("尚未自动绑定");
  expect(f.writes).toEqual([]);
  f.assertNoInput();
});
it.each([
  { ok: false, posted: false, error: "focus rejected" },
  { ok: true, posted: true },
  { ok: true },
])("a denied or non-read-only focus reply cannot proceed %j", async (result) => {
  const f = fixture();
  await f.bind();
  const operation = f.focus();
  await f.ack("focus", result);
  await expect(operation).rejects.toThrow();
  expect(f.writes.some((row) => row.command === "observe")).toBe(false);
  f.assertNoInput();
});
it("a denied observation cannot validate a focus receipt", async () => {
  const f = fixture();
  await f.bind();
  const operation = f.focus();
  await f.ack("focus", { posted: false });
  await f.ack("observe", { ok: false });
  await expect(operation).rejects.toThrow("无法读取");
  f.assertNoInput();
});
it("host stop immediately cancels focus while waiting for visibility and a late frame cannot revive it", async () => {
  const f = fixture();
  await f.bind();
  const operation = f.focus();
  const rejected = vi.fn();
  void operation.catch(rejected);
  await f.ack("focus", { posted: false });
  await f.ack("observe");
  await vi.advanceTimersByTimeAsync(0);
  expect(rejected).not.toHaveBeenCalled();
  const receipt = { id: f.state.userFocus.id };
  const stoppedAt = Date.now();
  await f.state.receive({ kind: "host-status", stopped: true, reason: "server-stop" });
  await vi.advanceTimersByTimeAsync(0);
  expect(rejected).toHaveBeenCalledOnce();
  await expect(operation).rejects.toThrow("官网聚焦已取消");
  expect(Date.now()).toBe(stoppedAt);
  await f.frame();
  expect(() => f.runtime.assertFocusedPage(receipt)).toThrow("聚焦状态已失效");
  expect(f.runtime.status()).toMatchObject({ stopped: true, reason: "server-stop" });
  expect(f.writes.filter((row) => row.kind === "command").map((row) => row.command)).toEqual([
    "focus",
    "observe",
  ]);
  f.assertNoInput();
});
it("host stop invalidates a returned focus receipt before manual recovery can issue commands", async () => {
  const f = fixture();
  await f.bind();
  const receipt = await f.succeed();
  expect(() => f.runtime.assertFocusedPage(receipt)).not.toThrow();
  await f.state.receive({ kind: "host-status", stopped: true, reason: "server-stop" });
  const writeCount = f.writes.length;
  await expect(f.runtime.prepareManualRecovery(receipt)).rejects.toThrow("聚焦状态已失效");
  expect(() => f.runtime.assertFocusedPage(receipt)).toThrow("聚焦状态已失效");
  expect(f.writes).toHaveLength(writeCount);
  expect(f.runtime.status()).toMatchObject({ stopped: true, reason: "server-stop" });
  f.assertNoInput();
});
it("host stop during recovery status inspection prevents a late real status ACK from resuming input", async () => {
  const f = fixture();
  await f.bind();
  const receipt = await f.succeed();
  const operation = f.runtime.prepareManualRecovery(receipt);
  const rejected = vi.fn();
  void operation.catch(rejected);
  await vi.advanceTimersByTimeAsync(0);
  const statusRequest = f.message("status");
  expect(statusRequest).toMatchObject({ kind: "command", command: "status" });
  const recovery = f.state.recovery;
  const ticket = structuredClone(recovery.ticket);
  expect(recovery.focusId).toBe(receipt.id);
  expect(recovery.controller.signal.aborted).toBe(false);
  await f.state.receive({ kind: "host-status", stopped: true, reason: "server-stop" });
  expect(recovery.controller.signal.aborted).toBe(true);
  expect(f.state.pending.has(statusRequest.actionId)).toBe(true);
  await f.ack("status", {
    permissions: {
      accessibility: true,
      inputMonitoring: true,
      inputMonitorActive: true,
      locked: false,
      frontmostChrome: true,
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(rejected).toHaveBeenCalledOnce();
  await expect(operation).rejects.toThrow("官网聚焦已取消");
  expect(f.state.pending.has(statusRequest.actionId)).toBe(false);
  expect(f.writes.some((row) => row.kind === "resume")).toBe(false);
  expect(() => f.runtime.completeManualRecovery(ticket)).toThrow("恢复票据已失效");
  expect(f.runtime.status().stopped).toBe(true);
  expect(f.state.recovery).toBeUndefined();
  f.assertNoInput();
});
it.each([
  { visible: false },
  { loading: true },
  { authenticated: false },
  { authenticated: undefined },
  { access: "unknown" },
  { observedAt: "2026-11-18T10:00:00.009Z" },
  { pageGeneration: 2 },
])(
  "focus cannot complete on a hidden/loading/unverified/stale/different-generation snapshot %j",
  async (overrides) => {
    const f = fixture();
    await f.bind();
    const operation = f.focus();
    await f.ack("focus", { posted: false });
    await f.frame(overrides);
    await f.ack("observe");
    await vi.advanceTimersByTimeAsync(5001);
    await expect(operation).rejects.toThrow();
    f.assertNoInput();
  },
);
it.each(["binding", "epoch", "socket", "stop"])(
  "%s changes during focus invalidate the operation without input",
  async (change) => {
    const f = fixture();
    await f.bind();
    const operation = f.focus();
    if (change === "binding")
      await f.receive("status", { ...f.binding, bound: true, bindingEpoch: "new-binding" });
    if (change === "epoch") f.setEpoch(1);
    if (change === "socket") f.state.socket = { ...f.state.socket };
    if (change === "stop") await f.runtime.stop("explicit cancellation");
    await f.ack("focus", { posted: false });
    await expect(operation).rejects.toThrow();
    expect(f.writes.some((row) => row.command === "observe")).toBe(false);
    f.assertNoInput();
  },
);
it.each(["binding", "url", "stop", "expiry"])(
  "a completed focus receipt cannot be reused after %s",
  async (change) => {
    const f = fixture();
    await f.bind();
    const receipt = await f.succeed();
    if (change === "binding")
      await f.receive("status", { ...f.binding, bound: true, bindingEpoch: "new-binding" });
    if (change === "url")
      await f.frame({ url: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=other" });
    if (change === "stop") await f.runtime.stop("explicit cancellation");
    if (change === "expiry") await vi.advanceTimersByTimeAsync(5001);
    expect(() => f.runtime.assertFocusedPage(receipt)).toThrow("聚焦状态已失效");
    f.assertNoInput();
  },
);
