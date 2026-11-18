import { describe, expect, it, vi } from "vite-plus/test";
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
function fixture(initial?: unknown, automaticTabs: Record<string, any>[] = []) {
  let saved: any = initial ? structuredClone(initial) : undefined;
  let focused = true;
  let deferredProof: ((value: unknown) => void) | undefined;
  let defer = false,
    hold: string | undefined,
    release: (() => void) | undefined,
    tokenSequence = 0;
  const focusCalls: unknown[] = [];
  const observerTokens = new Map<number, string>();
  const tabValues = new Map<number, Record<string, unknown>>();
  const held = (kind: string, result: unknown, apply = () => {}) => {
    if (hold === kind) {
      hold = undefined;
      return new Promise((resolve) => {
        release = () => {
          apply();
          resolve(result);
        };
      });
    }
    apply();
    return Promise.resolve(result);
  };
  if (saved?.bound?.observerToken) observerTokens.set(saved.bound.tabId, saved.bound.observerToken);
  const handlers: Record<string, (...args: any[]) => any> = {},
    sent: any[] = [],
    tabMessages: any[] = [];
  const event = (name: string) => ({
    addListener: (fn: (...args: any[]) => any) => {
      handlers[name] = fn;
    },
  });
  const ports: any[] = [];
  const connectNative = () => {
    const local: Record<string, (...args: any[]) => any> = {};
    const connection = {
      disconnected: false,
      handlers: local,
      postMessage: (message: unknown) => {
        if (connection.disconnected) throw new Error("disconnected-port");
        sent.push(structuredClone(message));
      },
      disconnect: () => (connection.disconnected = true),
      onDisconnect: {
        addListener: (fn: (...args: any[]) => any) => (handlers.disconnect = local.disconnect = fn),
      },
      onMessage: {
        addListener: (fn: (...args: any[]) => any) => (handlers.native = local.native = fn),
      },
    };
    ports.push(connection);
    return connection;
  };
  const chrome = {
    runtime: {
      id: "extension",
      connectNative,
      onMessage: event("snapshot"),
      onInstalled: event("installed"),
      onStartup: event("startup"),
    },
    storage: {
      local: {
        get: async () => ({ bridge: structuredClone(saved) }),
        set: async ({ bridge }: any) => {
          saved = structuredClone(bridge);
          await held("save", undefined);
        },
      },
    },
    tabs: {
      query: async () => structuredClone(automaticTabs),
      update: async (id: number, update: any) =>
        held("activate", undefined, () => {
          focusCalls.push({ tabId: id, ...update });
          tabValues.set(id, { ...tabValues.get(id), ...update });
        }),
      onActivated: event("activated"),
      get: async (id: number) =>
        held("get", {
          id,
          windowId: 1,
          active: true,
          url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
          ...tabValues.get(id),
        }),
      sendMessage: async (tabId: number, message: any) => {
        tabMessages.push({ ...message, tabId });
        if (message.kind === "revalidate" && defer)
          return new Promise((resolve) => {
            deferredProof = resolve;
          });
        if (message.kind === "bind") {
          const observerToken = `observer-${++tokenSequence}`;
          observerTokens.set(tabId, observerToken);
          return held("bind", { pageId: `page-${tabId}`, pageGeneration: 1, observerToken });
        }
        if (["stop", "unbind"].includes(message.kind))
          return held(message.kind, { ok: true }, () => {
            if (!message.observerToken || observerTokens.get(tabId) === message.observerToken)
              observerTokens.delete(tabId);
          });
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
    windows: {
      get: async () => ({ focused }),
      update: async (id: number, update: any) =>
        held("focus-window", undefined, () => {
          focusCalls.push({ windowId: id, ...update });
          focused = true;
        }),
      onFocusChanged: event("focus"),
    },
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
  const bind = async (tabId = 1) => {
    await handlers.action({
      id: tabId,
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
    focusCalls,
    ports,
    sent,
    tabMessages,
    observerTokens,
    tabValues,
    holdNext: (kind: string) => {
      hold = kind;
    },
    release: () => release?.(),
    bind,
    snapshot,
    timers,
    saved: () => saved,
    setFocused: (value: boolean) => {
      focused = value;
    },
    selectAutomatic: (tab: Record<string, any> | undefined) => {
      automaticTabs.splice(0, automaticTabs.length, ...(tab ? [tab] : []));
    },
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
  it.each(["size", "buffer"])(
    "%s failure closes the Native connection before persistence and fences a pending proof",
    async (failure) => {
      const outbox =
        failure === "buffer"
          ? Array.from({ length: 128 }, (_, index) => ({
              version: 1,
              connectionEpoch: "connection",
              messageId: `pending-${index}`,
              sequence: index + 1,
              kind: "snapshot",
              payload: {},
            }))
          : [];
      const f = fixture({
        version: 1,
        connectionEpoch: "connection",
        nextSequence: outbox.length + 1,
        outbox,
        bound: {
          tabId: 1,
          windowId: 1,
          pageId: "page-1",
          pageGeneration: 1,
          observerToken: "active-observer",
        },
        stopped: false,
        authority: { stopEpoch: 0, browserSessionEpoch: "session" },
      });
      await settle();
      f.deferProof();
      f.handlers.native({
        kind: "command",
        command: "execute",
        plan: {
          actionId: "pending-input",
          pageId: "page-1",
          pageGeneration: 1,
          stopEpoch: 0,
          browserSessionEpoch: "session",
          target: { kind: "query-field", field: "price_min", value: "1" },
        },
      });
      await settle();
      expect(f.tabMessages.some((message) => message.kind === "revalidate")).toBe(true);
      f.holdNext("save");
      const rejected = f.snapshot(sender, {
        pageId: "page-1",
        pageGeneration: 1,
        ...(failure === "size" ? { text: "x".repeat(451000) } : {}),
      });
      await settle();
      expect(f.ports[0].disconnected).toBe(true);
      f.releaseProof({ ok: true, proof: { actionId: "pending-input", targetVersion: "one" } });
      await settle();
      expect(f.sent.some((message) => message.kind === "command-proof")).toBe(false);
      f.release();
      expect(await rejected).toMatchObject({
        ok: false,
        error: failure === "size" ? "bridge-message-size" : "bridge-buffer-full",
      });
      expect(f.saved()).toMatchObject({ stopped: true, observing: false });
      expect(f.saved().outbox).toHaveLength(outbox.length);
      expect(f.observerTokens.has(1)).toBe(false);
    },
  );
  it("late messages and disconnect from a failed port cannot stop or command a fresh binding", async () => {
    const f = fixture();
    await f.bind();
    const oldPort = f.ports[0];
    await f.snapshot(sender, { pageId: "page-1", pageGeneration: 1, text: "x".repeat(451000) });
    // Acknowledge the existing bound message after reconnect, then bind a new tab.
    f.handlers.alarm({ name: "cbg-flush" });
    await settle();
    const pending = f.saved().outbox[0];
    if (pending) f.handlers.native({ ...pending, kind: "ack" });
    await settle();
    await f.bind(2);
    const freshPort = f.ports.at(-1);
    const token = f.observerTokens.get(2);
    oldPort.handlers.disconnect();
    oldPort.handlers.native({ kind: "command", command: "stop", actionId: "old-port-stop" });
    await settle();
    expect(freshPort).not.toBe(oldPort);
    expect(freshPort.disconnected).toBe(false);
    expect(f.saved()).toMatchObject({ stopped: false, bound: { tabId: 2 } });
    expect(f.observerTokens.get(2)).toBe(token);
  });
  it("a stop held on persistence cannot reply through a new Native connection", async () => {
    const f = fixture();
    await f.bind();
    f.holdNext("save");
    f.handlers.native({ kind: "command", command: "stop", actionId: "old-held-stop" });
    await settle();
    f.ports[0].handlers.disconnect();
    await settle();
    await f.bind(2);
    const token = f.observerTokens.get(2);
    f.release();
    await settle();
    expect(f.saved()).toMatchObject({ stopped: false, bound: { tabId: 2 } });
    expect(f.observerTokens.get(2)).toBe(token);
    expect(f.sent.some((message) => message.actionId === "old-held-stop")).toBe(false);
  });
  it.each(["get", "bind"])(
    "an old observe held at %s cannot stop a newer successful resume",
    async (stage) => {
      const f = fixture();
      await f.bind();
      f.handlers.native({ kind: "command", command: "stop", actionId: "stop" });
      await settle();
      f.holdNext(stage);
      f.handlers.native({ kind: "command", command: "observe", actionId: "old-observe" });
      await settle();
      f.handlers.native({
        kind: "command",
        command: "resume",
        actionId: "new-resume",
        context: {
          pageId: "page-1",
          pageGeneration: 1,
          stopEpoch: 1,
          browserSessionEpoch: "new-session",
        },
      });
      await settle();
      const token = f.observerTokens.get(1);
      expect(token).toBeTypeOf("string");
      expect(f.saved().stopped).toBe(false);
      f.release();
      await settle();
      expect(f.observerTokens.get(1)).toBe(token);
      expect(f.saved().stopped).toBe(false);
      expect(
        f.sent.find(
          (message) => message.kind === "command-result" && message.actionId === "old-observe",
        )?.ok,
      ).toBe(false);
      if (stage === "bind")
        expect(f.tabMessages.at(-1)).toMatchObject({
          kind: "stop",
          observerToken: expect.any(String),
        });
    },
  );
  it("an old navigation unbind ACK cannot overwrite or delete a newer user binding", async () => {
    const childUrl = "https://xyq.cbg.163.com/equip?s=367&eid=child";
    const f = fixture({
      version: 1,
      connectionEpoch: "connection",
      nextSequence: 1,
      outbox: [],
      bound: {
        tabId: 1,
        windowId: 1,
        pageId: "page-1",
        pageGeneration: 1,
        observerToken: "old-parent",
      },
      stopped: false,
      controlRevision: 0,
      navigation: {
        createdAt: Date.now(),
        controlRevision: 0,
        fromTabId: 1,
        fromUrl: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
        expectedUrl: childUrl,
        bindingEpoch: "navigation",
        plan: {
          actionId: "old-navigation",
          target: { kind: "listing-detail", serverId: "367", eid: "child" },
        },
      },
    });
    await settle();
    f.tabValues.set(2, { url: childUrl });
    f.holdNext("unbind");
    f.handlers.updated(2, { status: "complete" });
    await settle();
    expect(f.tabMessages.some((message) => message.kind === "unbind" && message.tabId === 1)).toBe(
      true,
    );
    f.handlers.native({ kind: "command", command: "stop", actionId: "stop-navigation" });
    await settle();
    await f.bind(3);
    const token = f.observerTokens.get(3);
    f.handlers.native({
      kind: "command",
      command: "resume",
      actionId: "new-resume",
      context: {
        pageId: "page-3",
        pageGeneration: 1,
        stopEpoch: 1,
        browserSessionEpoch: "new-session",
      },
    });
    await settle();
    const resumedToken = f.observerTokens.get(3);
    f.handlers.native({
      kind: "command",
      command: "execute",
      plan: {
        actionId: "new-navigation",
        pageId: "page-3",
        pageGeneration: 1,
        stopEpoch: 1,
        browserSessionEpoch: "new-session",
        target: { kind: "listing-detail", serverId: "367", eid: "new-child" },
      },
    });
    await settle();
    expect(f.saved().navigation?.plan.actionId).toBe("new-navigation");
    f.release();
    await settle();
    expect(resumedToken).not.toBe(token);
    expect(f.saved().bound).toMatchObject({
      tabId: 3,
      pageId: "page-3",
      observerToken: resumedToken,
    });
    expect(f.saved().stopped).toBe(false);
    expect(f.observerTokens.get(3)).toBe(resumedToken);
    expect(f.saved().navigation?.plan.actionId).toBe("new-navigation");
    expect(f.observerTokens.has(2)).toBe(false);
    expect(
      f
        .saved()
        .outbox.some(
          (envelope: any) => envelope.payload?.navigated && envelope.payload.tabId === 2,
        ),
    ).toBe(false);
  });
  it("a loading event waiting for an old unbind ACK cannot clear a new user binding", async () => {
    const f = fixture();
    await f.bind();
    f.holdNext("unbind");
    f.handlers.updated(1, { status: "loading" });
    await settle();
    await f.bind(3);
    const token = f.observerTokens.get(3);
    f.release();
    await settle();
    expect(f.saved().bound).toMatchObject({ tabId: 3, observerToken: token });
    expect(f.saved().stopped).toBe(false);
    expect(f.observerTokens.get(3)).toBe(token);
    expect(
      f
        .saved()
        .outbox.some(
          (message: any) => message.payload?.reason === "unexpected-navigation-rebind-required",
        ),
    ).toBe(false);
  });
  it("an old stop waiting for persistence cannot stop an observation installed by a newer resume", async () => {
    const f = fixture();
    await f.bind();
    f.holdNext("save");
    f.handlers.native({ kind: "command", command: "stop", actionId: "old-stop" });
    await settle();
    f.handlers.native({
      kind: "command",
      command: "resume",
      actionId: "new-resume",
      context: {
        pageId: "page-1",
        pageGeneration: 1,
        stopEpoch: 1,
        browserSessionEpoch: "new-session",
      },
    });
    await settle();
    const token = f.observerTokens.get(1);
    f.release();
    await settle();
    expect(f.saved().stopped).toBe(false);
    expect(f.observerTokens.get(1)).toBe(token);
  });
  it.each(["user-stop", "bound-tab-closed", "unexpected-navigation-rebind-required"])(
    "%s includes the stopped binding identity for the runtime generation check",
    async (reason) => {
      const f = fixture();
      await f.bind();
      const { pageId, pageGeneration, tabId, windowId, bindingEpoch } = f.saved().bound;
      if (reason === "user-stop") await f.bind();
      else if (reason === "bound-tab-closed") f.handlers.removed(1);
      else f.handlers.updated(1, { status: "loading" });
      await settle();
      expect(
        f.saved().outbox.find((message: any) => message.payload?.reason === reason)?.payload,
      ).toMatchObject({ stopped: true, pageId, pageGeneration, tabId, windowId, bindingEpoch });
    },
  );
  it("read-only observe refreshes a stopped binding without granting input authority", async () => {
    const f = fixture();
    await f.bind();
    f.handlers.native({ kind: "command", command: "stop", actionId: "stop" });
    await settle();
    expect((await f.snapshot(sender)).ok).toBe(false);
    const authority = f.saved().authority;
    f.handlers.native({ kind: "command", command: "observe", actionId: "observe" });
    await settle();
    expect(f.saved().stopped).toBe(true);
    expect(f.saved().observing).toBe(true);
    expect(f.saved().authority).toEqual(authority);
    expect(f.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "command-result",
          actionId: "observe",
          ok: true,
          posted: false,
        }),
      ]),
    );
    expect(
      f.tabMessages.filter((message) =>
        ["prepare", "revalidate", "execute"].includes(message.kind),
      ),
    ).toEqual([]);
    expect((await f.snapshot(sender)).ok).toBe(true);
  });
  it("stops page observation when its native host disconnects", async () => {
    const f = fixture();
    await f.bind();
    f.handlers.disconnect();
    await settle();
    expect(f.saved().observing).toBe(false);
    expect(f.tabMessages.at(-1).kind).toBe("stop");
    expect((await f.snapshot(sender)).ok).toBe(false);
  });
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

const automaticRoleTab = (
  id = 1,
  url = "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py",
) => ({ id, url, windowId: 1, active: true });
const settleAutomatic = async () => {
  await settle();
  await settle();
  await settle();
};
describe("automatic domain-limited observation", () => {
  it("binds the selected official page at startup without an extension click or input proof", async () => {
    const f = fixture(undefined, [automaticRoleTab()]);
    await settleAutomatic();
    expect(f.saved().bound).toMatchObject({ tabId: 1, url: automaticRoleTab().url });
    expect(f.tabMessages.filter((m) => m.kind === "bind")).toHaveLength(1);
    expect(f.saved().outbox.some((m: any) => m.kind === "status" && m.payload.bound)).toBe(true);
    expect(f.sent.some((m) => m.kind === "command-proof")).toBe(false);
    f.handlers.activated({ tabId: 1 });
    f.handlers.focus(1);
    f.handlers.alarm();
    await settleAutomatic();
    expect(f.tabMessages.filter((m) => m.kind === "bind")).toHaveLength(1);
  });
  it.each([
    "http://xyq.cbg.163.com/",
    "https://xyq.cbg.163.com.evil.test/",
    "https://cbg.163.com/",
    "https://xyq.cbg.163.com/cgi-bin/login.py",
    "https://xyq.cbg.163.com/pay",
    "https://xyq.cbg.163.com/cgi-bin/x.py?act=logout",
  ])("never automatically binds %s", async (url) => {
    const f = fixture(undefined, [automaticRoleTab(1, url)]);
    await settleAutomatic();
    expect(f.tabMessages.some((m) => m.kind === "bind")).toBe(false);
  });
  it("does not mistake ordinary sorting or an order serial parameter for a payment page", async () => {
    const f = fixture(undefined, [
      automaticRoleTab(
        1,
        "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?order_by=price&game_ordersn=123",
      ),
    ]);
    await settleAutomatic();
    expect(f.saved().bound?.tabId).toBe(1);
  });
  it("keeps an explicit user pause across focus, navigation and reconnect alarms", async () => {
    const tab = automaticRoleTab();
    const f = fixture(undefined, [tab]);
    await settleAutomatic();
    await f.handlers.action(tab);
    await settleAutomatic();
    expect(f.saved().autoPaused).toBe(true);
    f.selectAutomatic(automaticRoleTab(2));
    f.handlers.activated({ tabId: 2 });
    f.handlers.alarm();
    await settleAutomatic();
    expect(f.saved().stopped).toBe(true);
    expect(f.tabMessages.filter((m) => m.kind === "bind")).toHaveLength(1);
  });
  it("stops the old binding before automatically selecting another official tab", async () => {
    const f = fixture(undefined, [automaticRoleTab()]);
    await settleAutomatic();
    f.selectAutomatic(automaticRoleTab(2));
    f.handlers.activated({ tabId: 2 });
    await settleAutomatic();
    expect(f.saved().bound.tabId).toBe(2);
    const messages = f.saved().outbox.map((m: any) => m.payload);
    expect(messages.findIndex((m: any) => m.reason === "automatic-page-change")).toBeLessThan(
      messages.findIndex((m: any) => m.bound && m.tabId === 2),
    );
    expect(f.observerTokens.has(1)).toBe(false);
  });
  it("announces an existing selected binding again after a fresh worker/native connection", async () => {
    const first = fixture(undefined, [automaticRoleTab()]);
    await settleAutomatic();
    const restored = first.saved();
    restored.outbox = [];
    const second = fixture(restored, [automaticRoleTab()]);
    await settleAutomatic();
    expect(second.tabMessages.some((m) => m.kind === "bind")).toBe(true);
    expect(second.saved().outbox.some((m: any) => m.kind === "status" && m.payload.bound)).toBe(
      true,
    );
  });
  it("does not let a stale saved navigation block automatic binding after worker restart", async () => {
    const f = fixture(undefined, [automaticRoleTab()]);
    await settleAutomatic();
    const initial = f.saved();
    initial.navigation = { createdAt: Date.now() };
    const g = fixture(initial, [automaticRoleTab(2)]);
    await settleAutomatic();
    expect(g.saved().bound?.tabId).toBe(2);
    expect(g.saved().navigation).toBeUndefined();
  });
  it("discards a delayed automatic bind after the selected tab changes", async () => {
    const f = fixture();
    await settleAutomatic();
    f.holdNext("bind");
    f.selectAutomatic(automaticRoleTab());
    f.handlers.activated({ tabId: 1 });
    await settleAutomatic();
    f.selectAutomatic(automaticRoleTab(2));
    f.handlers.activated({ tabId: 2 });
    f.release();
    await settleAutomatic();
    expect(f.saved().bound?.tabId).toBe(2);
    expect(f.saved().outbox.some((m: any) => m.payload.bound && m.payload.tabId === 1)).toBe(false);
  });
});

it("retains a background official read binding but never authorizes an unfocused input proof", async () => {
  const tab = automaticRoleTab();
  const f = fixture(undefined, [tab]);
  await settleAutomatic();
  f.handlers.native({
    kind: "command",
    command: "resume",
    actionId: "resume-read",
    context: { pageId: "page-1", pageGeneration: 1, stopEpoch: 1, browserSessionEpoch: "session" },
  });
  await settleAutomatic();
  f.setFocused(false);
  f.selectAutomatic(undefined);
  f.handlers.focus(-1);
  await settleAutomatic();
  expect(f.saved().bound?.tabId).toBe(1);
  f.handlers.native({
    kind: "command",
    command: "execute",
    plan: {
      actionId: "unfocused",
      pageId: "page-1",
      pageGeneration: 1,
      stopEpoch: 1,
      browserSessionEpoch: "session",
      target: { kind: "query" },
      expected: { kind: "changed" },
    },
  });
  await settleAutomatic();
  expect(f.sent.some((m) => m.kind === "command-proof" && m.actionId === "unfocused")).toBe(false);
  expect(
    f.sent.find((m) => m.kind === "command-result" && m.actionId === "unfocused"),
  ).toMatchObject({ ok: false, error: "foreground-tab-mismatch" });
});
it("reconciles a disconnected stale navigation instead of preserving it forever", async () => {
  const f = fixture(undefined, [automaticRoleTab()]);
  await settleAutomatic();
  f.handlers.native({
    kind: "command",
    command: "resume",
    actionId: "resume-nav",
    context: { pageId: "page-1", pageGeneration: 1, stopEpoch: 1, browserSessionEpoch: "session" },
  });
  await settleAutomatic();
  f.handlers.native({
    kind: "command",
    command: "execute",
    plan: {
      actionId: "owned-nav",
      pageId: "page-1",
      pageGeneration: 1,
      stopEpoch: 1,
      browserSessionEpoch: "session",
      target: { kind: "listing-detail", serverId: "1", eid: "fixture" },
    },
  });
  await settleAutomatic();
  expect(f.saved().navigation?.plan.actionId).toBe("owned-nav");
  f.selectAutomatic(automaticRoleTab(2));
  f.handlers.activated({ tabId: 2 });
  await settleAutomatic();
  expect(f.saved().bound?.tabId).toBe(1);
  expect(f.saved().navigation?.plan.actionId).toBe("owned-nav");
  f.handlers.disconnect();
  await settleAutomatic();
  expect(f.saved().navigation).toBeUndefined();
  f.handlers.alarm();
  await settleAutomatic();
  expect(f.saved().bound?.tabId).toBe(2);
});

it("automatically restores same-page observation after a non-user server stop without input proof", async () => {
  const f = fixture(undefined, [automaticRoleTab()]);
  await settleAutomatic();
  const before = f.tabMessages.filter((m) => m.kind === "bind").length;
  f.handlers.native({ kind: "command", command: "stop", actionId: "server-stop" });
  await settleAutomatic();
  expect(f.saved().observing).toBe(false);
  expect(f.saved().autoPaused).toBe(false);
  f.handlers.alarm();
  await settleAutomatic();
  expect(f.saved().observing).toBe(true);
  expect(f.tabMessages.filter((m) => m.kind === "bind").length).toBe(before + 1);
  expect(f.sent.some((m) => m.kind === "command-proof")).toBe(false);
});
it("rebinds the same document after its owned navigation expires", async () => {
  const f = fixture(undefined, [automaticRoleTab()]);
  await settleAutomatic();
  f.handlers.native({
    kind: "command",
    command: "resume",
    actionId: "resume-expiry",
    context: { pageId: "page-1", pageGeneration: 1, stopEpoch: 1, browserSessionEpoch: "session" },
  });
  await settleAutomatic();
  f.handlers.native({
    kind: "command",
    command: "execute",
    plan: {
      actionId: "expired-navigation",
      pageId: "page-1",
      pageGeneration: 1,
      stopEpoch: 1,
      browserSessionEpoch: "session",
      target: { kind: "listing-detail", serverId: "1", eid: "fixture" },
    },
  });
  await settleAutomatic();
  expect(f.saved().navigation).toBeDefined();
  const before = f.tabMessages.filter((m) => m.kind === "bind").length;
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 21000);
  try {
    f.handlers.alarm();
    await settleAutomatic();
    expect(f.saved().navigation).toBeUndefined();
    expect(f.saved().observing).toBe(true);
    expect(f.tabMessages.filter((m) => m.kind === "bind").length).toBe(before + 1);
  } finally {
    clock.mockRestore();
  }
});

describe("explicit read-only focus", () => {
  const command = (f: ReturnType<typeof fixture>) => ({
    kind: "command",
    command: "focus",
    actionId: "focus-test",
    context: {
      ...f.saved().bound,
      connectionEpoch: f.saved().connectionEpoch,
      url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
    },
  });
  it("只切回原绑定，不恢复或申请输入授权", async () => {
    const f = fixture();
    await f.bind();
    const before = f.saved();
    f.setFocused(false);
    f.handlers.native(command(f));
    await settle();
    expect(f.focusCalls).toEqual([
      { windowId: 1, state: "normal", focused: true },
      { tabId: 1, active: true },
    ]);
    expect(f.sent).toContainEqual({
      kind: "command-result",
      actionId: "focus-test",
      ok: true,
      posted: false,
    });
    expect(f.saved().authority).toEqual(before.authority);
    expect(f.saved().stopped).toEqual(before.stopped);
    expect(f.sent.some((m) => m.kind === "command-proof")).toBe(false);
  });
  it.each(["identity", "domain", "window"])("拒绝变化的%s", async (kind) => {
    const f = fixture();
    await f.bind();
    const message = command(f);
    if (kind === "identity") message.context.pageGeneration++;
    if (kind === "domain") f.tabValues.set(1, { url: "https://example.com/" });
    if (kind === "window") f.tabValues.set(1, { windowId: 2 });
    f.handlers.native(message);
    await settle();
    expect(f.focusCalls).toEqual([]);
    expect(f.sent.find((m) => m.actionId === "focus-test")?.ok).toBe(false);
  });
  it("等待窗口时发生停止，不能继续激活标签页", async () => {
    const f = fixture();
    await f.bind();
    f.holdNext("focus-window");
    f.handlers.native(command(f));
    await settle();
    f.handlers.native({ kind: "command", command: "stop", actionId: "stop-test" });
    await settle();
    f.release();
    await settle();
    expect(f.focusCalls.some((v: any) => v.tabId)).toBe(false);
    expect(f.sent.find((m) => m.actionId === "focus-test")?.ok).toBe(false);
    expect(f.saved().stopped).toBe(true);
  });
});

it("人工toolbar暂停早于focus送达，拒绝旧任务意图", async () => {
  const f = fixture();
  await f.bind();
  const old = f.saved();
  await f.handlers.action({
    id: 1,
    windowId: 1,
    url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
  });
  await settle();
  expect(f.saved().autoPaused).toBe(true);
  f.handlers.native({
    kind: "command",
    command: "focus",
    actionId: "late-focus",
    context: {
      ...old.bound,
      connectionEpoch: old.connectionEpoch,
      url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
    },
  });
  await settle();
  expect(f.focusCalls).toEqual([]);
  expect(f.sent.find((m) => m.actionId === "late-focus")?.ok).toBe(false);
  expect(f.saved().autoPaused).toBe(true);
});

it("toolbar暂停不能被延迟recoveryEpoch恢复命令清除", async () => {
  const f = fixture();
  await f.bind();
  const old = f.saved();
  await f.handlers.action({
    id: 1,
    windowId: 1,
    url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
  });
  await settle();
  f.handlers.native({
    kind: "command",
    command: "resume",
    actionId: "late-resume",
    context: {
      ...old.bound,
      stopEpoch: 1,
      browserSessionEpoch: "session",
      recoveryEpoch: "old-intent",
    },
  });
  await settle();
  expect(f.sent.find((m) => m.actionId === "late-resume")?.ok).toBe(false);
  expect(f.saved().autoPaused).toBe(true);
  expect(f.saved().stopped).toBe(true);
});

it("server-stop后的focus先真实恢复只读观察，晚到focus事件不换绑定", async () => {
  const f = fixture(undefined, [automaticRoleTab()]);
  await settleAutomatic();
  f.handlers.native({ kind: "command", command: "stop", actionId: "server-stopped" });
  await settleAutomatic();
  const before = f.saved();
  f.tabValues.set(1, automaticRoleTab());
  const binds = f.tabMessages.filter((m) => m.kind === "bind").length;
  f.handlers.native({
    kind: "command",
    command: "focus",
    actionId: "focus-after-stop",
    context: {
      ...before.bound,
      connectionEpoch: before.connectionEpoch,
      url: automaticRoleTab().url,
    },
  });
  await settleAutomatic();
  expect(f.sent.find((m) => m.actionId === "focus-after-stop")?.ok).toBe(true);
  expect(f.tabMessages.filter((m) => m.kind === "bind").length).toBe(binds + 1);
  expect(f.saved().observing).toBe(true);
  expect(f.saved().stopped).toBe(true);
  f.handlers.focus(1);
  await settleAutomatic();
  expect(f.saved().bound.bindingEpoch).toBe(before.bound.bindingEpoch);
  expect(f.saved().authority).toEqual(before.authority);
});
