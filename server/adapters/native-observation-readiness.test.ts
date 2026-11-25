import { expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { ExtensionNativeRuntime } from "./extension-native";

it("ACKs an explicitly unready observation, accepts the actual later list, and strictly rejects a rendered invalid age", async () => {
  const db = new DatabaseSync(":memory:");
  const writes: any[] = [];
  const runtime = new ExtensionNativeRuntime({
    db,
    socketPath: "/private/tmp/not-started-readiness.sock",
    stopEpoch: () => 0,
    onRisk: () => {},
    runAction: async (_plan, dispatch) => dispatch(),
  });
  const internal = runtime as any;
  internal.socket = {
    destroyed: false,
    destroy() {},
    write(raw: string) {
      const message = JSON.parse(raw);
      writes.push(message);
      if (message.kind === "resume")
        queueMicrotask(() =>
          internal.receive({ kind: "input-result", actionId: message.actionId, ok: true }),
        );
    },
  };
  let sequence = 0;
  const receive = (kind: string, payload: unknown) =>
    internal.receive({
      version: 1,
      connectionEpoch: "ready-connection",
      messageId: `ready-${++sequence}`,
      sequence,
      kind,
      payload,
    });
  try {
    await receive("status", { bound: true, pageId: "page", pageGeneration: 1 });
    const base = {
      pageId: "page",
      pageGeneration: 1,
      observedAt: new Date().toISOString(),
      url: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=role",
      title: "fixture",
      revision: "unready",
      visible: true,
      loading: true,
      access: "unknown",
      queryArgs: {},
      empty: true,
    };
    await receive("snapshot", base);
    expect((await runtime.snapshot()).loading).toBe(true);
    expect(writes.some((message) => message.kind === "ack" && message.sequence === 2)).toBe(true);
    const actual = {
      ...base,
      revision: "ready",
      access: "normal",
      loading: false,
      authenticated: true,
      queryArgs: { server_type: "1,2,3" },
      listing: {
        page: 1,
        totalPages: 1,
        order: "selling_time DESC",
        serverType: "1,2,3",
        items: [],
      },
    };
    await receive("snapshot", actual);
    expect((await runtime.snapshot()).listing?.page).toBe(1);
    await expect(
      receive("snapshot", {
        ...actual,
        queryArgs: { server_type: "" },
        listing: { ...actual.listing, serverType: "" },
      }),
    ).rejects.toThrow("服龄");
    expect(writes.some((message) => message.kind === "ack" && message.sequence === 4)).toBe(false);
  } finally {
    await runtime.stop("test finished");
    db.close();
  }
});
