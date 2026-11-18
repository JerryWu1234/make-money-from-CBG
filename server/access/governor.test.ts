import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import {
  AccessGovernor,
  AccessGateError,
  DEFAULT_ACCESS_POLICY,
  type AccessContext,
  type AccessPolicy,
} from "./index";

const databases: DatabaseSync[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(policy: Partial<AccessPolicy> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "cbg-access-"));
  dirs.push(directory);
  const filename = path.join(directory, "app.sqlite");
  let now = 1000000;
  const clock = { now: () => now, monotonic: () => now };
  const connect = () => {
    const db = new DatabaseSync(filename);
    databases.push(db);
    db.exec("PRAGMA journal_mode=WAL");
    return db;
  };
  const db = connect();
  const gate = new AccessGovernor(db, { clock, policy: { ...DEFAULT_ACCESS_POLICY, ...policy } });
  const owner = gate.acquireOwner("owner");
  const context: AccessContext = {
    ...owner,
    stopEpoch: 0,
    runId: "run",
    queryId: "query",
    pageId: "page",
    pageGeneration: 1,
    browserSessionEpoch: "browser",
    sourceKind: "test",
  };
  gate.registerPage(context);
  return {
    gate,
    db,
    context,
    connect,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}
function authorize(gate: AccessGovernor, context: AccessContext) {
  const permit = gate.reserve(context);
  const result = gate.authorize(permit.permitId, context);
  if (!result.authorized) throw new Error(result.reason);
  return permit;
}
function errorCode(fn: () => unknown, code: string) {
  expect(fn).toThrowError(expect.objectContaining({ code }));
}

it("显式用户继续仅清soft暂停，保留unknown账本/证据并用新epoch拒绝旧任务", () => {
  const f = fixture(),
    permit = authorize(f.gate, f.context);
  f.gate.failUnknown(permit.permitId, f.context);
  f.gate.reportRisk({ reason: "manual_stop" });
  const paused = f.gate.reportRisk({ reason: "login" });
  const evidence = f.db
    .prepare("SELECT * FROM access_evidence ORDER BY recorded_at,evidence_id")
    .all();
  const ledger = f.db.prepare("SELECT * FROM access_permits").all();
  const resumed = f.gate.resumeForUser(paused.revision);
  expect(resumed).toMatchObject({
    state: "ready",
    reasons: [],
    revision: paused.revision + 1,
    stopEpoch: paused.stopEpoch + 1,
  });
  expect(f.db.prepare("SELECT * FROM access_permits").all()).toEqual(ledger);
  for (const row of evidence)
    expect(
      f.db.prepare("SELECT * FROM access_evidence WHERE evidence_id=?").get(row.evidence_id),
    ).toEqual(row);
  expect(
    f.db
      .prepare("SELECT reason FROM access_evidence WHERE evidence_id=?")
      .get(resumed.lastEvidenceId!),
  ).toEqual({ reason: "user_resume" });
  errorCode(() => f.gate.reserve(f.context), "stale_stop_epoch");
  const fresh = { ...f.context, stopEpoch: resumed.stopEpoch, pageGeneration: 2 };
  f.gate.registerPage(fresh);
  expect(() => f.gate.reserve(fresh)).not.toThrow();
  errorCode(() => f.gate.resumeForUser(paused.revision), "stale_revision");
});
it.each([
  "verification",
  "http_403",
  "http_429",
  "frequency",
  "clock_anomaly",
  "unexpected_reason",
])("普通用户继续不能清除%s", (reason) => {
  const f = fixture(),
    state = f.gate.reportRisk({ reason });
  errorCode(() => f.gate.resumeForUser(state.revision), "user_recovery_required");
  expect(f.gate.read()).toMatchObject({
    state: state.state,
    revision: state.revision,
    stopEpoch: state.stopEpoch,
    reasons: state.reasons,
  });
});
it("冷却期限过去也不会以soft入口自动清除", () => {
  const f = fixture();
  const state = f.gate.reportRisk({ reason: "login", state: "cooldown" });
  f.advance(DEFAULT_ACCESS_POLICY.fallbackCooldownMs + 1);
  errorCode(() => f.gate.resumeForUser(state.revision), "user_recovery_required");
});
it("新风险与双点击CAS竞争均不被旧继续请求抹掉", () => {
  const f = fixture();
  const first = f.gate.reportRisk({ reason: "login" });
  const current = f.gate.reportRisk({ reason: "verification" });
  errorCode(() => f.gate.resumeForUser(first.revision), "stale_revision");
  expect(f.gate.read().revision).toBe(current.revision);
});
it("有真实授权在途时，即使仅soft原因也不继续", () => {
  const f = fixture();
  const permit = authorize(f.gate, f.context);
  const state = f.gate.reportRisk({ reason: "manual_stop" });
  errorCode(() => f.gate.resumeForUser(state.revision), "inflight_action");
  expect(
    f.db.prepare("SELECT status FROM access_permits WHERE permit_id=?").get(permit.permitId),
  ).toEqual({ status: "dispatch_authorized" });
});
it("Native准备先推进epoch但仍暂停，finish CAS不再次改变已核票据epoch", () => {
  const f = fixture(),
    paused = f.gate.reportRisk({ reason: "login" });
  errorCode(() => f.gate.resumeForUser(paused.revision, paused.stopEpoch), "stale_revision");
  const prepared = f.gate.prepareUserResume(paused.revision);
  expect(prepared).toMatchObject({
    state: "needs_action",
    stopEpoch: paused.stopEpoch + 1,
    revision: paused.revision + 1,
  });
  errorCode(() => f.gate.reserve(f.context), "stale_stop_epoch");
  const ready = f.gate.resumeForUser(prepared.revision, prepared.stopEpoch);
  expect(ready).toMatchObject({
    state: "ready",
    stopEpoch: prepared.stopEpoch,
    revision: prepared.revision + 1,
  });
});
it("Native准备后新风险阻止finish，旧ready状态也能先fence再准备", () => {
  const f = fixture(),
    ready = f.gate.read(),
    prepared = f.gate.prepareUserResume(ready.revision);
  expect(prepared).toMatchObject({ state: "needs_action", stopEpoch: ready.stopEpoch + 1 });
  f.gate.reportRisk({ reason: "verification" });
  errorCode(() => f.gate.resumeForUser(prepared.revision, prepared.stopEpoch), "stale_revision");
  expect(f.gate.read().state).toBe("needs_action");
});

