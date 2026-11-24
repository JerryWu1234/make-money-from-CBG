import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessPhysicalTakeover,
  validPhysicalIntent,
} from "./native-physical-takeover-evidence.mjs";

const base = Date.UTC(2026, 10, 17);
const iso = (ms) => new Date(ms).toISOString();
function records() {
  const scope = { observerPid: 10, hostPid: 20, helperPid: 30 };
  const lease = {
    activityId: "activity",
    authorizationEpoch: 1,
    stopEpoch: 0,
    browserSessionEpoch: "session",
    hostGeneration: 3,
    hostInstanceEpoch: "host-instance",
  };
  const request = {
    ...scope,
    rowIndex: 0,
    startRowIndex: 0,
    sequence: 1,
    receivedAt: base,
    direction: "host-to-helper",
    message: {
      command: "activity-begin",
      actionId: "begin",
      hostGeneration: 3,
      hostInstanceEpoch: "host-instance",
      activity: { ...lease },
    },
  };
  const ack = {
    ...scope,
    rowIndex: 1,
    sequence: 2,
    receivedAt: base + 10,
    direction: "helper-to-host",
    message: { actionId: "begin", activityId: "activity", ok: true, active: true, error: "" },
  };
  const invalidation = {
    ...scope,
    rowIndex: 3,
    sequence: 4,
    receivedAt: base + 5020,
    direction: "helper-to-host",
    message: {
      ...lease,
      kind: "activity-invalidated",
      reason: "input-stopped-or-user-preempted",
      inputPreemption: {
        diagnosticSchema: 2,
        recordScope: "first-preemption-in-helper-process",
        helperPid: 30,
        authorizationEpoch: 1,
        eventType: 5,
        ownsInput: true,
        tapDisabled: false,
        userData: 0,
        sourcePid: 0,
        sourceStateID: 1,
        grantTimestampNs: "1000000000",
        eventTimestampNs: "6000000000",
        callbackTimestampNs: "6001000000",
        mouse: { locationAvailable: true, location: { x: 300, y: 400 }, deltaX: 2, deltaY: 1 },
      },
    },
  };
  return {
    intent: {
      statement: "可以开始，我会在提示后只移动一次",
      receivedAt: iso(base - 1000),
      inputKind: "trackpad-move",
      inputDevice: "built-in-trackpad",
      oneActionOnly: true,
    },
    window: {
      id: "fresh-window",
      inputKind: "trackpad-move",
      openedAt: base + 4000,
      noticeShownAt: base + 4001,
      closesAt: base + 24000,
      stoppedNoticeAt: base + 5030,
    },
    grant: { request, ack },
    invalidation,
    lease,
    helperPid: 30,
    inactive: {
      ok: true,
      activity: { active: false, expired: false, lease: {} },
      inputPreemption: structuredClone(invalidation.message.inputPreemption),
    },
    attestation: {
      windowId: "fresh-window",
      inputKind: "trackpad-move",
      statement: "看到提示后我亲自移动一次，随后看到已停止，没有其他操作",
      receivedAt: iso(base + 6000),
      actionOnceAfterPrompt: true,
      stopObservedAfterAction: true,
      noOtherInput: true,
    },
    timing: { elapsedWallMs: 5020, elapsedMonotonicMs: 5020 },
    transportRows: [],
    messages: [request, ack, invalidation],
  };
}

await test("aligns a human-confirmed move with the actual stop while retaining producer uncertainty", () => {
  const result = assessPhysicalTakeover(records());
  assert.equal(result.status, "verified");
  assert.deepEqual(result.eventInterval, { earliest: base + 5000, latest: base + 5010 });
  assert.equal(result.producerIdentityProven, false);
  assert.equal(result.strictCausationProven, false);
});
await test("accepts the real raw helper activity ACK shape without the host-added input-result kind", () => {
  const r = records();
  assert.equal(Object.hasOwn(r.grant.ack.message, "kind"), false);
  assert.equal(assessPhysicalTakeover(r).status, "verified");
});

