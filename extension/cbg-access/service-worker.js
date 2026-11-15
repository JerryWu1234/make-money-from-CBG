const HOST = "com.cbg.access_bridge";
const ORIGIN = "https://xyq.cbg.163.com";
let port,
  flushing = false,
  inFlightAt = 0,
  ackTimer,
  chain = Promise.resolve(),
  statePromise;
const rates = new Map();
const serial = (fn) => {
  chain = chain.then(fn, fn);
  return chain;
};
async function state() {
  return (statePromise ??= (async () => {
    const saved = (await chrome.storage.local.get("bridge")).bridge;
    if (saved) return saved;
    const next = {
      version: 1,
      connectionEpoch: crypto.randomUUID(),
      nextSequence: 1,
      outbox: [],
      bound: null,
      stopped: true,
    };
    await chrome.storage.local.set({ bridge: next });
    return next;
  })());
}
const save = (value) => chrome.storage.local.set({ bridge: value });
async function enqueue(kind, payload) {
  await serial(async () => {
    const value = await state();
    if (value.outbox.length >= 128) {
      value.stopped = true;
      value.controlRevision = (value.controlRevision || 0) + 1;
      await save(value);
      throw new Error("bridge-buffer-full");
    }
    if (JSON.stringify(payload).length > 450000) {
      value.stopped = true;
      value.controlRevision = (value.controlRevision || 0) + 1;
      await save(value);
      throw new Error("bridge-message-size");
    }
    value.outbox.push({
      version: 1,
      connectionEpoch: value.connectionEpoch,
      messageId: crypto.randomUUID(),
      sequence: value.nextSequence++,
      kind,
      payload,
    });
    await save(value);
  });
  void flush();
}
async function connect() {
  if (port) return;
  port = chrome.runtime.connectNative(HOST);
  port.onDisconnect.addListener(() => {
    port = null;
    flushing = false;
    clearTimeout(ackTimer);
    void serial(async () => {
      const value = await state();
      value.stopped = true;
      value.controlRevision = (value.controlRevision || 0) + 1;
      await save(value);
    });
  });
  port.onMessage.addListener((message) => {
    if (message.kind === "ack")
      void serial(async () => {
        const value = await state();
        if (
          message.connectionEpoch !== value.connectionEpoch ||
          value.outbox[0]?.messageId !== message.messageId
        )
          return;
        value.outbox.shift();
        await save(value);
        flushing = false;
        clearTimeout(ackTimer);
        void flush();
      });
    else if (message.kind === "command") void command(message);
  });
}
async function flush() {
  await connect();
  if (!port || (flushing && Date.now() - inFlightAt < 5000)) return;
  const value = await state();
  if (!value.outbox.length) return;
  flushing = true;
  inFlightAt = Date.now();
  port.postMessage(value.outbox[0]);
  clearTimeout(ackTimer);
  ackTimer = setTimeout(() => {
    flushing = false;
    void flush();
  }, 5000);
}
async function command(message) {
  const value = await state(),
    plan = message.plan;
  const commandPort = port;
  if (message.command === "stop") {
    value.controlRevision = (value.controlRevision || 0) + 1;
    value.stopped = true;
    delete value.navigation;
    await save(value);
    if (value.bound)
      await chrome.tabs.sendMessage(value.bound.tabId, { kind: "stop" }).catch(() => {});
    port?.postMessage({ kind: "command-result", actionId: message.actionId, ok: true });
    return;
  }
  try {
    if (message.command === "resume") {
      const revision = (value.controlRevision = (value.controlRevision || 0) + 1);
      value.stopped = true;
      value.authority = {
        stopEpoch: message.context?.stopEpoch,
        browserSessionEpoch: message.context?.browserSessionEpoch,
      };
      if (
        !value.bound ||
        !message.context ||
        message.context.pageId !== value.bound.pageId ||
        message.context.pageGeneration !== value.bound.pageGeneration
      )
        throw new Error("recovery-bound-page-mismatch");
      const current = await chrome.tabs.get(value.bound.tabId),
        window = await chrome.windows.get(current.windowId);
      if (!current.active || !window.focused || new URL(current.url).origin !== ORIGIN)
        throw new Error("recovery-foreground-mismatch");
      if (value.controlRevision !== revision || port !== commandPort)
        throw new Error("recovery-generation-changed");
      await chrome.tabs.sendMessage(current.id, { kind: "bind", context: message.context });
      if (value.controlRevision !== revision || port !== commandPort)
        throw new Error("recovery-generation-changed");
      value.stopped = false;
      await save(value);
      if (value.controlRevision !== revision || value.stopped || port !== commandPort)
        throw new Error("recovery-generation-changed");
      port?.postMessage({
        kind: "command-result",
        actionId: message.actionId,
        ok: true,
        posted: false,
      });
      await chrome.tabs.sendMessage(current.id, { kind: "capture" });
      return;
    }
    if (
      value.stopped ||
      !value.bound ||
      !plan ||
      plan.pageId !== value.bound.pageId ||
      plan.pageGeneration !== value.bound.pageGeneration
    )
      throw new Error("bridge-unbound-or-stopped");
    const control = {
      revision: value.controlRevision || 0,
      pageId: value.bound.pageId,
      pageGeneration: value.bound.pageGeneration,
      epoch: value.connectionEpoch,
      stopEpoch: plan.stopEpoch,
      session: plan.browserSessionEpoch,
    };
    const assertCurrent = () => {
      if (
        value.stopped ||
        (value.controlRevision || 0) !== control.revision ||
        value.connectionEpoch !== control.epoch ||
        value.bound?.pageId !== control.pageId ||
        value.bound?.pageGeneration !== control.pageGeneration ||
        value.authority?.stopEpoch !== control.stopEpoch ||
        value.authority?.browserSessionEpoch !== control.session ||
        port !== commandPort
      )
        throw new Error("stale-command-generation");
    };
    assertCurrent();
    const tab = await chrome.tabs.get(value.bound.tabId),
      window = await chrome.windows.get(tab.windowId);
    assertCurrent();
    if (!tab.active || !window.focused || new URL(tab.url).origin !== ORIGIN)
      throw new Error("foreground-tab-mismatch");
    if (
      ![
        "next-page",
        "jump-page",
        "listing-detail",
        "return-to-list",
        "refresh-list",
        "detail-tab",
        "detail-subtab",
        "detail-entry",
        "inspect-item",
        "market-entry",
        "market-field",
        "market-reset",
        "market-reset-server",
        "market-expand",
        "market-choice",
        "market-submit",
        "market-page",
        "market-level",
        "market-level-handle",
        "query",
        "query-field",
        "sort",
        "scroll",
      ].includes(plan.target?.kind)
    )
      throw new Error("unsupported-plan");
    if (plan.target.kind === "refresh-list" && plan.target.url !== tab.url)
      throw new Error("refresh-current-url-mismatch");
    if (
      plan.target.kind === "return-to-list" &&
      (!value.parent || value.parent.url !== plan.target.url)
    )
      throw new Error("unowned-return-path");
    if (message.command === "locate") {
      const location = await chrome.tabs.sendMessage(tab.id, { kind: "locate", plan });
      assertCurrent();
      port?.postMessage({
        kind: "command-result",
        actionId: plan.actionId,
        ok: location?.ok === true,
        posted: false,
        location: location?.location,
        error: location?.error,
      });
      return;
    }
    const prepared = await chrome.tabs.sendMessage(tab.id, { kind: "prepare", plan });
    assertCurrent();
    if (!prepared?.ok) throw new Error(prepared?.error || "prepare-failed");
    const verified = await chrome.tabs.sendMessage(tab.id, { kind: "revalidate", plan });
    assertCurrent();
    if (
      !verified?.ok ||
      verified.proof.targetVersion !== prepared.proof.targetVersion ||
      JSON.stringify(verified.proof.rect) !== JSON.stringify(prepared.proof.rect)
    )
      throw new Error("target-changed");
    if (
      ["listing-detail", "market-entry", "return-to-list", "refresh-list"].includes(
        plan.target.kind,
      )
    ) {
      value.navigation = {
        controlRevision: value.controlRevision || 0,
        bindingEpoch: value.bound.bindingEpoch,
        plan,
        fromTabId: tab.id,
        fromUrl: tab.url,
        parent: value.parent,
        expectedUrl:
          plan.target.kind === "listing-detail"
            ? `${ORIGIN}/equip?s=${plan.target.serverId}&eid=${encodeURIComponent(plan.target.eid)}`
            : ["return-to-list", "refresh-list"].includes(plan.target.kind)
              ? plan.target.url
              : verified.proof.href,
        createdAt: Date.now(),
      };
      await save(value);
    }
    assertCurrent();
    verified.proof.ownedChildTab =
      plan.target.kind === "return-to-list" && value.parent?.childTabId === tab.id;
    port?.postMessage({ kind: "command-proof", actionId: plan.actionId, proof: verified.proof });
  } catch (error) {
    port?.postMessage({
      kind: "command-result",
      actionId: plan?.actionId || message.actionId,
      ok: false,
      posted: false,
      error: String(error.message || error),
    });
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.kind !== "snapshot") return;
  void (async () => {
    if (
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      !sender.tab ||
      !sender.url ||
      new URL(sender.url).origin !== ORIGIN
    )
      throw new Error("sender-origin-frame");
    const value = await state(),
      payload = message.payload;
    if (
      !value.bound ||
      sender.tab.id !== value.bound.tabId ||
      payload.pageId !== value.bound.pageId ||
      payload.pageGeneration !== value.bound.pageGeneration
    )
      return reply({ ok: false, error: "unbound-generation" });
    const now = Date.now(),
      recent = (rates.get(sender.tab.id) || []).filter((time) => now - time < 1000);
    if (recent.length >= 12) throw new Error("message-rate");
    recent.push(now);
    rates.set(sender.tab.id, recent);
    await enqueue("snapshot", payload);
    reply({ ok: true });
  })().catch((error) => reply({ ok: false, posted: false, error: String(error.message || error) }));
  return true;
});
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || !tab.url || new URL(tab.url).origin !== ORIGIN) return;
  const value = await state();
  if (!value.stopped) {
    await command({ command: "stop", actionId: crypto.randomUUID() });
    await enqueue("status", { stopped: true, reason: "user-stop" });
    await chrome.action.setBadgeText({ text: "停" });
    return;
  }
  value.controlRevision = (value.controlRevision || 0) + 1;
  value.authority = null;
  const bound = await chrome.tabs.sendMessage(tab.id, { kind: "bind" });
  value.bound = {
    tabId: tab.id,
    windowId: tab.windowId,
    bindingEpoch: crypto.randomUUID(),
    ...bound,
  };
  value.stopped = false;
  delete value.navigation;
  delete value.parent;
  await save(value);
  await connect();
  await chrome.action.setBadgeText({ text: "读" });
  await enqueue("status", {
    bound: true,
    ...bound,
    tabId: tab.id,
    windowId: tab.windowId,
    bindingEpoch: value.bound.bindingEpoch,
  });
});
async function finishedNavigation(tabId) {
  const value = await state(),
    navigation = value.navigation;
  if (!navigation || Date.now() - navigation.createdAt > 20000 || value.stopped) return;
  const stillCurrent = () =>
    value.navigation === navigation &&
    !value.stopped &&
    (value.controlRevision || 0) === navigation.controlRevision;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (
    !tab?.url ||
    (!tab.active && tabId !== navigation.fromTabId) ||
    new URL(tab.url).origin !== ORIGIN
  )
    return;
  const actual = new URL(tab.url),
    expected = new URL(navigation.expectedUrl);
  if (
    actual.pathname !== expected.pathname ||
    (actual.pathname === "/equip"
      ? actual.searchParams.get("s") !== expected.searchParams.get("s") ||
        actual.searchParams.get("eid") !== expected.searchParams.get("eid")
      : actual.search !== expected.search)
  )
    return;
  const bound = await chrome.tabs
    .sendMessage(tab.id, { kind: "bind", plan: navigation.plan })
    .catch(() => null);
  if (!bound || !stillCurrent()) return;
  if (navigation.plan.target.kind === "listing-detail")
    value.parent = {
      tabId: navigation.fromTabId,
      url: navigation.fromUrl,
      childTabId: tabId === navigation.fromTabId ? null : tabId,
    };
  else if (navigation.plan.target.kind === "return-to-list") delete value.parent;
  value.bound = {
    tabId: tab.id,
    windowId: tab.windowId,
    bindingEpoch: navigation.bindingEpoch,
    ...bound,
  };
  delete value.navigation;
  await save(value);
  await enqueue("status", {
    navigated: true,
    ...bound,
    actionId: navigation.plan.actionId,
    tabId: tab.id,
    windowId: tab.windowId,
    bindingEpoch: value.bound.bindingEpoch,
  });
  await chrome.tabs.sendMessage(tab.id, { kind: "capture" }).catch(() => {});
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  void (async () => {
    const value = await state();
    if (info.status === "loading" && value.bound?.tabId === tabId && !value.navigation) {
      value.controlRevision = (value.controlRevision || 0) + 1;
      value.stopped = true;
      value.bound = null;
      await save(value);
      await enqueue("status", { stopped: true, reason: "unexpected-navigation-rebind-required" });
    }
    if (info.status === "complete") await finishedNavigation(tabId);
  })();
});
chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    const value = await state();
    if (value.navigation && tab.openerTabId === value.navigation.fromTabId) {
      value.navigation.childTabId = tab.id;
      await save(value);
      await finishedNavigation(tab.id);
    }
  })();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const value = await state();
    if (value.bound?.tabId !== tabId) return;
    if (
      value.navigation?.plan.target.kind === "return-to-list" &&
      value.parent?.childTabId === tabId
    ) {
      await finishedNavigation(value.parent.tabId);
      return;
    }
    value.stopped = true;
    value.bound = null;
    await save(value);
    await enqueue("status", { stopped: true, reason: "bound-tab-closed" });
  })();
});
chrome.alarms.create("bridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  void flush();
});
void flush();

