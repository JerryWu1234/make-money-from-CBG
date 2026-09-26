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
import {
  localDateKey,
  nextScanTime,
  parseScanScheduleConfig,
  scheduledStartForDay,
  type ScanScheduleConfig,
} from "./schedule-time";
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
  startCrawl: (canStart: () => boolean) => Promise<CrawlStartResult>;
  crawlActivity: () => ActiveCrawl | null;
  stopCrawl: (reason?: "time_limit") => CrawlStatus;
}

const driver: ScanDriver = {
  browserStatus: checkCbgStatus,
  openBrowser: openCbg,
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
    this.store.setConfig(config);
    const row = this.store.read();
    if (row.mode === "enabled" && !this.watchedRun)
      this.setNextRunAt(nextScanTime(this.now(), config, row.lastScheduledDate, row.enabledAt));
    diagnostics.record("scan.configured", { config });
    void this.tick();
    return this.status();
  }

  enable() {
    const now = this.now();
    const prior = this.store.read();
    if (prior.mode === "suspended" && prior.lastScheduledDate === localDateKey(now))
      this.store.setLastScheduledDate(null);
    this.retryBrowserOnResume = prior.mode === "suspended";
    if (prior.mode === "disabled") this.store.setEnabledAt(now);
    this.store.setMode("enabled");
    this.loginRequested = false;
    const row = this.store.read();
    this.setNextRunAt(nextScanTime(now, row.config, row.lastScheduledDate, row.enabledAt));
    diagnostics.record("scan.enabled");
    void this.tick();
    return this.status();
  }

  disable() {
    this.store.setMode("disabled");
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

  private async check() {
    const now = this.now();
    if (!this.store.acquire(now)) {
      this.state = "other_instance";
      this.message = "另一个本地服务正在管理定时计划。";
      return;
    }
    const row = this.store.read();
    if (this.watchedRun) {
      this.checkDuration(now, row.config);
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
      this.watchRun(existing.completion, existing.startedAt);
      return;
    }
    const due = nextScanTime(now, row.config, row.lastScheduledDate, row.enabledAt);
    if (due > now) {
      this.loginRequested = false;
      this.setNextRunAt(due);
      this.state = "waiting_window";
      this.message = "等待下一次计划执行。";
      return;
    }
    this.setNextRunAt(due);
    const browser = await this.scan.browserStatus();
    if (this.closed || this.store.read().mode !== "enabled") return;
    const readyAt = this.now();
    const current = this.store.read();
    const currentDue = nextScanTime(
      readyAt,
      current.config,
      current.lastScheduledDate,
      current.enabledAt,
    );
    if (currentDue > readyAt) {
      this.setNextRunAt(currentDue);
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
    if (browserIssue) {
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
      this.state = "waiting_login";
      this.message = browser.running
        ? "正在准备藏宝阁角色列表，请在页面完成登录。"
        : `${browser.message || "请在页面登录藏宝阁。"} 登录并进入角色列表后会自动扫描。`;
      this.setNextRunAt(null);
      if (!this.loginRequested && !browser.running) {
        this.loginRequested = true;
        this.scan.openBrowser();
        diagnostics.record("scan.login_requested");
      }
      return;
    }
    this.loginRequested = false;
    try {
      const attempt = await this.scan.startCrawl(() => this.store.read().mode === "enabled");
      if (!attempt.started) {
        if (attempt.activity?.origin === "manual") this.closeForManualCrawl();
        else if (attempt.activity)
          this.watchRun(attempt.activity.completion, attempt.activity.startedAt);
        return;
      }
      if (!attempt.activity) throw new Error("采集任务未能启动");
      this.store.setLastScheduledDate(localDateKey(attempt.activity.startedAt));
      this.watchRun(attempt.activity.completion, attempt.activity.startedAt);
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

  private checkDuration(now: number, config: ScanScheduleConfig) {
    if (
      !this.limitStopRequested &&
      this.runStartedAt !== null &&
      config.maxDurationMinutes !== null &&
      now >= this.runStartedAt + config.maxDurationMinutes * 60000
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

  private watchRun(run: Promise<CrawlStatus>, started: number) {
    this.watchedRun = run;
    this.runStartedAt = started;
    this.limitStopRequested = false;
    this.setNextRunAt(null);
    this.state = "running";
    this.message = "正在执行本轮扫描。";
    diagnostics.record("scan.run_started", { startedAt: new Date(started).toISOString() });
    void run
      .then((result) => this.finishRun(result, started))
      .catch((error: unknown) => this.suspend(error))
      .finally(() => {
        this.watchedRun = null;
        this.runStartedAt = null;
        this.limitStopRequested = false;
        if (!this.closed) void this.tick();
      });
  }

  private finishRun(result: CrawlStatus, started: number) {
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
    diagnostics.record("scan.run_finished", { ...summary });
    const row = this.store.read();
    if (row.mode !== "enabled") return;
    if (result.phase !== "completed" && !hitTimeLimit) {
      this.suspend(result.error || result.message);
      return;
    }
    const todayStart = scheduledStartForDay(new Date(ended), row.config);
    if (todayStart !== null && todayStart <= ended && row.lastScheduledDate !== localDateKey(ended))
      this.store.setLastScheduledDate(localDateKey(ended));
    this.setNextRunAt(
      nextScanTime(ended, row.config, this.store.read().lastScheduledDate, row.enabledAt),
    );
    this.state = "waiting_next";
    this.message = summary.message;
  }

  private suspend(error: unknown) {
    if (this.closed) return;
    const row = this.store.read();
    if (row.mode !== "enabled") return;
    const message = error instanceof Error ? error.message : String(error);
    this.store.setMode("suspended", message);
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
