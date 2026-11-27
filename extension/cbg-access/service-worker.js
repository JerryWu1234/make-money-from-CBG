const HOST = "com.cbg.access_bridge";
const ORIGIN = "https://xyq.cbg.163.com";
const STORAGE_REVISION = 2;
let port,
  flushing = false,
  inFlightAt = 0,
  ackTimer,
  chain = Promise.resolve(),
  statePromise,
  automaticFlight = null,
  automaticAgain = false,
  automaticSelection = 0,
  userFocusPending = 0,
  announcedPort = null;
const rates = new Map();
const serial = (fn) => {
  chain = chain.then(fn, fn);
  return chain;
};
async function state() {
  return (statePromise ??= (async () => {
    const saved = (await chrome.storage.local.get("bridge")).bridge;
    if (saved) {
      const outbox = Array.isArray(saved.outbox) ? saved.outbox : [];
      const startsAfterGap = Number.isSafeInteger(outbox[0]?.sequence) && outbox[0].sequence > 1;
      const onlyDiscardable = outbox.every((message) =>
        ["status", "snapshot"].includes(message.kind),
      );
      if (saved.storageRevision !== STORAGE_REVISION && startsAfterGap && onlyDiscardable) {
        // A prior worker can persist read-only messages before this server has
        // committed any receipt for that epoch. Those messages begin after 1,
        // so BridgeStore correctly rejects them as a sequence gap. Replace only
        // this disposable status/snapshot backlog with a clean read-only epoch;
        // never discard proof/result messages or an explicit user pause.
        const next = {
          version: 1,
          storageRevision: STORAGE_REVISION,
          connectionEpoch: crypto.randomUUID(),
          nextSequence: 1,
          outbox: [],
          bound: null,
          stopped: true,
          autoPaused: saved.autoPaused === true,
          controlRevision:
            (Number.isSafeInteger(saved.controlRevision) ? saved.controlRevision : 0) + 1,
        };
        await chrome.storage.local.set({ bridge: next });
        return next;
      }
      if (saved.storageRevision !== STORAGE_REVISION) {
        const next = { ...saved, storageRevision: STORAGE_REVISION };
        await chrome.storage.local.set({ bridge: next });
        return next;
      }
      return saved;
    }
    const next = {
      version: 1,
      storageRevision: STORAGE_REVISION,
      connectionEpoch: crypto.randomUUID(),
      nextSequence: 1,
      outbox: [],
      bound: null,
      stopped: true,
      autoPaused: false,
    };
    await chrome.storage.local.set({ bridge: next });
    return next;
  })());
}
const save = (value) => chrome.storage.local.set({ bridge: value });
const bindingIdentity = (bound) =>
  bound && {
    pageId: bound.pageId,
    pageGeneration: bound.pageGeneration,
    tabId: bound.tabId,
    windowId: bound.windowId,
    bindingEpoch: bound.bindingEpoch,
  };