for (const [name, mutate] of [
  [
    "file signal without an actual user intent",
    (r) => {
      r.intent.statement = "";
    },
  ],
  [
    "stale intent",
    (r) => {
      r.intent.receivedAt = iso(base - 700000);
    },
  ],
  [
    "future intent",
    (r) => {
      r.intent.receivedAt = iso(base + 5000);
    },
  ],
  [
    "other input device",
    (r) => {
      r.intent.inputDevice = "synthetic";
    },
  ],
  [
    "no post-action reply",
    (r) => {
      delete r.attestation;
    },
  ],
  [
    "user did not move",
    (r) => {
      r.attestation.actionOnceAfterPrompt = false;
    },
  ],
  [
    "stopped before the user moved",
    (r) => {
      r.attestation.stopObservedAfterAction = false;
    },
  ],
  [
    "multiple or uncertain operations",
    (r) => {
      r.attestation.noOtherInput = false;
    },
  ],
  [
    "empty actual reply",
    (r) => {
      r.attestation.statement = "";
    },
  ],
  [
    "reply from another window",
    (r) => {
      r.attestation.windowId = "old";
    },
  ],
  [
    "reply predating stopped notice",
    (r) => {
      r.attestation.receivedAt = iso(base + 5000);
    },
  ],
  [
    "reply after its bounded deadline",
    (r) => {
      r.attestation.receivedAt = iso(base + 70000);
    },
  ],
  [
    "a pre-window event reported inside the window",
    (r) => {
      r.invalidation.message.inputPreemption.eventTimestampNs = "4000000000";
    },
  ],
  [
    "an event before the visible prompt",
    (r) => {
      r.window.noticeShownAt = base + 5001;
    },
  ],
  [
    "an event after the action window",
    (r) => {
      r.invalidation.message.inputPreemption.eventTimestampNs = "26000000000";
      r.invalidation.message.inputPreemption.callbackTimestampNs = "26001000000";
      r.invalidation.receivedAt = base + 25020;
    },
  ],
  [
    "an event reported too late",
    (r) => {
      r.invalidation.receivedAt = base + 27000;
      r.window.stoppedNoticeAt = base + 27010;
    },
  ],
  [
    "an event predating its grant",
    (r) => {
      r.invalidation.message.inputPreemption.eventTimestampNs = "999999999";
    },
  ],
  [
    "tap disabled instead of user takeover",
    (r) => {
      r.invalidation.message.inputPreemption.tapDisabled = true;
    },
  ],
  [
    "keyboard event instead of instructed move",
    (r) => {
      r.invalidation.message.inputPreemption.eventType = 10;
    },
  ],
  [
    "a marked own event",
    (r) => {
      r.invalidation.message.inputPreemption.userData = 0x43424741;
    },
  ],
  [
    "idle event",
    (r) => {
      r.invalidation.message.inputPreemption.ownsInput = false;
    },
  ],
  [
    "zero-delta source-unknown event",
    (r) => {
      r.invalidation.message.inputPreemption.mouse.deltaX = 0;
      r.invalidation.message.inputPreemption.mouse.deltaY = 0;
    },
  ],
  [
    "wrong helper",
    (r) => {
      r.invalidation.helperPid++;
    },
  ],
  [
    "wrong activity",
    (r) => {
      r.invalidation.message.activityId = "other";
    },
  ],
  [
    "wrong authorization epoch",
    (r) => {
      r.invalidation.message.inputPreemption.authorizationEpoch++;
    },
  ],
  [
    "wrong host generation",
    (r) => {
      r.invalidation.message.hostGeneration++;
    },
  ],
  [
    "expiry rather than a physical stop",
    (r) => {
      r.invalidation.message.reason = "native-workflow-activity-expired";
    },
  ],
  [
    "an active helper after alleged stop",
    (r) => {
      r.inactive.activity.active = true;
    },
  ],
  [
    "an uncleared lease",
    (r) => {
      r.inactive.activity.lease = { activityId: "activity" };
    },
  ],
  [
    "inactive status from a different helper",
    (r) => {
      r.inactive.inputPreemption.helperPid++;
    },
  ],
  [
    "a fabricated cleared-array lease",
    (r) => {
      r.inactive.activity.lease = [];
    },
  ],
  [
    "a non-boolean ACK",
    (r) => {
      r.grant.ack.message.active = "true";
    },
  ],
  [
    "missing receipt clock",
    (r) => {
      delete r.grant.request.receivedAt;
    },
  ],
  [
    "both matching action IDs missing",
    (r) => {
      delete r.grant.request.message.actionId;
      delete r.grant.ack.message.actionId;
    },
  ],
  [
    "boolean clock durations",
    (r) => {
      r.timing.elapsedWallMs = false;
      r.timing.elapsedMonotonicMs = false;
    },
  ],
  [
    "boolean mouse coordinates",
    (r) => {
      r.invalidation.message.inputPreemption.mouse.location.x = false;
      r.invalidation.message.inputPreemption.mouse.location.y = true;
    },
  ],
  [
    "non-finite ACK clock",
    (r) => {
      r.grant.ack.receivedAt = NaN;
    },
  ],
  [
    "non-finite invalidation clock",
    (r) => {
      r.invalidation.receivedAt = Infinity;
    },
  ],
  [
    "missing message order",
    (r) => {
      delete r.invalidation.rowIndex;
    },
  ],
  [
    "missing record sequence",
    (r) => {
      delete r.grant.ack.sequence;
    },
  ],
  [
    "missing stop notice clock",
    (r) => {
      delete r.window.stoppedNoticeAt;
    },
  ],
  [
    "missing window id in both files",
    (r) => {
      delete r.window.id;
      delete r.attestation.windowId;
    },
  ],
  [
    "non-string event clock",
    (r) => {
      r.invalidation.message.inputPreemption.eventTimestampNs = true;
    },
  ],
  [
    "wall clock moved during the action",
    (r) => {
      r.timing.elapsedWallMs += 101;
    },
  ],
  [
    "a signal in the observation window",
    (r) => {
      r.transportRows.push({
        observerPid: 10,
        sequence: 3,
        receivedAt: base + 4500,
        event: "signal",
      });
    },
  ],
  [
    "a signal after grant but before the visible window",
    (r) => {
      r.transportRows.push({
        observerPid: 10,
        hostPid: 20,
        helperPid: 30,
        sequence: 3,
        receivedAt: r.window.openedAt - 1,
        event: "signal",
        signal: "SIGUSR1",
      });
    },
  ],
  [
    "a stop after grant but before the visible window",
    (r) => {
      r.messages.push({
        observerPid: 10,
        hostPid: 20,
        helperPid: 30,
        direction: "host-to-helper",
        rowIndex: 2,
        sequence: 3,
        receivedAt: r.window.openedAt - 1,
        message: { command: "stop" },
      });
    },
  ],
  [
    "a harness stop command in the observation window",
    (r) => {
      r.messages.push({
        observerPid: 10,
        hostPid: 20,
        helperPid: 30,
        sequence: 3,
        direction: "host-to-helper",
        rowIndex: 2,
        receivedAt: base + 4500,
        message: { command: "stop" },
      });
    },
  ],
])
  await test(`does not pass ${String(name)}`, () => {
    const r = records();
    mutate(r);
    const result = assessPhysicalTakeover(r);
    assert.equal(result.status, "inconclusive");
    assert.equal(result.producerIdentityProven, false);
  });

