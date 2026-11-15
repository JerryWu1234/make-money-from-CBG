import { expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { ExtensionNativeRuntime } from "./extension-native";

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const writes: any[] = [];
  const runtime = new ExtensionNativeRuntime({
    db,
    socketPath: "/private/tmp/native-fresh-review-unused.sock",
    stopEpoch: () => 0,
    onRisk: () => {},
    runAction: async (_plan, dispatch) => dispatch(),
  });
  const internal = runtime as any;
  internal.socket = {
    destroyed: false,
    write(raw: string) {
      const message = JSON.parse(raw);
      writes.push(message);
      if (message.kind === "activity" || message.kind === "resume")
        queueMicrotask(() =>
          internal.receive({
            kind: "input-result",
            actionId: message.actionId,
            activityId: message.activity?.activityId,
            awake: message.command !== "end",
            ok: true,
          }),
        );
    },
  };
  const binding = {
    pageId: "review-page",
    pageGeneration: 1,
    tabId: 3,
    windowId: 1,
    bindingEpoch: "review-binding",
  };
  let sequence = 0;
  const envelope = (payload: unknown, connectionEpoch = "review-connection") => ({
    version: 1,
    connectionEpoch,
    sequence: ++sequence,
    messageId: `review-message-${sequence}`,
    kind: "status",
    payload,
  });
  await internal.receive(envelope({ ...binding, bound: true }));
  await Promise.resolve();
  expect(runtime.status().stopped).toBe(false);
  return { db, writes, runtime, internal, binding, envelope };
}

it.each(["user-stop", "bound-tab-closed", "unexpected-navigation-rebind-required"])(
  "revokes the helper lease when the extension reports %s",
  async (reason) => {
    const { db, writes, runtime, internal, binding, envelope } = await fixture();
    const activity = await runtime.activity.begin(new AbortController().signal);
    try {
      await internal.receive(envelope({ ...binding, stopped: true, reason }));
      expect(runtime.status().stopped).toBe(true);
      expect.soft(activity.signal.aborted).toBe(true);
      expect.soft(internal.workflowActivity).toBeUndefined();
      expect
        .soft(writes.some((message) => message.kind === "command" && message.command === "stop"))
        .toBe(true);
    } finally {
      await runtime.stop("review cleanup");
      await activity.close();
      db.close();
    }
  },
);

it.each(["generation", "binding", "tab", "connection"])(
  "does not stop a current activity for an old %s identity",
  async (changed) => {
    const { db, writes, runtime, internal, binding, envelope } = await fixture();
    const activity = await runtime.activity.begin(new AbortController().signal);
    try {
      const old = {
        ...binding,
        ...(changed === "generation" ? { pageGeneration: 2 } : {}),
        ...(changed === "binding" ? { bindingEpoch: "old-binding" } : {}),
        ...(changed === "tab" ? { tabId: 2 } : {}),
        stopped: true,
        reason: "user-stop",
      };
      const message = envelope(
        old,
        changed === "connection" ? "old-connection" : "review-connection",
      );
      if (changed === "connection") message.sequence = 1;
      await internal.receive(message);
      expect(runtime.status().stopped).toBe(false);
      expect(activity.signal.aborted).toBe(false);
      expect(
        writes.some((message) => message.kind === "command" && message.command === "stop"),
      ).toBe(false);
    } finally {
      await runtime.stop("review cleanup");
      await activity.close();
      db.close();
    }
  },
);

it("does not replay a consumed stop status against a later activity in the same binding", async () => {
  const { db, runtime, internal, binding, envelope } = await fixture();
  const first = await runtime.activity.begin(new AbortController().signal);
  const stopped = envelope({ ...binding, stopped: true, reason: "user-stop" });
  await internal.receive(stopped);
  await first.close();
  // A successful manual resume preserves the Chrome binding identity.
  internal.stopped = false;
  const second = await runtime.activity.begin(new AbortController().signal);
  try {
    await internal.receive(stopped);
    expect(runtime.status().stopped).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(internal.workflowActivity?.lease.activityId).toBe(second.lease.activityId);
  } finally {
    await runtime.stop("review cleanup");
    await second.close();
    db.close();
  }
});