it("moves only an unfinished query after its exact completed navigation permit", async () => {
  const f = fixture();
  f.gate.registerQuery(f.context, { accepted: false });
  const target = { kind: "refresh-list" as const, url: "https://xyq.cbg.163.com/list" };
  const document = { pageId: "fresh-document", pageGeneration: 1 };
  const action = { ...f.context, actionId: "refresh", target };
  errorCode(
    () => f.gate.movePendingQuery(f.context, document, action.actionId, target),
    "query_navigation_not_confirmed",
  );
  const permit = authorize(f.gate, action);
  errorCode(
    () => f.gate.movePendingQuery(f.context, document, action.actionId, target),
    "query_navigation_not_confirmed",
  );
  f.gate.complete(permit.permitId, action);
  errorCode(
    () =>
      f.gate.movePendingQuery(f.context, document, action.actionId, { ...target, url: "wrong" }),
    "query_navigation_not_confirmed",
  );
  const next = f.gate.movePendingQuery(f.context, document, action.actionId, target);
  expect(next).toMatchObject({ ...document, queryId: f.context.queryId, actionId: "refresh" });
  errorCode(() => f.gate.withProgress(next, () => undefined), "query_not_accepted");
  f.gate.registerQuery(next, { accepted: true });
  expect(() => f.gate.withProgress(next, () => undefined)).not.toThrow();
  errorCode(
    () =>
      f.gate.movePendingQuery(
        next,
        { pageId: "third", pageGeneration: 1 },
        action.actionId,
        target,
      ),
    "query_navigation_not_confirmed",
  );
  errorCode(() => f.gate.withProgress(f.context, () => undefined), "stale_page");
});