await test("a sourcePid=0 record plus file attestation is insufficient without actual OS records", () => {
  const r = records();
  delete r.invalidation;
  assert.equal(assessPhysicalTakeover(r).status, "inconclusive");
  assert.equal(validPhysicalIntent({ ...r.intent, oneActionOnly: "true" }, base), false);
});

function keyboardRecords() {
  const r = records();
  r.intent.inputKind = r.window.inputKind = r.attestation.inputKind = "keyboard-escape";
  r.intent.inputDevice = "built-in-keyboard";
  r.intent.statement = "可以，我只按一次Esc";
  r.attestation.statement = "我看到等待后亲自按了一次Esc，随后看到已停止，没有其他操作";
  r.invalidation.message.inputPreemption.eventType = 10;
  delete r.invalidation.message.inputPreemption.mouse;
  r.inactive.inputPreemption = structuredClone(r.invalidation.message.inputPreemption);
  r.domEvents = [
    { type: "keydown", id: "price_min", trusted: true, code: "KeyA", keyCode: 65, at: base + 1000 },
    {
      type: "keydown",
      id: "price_min",
      trusted: true,
      code: "Escape",
      keyCode: 27,
      at: base + 5002,
    },
  ];
  return r;
}
await test("aligns user-confirmed Escape with real unmarked keydown, without claiming an observed keycode", () => {
  const r = keyboardRecords(),
    result = assessPhysicalTakeover(r);
  assert.equal(result.status, "verified");
  assert.equal(
    result.osEventProof,
    "helper-unmarked-keydown-no-keycode;fixture-trusted-Escape-code-keyCode27",
  );
  assert.equal(result.domEscape.keyCode, 27);
  assert.equal(result.producerIdentityProven, false);
  assert.equal(result.strictCausationProven, false);
  assert.equal(Object.hasOwn(r.invalidation.message.inputPreemption, "keyCode"), false);
});
await test("first unknown mouse event cannot count as Escape takeover even after a later user Escape reply", () => {
  const r = keyboardRecords();
  r.invalidation.message.inputPreemption.eventType = 5;
  r.inactive.inputPreemption = structuredClone(r.invalidation.message.inputPreemption);
  assert.equal(assessPhysicalTakeover(r).status, "inconclusive");
});
await test("binds the actual reply to the same declared input kind", () => {
  const r = keyboardRecords();
  r.attestation.inputKind = "trackpad-move";
  assert.equal(assessPhysicalTakeover(r).status, "inconclusive");
});
await test("a keydown record without the user's actual Escape confirmation cannot pass", () => {
  const r = keyboardRecords();
  delete r.attestation;
  assert.equal(assessPhysicalTakeover(r).status, "inconclusive");
});

for (const [name, mutate] of [
  [
    "missing actual DOM Escape",
    (r) => {
      r.domEvents = [];
    },
  ],
  [
    "untrusted synthetic DOM Escape",
    (r) => {
      r.domEvents[1].trusted = false;
    },
  ],
  [
    "another first DOM key followed by Escape",
    (r) => {
      r.domEvents.splice(1, 0, { ...r.domEvents[0], at: base + 4500 });
    },
  ],
  [
    "wrong DOM code",
    (r) => {
      r.domEvents[1].code = "KeyA";
    },
  ],
  [
    "missing DOM keyCode",
    (r) => {
      delete r.domEvents[1].keyCode;
    },
  ],
  [
    "DOM Escape outside the visible action window",
    (r) => {
      r.domEvents[1].at = base + 3000;
    },
  ],
  [
    "DOM Escape too late to align with helper",
    (r) => {
      r.domEvents[1].at = base + 7000;
    },
  ],
  [
    "DOM Escape before helper event interval",
    (r) => {
      r.domEvents[1].at = base + 4500;
    },
  ],
])
  await test(`does not pass ${String(name)}`, () => {
    const r = keyboardRecords();
    mutate(r);
    assert.equal(assessPhysicalTakeover(r).status, "inconclusive");
  });
