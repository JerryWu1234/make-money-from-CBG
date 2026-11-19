const marker = 0x43424741;
const text = (value) => typeof value === "string" && value.trim().length > 0;
const date = (value) => (typeof value === "string" ? Date.parse(value) : NaN);
const object = (value) => !!value && typeof value === "object" && !Array.isArray(value);

export function validPhysicalIntent(intent, now) {
  const device =
    intent?.inputKind === "keyboard-escape"
      ? "built-in-keyboard"
      : intent?.inputKind === "trackpad-move"
        ? "built-in-trackpad"
        : null;
  return (
    Number.isFinite(now) &&
    !!device &&
    intent.inputDevice === device &&
    intent.oneActionOnly === true &&
    text(intent.statement) &&
    Number.isFinite(date(intent.receivedAt)) &&
    date(intent.receivedAt) <= now &&
    now - date(intent.receivedAt) <= 10 * 60 * 1000
  );
}

/** Pure acceptance of supplied records. This never observes or generates input. */
export function assessPhysicalTakeover({
  intent,
  window,
  grant,
  invalidation,
  lease,
  helperPid,
  inactive,
  attestation,
  timing,
  transportRows = [],
  messages = [],
  domEvents = [],
}) {
  const inconclusive = (reason, details = {}) => ({
    status: "inconclusive",
    reason,
    producerIdentityProven: false,
    strictCausationProven: false,
    ...details,
  });
  if (!window || !validPhysicalIntent(intent, window.openedAt))
    return inconclusive("missing-current-user-intent");
  if (
    !object(lease) ||
    !text(lease.activityId) ||
    !text(lease.browserSessionEpoch) ||
    !text(lease.hostInstanceEpoch) ||
    !Number.isSafeInteger(lease.authorizationEpoch) ||
    lease.authorizationEpoch < 1 ||
    !Number.isSafeInteger(lease.hostGeneration) ||
    lease.hostGeneration < 1 ||
    !Number.isSafeInteger(lease.stopEpoch) ||
    lease.stopEpoch < 0
  )
    return inconclusive("invalid-original-lease");
  if (
    !text(window.id) ||
    window.inputKind !== intent.inputKind ||
    !Number.isFinite(window.noticeShownAt) ||
    window.noticeShownAt < window.openedAt ||
    window.closesAt - window.openedAt !== 20000
  )
    return inconclusive("invalid-action-window");
  if (
    !object(grant?.request?.message) ||
    !object(grant?.ack?.message) ||
    !object(invalidation?.message)
  )
    return inconclusive("missing-real-helper-records");
  const request = grant.request,
    ack = grant.ack,
    stopped = invalidation.message;
  if (
    typeof request.message.actionId !== "string" ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(request.message.actionId)
  )
    return inconclusive("invalid-grant-action-id");
  if (
    ![helperPid, request.observerPid, request.hostPid, invalidation.sequence].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    return inconclusive("invalid-process-or-record-identity");
  if (
    ![request.receivedAt, ack.receivedAt, invalidation.receivedAt].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    ack.receivedAt > window.openedAt
  )
    return inconclusive("invalid-grant-clock-bracket");
  if (
    ![request, ack, invalidation].every(
      (row) =>
        Number.isSafeInteger(row.rowIndex) &&
        row.rowIndex >= 0 &&
        Number.isSafeInteger(row.sequence) &&
        row.sequence > 0,
    )
  )
    return inconclusive("invalid-record-order");
  if (
    !Number.isSafeInteger(request.startRowIndex) ||
    request.startRowIndex < 0 ||
    request.startRowIndex > request.rowIndex
  )
    return inconclusive("invalid-record-order");
  for (const key of ["observerPid", "hostPid", "helperPid"])
    if (request[key] !== ack[key] || request[key] !== invalidation[key])
      return inconclusive("helper-transport-identity-mismatch");
  const firstGrantSequence = transportRows[request.startRowIndex]?.sequence ?? request.sequence;
  if (
    messages.some(
      (row) =>
        row.observerPid === request.observerPid &&
        (!Number.isSafeInteger(row.rowIndex) ||
          row.rowIndex < 0 ||
          !Number.isSafeInteger(row.sequence) ||
          row.sequence < 1 ||
          !Number.isSafeInteger(row.receivedAt) ||
          row.hostPid !== request.hostPid ||
          row.helperPid !== helperPid ||
          !object(row.message)),
    )
  )
    return inconclusive("invalid-helper-message-metadata");
  const inputCommands = messages.filter(
    (row) =>
      row.observerPid === invalidation.observerPid &&
      row.direction === "host-to-helper" &&
      row.rowIndex >= request.startRowIndex &&
      row.rowIndex <= invalidation.rowIndex,
  );
  if (
    request.helperPid !== helperPid ||
    request.direction !== "host-to-helper" ||
    ack.direction !== "helper-to-host" ||
    invalidation.direction !== "helper-to-host" ||
    request.message.command !== "activity-begin" ||
    ack.message.actionId !== request.message.actionId ||
    ack.message.ok !== true ||
    ack.message.active !== true ||
    ack.message.activityId !== lease?.activityId ||
    request.rowIndex >= ack.rowIndex ||
    ack.rowIndex >= invalidation.rowIndex ||
    request.sequence >= ack.sequence ||
    ack.sequence >= invalidation.sequence
  )
    return inconclusive("unverified-original-grant");
  for (const key of ["activityId", "authorizationEpoch", "stopEpoch", "browserSessionEpoch"])
    if (request.message.activity?.[key] !== lease?.[key] || stopped[key] !== lease?.[key])
      return inconclusive("wrong-activity-scope");
  for (const key of ["hostGeneration", "hostInstanceEpoch"])
    if (request.message[key] !== lease?.[key] || stopped[key] !== lease?.[key])
      return inconclusive("wrong-host-scope");
  if (
    stopped.kind !== "activity-invalidated" ||
    stopped.reason !== "input-stopped-or-user-preempted"
  )
    return inconclusive("stop-not-caused-by-input-preemption");
  const event = stopped.inputPreemption;
  const expectedType = intent.inputKind === "keyboard-escape" ? 10 : 5;
  if (
    !event ||
    event.diagnosticSchema !== 2 ||
    event.recordScope !== "first-preemption-in-helper-process" ||
    event.helperPid !== helperPid ||
    event.authorizationEpoch !== lease.authorizationEpoch ||
    event.eventType !== expectedType ||
    event.ownsInput !== true ||
    event.tapDisabled !== false ||
    !Number.isSafeInteger(event.userData) ||
    event.userData === marker ||
    !Number.isSafeInteger(event.sourcePid) ||
    !Number.isSafeInteger(event.sourceStateID)
  )
    return inconclusive("first-event-does-not-match-the-confirmed-input-kind");
  const mouse = event.mouse;
  if (
    expectedType === 5 &&
    (!mouse ||
      mouse.locationAvailable !== true ||
      !Number.isFinite(mouse.location?.x) ||
      !Number.isFinite(mouse.location?.y) ||
      !Number.isSafeInteger(mouse.deltaX) ||
      !Number.isSafeInteger(mouse.deltaY) ||
      Math.abs(mouse.deltaX) + Math.abs(mouse.deltaY) === 0)
  )
    return inconclusive("mouse-movement-not-positively-observed");
  let delta, callbackDelta;
  try {
    if (
      ![event.eventTimestampNs, event.grantTimestampNs, event.callbackTimestampNs].every(
        (value) => typeof value === "string" && /^\d{1,20}$/.test(value),
      )
    )
      return inconclusive("invalid-event-clock");
    const eventNs = BigInt(event.eventTimestampNs),
      grantNs = BigInt(event.grantTimestampNs),
      callbackNs = BigInt(event.callbackTimestampNs);
    if (grantNs <= 0n || eventNs < grantNs || callbackNs < eventNs)
      return inconclusive("invalid-or-old-event-clock");
    delta = Number(eventNs - grantNs) / 1e6;
    callbackDelta = Number(callbackNs - grantNs) / 1e6;
  } catch {
    return inconclusive("invalid-event-clock");
  }
  if (!Number.isFinite(delta + callbackDelta) || request.receivedAt > ack.receivedAt)
    return inconclusive("invalid-grant-clock-bracket");
  // Only helper's two same-clock timestamps are subtracted. The real begin
  // request/ACK bracket bounds the unknown grant instant on the wall clock.
  const eventInterval = { earliest: request.receivedAt + delta, latest: ack.receivedAt + delta };
  if (
    eventInterval.earliest < Math.max(window.openedAt, window.noticeShownAt) ||
    eventInterval.latest > window.closesAt ||
    invalidation.receivedAt < request.receivedAt + callbackDelta ||
    invalidation.receivedAt > window.closesAt + 2000
  )
    return inconclusive("event-outside-visible-action-window-or-reported-late", { eventInterval });
  if (
    !timing ||
    !Number.isFinite(timing.elapsedWallMs) ||
    !Number.isFinite(timing.elapsedMonotonicMs) ||
    timing.elapsedWallMs < 0 ||
    timing.elapsedMonotonicMs < 0 ||
    Math.abs(timing.elapsedWallMs - timing.elapsedMonotonicMs) > 100
  )
    return inconclusive("wall-clock-timing-uncertain", { eventInterval });
  let domEscape;
  if (expectedType === 10) {
    if (
      !Array.isArray(domEvents) ||
      domEvents.some(
        (row) =>
          row?.type === "keydown" &&
          row.id === "price_min" &&
          row.trusted === true &&
          !Number.isSafeInteger(row.at),
      )
    )
      return inconclusive("invalid-fixture-keydown-clock", { eventInterval });
    domEscape = domEvents.find(
      (row) =>
        row?.type === "keydown" &&
        row.id === "price_min" &&
        row.trusted === true &&
        row.at >= Math.max(window.openedAt, window.noticeShownAt) &&
        row.at <= window.closesAt,
    );
    if (!domEscape || domEscape.code !== "Escape" || domEscape.keyCode !== 27)
      return inconclusive("first-trusted-fixture-keydown-is-not-Escape", { eventInterval });
    if (domEscape.at < eventInterval.earliest - 2 || domEscape.at > eventInterval.latest + 1000)
      return inconclusive("fixture-Escape-not-aligned-with-helper-keydown", { eventInterval });
  }
  if (
    transportRows.some(
      (row) =>
        row.observerPid === invalidation.observerPid &&
        (!Number.isSafeInteger(row.sequence) ||
          !Number.isFinite(row.receivedAt) ||
          (row.sequence >= firstGrantSequence &&
            row.sequence <= invalidation.sequence &&
            row.event !== "data")),
    ) ||
    inputCommands.filter((row) => row.message.command === "activity-begin").length !== 1 ||
    inputCommands.some((row) => {
      const message = row.message;
      if (message.command === "status") return false;
      if (message.command === "activity-begin")
        return message.actionId !== request.message.actionId;
      if (message.command === "activity-renew")
        return (
          message.activity?.activityId !== lease.activityId ||
          message.activity?.authorizationEpoch !== lease.authorizationEpoch ||
          message.hostGeneration !== lease.hostGeneration ||
          message.hostInstanceEpoch !== lease.hostInstanceEpoch
        );
      if (message.command === "execute") return row.receivedAt >= window.openedAt;
      return true;
    })
  )
    return inconclusive("other-stop-authority-or-transport-event-after-grant", { eventInterval });
  if (
    inactive?.ok !== true ||
    inactive.activity?.active !== false ||
    !object(inactive.activity.lease) ||
    Object.keys(inactive.activity.lease).length !== 0 ||
    inactive.inputPreemption?.helperPid !== helperPid ||
    inactive.inputPreemption.eventTimestampNs !== event.eventTimestampNs ||
    inactive.inputPreemption.authorizationEpoch !== event.authorizationEpoch
  )
    return inconclusive("real-helper-revocation-not-confirmed", { eventInterval });
  if (
    !Number.isFinite(window.stoppedNoticeAt) ||
    window.stoppedNoticeAt < invalidation.receivedAt ||
    !attestation ||
    attestation.windowId !== window.id ||
    attestation.inputKind !== intent.inputKind ||
    !text(attestation.statement) ||
    attestation.actionOnceAfterPrompt !== true ||
    attestation.stopObservedAfterAction !== true ||
    attestation.noOtherInput !== true ||
    !Number.isFinite(date(attestation.receivedAt)) ||
    date(attestation.receivedAt) < window.stoppedNoticeAt ||
    date(attestation.receivedAt) > window.stoppedNoticeAt + 60000
  )
    return inconclusive("missing-or-uncertain-post-action-user-attestation", { eventInterval });
  return {
    status: "verified",
    eventInterval,
    scope:
      expectedType === 10
        ? "human-confirmed-Escape-with-aligned-unmarked-keydown-stop"
        : "human-confirmed-physical-movement-with-aligned-real-helper-stop",
    osEventProof:
      expectedType === 10
        ? "helper-unmarked-keydown-no-keycode;fixture-trusted-Escape-code-keyCode27"
        : "unmarked-mouse-move-with-nonzero-delta",
    ...(domEscape ? { domEscape } : {}),
    producerIdentityProven: false,
    strictCausationProven: false,
    limitations:
      "Operator confirmation and OS records are separate evidence. The visible stopped notice is delayed, so a same-kind spontaneous event stopping the helper just before the user's action cannot be excluded. This proves alignment only, not strict causation, a helper-observed keycode, low-level producer, or historical unexplained mouse source. Escape code/keyCode are observed only in the isolated fixture DOM.",
  };
}