it("never uses an unrelated completed click or old stop epoch to move a query", () => {
  const f = fixture();
  f.gate.registerQuery(f.context, { accepted: false });
  const click = { ...f.context, actionId: "click", target: { kind: "next-page", currentPage: 1 } };
  f.gate.complete(authorize(f.gate, click).permitId, click);
  const document = { pageId: "new-doc", pageGeneration: 1 };
  const navigation = { kind: "refresh-list" as const, url: "https://xyq.cbg.163.com/list" };
  errorCode(
    () => f.gate.movePendingQuery(f.context, document, click.actionId, navigation),
    "query_navigation_not_confirmed",
  );
  f.gate.reportRisk({ reason: "manual-stop" });
  errorCode(
    () => f.gate.movePendingQuery(f.context, document, click.actionId, navigation),
    "stale_stop_epoch",
  );
  expect(
    f.db.prepare("SELECT page_id FROM access_pages WHERE page_id=?").get(document.pageId),
  ).toBeUndefined();
});

it("persists a union of reasons, Retry-After and stop epochs across connections and restart", () => {
  const f = fixture();
  const other = new AccessGovernor(f.connect(), { clock: f.clock });
  f.gate.reportRisk({ reason: "login" });
  other.reportRisk({ reason: "http_429", retryAfter: "120" });
  const resumed = new AccessGovernor(f.connect(), { clock: f.clock }).read();
  expect(resumed).toMatchObject({
    state: "needs_action",
    stopEpoch: 2,
    revision: 2,
    retryNotBefore: 1120000,
  });
  expect(resumed.reasons.map((r) => r.code)).toEqual(["login", "http_429"]);
  errorCode(() => other.reserve(f.context), "stale_stop_epoch");
});
it("cooldown expiry never resumes automatically and stale human confirmation cannot clear new risk", () => {
  const f = fixture();
  const state = f.gate.reportRisk({ reason: "http_429", retryAfter: "2" });
  errorCode(() => f.gate.beginRecovery(state.revision, f.context), "cooldown_active");
  f.advance(2000);
  expect(f.gate.read().state).toBe("cooldown");
  const token = f.gate.beginRecovery(state.revision, f.context);
  f.gate.reportRisk({ reason: "verification" });
  errorCode(() => f.gate.finishRecovery(token, ["http_429"]), "stale_revision");
  const current = f.gate.read();
  const next = f.gate.beginRecovery(current.revision, f.context);
  errorCode(() => f.gate.finishRecovery(next, ["verification"]), "unresolved_reasons");
  expect(f.gate.finishRecovery(next, ["http_429", "verification"]).state).toBe("ready");
});
it("separate valid owners coexist while all grants share a single site slot", () => {
  const f = fixture({ minIntervalMs: 0 });
  const other = new AccessGovernor(f.connect(), { clock: f.clock });
  const owner = other.acquireOwner("other");
  const context = { ...f.context, ...owner, pageId: "other-page" };
  other.registerPage(context);
  const first = authorize(f.gate, f.context);
  const second = other.reserve(context);
  expect(other.authorize(second.permitId, context)).toMatchObject({
    authorized: false,
    reason: "slot",
  });
  f.gate.complete(first.permitId, f.context);
  expect(other.authorize(second.permitId, context).authorized).toBe(true);
});
it("completed and authorized permits retain window charges after restart and exact boundary is respected", () => {
  const f = fixture({ minIntervalMs: 1000, maxActionsPerWindow: 1, windowMs: 10000 });
  const first = authorize(f.gate, f.context);
  f.gate.complete(first.permitId, f.context);
  f.advance(1000);
  const other = new AccessGovernor(f.connect(), { clock: f.clock });
  const next = other.reserve(f.context);
  expect(other.authorize(next.permitId, f.context)).toMatchObject({
    authorized: false,
    reason: "window",
    retryAt: 1010000,
  });
  f.advance(8999);
  expect(other.authorize(next.permitId, f.context).authorized).toBe(false);
  f.advance(1);
  expect(other.authorize(next.permitId, f.context).authorized).toBe(true);
  errorCode(() => other.authorize(next.permitId, f.context), "permit_not_reserved");
});
it("cancelled reservations do not consume quota, final authorization cannot be refunded", () => {
  const f = fixture({ minIntervalMs: 0, maxActionsPerWindow: 1 });
  const cancelled = f.gate.reserve(f.context);
  f.gate.cancel(cancelled.permitId, f.context);
  const first = authorize(f.gate, f.context);
  errorCode(() => f.gate.cancel(first.permitId, f.context), "authorized_not_cancellable");
  f.gate.complete(first.permitId, f.context);
  const next = f.gate.reserve(f.context);
  expect(f.gate.authorize(next.permitId, f.context)).toMatchObject({
    authorized: false,
    reason: "window",
  });
});
it("expired owner after authorization becomes unknown, persists stop even when the triggering grant is refused", () => {
  const f = fixture({ leaseMs: 1000 });
  const first = authorize(f.gate, f.context);
  f.advance(1001);
  errorCode(() => f.gate.reserve(f.context), "stale_owner");
  const other = new AccessGovernor(f.connect(), { clock: f.clock });
  expect(other.read()).toMatchObject({ state: "needs_action", stopEpoch: 1 });
  expect(other.permit(first.permitId).status).toBe("unknown");
  const owner = other.acquireOwner("owner");
  expect(owner.fence).toBe(2);
  errorCode(() => other.complete(first.permitId, f.context), "stale_owner");
});
it("unknown in-flight outcomes stop ordinary dispatch and cannot be replayed", async () => {
  const f = fixture();
  await expect(
    f.gate.runAction(f.context, async () => {
      throw new Error("transport lost");
    }),
  ).rejects.toThrow("transport lost");
  const state = f.gate.read();
  expect(state.state).toBe("needs_action");
  expect(state.reasons.map((r) => r.code)).toContain("unknown_inflight");
  errorCode(() => f.gate.reserve({ ...f.context, stopEpoch: state.stopEpoch }), "site_paused");
});
it("queued cancellation cleans only its reservation and preserves an existing authorization", async () => {
  const f = fixture();
  const first = authorize(f.gate, f.context);
  const control = new AbortController();
  const waiting = f.gate.waitForPermit(f.context, control.signal);
  control.abort(new Error("cancelled"));
  await expect(waiting).rejects.toThrow("cancelled");
  expect(f.gate.permit(first.permitId).status).toBe("dispatch_authorized");
  expect(
    f.db.prepare("SELECT COUNT(*) AS count FROM access_permits WHERE status='cancelled'").get()!
      .count,
  ).toBe(1);
});
it("wall-clock rollback persists a protective pause and never expires prior budget early", () => {
  const f = fixture();
  const permit = authorize(f.gate, f.context);
  f.gate.complete(permit.permitId, f.context);
  f.setNow(900000);
  errorCode(() => f.gate.reserve(f.context), "stale_stop_epoch");
  expect(f.gate.read()).toMatchObject({ state: "needs_action", lastDispatchAt: 1000000 });
  expect(
    new AccessGovernor(f.connect(), { clock: f.clock }).read().reasons.map((r) => r.code),
  ).toContain("clock_anomaly");
});
it("risk committed by a second DB connection fences business progress prepared before the stop", () => {
  const f = fixture();
  f.db.exec("CREATE TABLE checkpoint(id INTEGER)");
  f.gate.registerQuery(f.context, { accepted: true });
  f.gate.withProgress(f.context, () => f.db.prepare("INSERT INTO checkpoint VALUES(1)").run());
  const other = new AccessGovernor(f.connect(), { clock: f.clock });
  other.reportRisk({ reason: "login" });
  errorCode(
    () =>
      f.gate.withProgress(f.context, () => f.db.prepare("INSERT INTO checkpoint VALUES(2)").run()),
    "stale_stop_epoch",
  );
  expect(f.db.prepare("SELECT * FROM checkpoint").all()).toEqual([{ id: 1 }]);
});
it("progress requires an active transaction, accepted current query, source version and page generation", () => {
  const f = fixture();
  errorCode(() => f.gate.assertProgress(f.context), "transaction_required");
  errorCode(() => f.gate.withProgress(f.context, () => undefined), "query_not_accepted");
  f.gate.registerQuery(f.context, { accepted: true, sourceVersion: "v2" });
  errorCode(
    () => f.gate.withProgress({ ...f.context, sourceVersion: "v1" }, () => undefined),
    "query_not_accepted",
  );
  f.gate.withProgress({ ...f.context, sourceVersion: "v2" }, () => undefined);
  f.gate.registerPage({ ...f.context, pageGeneration: 2 });
  errorCode(() => f.gate.withProgress(f.context, () => undefined), "stale_page");
});
it("suspect has one persistent bounded diagnostic plan whose data cannot advance ordinary progress", () => {
  const f = fixture({ minIntervalMs: 0 });
  const state = f.gate.reportRisk({ reason: "suspect_empty", state: "suspect" });
  const context: AccessContext = {
    ...f.context,
    stopEpoch: state.stopEpoch,
    purpose: "diagnostic",
    diagnosticPlanId: "event",
  };
  errorCode(() => f.gate.reserve(context), "diagnostic_not_allowed");
  f.gate.registerDiagnosticPlan("event", context, 1);
  const first = authorize(f.gate, context);
  f.gate.complete(first.permitId, context);
  const other = new AccessGovernor(f.connect(), { clock: f.clock });
  other.registerDiagnosticPlan("event", context, 1);
  errorCode(() => other.reserve(context), "diagnostic_not_allowed");
  errorCode(() => other.registerQuery(context, { accepted: true }), "query_not_acceptable");
  other.reportRisk({ reason: "verification" });
  errorCode(
    () => other.reserve({ ...context, stopEpoch: other.read().stopEpoch }),
    "diagnostic_not_allowed",
  );
});
it("recovery has separate purpose, bounded budget across tokens, and uses the ordinary global rate budget", () => {
  const f = fixture({ minIntervalMs: 0, maxActionsPerWindow: 10 });
  const state = f.gate.reportRisk({ reason: "login" });
  for (let i = 0; i < 4; i++) {
    const token = f.gate.beginRecovery(state.revision, f.context);
    const context: AccessContext = {
      ...f.context,
      stopEpoch: state.stopEpoch,
      purpose: "recovery",
      recoveryToken: token.token,
    };
    const permit = authorize(f.gate, context);
    f.gate.complete(permit.permitId, context);
  }
  const token = f.gate.beginRecovery(state.revision, f.context);
  errorCode(
    () =>
      f.gate.reserve({
        ...f.context,
        stopEpoch: state.stopEpoch,
        purpose: "recovery",
        recoveryToken: token.token,
      }),
    "recovery_budget_exhausted",
  );
});
it("policy edits persist without clearing reasons or existing window charges", () => {
  const f = fixture();
  authorize(f.gate, f.context);
  const state = f.gate.reportRisk({ reason: "login" });
  const edited = f.gate.updatePolicy(
    { ...state.policy, version: 2, minIntervalMs: 6000 },
    state.revision,
  );
  expect(edited).toMatchObject({
    state: "needs_action",
    stopEpoch: 1,
    policyVersion: 2,
    lastDispatchAt: 1000000,
  });
  expect(edited.reasons.map((r) => r.code)).toEqual(["login"]);
  errorCode(
    () => f.gate.updatePolicy({ ...state.policy, version: 3 }, state.revision),
    "stale_revision",
  );
});
it("unknown schema, missing state and storage write failure fail closed", () => {
  const f = fixture();
  f.db.exec("UPDATE access_schema SET version=99");
  expect(() => new AccessGovernor(f.connect(), { clock: f.clock })).toThrow(AccessGateError);
  errorCode(() => f.gate.read(), "storage_unavailable");
  const second = fixture();
  second.db.exec("PRAGMA query_only=ON");
  errorCode(() => second.gate.reportRisk({ reason: "login" }), "storage_unavailable");
  second.db.exec("PRAGMA query_only=OFF");
  errorCode(() => second.gate.reserve(second.context), "storage_unavailable");
});
it("request observations are deduplicated independently from action counts and redact secrets", () => {
  const f = fixture();
  const summary = {
    url: "https://xyq.cbg.163.com/cgi-bin/recommend.py?token=super-secret&page=2",
    Cookie: "private-cookie",
    message: "Bearer private-secret",
  };
  f.gate.recordRequest(f.context, summary, "request");
  f.gate.recordRequest(f.context, summary, "request");
  expect(f.gate.requestCount(0)).toBe(1);
  const saved = String(
    f.db.prepare("SELECT summary_json FROM access_requests").get()!.summary_json,
  );
  expect(saved).not.toContain("super-secret");
  expect(saved).not.toContain("private-cookie");
  expect(saved).not.toContain("private-secret");
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM access_permits").get()!.count).toBe(0);
});

