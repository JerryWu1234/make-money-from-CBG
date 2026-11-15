import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  DEFAULT_ACCESS_POLICY,
  parseAccessPolicy,
  retryAfterDeadline,
  type AccessPolicy,
} from "./policy";
import { redactEvidence, redactText } from "./redaction";

export type AccessStatus = "ready" | "suspect" | "cooldown" | "needs_action";
export interface AccessReason {
  code: string;
  occurredAt: number;
  evidenceId: string;
}
export interface AccessState {
  schemaVersion: 1;
  siteKey: "cbg";
  revision: number;
  stopEpoch: number;
  state: AccessStatus;
  reasons: AccessReason[];
  occurredAt: number | null;
  retryNotBefore: number | null;
  lastEvidenceId: string | null;
  policyVersion: number;
  policy: AccessPolicy;
  updatedAt: number;
  lastWallAt: number;
  lastDispatchAt: number | null;
}
export interface OwnerFence {
  owner: string;
  fence: number;
  expiresAt: number;
}
/** Independent business lease: service heartbeats must never renew a crawl worker. */
export interface CrawlLease {
  owner: string;
  fence: number;
}
export interface AccessContext {
  schemaVersion?: 1;
  owner: string;
  fence: number;
  stopEpoch: number;
  runId: string;
  queryId: string;
  pageId: string;
  pageGeneration: number;
  browserSessionEpoch: string;
  sourceKind: string;
  actionId?: string | null;
  sourceVersion?: string;
  purpose?: "ordinary" | "diagnostic" | "recovery";
  diagnosticPlanId?: string;
  recoveryToken?: string;
  crawlLease?: CrawlLease;
}
export interface AccessPermit {
  permitId: string;
  status: "reserved" | "dispatch_authorized" | "completed" | "cancelled" | "unknown";
  context: AccessContext;
  reservedAt: number;
  authorizedAt: number | null;
  finishedAt: number | null;
  policyVersion: number;
  endReason: string | null;
}
export interface RecoveryToken {
  token: string;
  revision: number;
  stopEpoch: number;
  owner: string;
  fence: number;
}
export interface RiskInput {
  reason: string;
  idempotencyKey?: string;
  state?: Exclude<AccessStatus, "ready">;
  retryAfter?: string;
  evidence?: unknown;
  context?: Partial<AccessContext>;
}
export interface AccessClock {
  now(): number;
  monotonic?(): number;
}
export class AccessGateError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly state?: AccessState,
  ) {
    super(message);
    this.name = "AccessGateError";
  }
}
const SCHEMA_VERSION = 1;
const columns =
  "permit_id,status,context_json,reserved_at,authorized_at,finished_at,policy_version,end_reason";

