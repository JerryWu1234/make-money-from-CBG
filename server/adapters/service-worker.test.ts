import { describe, expect, it } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
const source = readFileSync(
  new URL("../../extension/cbg-access/service-worker.js", import.meta.url),
  "utf8",
);
const settle = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
function fixture(initial?: unknown) {
  let saved: any = initial ? structuredClone(initial) : undefined;
  let deferredProof: ((value: unknown) => void) | undefined;
  let defer = false;
  const handlers: Record<string, (...args: any[]) => any> = {},
    sent: any[] = [],
    tabMessages: any[] = [];
  const event = (name: string) => ({
    addListener: (fn: (...args: any[]) => any) => {
      handlers[name] = fn;
    },
  });
  const port = {
    postMessage: (message: unknown) => sent.push(structuredClone(message)),
    onDisconnect: event("disconnect"),
    onMessage: event("native"),
  };
  const chrome = {
    runtime: { id: "extension", connectNative: () => port, onMessage: event("snapshot") },
    storage: {
      local: {
        get: async () => ({ bridge: structuredClone(saved) }),
        set: async ({ bridge }: any) => {
          saved = structuredClone(bridge);
        },
      },
    },
    tabs: {
      get: async (id: number) => ({
        id,
        windowId: 1,
        active: true,
        url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
      }),
      sendMessage: async (_: number, message: any) => {
        tabMessages.push(message);
        if (message.kind === "revalidate" && defer)
          return new Promise((resolve) => {
            deferredProof = resolve;
          });
        if (message.kind === "bind") return { pageId: "page-1", pageGeneration: 1 };
        return {
          ok: true,
          proof: {
            actionId: message.plan?.actionId,
            targetVersion: "one",
            rect: { x: 5, y: 5, width: 20, height: 20 },
          },
        };
      },
      onUpdated: event("updated"),
      onCreated: event("created"),
      onRemoved: event("removed"),
    },
    windows: { get: async () => ({ focused: true }) },
    action: { onClicked: event("action"), setBadgeText: async () => {} },
    webRequest: { onHeadersReceived: event("headers") },
    alarms: { create: () => {}, onAlarm: event("alarm") },
  };
  const timers: (() => void)[] = [];
  runInNewContext(source, {
    chrome,
    crypto: { randomUUID },
    URL,
    Map,
    Date,
    structuredClone,
    setTimeout: (fn: () => void) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  });
  const bind = async () => {
    await handlers.action({
      id: 1,
      windowId: 1,
      url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
    });
    await settle();
  };
  const snapshot = (sender: unknown, payload: unknown = { pageId: "page-1", pageGeneration: 1 }) =>
    new Promise<any>((resolve) =>
      handlers.snapshot({ kind: "snapshot", payload }, sender, resolve),
    );
  return {
    handlers,
    sent,
    tabMessages,
    bind,
    snapshot,
    timers,
    saved: () => saved,
    deferProof: () => {
      defer = true;
    },
    releaseProof: (value: unknown) => deferredProof?.(value),
  };
}
const sender = {
  id: "extension",
  frameId: 0,
  tab: { id: 1 },
  url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
};
describe("MV3 trust boundary and durable outbox", () => {
  it("rejects forged origins, frames, tabs and payload generations using actual sender metadata", async () => {
    const f = fixture();
    await f.bind();
    for (const bad of [
      { ...sender, frameId: 1 },
      { ...sender, url: "https://evil.test/" },
      { ...sender, id: "other-extension" },
      { ...sender, tab: { id: 2 } },
    ])
      expect((await f.snapshot(bad)).ok).toBe(false);
    expect((await f.snapshot(sender, { pageId: "page-1", pageGeneration: 2 })).ok).toBe(false);
    expect((await f.snapshot(sender)).ok).toBe(true);
  });
  it("keeps the first unacknowledged data message and survives a service-worker restart", async () => {
    const f = fixture();
    await f.bind();
    const first = f.sent.find((message) => message.version === 1);
    expect(first.kind).toBe("status");
    f.handlers.native({
      kind: "ack",
      connectionEpoch: first.connectionEpoch,
      messageId: "incorrect",
    });
    await settle();
    expect(f.saved().outbox).toHaveLength(1);
    const restart = fixture(f.saved());
    await settle();
    expect(restart.sent[0]).toEqual(first);
    restart.handlers.native({
      kind: "ack",
      connectionEpoch: first.connectionEpoch,
      messageId: first.messageId,
    });
    await settle();
    expect(restart.saved().outbox).toHaveLength(0);
    expect(restart.sent.some((message) => message.kind === "command-proof")).toBe(false);
  });
  it("retransmits a data envelope when its ACK is lost on a still-connected port", async () => {
    const f = fixture();
    await f.bind();
    const first = structuredClone(f.sent[0]);
    f.timers.at(-1)!();
    await settle();
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1]).toEqual(first);
    expect(f.sent.every((message) => message.version === 1)).toBe(true);
  });
  it("never emits an old proof when stop and a newer resume interleave with revalidation", async () => {
    const f = fixture({
      version: 1,
      connectionEpoch: "connection",
      nextSequence: 1,
      outbox: [],
      bound: { tabId: 1, windowId: 1, pageId: "page-1", pageGeneration: 1 },
      stopped: false,
      controlRevision: 0,
      authority: { stopEpoch: 0, browserSessionEpoch: "session" },
    });
    await settle();
    f.deferProof();
    const plan = {
      actionId: "old-action",
      pageId: "page-1",
      pageGeneration: 1,
      stopEpoch: 0,
      browserSessionEpoch: "session",
      target: { kind: "query-field", field: "price_min", value: "1" },
    };
    f.handlers.native({ kind: "command", command: "execute", plan });
    await settle();
    expect(f.tabMessages.some((value) => value.kind === "revalidate")).toBe(true);
    f.handlers.native({ kind: "command", command: "stop", actionId: "stop" });
    await settle();
    f.handlers.native({
      kind: "command",
      command: "resume",
      actionId: "resume",
      context: {
        pageId: "page-1",
        pageGeneration: 1,
        stopEpoch: 1,
        browserSessionEpoch: "session",
      },
    });
    await settle();
    f.releaseProof({
      ok: true,
      proof: {
        actionId: "old-action",
        targetVersion: "one",
        rect: { x: 5, y: 5, width: 20, height: 20 },
      },
    });
    await settle();
    expect(
      f.sent.some((value) => value.kind === "command-proof" && value.actionId === "old-action"),
    ).toBe(false);
    expect(
      f.sent.find((value) => value.kind === "command-result" && value.actionId === "old-action")
        ?.ok,
    ).toBe(false);
  });
  it("bounds data messages and rate without forwarding page-provided executable commands", async () => {
    const f = fixture();
    await f.bind();
    const large = await f.snapshot(sender, {
      pageId: "page-1",
      pageGeneration: 1,
      text: "x".repeat(451000),
    });
    expect(large).toMatchObject({ ok: false, error: "bridge-message-size" });
    expect(f.saved().stopped).toBe(true);
    expect(f.sent.every((message) => message.kind !== "execute-script")).toBe(true);
    const g = fixture();
    await g.bind();
    for (let n = 0; n < 12; n++) expect((await g.snapshot(sender)).ok).toBe(true);
    expect((await g.snapshot(sender)).error).toBe("message-rate");
  });
});