it("a forward clock jump relative to monotonic time is a persistent manual-action pause", () => {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  let wall = 1000000,
    mono = 0;
  const gate = new AccessGovernor(db, { clock: { now: () => wall, monotonic: () => mono } });
  wall += 600000;
  mono += 1;
  expect(gate.read()).toMatchObject({ state: "needs_action", stopEpoch: 1 });
  expect(gate.read().reasons.map((r) => r.code)).toEqual(["clock_anomaly"]);
});
it("unfinalized reservation can be recovered after owner expiry without spending budget or clearing prior stops", () => {
  const f = fixture({ leaseMs: 1000 });
  const reserved = f.gate.reserve(f.context);
  f.advance(1001);
  const owner = f.gate.acquireOwner("owner");
  const context = { ...f.context, ...owner };
  f.gate.registerPage(context);
  expect(f.gate.permit(reserved.permitId).status).toBe("cancelled");
  expect(f.gate.read()).toMatchObject({ state: "ready", stopEpoch: 0 });
  expect(f.gate.authorize(f.gate.reserve(context).permitId, context).authorized).toBe(true);
});
it("malformed persisted reasons and missing state never initialize a replacement ready state", () => {
  const f = fixture();
  f.db.exec("DELETE FROM access_site");
  expect(() => new AccessGovernor(f.connect(), { clock: f.clock })).toThrow(AccessGateError);
  // The schema row proves initialization already occurred: missing state must stay missing.
  expect(f.db.prepare("SELECT COUNT(*) AS count FROM access_site").get()!.count).toBe(0);
});

