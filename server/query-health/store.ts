import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { QueryDiagnosticState } from "./diagnostic-state";

export type QueryIdentity = {
  schemaVersion: 1;
  category: string;
  server: string;
  serverAge: string;
  conditions: Record<string, string | number>;
  page: number;
  sort: string;
  browserSessionEpoch: string;
};
export type QueryEvidence = {
  count: number;
  loaded: boolean;
  committed: boolean;
  emptyMarker: boolean;
  identityMatched: boolean;
  blocked?: boolean;
};
export type QueryVerdict = {
  result: "data" | "empty" | "unknown";
  access: "observed_normal" | "suspect" | "blocked";
  accepted: boolean;
};
export type QueryRecord = {
  queryId: string;
  identityMode?: "initial-form" | "exact";
  identity: QueryIdentity;
  purpose: "ordinary" | "target_review" | "canary" | "restoration";
  eventId?: string;
  observedAt: number;
};

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
const normalizeValue = (value: string | number) => {
  const text = String(value).trim();
  return /^[\d,.-]+$/.test(text) && text.includes(",")
    ? text
        .split(",")
        .map((part) => part.trim())
        .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
        .join(",")
    : text;
};
export const queryIdentityHash = (identity: QueryIdentity) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          ...identity,
          serverAge: normalizeValue(identity.serverAge),
          sort: identity.sort.trim(),
          conditions: Object.fromEntries(
            Object.entries(identity.conditions).map(([key, value]) => [key, normalizeValue(value)]),
          ),
        }),
      ),
    )
    .digest("hex");

