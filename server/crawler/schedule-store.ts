import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ALL_WEEKDAYS,
  localDateKey,
  parseScanScheduleConfig,
  scheduledStartsForDay,
  type ScanScheduleConfig,
} from "./schedule-time";

export type ScheduleMode = "disabled" | "enabled" | "suspended";
export interface ScanRunSummary {
  startedAt: string;
  endedAt: string;
  outcome: "completed" | "time_limit" | "paused" | "error";
  saved: number;
  skipped: number;
  failed: number;
  message: string;
}
export interface StoredSchedule {
  config: ScanScheduleConfig;
  mode: ScheduleMode;
  issue: string | null;
  nextRunAt: number | null;
  lastScheduledDate: string | null;
  pendingLoginDate: string | null;
  pendingLoginAt: number | null;
  lastLoginNotifiedDate: string | null;
  lastSkippedDate: string | null;
  lastSkippedAt: number | null;
  enabledAt: number | null;
  lastRun: ScanRunSummary | null;
}

const DEFAULT_CONFIG: ScanScheduleConfig = {
  scheduleType: "weekly",
  daily: { startTime: "09:00" },
  days: ALL_WEEKDAYS.map((weekday) => ({
    weekday,
    enabled: true,
    startTime: "09:00",
  })),
  maxDurationMinutes: null,
};

export class ScanScheduleStore {
  readonly db: DatabaseSync;
  readonly owner = randomUUID();