it("late callback risk compares stop/page/session fences atomically and only archives stale source", () => {
  const f = fixture();
  const other = new AccessGovernor(f.connect(), { clock: f.clock });
  other.reportRisk({ reason: "manual_stop" });
  const state = f.gate.reportRisk(
    { reason: "login", context: f.context, evidence: { sourceKind: "website_callback" } },
    f.context,
  );
  expect(state).toMatchObject({
    stopEpoch: 1,
    revision: 1,
    reasons: [expect.objectContaining({ code: "manual_stop" })],
  });
  const archived = f.db
    .prepare("SELECT context_json,evidence_json FROM access_evidence WHERE reason='login'")
    .get()!;
  expect(JSON.parse(archived.context_json as string)).toMatchObject({
    queryId: "query",
    stopEpoch: 0,
  });
  expect(JSON.parse(archived.evidence_json as string).disposition).toBe(
    "stale_source_archive_only",
  );
  const latest = { ...f.context, stopEpoch: state.stopEpoch, pageGeneration: 2 };
  other.registerPage(latest);
  const currentEpochOldPage = { ...f.context, stopEpoch: state.stopEpoch };
  expect(
    f.gate.reportRisk({ reason: "verification", context: currentEpochOldPage }, currentEpochOldPage)
      .stopEpoch,
  ).toBe(1);
  expect(f.gate.read().reasons.map((reason) => reason.code)).toEqual(["manual_stop"]);
});

it("bridge risk replay is idempotent across connections and after manual recovery", () => {
  const f = fixture();
  const first = f.gate.reportRisk({ reason: "http_403", idempotencyKey: "epoch:message-1" });
  const second = new AccessGovernor(f.connect(), { clock: f.clock });
  expect(
    second.reportRisk({ reason: "http_403", idempotencyKey: "epoch:message-1" }).stopEpoch,
  ).toBe(first.stopEpoch);
  const token = f.gate.beginRecovery(first.revision, f.context);
  f.gate.finishRecovery(token, ["http_403"]);
  expect(second.reportRisk({ reason: "http_403", idempotencyKey: "epoch:message-1" }).state).toBe(
    "ready",
  );
});