// HTTP access evidence includes JSONP scripts; no response body or request secrets are read.
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    void (async () => {
      if (
        ![403, 429].includes(details.statusCode) ||
        details.frameId !== 0 ||
        !["main_frame", "xmlhttprequest", "script"].includes(details.type)
      )
        return;
      const url = new URL(details.url),
        allowed = [
          "/cgi-bin/recommend.py",
          "/cgi-bin/query.py",
          "/cgi-bin/equipquery.py",
          "/cgi-bin/xyq_overall_search.py",
          "/cgi-bin/role_search.py",
        ];
      if (
        url.origin !== ORIGIN ||
        (details.type !== "main_frame" && !allowed.includes(url.pathname))
      )
        return;
      const value = await state();
      if (
        !value.bound ||
        (details.tabId !== value.bound.tabId && details.tabId !== value.navigation?.childTabId)
      )
        return;
      const retryAfter = details.responseHeaders?.find(
        (header) => header.name.toLowerCase() === "retry-after",
      )?.value;
      await enqueue("status", {
        risk: details.statusCode === 429 ? "http_429" : "http_403",
        retryAfter: typeof retryAfter === "string" ? retryAfter.slice(0, 200) : undefined,
        pageId: value.bound.pageId,
        pageGeneration: value.bound.pageGeneration,
        endpoint: url.origin + url.pathname,
      });
    })().catch(() => {});
  },
  { urls: [ORIGIN + "/*"] },
  ["responseHeaders"],
);