  constructor(filename = path.resolve("data/cbg.sqlite")) {
    if (filename !== ":memory:") mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scan_schedule (
        id INTEGER PRIMARY KEY CHECK(id=1), config_json TEXT NOT NULL,
        mode TEXT NOT NULL, issue TEXT, next_run_at INTEGER, last_run_json TEXT,
        last_scheduled_date TEXT, enabled_at INTEGER,
        pending_login_date TEXT, last_login_notified_date TEXT, last_skipped_date TEXT,
        pending_login_at INTEGER, last_skipped_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS scan_schedule_slot (
        scheduled_at INTEGER PRIMARY KEY, outcome TEXT NOT NULL,
        started_at INTEGER, summary_json TEXT
      );
      CREATE TABLE IF NOT EXISTS scan_schedule_lock (
        id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );`);
    const columns = this.db.prepare("PRAGMA table_info(scan_schedule)").all();
    if (!columns.some((column) => column.name === "last_scheduled_date")) {
      this.db.exec("ALTER TABLE scan_schedule ADD COLUMN last_scheduled_date TEXT");
      const prior = this.db.prepare("SELECT last_run_json FROM scan_schedule WHERE id=1").get();
      if (prior?.last_run_json) {
        const lastRun = JSON.parse(String(prior.last_run_json)) as ScanRunSummary;
        const started = Date.parse(lastRun.startedAt);
        if (Number.isFinite(started)) this.setLastScheduledDate(localDateKey(started));
      }
    }
    if (!columns.some((column) => column.name === "enabled_at"))
      this.db.exec("ALTER TABLE scan_schedule ADD COLUMN enabled_at INTEGER");
    if (!columns.some((column) => column.name === "pending_login_date"))
      this.db.exec("ALTER TABLE scan_schedule ADD COLUMN pending_login_date TEXT");
    if (!columns.some((column) => column.name === "last_login_notified_date"))
      this.db.exec("ALTER TABLE scan_schedule ADD COLUMN last_login_notified_date TEXT");
    if (!columns.some((column) => column.name === "last_skipped_date"))
      this.db.exec("ALTER TABLE scan_schedule ADD COLUMN last_skipped_date TEXT");
    if (!columns.some((column) => column.name === "pending_login_at"))
      this.db.exec("ALTER TABLE scan_schedule ADD COLUMN pending_login_at INTEGER");
    if (!columns.some((column) => column.name === "last_skipped_at"))
      this.db.exec("ALTER TABLE scan_schedule ADD COLUMN last_skipped_at INTEGER");
    this.db
      .prepare("INSERT OR IGNORE INTO scan_schedule(id,config_json,mode) VALUES(1,?,'disabled')")
      .run(JSON.stringify(DEFAULT_CONFIG));
    const legacy = this.read();
    if (
      legacy.lastScheduledDate &&
      !this.db.prepare("SELECT 1 FROM scan_schedule_slot LIMIT 1").get()
    ) {
      const day = new Date(`${legacy.lastScheduledDate}T12:00:00`);
      if (Number.isFinite(day.getTime())) {
        const start = scheduledStartsForDay(day, legacy.config)[0];
        if (start !== undefined) this.recordSlot(start, "completed", start);
      }
    }
    if (legacy.pendingLoginDate && legacy.pendingLoginAt === null) {
      const day = new Date(`${legacy.pendingLoginDate}T12:00:00`);
      if (Number.isFinite(day.getTime())) {
        const start = scheduledStartsForDay(day, legacy.config)[0];
        if (start !== undefined) this.setPendingLoginAt(start);
      }
    }
  }

  read(): StoredSchedule {
    const row = this.db
      .prepare(
        "SELECT config_json,mode,issue,next_run_at,last_run_json,last_scheduled_date,enabled_at,pending_login_date,last_login_notified_date,last_skipped_date,pending_login_at,last_skipped_at FROM scan_schedule WHERE id=1",
      )
      .get()!;
    const saved = JSON.parse(String(row.config_json)) as Record<string, unknown>;
    const selected = Array.isArray(saved.weekdays) ? saved.weekdays : ALL_WEEKDAYS;
    const oldDaily = saved.daily as Record<string, unknown> | undefined;
    const config = parseScanScheduleConfig({
      scheduleType:
        saved.scheduleType === "daily" || saved.scheduleType === "weekly"
          ? saved.scheduleType
          : Array.isArray(saved.days) || Array.isArray(saved.weekdays)
            ? "weekly"
            : "daily",
      daily: {
        startTime: oldDaily?.startTime ?? saved.startTime ?? "09:00",
        additionalStartTimes: oldDaily?.additionalStartTimes,
      },
      days: Array.isArray(saved.days)
        ? saved.days
        : ALL_WEEKDAYS.map((weekday) => ({
            weekday,
            enabled: selected.includes(weekday),
            startTime: saved.startTime ?? "09:00",
          })),
      maxDurationMinutes: saved.maxDurationMinutes ?? null,
    });
    const lastRun = row.last_run_json
      ? (JSON.parse(String(row.last_run_json)) as ScanRunSummary)
      : null;
    return {
      config,
      mode: String(row.mode) as ScheduleMode,
      issue: row.issue == null ? null : String(row.issue),
      nextRunAt: row.next_run_at == null ? null : Number(row.next_run_at),
      lastScheduledDate: row.last_scheduled_date == null ? null : String(row.last_scheduled_date),
      pendingLoginDate: row.pending_login_date == null ? null : String(row.pending_login_date),
      pendingLoginAt: row.pending_login_at == null ? null : Number(row.pending_login_at),
      lastLoginNotifiedDate:
        row.last_login_notified_date == null ? null : String(row.last_login_notified_date),
      lastSkippedDate: row.last_skipped_date == null ? null : String(row.last_skipped_date),
      lastSkippedAt: row.last_skipped_at == null ? null : Number(row.last_skipped_at),
      enabledAt: row.enabled_at == null ? null : Number(row.enabled_at),
      lastRun,
    };
  }

  setConfig(config: ScanScheduleConfig) {
    this.db
      .prepare("UPDATE scan_schedule SET config_json=? WHERE id=1")
      .run(JSON.stringify(config));
  }

  setMode(mode: ScheduleMode, issue: string | null = null) {
    this.db
      .prepare("UPDATE scan_schedule SET mode=?,issue=?,next_run_at=NULL WHERE id=1")
      .run(mode, issue);
  }

  setNextRunAt(value: number | null) {
    this.db.prepare("UPDATE scan_schedule SET next_run_at=? WHERE id=1").run(value);
  }

  setLastScheduledDate(value: string | null) {
    this.db.prepare("UPDATE scan_schedule SET last_scheduled_date=? WHERE id=1").run(value);
  }

  setPendingLoginDate(value: string | null) {
    this.db
      .prepare("UPDATE scan_schedule SET pending_login_date=?,pending_login_at=NULL WHERE id=1")
      .run(value);
  }

  setPendingLoginAt(value: number | null) {
    this.db
      .prepare("UPDATE scan_schedule SET pending_login_date=?,pending_login_at=? WHERE id=1")
      .run(value === null ? null : localDateKey(value), value);
  }

  setLastLoginNotifiedDate(value: string) {
    this.db.prepare("UPDATE scan_schedule SET last_login_notified_date=? WHERE id=1").run(value);
  }

  setLastSkippedDate(value: string) {
    this.db.prepare("UPDATE scan_schedule SET last_skipped_date=? WHERE id=1").run(value);
  }

  setLastSkippedAt(value: number) {
    this.db
      .prepare("UPDATE scan_schedule SET last_skipped_date=?,last_skipped_at=? WHERE id=1")
      .run(localDateKey(value), value);
  }

  slotOutcome(start: number): string | null {
    const row = this.db
      .prepare("SELECT outcome FROM scan_schedule_slot WHERE scheduled_at=?")
      .get(start);
    return row ? String(row.outcome) : null;
  }

  recordSlot(
    start: number,
    outcome: string,
    startedAt: number | null = null,
    summary: ScanRunSummary | null = null,
  ) {
    this.db
      .prepare(`INSERT INTO scan_schedule_slot(scheduled_at,outcome,started_at,summary_json) VALUES(?,?,?,?)
      ON CONFLICT(scheduled_at) DO UPDATE SET outcome=excluded.outcome,
      started_at=COALESCE(excluded.started_at,scan_schedule_slot.started_at),
      summary_json=excluded.summary_json`)
      .run(start, outcome, startedAt, summary ? JSON.stringify(summary) : null);
  }

  startedSlotsOnDate(date: string) {
    const start = new Date(`${date}T00:00:00`).getTime();
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    const row = this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM scan_schedule_slot WHERE scheduled_at>=? AND scheduled_at<? AND started_at IS NOT NULL",
      )
      .get(start, end.getTime());
    return Number(row?.count ?? 0);
  }

  setEnabledAt(value: number) {
    this.db.prepare("UPDATE scan_schedule SET enabled_at=? WHERE id=1").run(value);
  }

  recordRun(value: ScanRunSummary) {
    this.db
      .prepare("UPDATE scan_schedule SET last_run_json=? WHERE id=1")
      .run(JSON.stringify(value));
  }

  acquire(now = Date.now()) {
    return (
      this.db
        .prepare(
          `INSERT INTO scan_schedule_lock VALUES(1,?,?)
           ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
           WHERE scan_schedule_lock.expires_at < ? OR scan_schedule_lock.owner=?`,
        )
        .run(this.owner, now + 45000, now, this.owner).changes === 1
    );
  }

  release() {
    this.db.prepare("DELETE FROM scan_schedule_lock WHERE owner=?").run(this.owner);
  }

  close() {
    this.db.close();
  }
}