/** Persistence is shared with business data. Probe claims are spent before any browser action. */
export class QueryHealthStore {
  constructor(
    readonly db: DatabaseSync,
    readonly now = Date.now,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS query_health_schema(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL);
      INSERT OR IGNORE INTO query_health_schema VALUES(1,1);`);
    if (db.prepare("SELECT version FROM query_health_schema WHERE id=1").get()?.version !== 1)
      throw new Error("不支持的查询健康 schema，已停止官网任务");
    db.exec(`CREATE TABLE IF NOT EXISTS query_health_results(
      query_id TEXT PRIMARY KEY,identity_hash TEXT NOT NULL,identity_json TEXT NOT NULL,
      purpose TEXT NOT NULL,event_id TEXT,observed_at INTEGER NOT NULL,received_at INTEGER NOT NULL,
      result TEXT NOT NULL,access TEXT NOT NULL,accepted INTEGER NOT NULL,evidence_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS query_health_baseline ON query_health_results(identity_hash,received_at);
      CREATE TABLE IF NOT EXISTS query_diagnostic_events(
      event_id TEXT PRIMARY KEY,identity_hash TEXT NOT NULL,original_json TEXT NOT NULL,cursor_json TEXT,
      stop_epoch INTEGER NOT NULL,target_claimed INTEGER NOT NULL DEFAULT 0,canary_claimed INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',conclusion TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
      restoration_claimed INTEGER NOT NULL DEFAULT 0,original_snapshot_json TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS query_diagnostic_generation ON query_diagnostic_events(identity_hash,stop_epoch);`);
    if (
      !db
        .prepare("PRAGMA table_info(query_diagnostic_events)")
        .all()
        .some((row) => row.name === "restoration_claimed")
    ) {
      try {
        db.exec(
          "ALTER TABLE query_diagnostic_events ADD COLUMN restoration_claimed INTEGER NOT NULL DEFAULT 0",
        );
      } catch (error) {
        if (
          !db
            .prepare("PRAGMA table_info(query_diagnostic_events)")
            .all()
            .some((row) => row.name === "restoration_claimed")
        )
          throw error;
      }
    }
    if (
      !db
        .prepare("PRAGMA table_info(query_diagnostic_events)")
        .all()
        .some((row) => row.name === "outcome_json")
    ) {
      try {
        db.exec("ALTER TABLE query_diagnostic_events ADD COLUMN outcome_json TEXT");
      } catch (error) {
        if (
          !db
            .prepare("PRAGMA table_info(query_diagnostic_events)")
            .all()
            .some((row) => row.name === "outcome_json")
        )
          throw error;
      }
    }
    if (
      !db
        .prepare("PRAGMA table_info(query_diagnostic_events)")
        .all()
        .some((row) => row.name === "original_snapshot_json")
    ) {
      try {
        db.exec("ALTER TABLE query_diagnostic_events ADD COLUMN original_snapshot_json TEXT");
      } catch (error) {
        if (
          !db
            .prepare("PRAGMA table_info(query_diagnostic_events)")
            .all()
            .some((row) => row.name === "original_snapshot_json")
        )
          throw error;
      }
    }
  }
  begin(
    identity: QueryIdentity,
    purpose: QueryRecord["purpose"] = "ordinary",
    eventId?: string,
  ): QueryRecord {
    if (
      identity.schemaVersion !== 1 ||
      !Number.isInteger(identity.page) ||
      identity.page < 1 ||
      !identity.category ||
      !identity.browserSessionEpoch ||
      Object.keys(identity.conditions).some((key) =>
        /token|cookie|auth|password|fingerprint|session|signature|safe_code|nickname|account|^fp$|^sign$/i.test(
          key,
        ),
      )
    )
      throw new Error("查询身份无效或含非公开字段");
    return {
      queryId: randomUUID(),
      identity: structuredClone(identity),
      purpose,
      eventId,
      observedAt: this.now(),
    };
  }
  observe(query: QueryRecord, evidence: QueryEvidence, baselineTtlMs: number): QueryVerdict {
    const sufficient =
      evidence.loaded &&
      evidence.committed &&
      evidence.identityMatched &&
      Number.isSafeInteger(evidence.count) &&
      evidence.count >= 0 &&
      (evidence.count > 0 || evidence.emptyMarker);
    const result = sufficient ? (evidence.count ? "data" : "empty") : "unknown";
    const anomaly =
      result === "empty" &&
      query.purpose === "ordinary" &&
      !!this.targetBaseline(query.identity, baselineTtlMs);
    const access = evidence.blocked
      ? "blocked"
      : result === "unknown" || anomaly
        ? "suspect"
        : "observed_normal";
    const verdict: QueryVerdict = {
      result,
      access,
      accepted: query.purpose === "ordinary" && access === "observed_normal",
    };
    this.db
      .prepare("INSERT INTO query_health_results VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        query.queryId,
        queryIdentityHash(query.identity),
        JSON.stringify(query.identity),
        query.purpose,
        query.eventId || null,
        query.observedAt,
        this.now(),
        result,
        access,
        +verdict.accepted,
        JSON.stringify(evidence),
      );
    return verdict;
  }
  targetBaseline(identity: QueryIdentity, ttl: number) {
    return this.db
      .prepare(`SELECT query_id FROM query_health_results WHERE identity_hash=? AND purpose='ordinary'
      AND result='data' AND access='observed_normal' AND accepted=1 AND received_at BETWEEN ? AND ? ORDER BY received_at DESC LIMIT 1`)
      .get(queryIdentityHash(identity), this.now() - ttl, this.now());
  }
  broadBaseline(identity: QueryIdentity, ttl: number): QueryIdentity | undefined {
    const records = this.db
      .prepare(`SELECT identity_json FROM query_health_results WHERE purpose='ordinary'
      AND result='data' AND access='observed_normal' AND accepted=1 AND received_at BETWEEN ? AND ? ORDER BY received_at DESC LIMIT 500`)
      .all(this.now() - ttl, this.now());
    for (const row of records) {
      const candidate = JSON.parse(String(row.identity_json)) as QueryIdentity;
      // Only a real, strictly broader successful query is a control. A wide query does not make a narrow empty suspicious.
      if (
        candidate.schemaVersion !== identity.schemaVersion ||
        candidate.category !== identity.category ||
        candidate.server !== identity.server ||
        candidate.serverAge !== identity.serverAge ||
        candidate.browserSessionEpoch !== identity.browserSessionEpoch ||
        candidate.page !== 1 ||
        candidate.sort !== identity.sort
      )
        continue;
      const filters = Object.entries(candidate.conditions).filter(([, v]) => String(v) !== "");
      const target = Object.entries(identity.conditions).filter(([, v]) => String(v) !== "");
      if (
        filters.length < target.length &&
        filters.every(([key, value]) => String(identity.conditions[key] ?? "") === String(value))
      )
        return candidate;
    }
    return undefined;
  }
  event(query: QueryRecord, stopEpoch: number, cursor?: unknown): string {
    const existing = this.db
      .prepare(
        "SELECT event_id FROM query_diagnostic_events WHERE identity_hash=? AND stop_epoch=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(queryIdentityHash(query.identity), stopEpoch);
    if (existing) return String(existing.event_id);
    const eventId = randomUUID();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO query_diagnostic_events(event_id,identity_hash,original_json,cursor_json,stop_epoch,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        eventId,
        queryIdentityHash(query.identity),
        JSON.stringify(query.identity),
        cursor === undefined ? null : JSON.stringify(cursor),
        stopEpoch,
        this.now(),
        this.now(),
      );
    return String(
      this.db
        .prepare(
          "SELECT event_id FROM query_diagnostic_events WHERE identity_hash=? AND stop_epoch=?",
        )
        .get(queryIdentityHash(query.identity), stopEpoch)!.event_id,
    );
  }
  claim(eventId: string, step: "target" | "canary" | "restoration"): boolean {
    const column = `${step}_claimed`;
    return (
      this.db
        .prepare(
          `UPDATE query_diagnostic_events SET ${column}=1,updated_at=? WHERE event_id=? AND ${column}=0 AND status='pending'${step !== "target" ? " AND target_claimed=1" : ""}`,
        )
        .run(this.now(), eventId).changes === 1
    );
  }
  saveOriginalSnapshot(eventId: string, snapshot: unknown) {
    if (
      this.db
        .prepare(
          "UPDATE query_diagnostic_events SET original_snapshot_json=?,updated_at=? WHERE event_id=? AND original_snapshot_json IS NULL AND target_claimed=1 AND status='pending'",
        )
        .run(JSON.stringify(snapshot), this.now(), eventId).changes !== 1
    )
      throw new Error("原查询恢复证据已保存或诊断事件不可写，拒绝覆盖");
  }
  finish(eventId: string, conclusion: string, outcome?: QueryDiagnosticState) {
    this.db
      .prepare(
        "UPDATE query_diagnostic_events SET status='needs_action',conclusion=?,outcome_json=?,updated_at=? WHERE event_id=?",
      )
      .run(conclusion, outcome ? JSON.stringify(outcome) : null, this.now(), eventId);
  }
}
