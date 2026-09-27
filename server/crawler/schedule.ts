import { execFile } from "node:child_process";
import { openCbg, checkCbgStatus } from "../cbg";
import { diagnostics } from "../diagnostics";
import type { OpenCbgResult } from "../types";
import {
  crawlActivity,
  startCrawl,
  stopCrawl,
  type ActiveCrawl,
  type CrawlStartResult,
} from "./controller";
import { ScanScheduleStore, type ScanRunSummary } from "./schedule-store";
import { localDateKey, parseScanScheduleConfig, scheduledStartsForDay } from "./schedule-time";
import type { CrawlStatus } from "./types";

type ScheduleState =
  | "disabled"
  | "waiting_window"
  | "waiting_login"
  | "running"
  | "waiting_next"
  | "waiting_lock"
  | "needs_action"
  | "other_instance";

interface ScanDriver {
  browserStatus: () => Promise<OpenCbgResult>;
  openBrowser: () => OpenCbgResult;
  notifyLogin: () => void;
  startCrawl: (canStart: () => boolean) => Promise<CrawlStartResult>;
  crawlActivity: () => ActiveCrawl | null;
  stopCrawl: (reason?: "time_limit") => CrawlStatus;
}

const driver: ScanDriver = {
  browserStatus: checkCbgStatus,
  openBrowser: openCbg,
  notifyLogin: () => {
    if (process.platform !== "darwin") return;
    execFile(
      "osascript",
      [
        "-e",
        'display notification "定时扫描等待登录，请打开本地采集页面扫码。" with title "藏宝阁定时扫描"',
      ],
      (error) => {
        if (error) diagnostics.record("scan.login_notice_error", { error });
      },
    );
  },
  startCrawl: (canStart) => startCrawl("scheduled", canStart),
  crawlActivity,
  stopCrawl,
};

export class ScanScheduler {
  private state: ScheduleState = "disabled";
  private message = "定时计划未启用。";
  private timer: ReturnType<typeof setInterval> | null = null;
  private pendingTick: Promise<void> | null = null;
  private watchedRun: Promise<CrawlStatus> | null = null;
  private runStartedAt: number | null = null;
  private runSlotAt: number | null = null;
  private runDurationMinutes: number | null = null;
  private overlapCheckedAt: number | null = null;
  private limitStopRequested = false;
  private loginRequested = false;
  private retryBrowserOnResume = false;
  private closed = false;

