import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ExtensionNativeRuntime } from "./extension-native";

function fixture(stale: boolean, deny = false) {
  const db = new DatabaseSync(":memory:"),
    writes: any[] = [];
  const runtime = new ExtensionNativeRuntime({
    db,
    socketPath: "/private/tmp/not-started-observer.sock",
    stopEpoch: () => 0,
    onRisk: async () => {},
    runAction: async (_plan, action) => action(),
  });
  const state = runtime as any,
    timestamp = new Date(Date.now() - (stale ? 20000 : 0)).toISOString();
  const callback = {
    eventId: "old-event",
    requestId: "old-request",
    actionId: "old-action",
    observedAt: timestamp,
  };
  const snapshot = {
    context: { pageId: "page", observedAt: timestamp, receivedAt: timestamp },
    revision: "same-semantic-revision",
    business: [callback],
  };
  state.pageId = "page";
  state.snapshots.set("page", snapshot);
  state.socket = {
    destroyed: false,
    write: (line: string) => {
      const message = JSON.parse(line);
      writes.push(message);
      queueMicrotask(() => {
        if (!deny) {
          const now = new Date().toISOString();
          state.snapshots.set("page", {
            ...snapshot,
            context: { ...snapshot.context, observedAt: now, receivedAt: now },
          });
          state.events.emit("change");
        }
        void state.receive({ kind: "input-result", actionId: message.actionId, ok: !deny });
      });
    },
  };
  return { db, state, runtime, writes, callback };
}
it("refreshes an expired idle observation without acquiring an activity or changing old callback receipts", async () => {
  const f = fixture(true);
  try {
    const snapshot = await f.state.activationSnapshot();
    expect(f.writes).toEqual([expect.objectContaining({ kind: "command", command: "observe" })]);
    expect(snapshot.business).toEqual([f.callback]);
    expect(snapshot.revision).toBe("same-semantic-revision");
    expect(f.runtime.status().stopped).toBe(true);
  } finally {
    f.db.close();
  }
});
it("uses a fresh real observation directly and does not start any background activity", async () => {
  const f = fixture(false);
  try {
    await f.state.activationSnapshot();
    expect(f.writes).toEqual([]);
  } finally {
    f.db.close();
  }
});
it("a denied observation refresh cannot proceed to input activation", async () => {
  const f = fixture(true, true);
  try {
    await expect(f.state.activationSnapshot()).rejects.toThrow("只读观察");
    expect(f.runtime.status().stopped).toBe(true);
  } finally {
    f.db.close();
  }
});

function boundRuntime() {
  const db = new DatabaseSync(":memory:"),
    writes: any[] = [],
    runtime = new ExtensionNativeRuntime({
      db,
      socketPath: "/private/tmp/not-started-worker-stop.sock",
      stopEpoch: () => 0,
      onRisk: async () => {},
      runAction: async (_plan, action) => action(),
    }),
    state = runtime as any,
    sequences = new Map<string, number>();
  state.socket = {
    destroyed: false,
    write: (line: string) => {
      const message = JSON.parse(line);
      writes.push(message);
      if (message.kind === "resume" || message.kind === "activity")
        void Promise.resolve().then(() =>
          state.receive({
            kind: "input-result",
            actionId: message.actionId,
            ok: true,
            active: message.kind === "activity" && message.command !== "end",
            activityId: message.activity?.activityId,
          }),
        );
    },
  };
  const envelope = (payload: unknown, epoch = "connection") => {
    const sequence = (sequences.get(epoch) || 0) + 1;
    sequences.set(epoch, sequence);
    return {
      version: 1,
      connectionEpoch: epoch,
      sequence,
      messageId: `message-${sequence}`,
      kind: "status",
      payload,
    };
  };
  const identity = (bindingEpoch = "binding") => ({
    pageId: "page",
    pageGeneration: 1,
    tabId: 1,
    windowId: 1,
    bindingEpoch,
  });
  const bind = async (bindingEpoch = "binding") => {
    await state.receive(envelope({ ...identity(bindingEpoch), bound: true }));
    for (let index = 0; index < 5; index++) await Promise.resolve();
  };
  return { db, writes, runtime, state, envelope, identity, bind };
}
afterEach(() => vi.useRealTimers());
it.each(["user-stop", "bound-tab-closed", "unexpected-navigation-rebind-required"])(
  "a current worker %s status releases the activity, cancels pending work and stops the host once",
  async (reason) => {
    vi.useFakeTimers();
    const f = boundRuntime();
    try {
      await f.bind();
      expect(f.writes.some((message) => message.kind === "activity")).toBe(false);
      const handle = await f.runtime.activity.begin(new AbortController().signal);
      const pending = expect(f.runtime.nativeStatus()).rejects.toThrow(reason);
      const stopped = f.envelope({ ...f.identity(), stopped: true, reason });
      await f.state.receive(stopped);
      await pending;
      expect(handle.signal.aborted).toBe(true);
      expect(f.state.workflowActivity).toBeUndefined();
      expect(f.runtime.status()).toMatchObject({ stopped: true, idle: false, reason });
      expect(
        f.writes.filter((message) => message.kind === "command" && message.command === "stop"),
      ).toHaveLength(1);
      await f.state.receive(stopped); // A lost ACK cannot execute stop twice.
      await f.state.receive({ kind: "host-status", reason: "server-stop", stopped: true });
      const count = f.writes.length;
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.writes).toHaveLength(count);
      await handle.close();
      expect(
        f.writes.filter((message) => message.kind === "command" && message.command === "stop"),
      ).toHaveLength(1);
    } finally {
      f.db.close();
    }
  },
);
it("a delayed stopped status from an old binding or connection cannot revoke a new activity", async () => {
  const f = boundRuntime();
  try {
    await f.bind("old-binding");
    await f.bind("new-binding");
    const handle = await f.runtime.activity.begin(new AbortController().signal);
    await f.state.receive(
      f.envelope({ ...f.identity("old-binding"), stopped: true, reason: "old-stop" }),
    );
    await f.state.receive(
      f.envelope(
        { ...f.identity("new-binding"), stopped: true, reason: "old-connection" },
        "old-connection",
      ),
    );
    expect(handle.signal.aborted).toBe(false);
    expect(f.runtime.status().stopped).toBe(false);
    expect(
      f.writes.some((message) => message.kind === "command" && message.command === "stop"),
    ).toBe(false);
    await handle.close();
  } finally {
    f.db.close();
  }
});
