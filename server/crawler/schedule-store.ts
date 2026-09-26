import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ALL_WEEKDAYS, parseScanScheduleConfig, type ScanScheduleConfig } from "./schedule-time";

export type ScheduleMode = "disabled" | "enabled" | "suspended";
export interface ScanRunSummary {
  startedAt: string;
  endedAt: string;
  outcome: "completed" | "paused" | "error";
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
  lastRun: ScanRunSummary | null;
}

const DEFAULT_CONFIG: ScanScheduleConfig = {
  scheduleType: "weekly",
  daily: { startTime: "09:00", endTime: "23:00" },
  days: ALL_WEEKDAYS.map((weekday) => ({
    weekday,
    enabled: true,
    startTime: "09:00",
    endTime: "23:00",
  })),
  intervalMinutes: 30,
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
        mode TEXT NOT NULL, issue TEXT, next_run_at INTEGER, last_run_json TEXT
      );
      CREATE TABLE IF NOT EXISTS scan_schedule_lock (
        id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL
      );`);
    this.db
      .prepare("INSERT OR IGNORE INTO scan_schedule(id,config_json,mode) VALUES(1,?,'disabled')")
      .run(JSON.stringify(DEFAULT_CONFIG));
  }

  read(): StoredSchedule {
    const row = this.db
      .prepare(
        "SELECT config_json,mode,issue,next_run_at,last_run_json FROM scan_schedule WHERE id=1",
      )
      .get()!;
    const saved = JSON.parse(String(row.config_json)) as Record<string, unknown>;
    const selected = Array.isArray(saved.weekdays) ? saved.weekdays : ALL_WEEKDAYS;
    const config = parseScanScheduleConfig(
      saved.scheduleType === "daily" || saved.scheduleType === "weekly"
        ? saved
        : {
            scheduleType:
              Array.isArray(saved.days) || Array.isArray(saved.weekdays) ? "weekly" : "daily",
            daily: {
              startTime: saved.startTime ?? "09:00",
              endTime: saved.endTime ?? "23:00",
            },
            days: Array.isArray(saved.days)
              ? saved.days
              : ALL_WEEKDAYS.map((weekday) => ({
                  weekday,
                  enabled: selected.includes(weekday),
                  startTime: saved.startTime,
                  endTime: saved.endTime,
                })),
            intervalMinutes: saved.intervalMinutes,
          },
    );
    return {
      config,
      mode: String(row.mode) as ScheduleMode,
      issue: row.issue == null ? null : String(row.issue),
      nextRunAt: row.next_run_at == null ? null : Number(row.next_run_at),
      lastRun: row.last_run_json ? (JSON.parse(String(row.last_run_json)) as ScanRunSummary) : null,
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