  constructor(
    private readonly store: ScanScheduleStore,
    private readonly scan: ScanDriver,
    private readonly now: () => number = Date.now,
  ) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 5000);
    void this.tick();
  }

  status() {
    return {
      ...this.store.read(),
      state: this.state,
      message: this.message,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  configure(input: unknown) {
    const config = parseScanScheduleConfig(input);
    const prior = this.store.read();
    if (prior.pendingLoginAt !== null) this.skipSlot(prior.pendingLoginAt);
    this.store.setConfig(config);
    this.store.setPendingLoginAt(null);
    if (prior.mode === "enabled") this.store.setEnabledAt(this.now());
    if (prior.mode === "enabled" && !this.watchedRun)
      this.setNextRunAt(this.nextSlot(this.now(), this.store.read()).next);
    diagnostics.record("scan.configured", { config });
    void this.tick();
    return this.status();
  }

  enable() {
    const now = this.now();
    const prior = this.store.read();
    this.retryBrowserOnResume = prior.mode === "suspended";
    this.store.setPendingLoginAt(null);
    if (prior.mode === "disabled") this.store.setEnabledAt(now);
    this.store.setMode("enabled");
    this.loginRequested = false;
    this.setNextRunAt(this.nextSlot(now, this.store.read()).next);
    diagnostics.record("scan.enabled");
    void this.tick();
    return this.status();
  }

  disable() {
    this.store.setMode("disabled");
    this.store.setPendingLoginAt(null);
    this.state = "disabled";
    this.message = "定时计划已关闭。";
    this.loginRequested = false;
    this.retryBrowserOnResume = false;
    diagnostics.record("scan.disabled");
    return this.status();
  }

  tick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pendingTick) return this.pendingTick;
    this.pendingTick = this.check()
      .catch((error: unknown) => this.suspend(error))
      .finally(() => {
        this.pendingTick = null;
      });
    return this.pendingTick;
  }

  async stop() {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.pendingTick;
    this.store.release();
    this.store.close();
  }

  private setNextRunAt(value: number | null) {
    if (this.store.read().nextRunAt !== value) this.store.setNextRunAt(value);
  }

  private skipSlot(start: number) {
    if (this.store.slotOutcome(start) !== null) return;
    this.store.recordSlot(start, "skipped");
    this.store.setLastSkippedAt(start);
    diagnostics.record("scan.slot_skipped", { scheduledAt: new Date(start).toISOString() });
  }

  private nextSlot(
    now: number,
    row: ReturnType<ScanScheduleStore["read"]>,
  ): {
    candidate: number | null;
    next: number | null;
  } {
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const starts = scheduledStartsForDay(today, row.config).filter(
      (start) => row.enabledAt === null || start >= row.enabledAt,
    );
    const due = starts.filter(
      (start) =>
        start <= now &&
        (this.store.slotOutcome(start) === null || this.store.slotOutcome(start) === "error"),
    );
    for (const missed of due.slice(0, -1))
      if (this.store.slotOutcome(missed) === null) this.skipSlot(missed);
    const candidate = due.at(-1) ?? null;
    if (
      candidate !== null &&
      this.store.startedSlotsOnDate(localDateKey(candidate)) >= 5 &&
      this.store.slotOutcome(candidate) === null
    ) {
      this.skipSlot(candidate);
      return this.nextSlot(now, row);
    }
    let next = starts.find((start) => start > now) ?? null;
    if (next === null) {
      for (let offset = 1; offset <= 7; offset++) {
        const day = new Date(today);
        day.setDate(day.getDate() + offset);
        const first = scheduledStartsForDay(day, row.config)[0];
        if (first !== undefined) {
          next = first;
          break;
        }
      }
    }
    return { candidate, next: candidate === null ? next : now };
  }

  private expirePendingLogin(candidate: number | null) {
    const pending = this.store.read().pendingLoginAt;
    if (pending === null || pending === candidate) return;
    this.skipSlot(pending);
    this.store.setPendingLoginAt(null);
    this.loginRequested = false;
  }

  private skipOverlaps(now: number, row: ReturnType<ScanScheduleStore["read"]>) {
    if (this.runSlotAt === null) return;
    const since = this.overlapCheckedAt ?? this.runSlotAt;
    const day = new Date(since);
    day.setHours(0, 0, 0, 0);
    const lastDay = new Date(now);
    lastDay.setHours(0, 0, 0, 0);
    while (day <= lastDay) {
      for (const start of scheduledStartsForDay(day, row.config)) {
        if (
          start > since &&
          start <= now &&
          (row.enabledAt === null || start >= row.enabledAt) &&
          this.store.slotOutcome(start) === null
        )
          this.skipSlot(start);
      }
      day.setDate(day.getDate() + 1);
    }
    this.overlapCheckedAt = now;
  }

  private async check() {
    const now = this.now();
    if (!this.store.acquire(now)) {
      this.state = "other_instance";
      this.message = "另一个本地服务正在管理定时计划。";
      return;
    }
    let row = this.store.read();
    if (this.watchedRun) {
      if (row.mode === "enabled") this.skipOverlaps(now, row);
      this.checkDuration(now);
      if (row.mode === "disabled") {
        this.state = "disabled";
        this.message = "计划已关闭，当前扫描继续执行。";
      }
      return;
    }
    if (row.mode === "disabled") {
      this.state = "disabled";
      this.message = "定时计划未启用。";
      return;
    }
    if (row.mode === "suspended") {
      this.state = "needs_action";
      this.message = row.issue || "定时计划已暂停，请处理后手动恢复。";
      return;
    }
    const existing = this.scan.crawlActivity();
    if (existing) {
      if (existing.origin === "manual") {
        this.closeForManualCrawl();
        return;
      }
      const day = new Date(existing.startedAt);
      const slot =
        scheduledStartsForDay(day, row.config)
          .filter(
            (start) => start <= existing.startedAt && this.store.slotOutcome(start) === "started",
          )
          .at(-1) ?? null;
      this.watchRun(existing.completion, existing.startedAt, slot, row.config.maxDurationMinutes);
      return;
    }
    const slot = this.nextSlot(now, row);
    this.expirePendingLogin(slot.candidate);
    if (slot.candidate === null) {
      this.loginRequested = false;
      this.setNextRunAt(slot.next);
      this.state = "waiting_window";
      this.message = "等待下一次计划执行。";
      return;
    }
    const due = slot.candidate;
    this.setNextRunAt(now);
    const browser = await this.scan.browserStatus();
    if (this.closed || this.store.read().mode !== "enabled") return;
    const readyAt = this.now();
    const current = this.store.read();
    const currentSlot = this.nextSlot(readyAt, current);
    this.expirePendingLogin(currentSlot.candidate);
    if (currentSlot.candidate !== due) {
      this.setNextRunAt(currentSlot.next);
      this.state = "waiting_window";
      this.message = "等待下一次计划执行。";
      return;
    }
    const ready = !browser.running && browser.isLoggedIn && browser.workflowStep === "completed";
    const browserIssue =
      browser.error?.message ||
      (browser.workflowStep === "error" ||
      /^(登录已失效|后台工作页已关闭|无法读取后台工作页)/.test(browser.message)
        ? browser.message
        : null);
    const loginIssue = /^(登录已失效|网站登录状态已失效|等待扫码登录超时|二维码.*失效)/.test(
      browserIssue || "",
    );
    if (browserIssue && !loginIssue) {
      if (this.retryBrowserOnResume) {
        this.retryBrowserOnResume = false;
        this.loginRequested = true;
        this.scan.openBrowser();
        this.state = "waiting_login";
        this.message = "正在重新准备藏宝阁角色列表…";
      } else this.suspend(browserIssue);
      return;
    }
    this.retryBrowserOnResume = false;
    if (!ready) {
      const date = localDateKey(readyAt);
      if (current.pendingLoginAt !== due) this.store.setPendingLoginAt(due);
      this.state = "waiting_login";
      this.message = loginIssue
        ? `${browserIssue} 请在页面扫码或点击“重新尝试”；本时间段内登录成功后会自动扫描。`
        : browser.running
          ? "正在准备藏宝阁角色列表；如需扫码，请在页面完成登录。"
          : `${browser.message || "请在页面登录藏宝阁。"} 本时间段内登录成功后会自动扫描。`;
      this.setNextRunAt(null);
      if (!this.loginRequested && !browser.running && browser.workflowStep !== "error") {
        this.loginRequested = true;
        this.scan.openBrowser();
        diagnostics.record("scan.login_requested");
      }
      if (current.lastLoginNotifiedDate !== date && (loginIssue || browser.needLogin)) {
        this.store.setLastLoginNotifiedDate(date);
        try {
          this.scan.notifyLogin();
        } catch (error) {
          diagnostics.record("scan.login_notice_error", { error });
        }
      }
      return;
    }
    this.loginRequested = false;
    try {
      const attempt = await this.scan.startCrawl(() => {
        const live = this.store.read();
        return live.mode === "enabled" && this.nextSlot(this.now(), live).candidate === due;
      });
      if (!attempt.started) {
        if (attempt.activity?.origin === "manual") this.closeForManualCrawl();
        else if (attempt.activity)
          this.watchRun(
            attempt.activity.completion,
            attempt.activity.startedAt,
            this.store.slotOutcome(due) === "started" ? due : null,
            current.config.maxDurationMinutes,
          );
        return;
      }
      if (!attempt.activity) throw new Error("采集任务未能启动");
      this.store.recordSlot(due, "started", attempt.activity.startedAt);
      this.store.setLastScheduledDate(localDateKey(attempt.activity.startedAt));
      this.store.setPendingLoginAt(null);
      this.watchRun(
        attempt.activity.completion,
        attempt.activity.startedAt,
        due,
        current.config.maxDurationMinutes,
      );
    } catch (error) {
      if (error instanceof Error && /已有另一个本地服务正在采集/.test(error.message)) {
        this.state = "waiting_lock";
        this.message = "等待上次采集锁释放后继续。";
        return;
      }
      throw error;
    }
  }

  private closeForManualCrawl() {
    this.disable();
    this.message = "手动采集正在运行，定时计划已关闭。";
  }

  private checkDuration(now: number) {
    if (
      !this.limitStopRequested &&
      this.runStartedAt !== null &&
      this.runDurationMinutes !== null &&
      now >= this.runStartedAt + this.runDurationMinutes * 60000
    ) {
      this.limitStopRequested = true;
      this.scan.stopCrawl("time_limit");
      diagnostics.record("scan.time_limit_reached", { startedAt: this.runStartedAt });
    }
    this.state = "running";
    this.message = this.limitStopRequested
      ? "已达到最长运行时长，正在暂停并保留断点。"
      : "正在执行本次扫描。";
  }

  private watchRun(
    run: Promise<CrawlStatus>,
    started: number,
    slot: number | null,
    duration: number | null,
  ) {
    this.watchedRun = run;
    this.runStartedAt = started;
    this.runSlotAt = slot;
    this.runDurationMinutes = duration;
    this.overlapCheckedAt = slot;
    this.limitStopRequested = false;
    this.setNextRunAt(null);
    this.state = "running";
    this.message = "正在执行本轮扫描。";
    diagnostics.record("scan.run_started", { startedAt: new Date(started).toISOString() });
    void run
      .then((result) => this.finishRun(result, started, slot))
      .catch((error: unknown) => this.suspend(error))
      .finally(() => {
        this.watchedRun = null;
        this.runStartedAt = null;
        this.runSlotAt = null;
        this.runDurationMinutes = null;
        this.overlapCheckedAt = null;
        this.limitStopRequested = false;
        if (!this.closed) void this.tick();
      });
  }

  private finishRun(result: CrawlStatus, started: number, slot: number | null) {
    if (this.closed) return;
    const ended = this.now();
    const hitTimeLimit = this.limitStopRequested && result.phase === "paused";
    const summary: ScanRunSummary = {
      startedAt: new Date(started).toISOString(),
      endedAt: new Date(ended).toISOString(),
      outcome: hitTimeLimit
        ? "time_limit"
        : result.phase === "completed"
          ? "completed"
          : result.phase === "paused"
            ? "paused"
            : "error",
      saved: result.saved,
      skipped: result.skipped,
      failed: result.failed || 0,
      message: hitTimeLimit ? "已达到最长运行时长，断点已保留。" : result.message,
    };
    this.store.recordRun(summary);
    if (slot !== null) this.store.recordSlot(slot, summary.outcome, started, summary);
    diagnostics.record("scan.run_finished", { ...summary });
    const row = this.store.read();
    if (row.mode !== "enabled") return;
    if (result.phase !== "completed" && !hitTimeLimit) {
      this.suspend(result.error || result.message);
      return;
    }
    this.skipOverlaps(Math.max(started, ended - 1), row);
    if (localDateKey(ended) !== localDateKey(started))
      this.store.setLastScheduledDate(localDateKey(ended));
    this.setNextRunAt(this.nextSlot(ended, row).next);
    this.state = "waiting_next";
    this.message = summary.message;
  }

  private suspend(error: unknown) {
    if (this.closed) return;
    const row = this.store.read();
    if (row.mode !== "enabled") return;
    const message = error instanceof Error ? error.message : String(error);
    this.store.setMode("suspended", message);
    this.store.setPendingLoginAt(null);
    this.state = "needs_action";
    this.message = message;
    diagnostics.record("scan.suspended", { reason: message });
  }
}

let scheduler: ScanScheduler | null = null;

export function initializeScanSchedule() {
  if (!scheduler) {
    scheduler = new ScanScheduler(new ScanScheduleStore(), driver);
    scheduler.start();
  }
  return scheduler;
}

export async function shutdownScanSchedule() {
  const running = scheduler;
  scheduler = null;
  await running?.stop();
}

export function scanScheduleStatus() {
  return initializeScanSchedule().status();
}

export function configureScanSchedule(value: unknown) {
  return initializeScanSchedule().configure(value);
}

export function enableScanSchedule() {
  return initializeScanSchedule().enable();
}

export function disableScanSchedule() {
  return initializeScanSchedule().disable();
}