async function stopTransport(value, reason) {
  const bound = value.bound && { ...value.bound },
    revision = (value.controlRevision || 0) + 1,
    failedPort = port;
  value.stopped = true;
  value.observing = false;
  value.controlRevision = revision;
  delete value.navigation;
  // The bounded outbox cannot carry another stop. Close this Native connection
  // before storage or a hung content script can delay revoking the input helper.
  if (port === failedPort) port = null;
  flushing = false;
  clearTimeout(ackTimer);
  try {
    failedPort?.disconnect();
  } catch {
    // An already-closed connection has already revoked its host/helper.
  }
  await save(value);
  if (bound && value.controlRevision === revision)
    await chrome.tabs
      .sendMessage(bound.tabId, { kind: "stop", observerToken: bound.observerToken })
      .catch(() => {});
  throw new Error(reason);
}
async function enqueue(kind, payload) {
  await serial(async () => {
    const value = await state();
    if (value.outbox.length >= 128) return stopTransport(value, "bridge-buffer-full");
    if (JSON.stringify(payload).length > 450000) return stopTransport(value, "bridge-message-size");
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
  const connectedPort = (port = chrome.runtime.connectNative(HOST));
  connectedPort.onDisconnect.addListener(() => {
    if (port !== connectedPort) return;
    port = null;
    announcedPort = null;
    flushing = false;
    clearTimeout(ackTimer);
    void serial(async () => {
      if (port && port !== connectedPort) return;
      const value = await state();
      if (port && port !== connectedPort) return;
      const bound = value.bound && { ...value.bound },
        revision = (value.controlRevision || 0) + 1;
      value.stopped = true;
      value.observing = false;
      value.controlRevision = revision;
      delete value.navigation;
      delete value.parent;
      value.authority = null;
      await save(value);
      if (bound && value.controlRevision === revision)
        await chrome.tabs
          .sendMessage(bound.tabId, { kind: "stop", observerToken: bound.observerToken })
          .catch(() => {});
    });
  });
  connectedPort.onMessage.addListener((message) => {
    if (port !== connectedPort) return;
    if (message.kind === "ack")
      void serial(async () => {
        if (port !== connectedPort) return;
        const value = await state();
        if (port !== connectedPort) return;
        if (
          message.connectionEpoch !== value.connectionEpoch ||
          value.outbox[0]?.messageId !== message.messageId
        )
          return;
        value.outbox.shift();
        await save(value);
        if (port !== connectedPort) return;
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
async function restoreObservation(value, commandPort) {
  const revision = value.controlRevision || 0,
    bound = value.bound;
  const stillCurrent = () =>
    (value.controlRevision || 0) === revision && value.bound === bound && port === commandPort;
  if (!bound) throw new Error("observation-unbound");
  const current = await chrome.tabs.get(bound.tabId);
  if (!stillCurrent()) throw new Error("observation-generation-changed");
  if (new URL(current.url).origin !== ORIGIN) throw new Error("observation-origin-mismatch");
  value.observing = true;
  const observed = await chrome.tabs.sendMessage(bound.tabId, {
    kind: "bind",
    context: value.observerContext,
  });
  if (!stillCurrent()) {
    if (typeof observed?.observerToken === "string")
      await chrome.tabs
        .sendMessage(bound.tabId, { kind: "stop", observerToken: observed.observerToken })
        .catch(() => {});
    throw new Error("observation-generation-changed");
  }
  bound.observerToken = observed?.observerToken;
  await save(value);
  if (!stillCurrent()) throw new Error("observation-generation-changed");
  await chrome.tabs.sendMessage(bound.tabId, {
    kind: "capture",
    observerToken: observed?.observerToken,
  });
  if (!stillCurrent()) throw new Error("observation-generation-changed");
}
async function command(message) {
  const value = await state(),
    plan = message.plan;
  const commandPort = port;
  const reply = (result) => {
    if (port === commandPort) commandPort?.postMessage(result);
  };
  if (message.command === "stop") {
    const bound = value.bound && { ...value.bound },
      revision = (value.controlRevision = (value.controlRevision || 0) + 1);
    value.stopped = true;
    value.observing = false;
    delete value.navigation;
    await save(value);
    if (bound && value.controlRevision === revision)
      await chrome.tabs
        .sendMessage(bound.tabId, { kind: "stop", observerToken: bound.observerToken })
        .catch(() => {});
    if (value.controlRevision === revision && value.stopped)
      reply({ kind: "command-result", actionId: message.actionId, ok: true });
    return;
  }
  try {
    if (message.command === "focus") {
      const bound = value.bound,
        context = message.context,
        revision = value.controlRevision || 0;
      const stillCurrent = () =>
        port === commandPort && value.bound === bound && (value.controlRevision || 0) === revision;
      if (value.autoPaused) throw new Error("focus-manually-paused");
      if (
        !bound ||
        !context ||
        context.pageId !== bound.pageId ||
        context.pageGeneration !== bound.pageGeneration ||
        context.tabId !== bound.tabId ||
        context.windowId !== bound.windowId ||
        context.bindingEpoch !== bound.bindingEpoch ||
        context.connectionEpoch !== value.connectionEpoch
      )
        throw new Error("focus-binding-mismatch");
      const current = await chrome.tabs.get(bound.tabId);
      if (
        !stillCurrent() ||
        !eligibleTab(current) ||
        current.windowId !== bound.windowId ||
        current.url.split("#")[0] !== context.url
      )
        throw new Error("focus-page-changed");
      userFocusPending++;
      automaticSelection++;
      try {
        if (!value.observing) await restoreObservation(value, commandPort);
        if (!stillCurrent()) throw new Error("focus-generation-changed");
        await chrome.windows.update(bound.windowId, { state: "normal", focused: true });
        if (!stillCurrent()) throw new Error("focus-generation-changed");
        await chrome.tabs.update(bound.tabId, { active: true });
        if (!stillCurrent()) throw new Error("focus-generation-changed");
        const verified = await chrome.tabs.get(bound.tabId);
        if (
          !stillCurrent() ||
          !eligibleTab(verified) ||
          verified.windowId !== bound.windowId ||
          verified.url.split("#")[0] !== context.url ||
          !verified.active
        )
          throw new Error("focus-page-changed");
        reply({ kind: "command-result", actionId: message.actionId, ok: true, posted: false });
      } finally {
        userFocusPending--;
      }
      return;
    }
    if (message.command === "observe") {
      await restoreObservation(value, commandPort);
      reply({
        kind: "command-result",
        actionId: message.actionId,
        ok: true,
        posted: false,
      });
      return;
    }
    if (message.command === "resume") {
      if (value.autoPaused) throw new Error("recovery-manually-paused");
      const revision = (value.controlRevision = (value.controlRevision || 0) + 1);
      const bound = value.bound;
      const stillCurrent = () =>
        value.controlRevision === revision && value.bound === bound && port === commandPort;
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
      const current = await chrome.tabs.get(bound.tabId);
      if (!stillCurrent()) throw new Error("recovery-generation-changed");
      const window = await chrome.windows.get(current.windowId);
      if (!stillCurrent()) throw new Error("recovery-generation-changed");
      if (!current.active || !window.focused || new URL(current.url).origin !== ORIGIN)
        throw new Error("recovery-foreground-mismatch");
      value.observerContext = message.context;
      value.observing = true;
      const observed = await chrome.tabs.sendMessage(current.id, {
        kind: "bind",
        context: message.context,
      });
      if (!stillCurrent()) {
        if (typeof observed?.observerToken === "string")
          await chrome.tabs
            .sendMessage(current.id, { kind: "stop", observerToken: observed.observerToken })
            .catch(() => {});
        throw new Error("recovery-generation-changed");
      }
      bound.observerToken = observed?.observerToken;
      value.stopped = false;
      await save(value);
      if (!stillCurrent() || value.stopped) throw new Error("recovery-generation-changed");
      reply({
        kind: "command-result",
        actionId: message.actionId,
        ok: true,
        posted: false,
      });
      if (stillCurrent() && !value.stopped)
        await chrome.tabs.sendMessage(current.id, {
          kind: "capture",
          observerToken: observed?.observerToken,
        });
      return;
    }
    if (
      value.stopped ||
      value.observing === false ||
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
      reply({
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
    reply({ kind: "command-proof", actionId: plan.actionId, proof: verified.proof });
  } catch (error) {
    reply({
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
      value.observing === false ||
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
const eligibleTab = (tab) => {
  try {
    const url = new URL(tab?.url);
    return (
      !!tab?.id &&
      url.origin === ORIGIN &&
      !url.username &&
      !url.password &&
      !/login|pay|order|purchase|account/i.test(url.pathname) &&
      !/login|logout|pay|purchase|order|account/i.test(url.searchParams.get("act") || "")
    );
  } catch {
    return false;
  }
};
chrome.action.onClicked.addListener(async (tab) => {
  if (!eligibleTab(tab)) return;
  const value = await state();
  if (!value.stopped) {
    value.autoPaused = true;
    const binding = bindingIdentity(value.bound),
      revision = (value.controlRevision || 0) + 1;
    await command({ command: "stop", actionId: crypto.randomUUID() });
    if (value.controlRevision !== revision || !value.stopped) return;
    await enqueue("status", { ...binding, stopped: true, reason: "user-stop" });
    if (value.controlRevision !== revision || !value.stopped) return;
    await chrome.action.setBadgeText({ text: "停" });
    return;
  }
  value.autoPaused = false;
  await save(value);
  await bindTab(tab);
});
async function bindTab(tab, selection) {
  const value = await state();
  const revision = (value.controlRevision = (value.controlRevision || 0) + 1);
  value.stopped = true;
  const stillCurrent = () =>
    value.controlRevision === revision &&
    value.stopped &&
    (selection === undefined || (selection === automaticSelection && !value.autoPaused));
  value.authority = null;
  if (value.bound && value.bound.tabId !== tab.id)
    await chrome.tabs
      .sendMessage(value.bound.tabId, { kind: "unbind", observerToken: value.bound.observerToken })
      .catch(() => {});
  if (!stillCurrent()) return;
  value.observing = true;
  delete value.observerContext;
  const bound = await chrome.tabs.sendMessage(tab.id, { kind: "bind" });
  if (!stillCurrent()) {
    if (typeof bound?.observerToken === "string")
      await chrome.tabs
        .sendMessage(tab.id, { kind: "stop", observerToken: bound.observerToken })
        .catch(() => {});
    return;
  }
  delete value.pendingRebind;
  value.bound = {
    tabId: tab.id,
    windowId: tab.windowId,
    url: tab.url,
    bindingEpoch: crypto.randomUUID(),
    ...bound,
  };
  value.stopped = false;
  delete value.navigation;
  delete value.parent;
  const binding = value.bound;
  const stillBound = () =>
    value.controlRevision === revision &&
    value.bound === binding &&
    !value.stopped &&
    (selection === undefined || (selection === automaticSelection && !value.autoPaused));
  await save(value);
  if (!stillBound()) return;
  await connect();
  if (!stillBound()) return;
  await chrome.action.setBadgeText({ text: "读" });
  if (!stillBound()) return;
  await enqueue("status", {
    bound: true,
    ...bound,
    tabId: tab.id,
    windowId: tab.windowId,
    bindingEpoch: binding.bindingEpoch,
  });
  if (stillBound()) announcedPort = port;
}
async function reconcileAutomaticBinding(selection) {
  if (typeof chrome.tabs.query !== "function") return;
  const value = await state();
  if (value.autoPaused || userFocusPending || selection !== automaticSelection) return;
  let revision = value.controlRevision || 0;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (
    value.autoPaused ||
    selection !== automaticSelection ||
    (value.controlRevision || 0) !== revision
  )
    return;
  if (!eligibleTab(tab)) return;
  // Binding only enables bounded, read-only snapshots. Actual input commands
  // independently require the official tab and its Chrome window to be focused.
  if (
    value.autoPaused ||
    selection !== automaticSelection ||
    (value.controlRevision || 0) !== revision
  )
    return;
  if (value.navigation) {
    const navigation = value.navigation;
    const live =
      !value.stopped &&
      port &&
      announcedPort === port &&
      navigation.controlRevision === revision &&
      Date.now() >= navigation.createdAt &&
      Date.now() - navigation.createdAt <= 20000;
    if (live) return;
    const oldBinding = bindingIdentity(value.bound);
    await command({ command: "stop", actionId: crypto.randomUUID() });
    revision = value.controlRevision || 0;
    await enqueue("status", { ...oldBinding, stopped: true, reason: "automatic-stale-navigation" });
    if (
      selection !== automaticSelection ||
      value.autoPaused ||
      value.navigation ||
      value.controlRevision !== revision
    )
      return;
  }
  if (
    value.observing === true &&
    value.bound?.tabId === tab.id &&
    value.bound.windowId === tab.windowId &&
    value.bound.url === tab.url &&
    port &&
    announcedPort === port
  )
    return;
  const [current] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (
    current?.id !== tab.id ||
    current.url !== tab.url ||
    value.autoPaused ||
    value.navigation ||
    selection !== automaticSelection ||
    (value.controlRevision || 0) !== revision
  )
    return;
  if (
    value.bound &&
    (value.bound.tabId !== tab.id ||
      value.bound.url !== tab.url ||
      value.bound.windowId !== tab.windowId)
  ) {
    const oldBinding = bindingIdentity(value.bound);
    await command({ command: "stop", actionId: crypto.randomUUID() });
    const stoppedRevision = value.controlRevision;
    await enqueue("status", { ...oldBinding, stopped: true, reason: "automatic-page-change" });
    if (
      value.autoPaused ||
      value.navigation ||
      selection !== automaticSelection ||
      value.controlRevision !== stoppedRevision
    )
      return;
  }
  if (selection !== automaticSelection) return;
  const [selected] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (
    selected?.id !== tab.id ||
    selected.url !== tab.url ||
    selection !== automaticSelection ||
    value.autoPaused ||
    value.navigation
  )
    return;
  await bindTab(tab, selection);
}
function scheduleAutomaticBinding() {
  automaticSelection++;
  automaticAgain = true;
  if (automaticFlight) return automaticFlight;
  automaticFlight = (async () => {
    while (automaticAgain) {
      automaticAgain = false;
      try {
        await reconcileAutomaticBinding(automaticSelection);
      } catch {
        // A pre-install document has no receiver. The next full page load or
        // reconnect retries; never inject into an unrelated page or run input.
        await chrome.action.setBadgeText({ text: "!" }).catch(() => {});
      }
    }
  })().finally(() => {
    automaticFlight = null;
  });
  return automaticFlight;
}
async function finishedNavigation(tabId) {
  const value = await state(),
    navigation = value.navigation;
  if (!navigation || Date.now() - navigation.createdAt > 20000 || value.stopped) return;
  const stillCurrent = () =>
    value.navigation === navigation &&
    !value.stopped &&
    (value.controlRevision || 0) === navigation.controlRevision;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!stillCurrent()) return;
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
  const releaseStaleObservation = async () => {
    if (typeof bound?.observerToken === "string")
      await chrome.tabs
        .sendMessage(tab.id, { kind: "stop", observerToken: bound.observerToken })
        .catch(() => {});
  };
  if (!bound || !stillCurrent()) {
    await releaseStaleObservation();
    return;
  }
  if (value.bound?.tabId !== tab.id && value.bound)
    await chrome.tabs
      .sendMessage(value.bound.tabId, { kind: "unbind", observerToken: value.bound.observerToken })
      .catch(() => {});
  if (!stillCurrent()) {
    await releaseStaleObservation();
    return;
  }
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
    url: tab.url,
    bindingEpoch: navigation.bindingEpoch,
    ...bound,
  };
  delete value.navigation;
  announcedPort = port;
  const binding = value.bound;
  const stillBound = () =>
    value.bound === binding &&
    !value.stopped &&
    (value.controlRevision || 0) === navigation.controlRevision;
  await save(value);
  if (!stillBound()) return;
  await enqueue("status", {
    navigated: true,
    ...bound,
    actionId: navigation.plan.actionId,
    tabId: tab.id,
    windowId: tab.windowId,
    bindingEpoch: binding.bindingEpoch,
  });
  if (!stillBound()) return;
  await chrome.tabs
    .sendMessage(tab.id, { kind: "capture", observerToken: bound.observerToken })
    .catch(() => {});
}
async function rebindAfterNavigation(tabId) {
  let value = await state();
  const pending = value.pendingRebind;
  if (
    !pending ||
    pending.tabId !== tabId ||
    value.autoPaused ||
    userFocusPending ||
    value.navigation
  )
    return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  value = await state();
  if (value.pendingRebind !== pending || value.autoPaused || userFocusPending || value.navigation)
    return;
  if (!tab) {
    delete value.pendingRebind;
    await save(value);
    return;
  }
  if (!eligibleTab(tab)) return;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  value = await state();
  if (value.pendingRebind !== pending || value.autoPaused || userFocusPending || value.navigation)
    return;
  if (active && active.id !== tabId && eligibleTab(active)) {
    await bindTab(active);
    return;
  }
  if (value.bound && value.bound.tabId !== tabId) {
    delete value.pendingRebind;
    await save(value);
    return;
  }
  // Page observation is read-only and may resume in a background CBG tab.
  // Input commands still independently require the official tab and window
  // to be foregrounded before they can receive authority.
  await bindTab(tab);
}
chrome.tabs.onUpdated.addListener((tabId, info) => {
  void (async () => {
    const value = await state();
    if (info.status === "loading" && value.bound?.tabId === tabId && !value.navigation) {
      const bound = value.bound,
        revision = (value.controlRevision = (value.controlRevision || 0) + 1);
      value.pendingRebind = {
        tabId,
        windowId: bound.windowId,
        bindingEpoch: bound.bindingEpoch,
        createdAt: Date.now(),
      };
      value.stopped = true;
      value.observing = false;
      value.bound = null;
      await save(value);
      if (value.controlRevision !== revision) return;
      await chrome.tabs
        .sendMessage(tabId, { kind: "unbind", observerToken: bound.observerToken })
        .catch(() => {});
      if (value.controlRevision !== revision) return;
      await enqueue("status", {
        ...bindingIdentity(bound),
        stopped: true,
        reason: "unexpected-navigation-rebind-required",
      });
    }
    if (info.status === "complete") {
      await finishedNavigation(tabId);
      await rebindAfterNavigation(tabId);
      await scheduleAutomaticBinding();
    } else if (info.url && info.status !== "loading") await scheduleAutomaticBinding();
  })();
});
chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    const value = await state();
    if (value.navigation && tab.openerTabId === value.navigation.fromTabId) {
      const navigation = value.navigation;
      navigation.childTabId = tab.id;
      await save(value);
      if (
        value.navigation !== navigation ||
        value.stopped ||
        (value.controlRevision || 0) !== navigation.controlRevision
      )
        return;
      await finishedNavigation(tab.id);
      return;
    }
    if (eligibleTab(tab)) await scheduleAutomaticBinding();
  })();
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const value = await state();
    if (value.pendingRebind?.tabId === tabId) {
      delete value.pendingRebind;
      await save(value);
    }
    if (value.bound?.tabId !== tabId) return;
    if (
      value.navigation?.plan.target.kind === "return-to-list" &&
      value.parent?.childTabId === tabId
    ) {
      await finishedNavigation(value.parent.tabId);
      return;
    }
    const bound = value.bound;
    value.controlRevision = (value.controlRevision || 0) + 1;
    value.stopped = true;
    value.observing = false;
    value.bound = null;
    await save(value);
    await enqueue("status", {
      ...bindingIdentity(bound),
      stopped: true,
      reason: "bound-tab-closed",
    });
  })();
});
chrome.alarms.create("bridge-reconnect", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => {
  void flush();
  void scheduleAutomaticBinding();
});
chrome.tabs.onActivated?.addListener(() => {
  void scheduleAutomaticBinding();
});
chrome.windows.onFocusChanged?.addListener(() => {
  void scheduleAutomaticBinding();
});
chrome.runtime.onInstalled?.addListener(() => {
  void scheduleAutomaticBinding();
});
chrome.runtime.onStartup?.addListener(() => {
  void scheduleAutomaticBinding();
});
void flush();
void scheduleAutomaticBinding();

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
