import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenCbgResult } from "../types";
import { ScanScheduler } from "./schedule";
import { ScanScheduleStore } from "./schedule-store";
import { localDateKey, nextScanTime, parseScanScheduleConfig } from "./schedule-time";
import type { ScanScheduleConfig } from "./schedule-time";
import type { CrawlStatus } from "./types";

const config: ScanScheduleConfig = {
  scheduleType: "weekly",
  daily: { startTime: "09:00" },
  days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    enabled: true,
    startTime: "22:00",
  })),
  maxDurationMinutes: null,
};
const only = (...weekdays: number[]): ScanScheduleConfig => ({
  ...config,
  days: config.days.map((day) => ({ ...day, enabled: weekdays.includes(day.weekday) })),
});
const daily = (maxDurationMinutes: number | null = null): ScanScheduleConfig => ({
  ...config,
  scheduleType: "daily",
  maxDurationMinutes,
});
const local = (day: number, hour: number, minute = 0) =>
  new Date(2026, 8, day, hour, minute).getTime();
const browser = (ready: boolean): OpenCbgResult => ({
  connected: ready,
  loginStatus: ready ? "logged_in" : "logged_out",
  title: "",
  url: "",
  serverName: "",
  isLoggedIn: ready,
  needLogin: !ready,
  message: ready ? "角色列表已就绪" : "请扫码登录",
  running: false,
  workflowStep: ready ? "completed" : "idle",
});
const crawlStatus = (phase: CrawlStatus["phase"]): CrawlStatus => ({
  running: false,
  phase,
  message: phase === "completed" ? "本轮完成" : phase === "paused" ? "采集已暂停" : "采集失败",
  page: 1,
  totalPages: 1,
  saved: 2,
  skipped: 3,
  failed: 1,
  totalSaved: 10,
  database: "data/cbg.sqlite",
});

const created: ScanScheduleStore[] = [];
afterEach(() => {
  for (const store of created.splice(0)) store.close();
});

function memoryStore(value: ScanScheduleConfig = config) {
  const store = new ScanScheduleStore(":memory:");
  created.push(store);
  store.setConfig(value);
  store.setMode("enabled");
  return store;
}

function fakeDriver() {
  let active: Promise<CrawlStatus> | null = null;
  let finish: ((value: CrawlStatus) => void) | null = null;
  let ready = true;
  const driver = {
    browserStatus: vi.fn(async () => browser(ready)),
    openBrowser: vi.fn(() => browser(false)),
    startCrawl: vi.fn(async () => {
      active = new Promise<CrawlStatus>((resolve) => {
        finish = resolve;
      });
      void active.finally(() => {
        active = null;
      });
      return crawlStatus("collecting");
    }),
    crawlCompletion: vi.fn(() => active),
    stopCrawl: vi.fn((_reason?: "time_limit") => crawlStatus("paused")),
  };
  return {
    driver,
    setReady(value: boolean) {
      ready = value;
    },
    finish(value: CrawlStatus) {
      if (!finish) throw new Error("没有运行中的扫描");
      finish(value);
    },
  };
}

describe("计划时间", () => {
  it("校验执行时间、运行日和可选时长", () => {
    expect(parseScanScheduleConfig(config)).toEqual(config);
    expect(parseScanScheduleConfig(daily())).toEqual(daily());
    expect(parseScanScheduleConfig({ ...daily(), days: only().days })).toEqual({
      ...daily(),
      days: only().days,
    });
    expect(() => parseScanScheduleConfig(only())).toThrow("至少选择一天");
    expect(() => parseScanScheduleConfig({ ...daily(), maxDurationMinutes: 0 })).toThrow("大于 0");
    expect(() => parseScanScheduleConfig({ ...daily(), maxDurationMinutes: 1.5 })).toThrow("整数");
    expect(() => parseScanScheduleConfig({ ...daily(), daily: { startTime: "25:00" } })).toThrow(
      "每天执行时间格式错误",
    );
    expect(() => parseScanScheduleConfig({ ...config, days: config.days.slice(1) })).toThrow(
      "完整设置",
    );
  });

  it("每天到点只执行一次，过点且当天未执行时补一次", () => {
    const plan = daily();
    expect(nextScanTime(local(25, 8), plan, null)).toBe(local(25, 9));
    expect(nextScanTime(local(25, 9), plan, null)).toBe(local(25, 9));
    expect(nextScanTime(local(25, 11), plan, null)).toBe(local(25, 11));
    expect(nextScanTime(local(25, 11), plan, localDateKey(local(25, 9)))).toBe(local(26, 9));
  });

  it("每周只在选中日各执行一次，并采用各自时间", () => {
    const plan = {
      ...only(1, 3),
      days: only(1, 3).days.map((day) =>
        day.weekday === 1
          ? { ...day, startTime: "09:00" }
          : day.weekday === 3
            ? { ...day, startTime: "13:00" }
            : day,
      ),
    };
    expect(nextScanTime(local(25, 22), plan, null)).toBe(local(28, 9)); // 周五等周一
    expect(nextScanTime(local(28, 10), plan, null)).toBe(local(28, 10));
    expect(nextScanTime(local(28, 10), plan, localDateKey(local(28, 9)))).toBe(local(30, 13));
    expect(nextScanTime(local(30, 10), plan, null)).toBe(local(30, 13));
  });
});