/** All decisions use this application's existing DB. Each grant is a SQLite write transaction. */
export class AccessGovernor {
  private fatal: Error | undefined;
  private lastMonotonic: number | undefined;
  private lastLocalWall: number | undefined;
  private readonly clock: AccessClock;
  constructor(
    readonly db: DatabaseSync,
    options: { policy?: AccessPolicy; clock?: AccessClock } = {},
  ) {
    this.clock = options.clock ?? { now: () => Date.now(), monotonic: () => performance.now() };
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.exec("BEGIN IMMEDIATE");
      const exists = db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='access_schema'")
        .get();
      if (exists) {
        const row = db.prepare("SELECT version FROM access_schema WHERE id=1").get();
        if (row?.version !== SCHEMA_VERSION)
          throw new Error("Unsupported access database schema; website tasks disabled");
        if (!db.prepare("SELECT 1 FROM access_site WHERE id=1").get())
          throw new Error("Access state missing from an initialized database");
        for (const name of [
          "access_owners",
          "access_pages",
          "access_queries",
          "access_permits",
          "access_evidence",
          "access_recovery",
          "access_diagnostic_plans",
          "access_requests",
          "access_risk_receipts",
        ])
          if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))
            throw new Error(`Access ledger table missing: ${name}`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS access_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS access_site(id INTEGER PRIMARY KEY CHECK(id=1),state_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS access_owners(owner TEXT PRIMARY KEY,fence INTEGER NOT NULL,expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS access_pages(page_id TEXT PRIMARY KEY,owner TEXT NOT NULL,fence INTEGER NOT NULL,generation INTEGER NOT NULL,session_epoch TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS access_queries(query_id TEXT PRIMARY KEY,context_json TEXT NOT NULL,accepted INTEGER NOT NULL,source_version TEXT);
        CREATE TABLE IF NOT EXISTS access_permits(permit_id TEXT PRIMARY KEY,status TEXT NOT NULL,context_json TEXT NOT NULL,owner TEXT NOT NULL,fence INTEGER NOT NULL,page_id TEXT NOT NULL,reserved_at INTEGER NOT NULL,authorized_at INTEGER,finished_at INTEGER,policy_version INTEGER NOT NULL,end_reason TEXT);
        CREATE INDEX IF NOT EXISTS access_permits_window ON access_permits(authorized_at);
        CREATE INDEX IF NOT EXISTS access_permits_active ON access_permits(status);
        CREATE TABLE IF NOT EXISTS access_evidence(evidence_id TEXT PRIMARY KEY,recorded_at INTEGER NOT NULL,reason TEXT NOT NULL,context_json TEXT NOT NULL,evidence_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS access_recovery(token TEXT PRIMARY KEY,revision INTEGER NOT NULL,stop_epoch INTEGER NOT NULL,owner TEXT NOT NULL,fence INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS access_diagnostic_plans(plan_id TEXT PRIMARY KEY,stop_epoch INTEGER NOT NULL,owner TEXT NOT NULL,fence INTEGER NOT NULL,max_actions INTEGER NOT NULL,used_actions INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS access_requests(request_id TEXT PRIMARY KEY,received_at INTEGER NOT NULL,context_json TEXT NOT NULL,summary_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS access_risk_receipts(event_key TEXT PRIMARY KEY, evidence_id TEXT NOT NULL);`);
      db.prepare("INSERT OR IGNORE INTO access_schema VALUES(1,?)").run(SCHEMA_VERSION);
      const now = this.clock.now();
      const policy = parseAccessPolicy(options.policy ?? DEFAULT_ACCESS_POLICY);
      const initial: AccessState = {
        schemaVersion: 1,
        siteKey: "cbg",
        revision: 0,
        stopEpoch: 0,
        state: "ready",
        reasons: [],
        occurredAt: null,
        retryNotBefore: null,
        lastEvidenceId: null,
        policyVersion: policy.version,
        policy,
        updatedAt: now,
        lastWallAt: now,
        lastDispatchAt: null,
      };
      db.prepare("INSERT OR IGNORE INTO access_site VALUES(1,?)").run(JSON.stringify(initial));
      this.stateInside();
      db.exec("COMMIT");
      this.transaction(() => undefined);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* no active transaction */
      }
      this.fatal = error instanceof Error ? error : new Error("Access persistence unavailable");
      throw new AccessGateError("storage_unavailable", "访问保护存储不可用，官网任务已禁用");
    }
  }

  private stateInside(): AccessState {
    if (
      this.db.prepare("SELECT version FROM access_schema WHERE id=1").get()?.version !==
      SCHEMA_VERSION
    )
      throw new Error("Unsupported access database schema");
    const row = this.db.prepare("SELECT state_json FROM access_site WHERE id=1").get();
    if (!row) throw new Error("Missing access state");
    const state = JSON.parse(String(row.state_json)) as AccessState;
    if (
      state.schemaVersion !== 1 ||
      state.siteKey !== "cbg" ||
      !Number.isSafeInteger(state.stopEpoch) ||
      state.stopEpoch < 0 ||
      !Number.isSafeInteger(state.revision) ||
      state.revision < 0 ||
      !["ready", "suspect", "cooldown", "needs_action"].includes(state.state) ||
      !Array.isArray(state.reasons) ||
      !state.reasons.every(
        (r) =>
          r &&
          typeof r.code === "string" &&
          typeof r.evidenceId === "string" &&
          Number.isFinite(r.occurredAt),
      ) ||
      (state.state === "ready" && state.reasons.length !== 0) ||
      !Number.isFinite(state.lastWallAt) ||
      (state.retryNotBefore !== null && !Number.isFinite(state.retryNotBefore)) ||
      (state.lastDispatchAt !== null && !Number.isFinite(state.lastDispatchAt))
    )
      throw new Error("Corrupt access state");
    parseAccessPolicy(state.policy);
    return state;
  }
  private save(state: AccessState) {
    this.db.prepare("UPDATE access_site SET state_json=? WHERE id=1").run(JSON.stringify(state));
  }
  private transaction<T>(fn: (state: AccessState, now: number) => T): T {
    if (this.fatal)
      throw new AccessGateError("storage_unavailable", "访问保护存储不可用，官网任务已禁用");
    let begun = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      begun = true;
      const state = this.stateInside();
      const wall = this.clock.now();
      if (!Number.isFinite(wall) || wall < 0) throw new Error("Invalid access clock");
      const mono = this.clock.monotonic?.();
      const drift =
        mono !== undefined && this.lastMonotonic !== undefined && this.lastLocalWall !== undefined
          ? wall - this.lastLocalWall - (mono - this.lastMonotonic)
          : 0;
      const backwards = wall + state.policy.clockToleranceMs < state.lastWallAt;
      const jumped = Math.abs(drift) > state.policy.maxClockJumpMs;
      const now = Math.max(wall, state.lastWallAt);
      if ((backwards || jumped) && !state.reasons.some((r) => r.code === "clock_anomaly"))
        this.riskInside(state, now, {
          reason: "clock_anomaly",
          state: "needs_action",
          evidence: { backwards, jumped },
        });
      state.lastWallAt = now;
      this.recoverExpiredInside(state, now);
      this.save(state);
      const result = fn(state, now);
      this.db.exec("COMMIT");
      begun = false;
      this.lastLocalWall = wall;
      this.lastMonotonic = mono;
      return result;
    } catch (error) {
      if (error instanceof AccessGateError) {
        // Protective maintenance survives a refused grant. All expected refusals
        // occur before the requested mutation, so only maintenance is committed.
        if (begun) {
          try {
            this.db.exec("COMMIT");
          } catch {
            this.fatal = new Error("Access protective maintenance commit failed");
            try {
              this.db.exec("ROLLBACK");
            } catch {
              /* poisoned instance stays closed */
            }
            throw new AccessGateError(
              "storage_unavailable",
              "Access protective state could not be persisted",
            );
          }
        }
        throw error;
      }
      if (begun) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          /* fail closed below */
        }
      }
      this.fatal = error instanceof Error ? error : new Error("Access persistence unavailable");
      throw new AccessGateError("storage_unavailable", "访问保护读写失败，官网任务已禁用");
    }
  }
  private recoverExpiredInside(state: AccessState, now: number) {
    this.db
      .prepare(
        "UPDATE access_permits SET status='cancelled',finished_at=?,end_reason='reservation_expired' WHERE status='reserved' AND (reserved_at<? OR NOT EXISTS(SELECT 1 FROM access_owners o WHERE o.owner=access_permits.owner AND o.fence=access_permits.fence AND o.expires_at>?))",
      )
      .run(now, now - state.policy.reservationTtlMs, now);
    const expired = this.db
      .prepare(
        "SELECT permit_id FROM access_permits WHERE status='dispatch_authorized' AND NOT EXISTS(SELECT 1 FROM access_owners o WHERE o.owner=access_permits.owner AND o.fence=access_permits.fence AND o.expires_at>?)",
      )
      .all(now);
    if (!expired.length) return;
    this.db
      .prepare(
        "UPDATE access_permits SET status='unknown',finished_at=?,end_reason='owner_expired_after_authorization' WHERE status='dispatch_authorized' AND NOT EXISTS(SELECT 1 FROM access_owners o WHERE o.owner=access_permits.owner AND o.fence=access_permits.fence AND o.expires_at>?)",
      )
      .run(now, now);
    this.riskInside(state, now, {
      reason: "unknown_inflight",
      state: "needs_action",
      evidence: { permitIds: expired.map((r) => r.permit_id) },
    });
  }
  private riskEvidenceInside(now: number, input: RiskInput): string {
    const reason = redactText(input.reason).slice(0, 120);
    if (!reason) throw new AccessGateError("invalid_reason", "风险原因不能为空");
    const evidenceId = randomUUID();
    this.db
      .prepare("INSERT INTO access_evidence VALUES(?,?,?,?,?)")
      .run(
        evidenceId,
        now,
        reason,
        JSON.stringify(redactEvidence(this.evidenceContext(input.context ?? {}, now))),
        JSON.stringify(redactEvidence(input.evidence ?? {})),
      );
    return evidenceId;
  }
  private riskInside(state: AccessState, now: number, input: RiskInput): AccessState {
    if (input.state !== undefined && !["suspect", "cooldown", "needs_action"].includes(input.state))
      throw new AccessGateError("invalid_state", "Invalid access risk state");
    const reason = redactText(input.reason).slice(0, 120);
    if (!reason) throw new AccessGateError("invalid_reason", "风险原因不能为空");
    const evidenceId = this.riskEvidenceInside(now, input);
    const next =
      input.state ??
      (["http_429", "frequency", "busy"].includes(reason) ? "cooldown" : "needs_action");
    state.revision++;
    state.stopEpoch++;
    state.updatedAt = now;
    state.occurredAt ??= now;
    state.lastEvidenceId = evidenceId;
    if (!state.reasons.some((r) => r.code === reason))
      state.reasons.push({ code: reason, occurredAt: now, evidenceId });
    // A weaker event must never remove a previously required manual action.
    state.state =
      state.state === "needs_action" || next === "needs_action"
        ? "needs_action"
        : state.state === "cooldown" || next === "cooldown"
          ? "cooldown"
          : "suspect";
    if (next === "cooldown" || input.retryAfter !== undefined)
      state.retryNotBefore = Math.max(
        state.retryNotBefore ?? 0,
        retryAfterDeadline(input.retryAfter, now, state.policy.fallbackCooldownMs),
      );
    this.db
      .prepare(
        "UPDATE access_permits SET status='cancelled',finished_at=?,end_reason='site_stopped' WHERE status='reserved'",
      )
      .run(now);
    this.save(state);
    return state;
  }
  read(): AccessState {
    return this.transaction((state) => structuredClone(state));
  }
  reportRisk(input: RiskInput, expectedContext?: AccessContext): AccessState {
    return this.transaction((state, now) => {
      const eventKey = input.idempotencyKey;
      if (eventKey && (eventKey.length > 300 || !/^[a-zA-Z0-9:._-]+$/.test(eventKey)))
        throw new AccessGateError("invalid_risk_id", "风险事件标识无效");
      if (
        eventKey &&
        this.db.prepare("SELECT 1 FROM access_risk_receipts WHERE event_key=?").get(eventKey)
      )
        return structuredClone(state);
      if (expectedContext) {
        let current = state.stopEpoch === expectedContext.stopEpoch;
        try {
          this.contextInside(expectedContext, now);
        } catch (error) {
          if (
            !(error instanceof AccessGateError) ||
            !["stale_owner", "stale_page", "stale_crawl"].includes(error.code)
          )
            throw error;
          current = false;
        }
        if (!current) {
          // Keep the original source as audit evidence, without reopening a stopped epoch.
          const evidenceId = this.riskEvidenceInside(now, {
            ...input,
            context: expectedContext,
            evidence: { disposition: "stale_source_archive_only", summary: input.evidence },
          });
          if (eventKey)
            this.db
              .prepare("INSERT INTO access_risk_receipts VALUES(?,?)")
              .run(eventKey, evidenceId);
          return structuredClone(state);
        }
      }
      const result = this.riskInside(state, now, input);
      if (eventKey)
        this.db
          .prepare("INSERT INTO access_risk_receipts VALUES(?,?)")
          .run(eventKey, result.lastEvidenceId);
      return structuredClone(result);
    });
  }
  updatePolicy(policy: AccessPolicy, expectedRevision: number): AccessState {
    const parsed = parseAccessPolicy(policy);
    return this.transaction((state, now) => {
      if (state.revision !== expectedRevision)
        throw new AccessGateError("stale_revision", "访问策略已变化", state);
      if (parsed.version <= state.policy.version)
        throw new AccessGateError("policy_version", "新策略版本必须递增");
      state.policy = parsed;
      state.policyVersion = parsed.version;
      state.revision++;
      state.updatedAt = now;
      this.save(state);
      return structuredClone(state);
    });
  }
  acquireOwner(owner: string, ttlMs?: number): OwnerFence {
    if (!owner || owner.length > 200)
      throw new AccessGateError("invalid_owner", "无效访问任务所有者");
    return this.transaction((state, now) => {
      const ttl = ttlMs ?? state.policy.leaseMs;
      if (!Number.isInteger(ttl) || ttl < 1000 || ttl > 3600000)
        throw new AccessGateError("invalid_lease", "无效租约时长");
      const prior = this.db
        .prepare("SELECT fence,expires_at FROM access_owners WHERE owner=?")
        .get(owner);
      const fence = prior ? Number(prior.fence) + (Number(prior.expires_at) <= now ? 1 : 0) : 1;
      this.db
        .prepare(
          "INSERT INTO access_owners VALUES(?,?,?) ON CONFLICT(owner) DO UPDATE SET fence=excluded.fence,expires_at=excluded.expires_at",
        )
        .run(owner, fence, now + ttl);
      return { owner, fence, expiresAt: now + ttl };
    });
  }
  renewOwner(token: Pick<OwnerFence, "owner" | "fence">, ttlMs?: number): OwnerFence {
    return this.transaction((state, now) => {
      this.ownerInside(token, now);
      const ttl = ttlMs ?? state.policy.leaseMs;
      if (!Number.isInteger(ttl) || ttl < 1000 || ttl > 3600000)
        throw new AccessGateError("invalid_lease", "无效租约时长");
      this.db
        .prepare("UPDATE access_owners SET expires_at=? WHERE owner=? AND fence=?")
        .run(now + ttl, token.owner, token.fence);
      return { ...token, expiresAt: now + ttl };
    });
  }
  releaseOwner(token: Pick<OwnerFence, "owner" | "fence">) {
    this.transaction((state, now) => {
      this.ownerInside(token, now);
      this.db
        .prepare("UPDATE access_owners SET expires_at=? WHERE owner=? AND fence=?")
        .run(now, token.owner, token.fence);
      this.recoverExpiredInside(state, now);
    });
  }
  private ownerInside(token: Pick<OwnerFence, "owner" | "fence">, now: number) {
    const row = this.db
      .prepare("SELECT fence,expires_at FROM access_owners WHERE owner=?")
      .get(token.owner);
    if (!row || row.fence !== token.fence || Number(row.expires_at) <= now)
      throw new AccessGateError("stale_owner", "访问任务租约已失效");
  }
  registerPage(
    context: Pick<
      AccessContext,
      "owner" | "fence" | "pageId" | "pageGeneration" | "browserSessionEpoch"
    >,
  ) {
    this.transaction((_state, now) => this.registerPageInside(context, now));
  }
  private registerPageInside(
    context: Pick<
      AccessContext,
      "owner" | "fence" | "pageId" | "pageGeneration" | "browserSessionEpoch"
    >,
    now: number,
  ) {
    this.ownerInside(context, now);
    if (
      !context.pageId ||
      !context.browserSessionEpoch ||
      !Number.isSafeInteger(context.pageGeneration) ||
      context.pageGeneration < 0
    )
      throw new AccessGateError("invalid_page", "无效页面代次");
    const prior = this.db
      .prepare("SELECT owner,fence,generation,session_epoch FROM access_pages WHERE page_id=?")
      .get(context.pageId);
    if (
      prior &&
      prior.owner === context.owner &&
      prior.fence === context.fence &&
      prior.session_epoch === context.browserSessionEpoch &&
      Number(prior.generation) > context.pageGeneration
    )
      throw new AccessGateError("stale_page", "页面代次已失效");
    if (prior && prior.owner !== context.owner) {
      const other = this.db
        .prepare("SELECT expires_at,fence FROM access_owners WHERE owner=?")
        .get(prior.owner);
      if (other && other.fence === prior.fence && Number(other.expires_at) > now)
        throw new AccessGateError("page_owned", "页面由其他有效任务持有");
    }
    this.db
      .prepare(
        "INSERT INTO access_pages VALUES(?,?,?,?,?) ON CONFLICT(page_id) DO UPDATE SET owner=excluded.owner,fence=excluded.fence,generation=excluded.generation,session_epoch=excluded.session_epoch",
      )
      .run(
        context.pageId,
        context.owner,
        context.fence,
        context.pageGeneration,
        context.browserSessionEpoch,
      );
  }
  private contextInside(context: AccessContext, now: number) {
    this.ownerInside(context, now);
    if (context.crawlLease) {
      const lease = context.crawlLease;
      const current = this.db
        .prepare("SELECT owner,fence,expires_at FROM crawl_lock WHERE id=1")
        .get();
      if (
        !current ||
        current.owner !== lease.owner ||
        current.fence !== lease.fence ||
        Number(current.expires_at) <= now
      )
        throw new AccessGateError("stale_crawl", "采集业务租约已失效，拒绝派发或推进旧任务");
    }
    if (
      ![
        context.runId,
        context.queryId,
        context.sourceKind,
        context.pageId,
        context.browserSessionEpoch,
      ].every((v) => typeof v === "string" && v.length > 0 && v.length <= 200) ||
      !Number.isSafeInteger(context.stopEpoch) ||
      !Number.isSafeInteger(context.pageGeneration)
    )
      throw new AccessGateError("invalid_context", "访问关联上下文不完整");
    const page = this.db
      .prepare("SELECT owner,fence,generation,session_epoch FROM access_pages WHERE page_id=?")
      .get(context.pageId);
    if (
      !page ||
      page.owner !== context.owner ||
      page.fence !== context.fence ||
      page.generation !== context.pageGeneration ||
      page.session_epoch !== context.browserSessionEpoch
    )
      throw new AccessGateError("stale_page", "页面或会话代次已变化");
  }
  registerQuery(context: AccessContext, result: { accepted: boolean; sourceVersion?: string }) {
    this.transaction((state, now) => {
      this.contextInside(context, now);
      if (
        result.accepted &&
        (state.state !== "ready" ||
          state.stopEpoch !== context.stopEpoch ||
          (context.purpose ?? "ordinary") !== "ordinary")
      )
        throw new AccessGateError(
          "query_not_acceptable",
          "暂停、诊断或旧代次查询不得推进进度",
          state,
        );
      const prior = this.db
        .prepare("SELECT context_json FROM access_queries WHERE query_id=?")
        .get(context.queryId);
      if (prior && !this.sameContext(JSON.parse(String(prior.context_json)), context))
        throw new AccessGateError("query_identity_conflict", "查询标识已绑定其他页面上下文");
      this.db
        .prepare(
          "INSERT INTO access_queries VALUES(?,?,?,?) ON CONFLICT(query_id) DO UPDATE SET accepted=excluded.accepted,source_version=excluded.source_version",
        )
        .run(
          context.queryId,
          JSON.stringify(context),
          result.accepted ? 1 : 0,
          result.sourceVersion ?? context.sourceVersion ?? null,
        );
    });
  }
  /** Move an unfinished query only after its authorized navigation action completed. */
  movePendingQuery(
    context: AccessContext,
    document: Pick<AccessContext, "pageId" | "pageGeneration">,
    actionId: string,
    navigation: { kind: "refresh-list" | "return-to-list"; url: string; openingActionId?: string },
  ): AccessContext {
    return this.transaction((state, now) => {
      this.contextInside(context, now);
      this.assertRunnableInside(state, context);
      const query = this.db
        .prepare("SELECT accepted,context_json FROM access_queries WHERE query_id=?")
        .get(context.queryId);
      const completed = this.db
        .prepare(
          "SELECT context_json FROM access_permits WHERE status='completed' AND json_extract(context_json,'$.actionId')=?",
        )
        .all(actionId)
        .some((row) => {
          const permit = JSON.parse(String(row.context_json)) as AccessContext & {
            target?: { kind: string; url?: string };
          };
          return (
            this.sameContext(permit, context) &&
            permit.target?.kind === navigation.kind &&
            permit.target.url === navigation.url
          );
        });
      const ownedOpening =
        !navigation.openingActionId ||
        (navigation.kind === "return-to-list" &&
          this.db
            .prepare(
              "SELECT context_json FROM access_permits WHERE status='completed' AND json_extract(context_json,'$.actionId')=?",
            )
            .all(navigation.openingActionId)
            .some((row) => {
              const opening = JSON.parse(String(row.context_json)) as AccessContext & {
                target?: { kind: string };
              };
              return (
                opening.owner === context.owner &&
                opening.fence === context.fence &&
                opening.runId === context.runId &&
                opening.stopEpoch === context.stopEpoch &&
                opening.browserSessionEpoch === context.browserSessionEpoch &&
                opening.sourceKind === context.sourceKind &&
                opening.crawlLease?.owner === context.crawlLease?.owner &&
                opening.crawlLease?.fence === context.crawlLease?.fence &&
                opening.pageId === document.pageId &&
                opening.pageGeneration === document.pageGeneration &&
                opening.target?.kind === "listing-detail"
              );
            }));
      if (
        !actionId ||
        !["refresh-list", "return-to-list"].includes(navigation.kind) ||
        !completed ||
        !ownedOpening ||
        !query ||
        query.accepted !== 0 ||
        !this.sameContext(JSON.parse(String(query.context_json)), context) ||
        (context.purpose ?? "ordinary") !== "ordinary" ||
        (document.pageId === context.pageId && document.pageGeneration <= context.pageGeneration)
      )
        throw new AccessGateError("query_navigation_not_confirmed", "查询没有可迁移的本地导航确认");
      const next = { ...context, ...document, actionId };
      this.registerPageInside(next, now);
      this.contextInside(next, now);
      if (context.pageId !== next.pageId)
        this.db
          .prepare(
            "DELETE FROM access_pages WHERE page_id=? AND owner=? AND fence=? AND generation=? AND session_epoch=?",
          )
          .run(
            context.pageId,
            context.owner,
            context.fence,
            context.pageGeneration,
            context.browserSessionEpoch,
          );
      this.db
        .prepare("UPDATE access_queries SET context_json=? WHERE query_id=? AND accepted=0")
        .run(JSON.stringify(next), context.queryId);
      return next;
    });
  }
  registerDiagnosticPlan(planId: string, context: AccessContext, maxActions = 6) {
    this.transaction((state, now) => {
      this.contextInside(context, now);
      if (
        state.state !== "suspect" ||
        state.stopEpoch !== context.stopEpoch ||
        !Number.isInteger(maxActions) ||
        maxActions < 1 ||
        maxActions > 256
      )
        throw new AccessGateError(
          "diagnostic_not_allowed",
          "诊断仅限当前疑似事件的有界计划",
          state,
        );
      const prior = this.db
        .prepare(
          "SELECT stop_epoch,owner,fence,max_actions FROM access_diagnostic_plans WHERE plan_id=?",
        )
        .get(planId);
      if (
        prior &&
        (prior.stop_epoch !== state.stopEpoch ||
          prior.owner !== context.owner ||
          prior.fence !== context.fence ||
          prior.max_actions !== maxActions)
      )
        throw new AccessGateError("diagnostic_plan_conflict", "诊断计划身份不一致");
      this.db
        .prepare(
          "INSERT OR IGNORE INTO access_diagnostic_plans(plan_id,stop_epoch,owner,fence,max_actions) VALUES(?,?,?,?,?)",
        )
        .run(planId, state.stopEpoch, context.owner, context.fence, maxActions);
    });
  }
  private assertRunnableInside(state: AccessState, context: AccessContext) {
    if (state.stopEpoch !== context.stopEpoch)
      throw new AccessGateError("stale_stop_epoch", "停止代次已变化", state);
    const purpose = context.purpose ?? "ordinary";
    if (purpose === "ordinary") {
      if (state.state !== "ready")
        throw new AccessGateError("site_paused", "官网访问已暂停，需人工核验后继续", state);
    } else if (purpose === "diagnostic") {
      const plan = this.db
        .prepare("SELECT * FROM access_diagnostic_plans WHERE plan_id=?")
        .get(context.diagnosticPlanId ?? "");
      if (
        state.state !== "suspect" ||
        !plan ||
        plan.owner !== context.owner ||
        plan.fence !== context.fence ||
        plan.stop_epoch !== context.stopEpoch ||
        Number(plan.used_actions) >= Number(plan.max_actions)
      )
        throw new AccessGateError("diagnostic_not_allowed", "当前诊断计划不可执行", state);
    } else if (purpose === "recovery") {
      const token = this.db
        .prepare("SELECT * FROM access_recovery WHERE token=?")
        .get(context.recoveryToken ?? "");
      if (
        state.state === "ready" ||
        !token ||
        token.used !== 0 ||
        token.revision !== state.revision ||
        token.stop_epoch !== state.stopEpoch ||
        token.owner !== context.owner ||
        token.fence !== context.fence
      )
        throw new AccessGateError("recovery_not_allowed", "人工恢复许可已失效", state);
      const attempts = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM access_permits p JOIN access_recovery r ON json_extract(p.context_json,'$.recoveryToken')=r.token WHERE p.authorized_at IS NOT NULL AND r.revision=?",
        )
        .get(state.revision)!;
      if (Number(attempts.count) >= 4)
        throw new AccessGateError(
          "recovery_budget_exhausted",
          "Recovery verification action budget exhausted",
        );
    } else throw new AccessGateError("invalid_purpose", "未知访问许可用途");
  }
  private sameContext(a: AccessContext, b: AccessContext) {
    return (
      a.owner === b.owner &&
      a.fence === b.fence &&
      a.stopEpoch === b.stopEpoch &&
      a.queryId === b.queryId &&
      a.pageId === b.pageId &&
      a.pageGeneration === b.pageGeneration &&
      a.browserSessionEpoch === b.browserSessionEpoch &&
      a.runId === b.runId &&
      a.sourceKind === b.sourceKind &&
      (a.purpose ?? "ordinary") === (b.purpose ?? "ordinary") &&
      a.diagnosticPlanId === b.diagnosticPlanId &&
      a.recoveryToken === b.recoveryToken &&
      a.crawlLease?.owner === b.crawlLease?.owner &&
      a.crawlLease?.fence === b.crawlLease?.fence
    );
  }
  reserve(context: AccessContext): AccessPermit {
    return this.transaction((state, now) => {
      this.contextInside(context, now);
      this.assertRunnableInside(state, context);
      const permitId = randomUUID();
      this.db
        .prepare(
          "INSERT INTO access_permits(permit_id,status,context_json,owner,fence,page_id,reserved_at,policy_version) VALUES(?,'reserved',?,?,?,?,?,?)",
        )
        .run(
          permitId,
          JSON.stringify(context),
          context.owner,
          context.fence,
          context.pageId,
          now,
          state.policyVersion,
        );
      return this.permitInside(permitId);
    });
  }
  private permitInside(permitId: string): AccessPermit {
    const row = this.db
      .prepare(`SELECT ${columns} FROM access_permits WHERE permit_id=?`)
      .get(permitId);
    if (!row) throw new AccessGateError("permit_missing", "动作许可不存在");
    return {
      permitId: String(row.permit_id),
      status: row.status as AccessPermit["status"],
      context: JSON.parse(String(row.context_json)) as AccessContext,
      reservedAt: Number(row.reserved_at),
      authorizedAt: row.authorized_at === null ? null : Number(row.authorized_at),
      finishedAt: row.finished_at === null ? null : Number(row.finished_at),
      policyVersion: Number(row.policy_version),
      endReason: row.end_reason === null ? null : String(row.end_reason),
    };
  }
  permit(permitId: string): AccessPermit {
    return this.transaction(() => this.permitInside(permitId));
  }
  authorize(
    permitId: string,
    context: AccessContext,
  ):
    | { authorized: true; permit: AccessPermit }
    | { authorized: false; retryAt: number; reason: "interval" | "window" | "slot" } {
    return this.transaction((state, now) => {
      this.contextInside(context, now);
      this.assertRunnableInside(state, context);
      const permit = this.permitInside(permitId);
      if (!this.sameContext(permit.context, context))
        throw new AccessGateError("permit_context", "动作许可上下文不匹配");
      if (permit.status !== "reserved")
        throw new AccessGateError("permit_not_reserved", "已授权或已结束动作不得重放");
      if (
        this.db
          .prepare("SELECT 1 FROM access_permits WHERE status='dispatch_authorized' LIMIT 1")
          .get()
      )
        return { authorized: false, retryAt: now + 100, reason: "slot" };
      if (state.lastDispatchAt !== null && now < state.lastDispatchAt + state.policy.minIntervalMs)
        return {
          authorized: false,
          retryAt: state.lastDispatchAt + state.policy.minIntervalMs,
          reason: "interval",
        };
      const window = this.db
        .prepare(
          "SELECT COUNT(*) AS count,MIN(authorized_at) AS earliest FROM access_permits WHERE authorized_at>?",
        )
        .get(now - state.policy.windowMs)!;
      if (Number(window.count) >= state.policy.maxActionsPerWindow)
        return {
          authorized: false,
          retryAt: Number(window.earliest) + state.policy.windowMs,
          reason: "window",
        };
      this.db
        .prepare(
          "UPDATE access_permits SET status='dispatch_authorized',authorized_at=?,policy_version=? WHERE permit_id=? AND status='reserved'",
        )
        .run(now, state.policyVersion, permitId);
      if (context.purpose === "diagnostic")
        this.db
          .prepare("UPDATE access_diagnostic_plans SET used_actions=used_actions+1 WHERE plan_id=?")
          .run(context.diagnosticPlanId!);
      state.lastDispatchAt = now;
      state.updatedAt = now;
      this.save(state);
      return { authorized: true, permit: this.permitInside(permitId) };
    });
  }
  complete(permitId: string, owner: Pick<OwnerFence, "owner" | "fence">) {
    this.transaction((_state, now) => {
      this.ownerInside(owner, now);
      const permit = this.permitInside(permitId);
      if (
        permit.context.owner !== owner.owner ||
        permit.context.fence !== owner.fence ||
        permit.status !== "dispatch_authorized"
      )
        throw new AccessGateError("stale_permit", "旧任务不得确认动作完成");
      this.db
        .prepare(
          "UPDATE access_permits SET status='completed',finished_at=?,end_reason='completed' WHERE permit_id=?",
        )
        .run(now, permitId);
    });
  }
  cancel(permitId: string, owner: Pick<OwnerFence, "owner" | "fence">) {
    this.transaction((_state, now) => {
      this.ownerInside(owner, now);
      const permit = this.permitInside(permitId);
      if (permit.context.owner !== owner.owner || permit.context.fence !== owner.fence)
        throw new AccessGateError("stale_permit", "旧任务不得取消动作许可");
      if (permit.status === "reserved")
        this.db
          .prepare(
            "UPDATE access_permits SET status='cancelled',finished_at=?,end_reason='cancelled_before_dispatch' WHERE permit_id=?",
          )
          .run(now, permitId);
      else if (permit.status === "dispatch_authorized")
        throw new AccessGateError(
          "authorized_not_cancellable",
          "已授权动作必须确认完成或标记结果未知",
        );
    });
  }
  failUnknown(
    permitId: string,
    owner: Pick<OwnerFence, "owner" | "fence">,
    reason = "dispatch_outcome_unknown",
  ) {
    return this.transaction((state, now) => {
      this.ownerInside(owner, now);
      const permit = this.permitInside(permitId);
      if (
        permit.context.owner !== owner.owner ||
        permit.context.fence !== owner.fence ||
        permit.status !== "dispatch_authorized"
      )
        throw new AccessGateError("stale_permit", "旧任务不得更改动作结果");
      this.db
        .prepare(
          "UPDATE access_permits SET status='unknown',finished_at=?,end_reason=? WHERE permit_id=?",
        )
        .run(now, redactText(reason), permitId);
      return this.riskInside(state, now, {
        reason: "unknown_inflight",
        state: "needs_action",
        context: permit.context,
        evidence: { permitId, reason },
      });
    });
  }
  async waitForPermit(context: AccessContext, signal?: AbortSignal): Promise<AccessPermit> {
    signal?.throwIfAborted();
    const permit = this.reserve(context);
    try {
      for (;;) {
        signal?.throwIfAborted();
        const result = this.authorize(permit.permitId, context);
        if (result.authorized) return result.permit;
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            clearTimeout(timer);
            reject(signal?.reason ?? new Error("Aborted"));
          };
          const timer = setTimeout(
            () => {
              signal?.removeEventListener("abort", stop);
              resolve();
            },
            Math.max(1, Math.min(result.retryAt - this.clock.now(), 250)),
          );
          signal?.addEventListener("abort", stop, { once: true });
          if (signal?.aborted) stop();
        });
      }
    } catch (error) {
      try {
        this.cancel(permit.permitId, context);
      } catch {
        /* persistent pause wins */
      }
      throw error;
    }
  }
  async runAction<T>(
    context: AccessContext,
    dispatch: (permit: AccessPermit) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const permit = await this.waitForPermit(context, signal);
    try {
      signal?.throwIfAborted();
      const result = await dispatch(permit);
      this.complete(permit.permitId, context);
      return result;
    } catch (error) {
      try {
        this.failUnknown(permit.permitId, context);
      } catch {
        /* never refund or replay authorization */
      }
      throw error;
    }
  }
  beginRecovery(
    expectedRevision: number,
    owner: Pick<OwnerFence, "owner" | "fence">,
  ): RecoveryToken {
    return this.transaction((state, now) => {
      this.ownerInside(owner, now);
      if (state.state === "ready" || state.revision !== expectedRevision)
        throw new AccessGateError("stale_revision", "恢复前访问状态已变化", state);
      if (state.retryNotBefore !== null && now < state.retryNotBefore)
        throw new AccessGateError("cooldown_active", "尚未到最早人工继续时间", state);
      const result = {
        token: randomUUID(),
        revision: state.revision,
        stopEpoch: state.stopEpoch,
        owner: owner.owner,
        fence: owner.fence,
      };
      this.db
        .prepare(
          "INSERT INTO access_recovery(token,revision,stop_epoch,owner,fence) VALUES(?,?,?,?,?)",
        )
        .run(result.token, result.revision, result.stopEpoch, result.owner, result.fence);
      return result;
    });
  }
  finishRecovery(token: RecoveryToken, verifiedReasons: string[]): AccessState {
    return this.transaction((state, now) => {
      this.ownerInside(token, now);
      const saved = this.db.prepare("SELECT * FROM access_recovery WHERE token=?").get(token.token);
      if (
        !saved ||
        saved.used !== 0 ||
        saved.owner !== token.owner ||
        saved.fence !== token.fence ||
        state.revision !== token.revision ||
        state.stopEpoch !== token.stopEpoch ||
        saved.revision !== state.revision ||
        saved.stop_epoch !== state.stopEpoch
      )
        throw new AccessGateError("stale_revision", "恢复期间出现新风险，请重新核验", state);
      if (state.retryNotBefore !== null && now < state.retryNotBefore)
        throw new AccessGateError("cooldown_active", "尚未到最早人工继续时间", state);
      if (!state.reasons.every((r) => verifiedReasons.includes(r.code)))
        throw new AccessGateError("unresolved_reasons", "仍有未完成人工核验的风险原因", state);
      const active = this.db
        .prepare("SELECT 1 FROM access_permits WHERE status='dispatch_authorized' LIMIT 1")
        .get();
      if (active) throw new AccessGateError("inflight_action", "仍有未完成的官网动作");
      this.db.prepare("UPDATE access_recovery SET used=1 WHERE token=?").run(token.token);
      state.state = "ready";
      state.reasons = [];
      state.retryNotBefore = null;
      state.occurredAt = null;
      state.revision++;
      state.updatedAt = now;
      this.save(state);
      return structuredClone(state);
    });
  }
  /** Call only after BEGIN IMMEDIATE on this exact DB, immediately before business writes. */
  assertActivity(context: AccessContext): void {
    if (this.fatal) throw new AccessGateError("storage_unavailable", "访问保护不可用");
    if (!this.db.isTransaction)
      throw new AccessGateError("transaction_required", "在线任务核验必须在业务写事务内执行");
    const state = this.stateInside(),
      wall = this.clock.now();
    if (!Number.isFinite(wall) || wall + state.policy.clockToleranceMs < state.lastWallAt)
      throw new AccessGateError("clock_anomaly", "Clock anomaly prevents online activity");
    this.contextInside(context, Math.max(wall, state.lastWallAt));
    this.assertRunnableInside(state, context);
    if ((context.purpose ?? "ordinary") !== "ordinary")
      throw new AccessGateError("diagnostic_progress", "诊断与恢复资料只能归档");
  }
  assertProgress(context: AccessContext): void {
    if (this.fatal) throw new AccessGateError("storage_unavailable", "访问保护不可用");
    // node:sqlite exposes isTransaction on supported runtimes. SELECT alone is never a fence.
    if (!(this.db as DatabaseSync & { isTransaction: boolean }).isTransaction)
      throw new AccessGateError("transaction_required", "在线进度核验必须在业务写事务内执行");
    try {
      const state = this.stateInside();
      const wall = this.clock.now();
      if (!Number.isFinite(wall) || wall + state.policy.clockToleranceMs < state.lastWallAt)
        throw new AccessGateError("clock_anomaly", "Clock anomaly prevents online progress");
      const now = Math.max(wall, state.lastWallAt);
      this.contextInside(context, now);
      this.assertRunnableInside(state, context);
      if ((context.purpose ?? "ordinary") !== "ordinary")
        throw new AccessGateError("diagnostic_progress", "诊断与恢复资料只能归档");
      const query = this.db
        .prepare("SELECT context_json,accepted,source_version FROM access_queries WHERE query_id=?")
        .get(context.queryId);
      if (
        !query ||
        query.accepted !== 1 ||
        !this.sameContext(JSON.parse(String(query.context_json)), context) ||
        (context.sourceVersion !== undefined && query.source_version !== context.sourceVersion)
      )
        throw new AccessGateError("query_not_accepted", "查询未通过当前身份和访问健康核验");
    } catch (error) {
      if (error instanceof AccessGateError) throw error;
      this.fatal = error instanceof Error ? error : new Error("Access persistence unavailable");
      throw new AccessGateError("storage_unavailable", "在线进度访问核验失败");
    }
  }
  withProgress<T>(context: AccessContext, fn: () => T): T {
    if (this.fatal) throw new AccessGateError("storage_unavailable", "访问保护不可用");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.assertProgress(context);
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private evidenceContext(context: Partial<AccessContext>, now: number) {
    return {
      schemaVersion: 1,
      runId: null,
      queryId: null,
      pageId: null,
      pageGeneration: null,
      browserSessionEpoch: null,
      stopEpoch: this.stateInside().stopEpoch,
      sourceKind: "governor",
      ...context,
      actionId: context.actionId ?? null,
      observedAt: now,
      receivedAt: now,
    };
  }
  recordRequest(
    context: Partial<AccessContext>,
    summary: unknown,
    requestId: string = randomUUID(),
  ): string {
    return this.transaction((_state, now) => {
      this.db
        .prepare("INSERT OR IGNORE INTO access_requests VALUES(?,?,?,?)")
        .run(
          requestId,
          now,
          JSON.stringify(redactEvidence(this.evidenceContext(context, now))),
          JSON.stringify(redactEvidence(summary)),
        );
      return requestId;
    });
  }
  requestCount(since: number): number {
    return this.transaction(() =>
      Number(
        this.db
          .prepare("SELECT COUNT(*) AS count FROM access_requests WHERE received_at>=?")
          .get(since)!.count,
      ),
    );
  }
}