describe("计划持久化", () => {
  it("保存两种执行时间、时长与本日启动记录，重启后不会丢失", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-scan-"));
    const filename = path.join(directory, "scan.sqlite");
    try {
      const first = new ScanScheduleStore(filename);
      const plan = { ...only(1, 3), daily: { startTime: "08:30" }, maxDurationMinutes: 45 };
      first.setConfig(plan);
      first.setMode("enabled");
      first.setLastScheduledDate(localDateKey(local(28, 9)));
      first.setNextRunAt(local(30, 22));
      first.close();
      const reopened = new ScanScheduleStore(filename);
      expect(reopened.read()).toMatchObject({
        config: plan,
        mode: "enabled",
        lastScheduledDate: localDateKey(local(28, 9)),
        nextRunAt: local(30, 22),
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("旧版配置保留开始时间，忽略结束时间和轮次间隔", () => {
    const store = new ScanScheduleStore(":memory:");
    created.push(store);
    store.db
      .prepare("UPDATE scan_schedule SET config_json=? WHERE id=1")
      .run(JSON.stringify({ startTime: "08:00", endTime: "23:00", intervalMinutes: 30 }));
    expect(store.read().config).toMatchObject({
      scheduleType: "daily",
      daily: { startTime: "08:00" },
      maxDurationMinutes: null,
    });
    store.db.prepare("UPDATE scan_schedule SET config_json=? WHERE id=1").run(
      JSON.stringify({
        weekdays: [1, 3, 5],
        startTime: "11:00",
        endTime: "20:00",
        intervalMinutes: 10,
      }),
    );
    expect(store.read().config.scheduleType).toBe("weekly");
    expect(
      store
        .read()
        .config.days.filter((day) => day.enabled)
        .map((day) => day.weekday),
    ).toEqual([1, 3, 5]);
    store.db.prepare("UPDATE scan_schedule SET config_json=? WHERE id=1").run(
      JSON.stringify({
        scheduleType: "weekly",
        daily: { startTime: "07:00", endTime: "21:00" },
        days: only(1, 3).days,
        intervalMinutes: 10,
      }),
    );
    expect(store.read().config).toMatchObject({
      scheduleType: "weekly",
      daily: { startTime: "07:00" },
      maxDurationMinutes: null,
    });
    expect(
      store
        .read()
        .config.days.filter((day) => day.enabled)
        .map((day) => day.weekday),
    ).toEqual([1, 3]);
  });

  it("旧数据库迁移时记住上次执行日，避免当天升级后重跑", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-scan-old-"));
    const filename = path.join(directory, "scan.sqlite");
    try {
      const db = new DatabaseSync(filename);
      db.exec(`CREATE TABLE scan_schedule (
        id INTEGER PRIMARY KEY CHECK(id=1), config_json TEXT NOT NULL,
        mode TEXT NOT NULL, issue TEXT, next_run_at INTEGER, last_run_json TEXT
      )`);
      db.prepare(
        "INSERT INTO scan_schedule(id,config_json,mode,last_run_json) VALUES(1,?,'enabled',?)",
      ).run(
        JSON.stringify({ ...config, intervalMinutes: 30 }),
        JSON.stringify({ startedAt: new Date(local(25, 22)).toISOString(), outcome: "completed" }),
      );
      db.close();
      const upgraded = new ScanScheduleStore(filename);
      expect(upgraded.read().lastScheduledDate).toBe(localDateKey(local(25, 22)));
      upgraded.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("两个服务只有一个调度者，锁过期后可接管", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-scan-lock-"));
    const filename = path.join(directory, "scan.sqlite");
    try {
      const first = new ScanScheduleStore(filename);
      const second = new ScanScheduleStore(filename);
      expect(first.acquire(1000)).toBe(true);
      expect(second.acquire(2000)).toBe(false);
      expect(second.acquire(46001)).toBe(true);
      first.release();
      expect(second.acquire(47000)).toBe(true);
      second.release();
      first.close();
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("扫描调度", () => {
  it("每天到点启动一次，完成后同日不再启动，次日继续", async () => {
    const store = memoryStore(daily());
    let now = local(25, 8);
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(store.read().nextRunAt).toBe(local(25, 9));
    expect(fake.driver.browserStatus).not.toHaveBeenCalled();
    now = local(25, 9);
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    expect(store.read().lastScheduledDate).toBe(localDateKey(now));
    now = local(25, 10);
    fake.finish(crawlStatus("completed"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("completed"));
    expect(store.read().nextRunAt).toBe(local(26, 9));
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    const restarted = new ScanScheduler(store, fake.driver, () => now);
    await restarted.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    restarted.disable();
    restarted.enable();
    await restarted.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    now = local(26, 9);
    await restarted.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(2);
  });

  it("每周未选中日不准备浏览器，到选中日才启动", async () => {
    const store = memoryStore(only(1));
    let now = local(25, 22); // 周五
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(fake.driver.browserStatus).not.toHaveBeenCalled();
    expect(store.read().nextRunAt).toBe(local(28, 22));
    now = local(28, 22); // 周一
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    now = local(28, 23);
    fake.finish(crawlStatus("completed"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("completed"));
    expect(store.read().nextRunAt).toBe(local(28 + 7, 22));
  });

  it("时长到期暂停并保留计划，下一运行日再执行", async () => {
    const store = memoryStore(daily(30));
    let now = local(25, 9);
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    now = local(25, 9, 29);
    await scheduler.tick();
    expect(fake.driver.stopCrawl).not.toHaveBeenCalled();
    now = local(25, 9, 30);
    await scheduler.tick();
    await scheduler.tick();
    expect(fake.driver.stopCrawl).toHaveBeenCalledTimes(1);
    expect(fake.driver.stopCrawl).toHaveBeenCalledWith("time_limit");
    fake.finish(crawlStatus("paused"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("time_limit"));
    expect(store.read().mode).toBe("enabled");
    expect(store.read().nextRunAt).toBe(local(26, 9));
    expect(store.read().lastRun?.message).toContain("断点已保留");
  });

  it("关闭计划后当前扫描仍遵守已设置的运行时长", async () => {
    const store = memoryStore(daily(30));
    let now = local(25, 9);
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    scheduler.disable();
    now = local(25, 9, 30);
    await scheduler.tick();
    expect(fake.driver.stopCrawl).toHaveBeenCalledWith("time_limit");
    fake.finish(crawlStatus("paused"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("time_limit"));
    expect(store.read().mode).toBe("disabled");
  });

  it("时长留空可跨日运行，覆盖期间到点的触发且不补跑", async () => {
    const store = memoryStore(daily());
    let now = local(25, 9);
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    now = local(26, 10);
    await scheduler.tick();
    expect(fake.driver.stopCrawl).not.toHaveBeenCalled();
    fake.finish(crawlStatus("completed"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("completed"));
    expect(store.read().lastScheduledDate).toBe(localDateKey(now));
    expect(store.read().nextRunAt).toBe(local(27, 9));
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("到点未登录时等待一次，登录后自动启动", async () => {
    const store = memoryStore(daily());
    const fake = fakeDriver();
    fake.setReady(false);
    const scheduler = new ScanScheduler(store, fake.driver, () => local(25, 9));
    await scheduler.tick();
    await scheduler.tick();
    expect(fake.driver.openBrowser).toHaveBeenCalledTimes(1);
    expect(fake.driver.startCrawl).not.toHaveBeenCalled();
    fake.setReady(true);
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("旧采集锁到期后再尝试本日唯一一次启动", async () => {
    const store = memoryStore(daily());
    const fake = fakeDriver();
    const start = fake.driver.startCrawl;
    fake.driver.startCrawl = vi
      .fn()
      .mockRejectedValueOnce(new Error("已有另一个本地服务正在采集，请先暂停它"))
      .mockImplementation(() => start());
    const scheduler = new ScanScheduler(store, fake.driver, () => local(25, 9));
    await scheduler.tick();
    expect(scheduler.status().state).toBe("waiting_lock");
    expect(store.read().lastScheduledDate).toBeNull();
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(2);
    expect(store.read().lastScheduledDate).toBe(localDateKey(local(25, 9)));
  });

  it("致命错误暂停计划；手动恢复可重试当日，手动关闭不会自动重启", async () => {
    const store = memoryStore(daily());
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => local(25, 9));
    await scheduler.tick();
    fake.finish(crawlStatus("error"));
    await vi.waitFor(() => expect(store.read().mode).toBe("suspended"));
    scheduler.enable();
    await vi.waitFor(() => expect(fake.driver.startCrawl).toHaveBeenCalledTimes(2));
    scheduler.disable();
    fake.finish(crawlStatus("paused"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("paused"));
    expect(store.read().mode).toBe("disabled");
  });
});
