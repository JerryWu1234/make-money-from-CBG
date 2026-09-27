import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenCbgResult } from "../types";
import type { ActiveCrawl, CrawlOrigin } from "./controller";
import { ScanScheduler } from "./schedule";
import { ScanScheduleStore } from "./schedule-store";
import { localDateKey, parseScanScheduleConfig, scheduledStartsForDay } from "./schedule-time";
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
const multiDaily = (): ScanScheduleConfig => ({
  ...daily(60),
  daily: { startTime: "09:00", additionalStartTimes: ["13:00"] },
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

function fakeDriver(now: () => number) {
  let active: ActiveCrawl | null = null;
  let finish: ((value: CrawlStatus) => void) | null = null;
  let ready = true;
  let browserResult: OpenCbgResult | null = null;
  const begin = (origin: CrawlOrigin) => {
    const completion = new Promise<CrawlStatus>((resolve) => {
      finish = resolve;
    });
    const activity: ActiveCrawl = { origin, startedAt: now(), completion };
    active = activity;
    void completion.finally(() => {
      if (active === activity) active = null;
    });
    return { status: crawlStatus("collecting"), started: true, activity };
  };
  const driver = {
    browserStatus: vi.fn(async () => browserResult ?? browser(ready)),
    openBrowser: vi.fn(() => browser(false)),
    notifyLogin: vi.fn(),
    startCrawl: vi.fn(async (canStart: () => boolean) => {
      if (active) return { status: crawlStatus("collecting"), started: false, activity: active };
      if (!canStart()) return { status: crawlStatus("idle"), started: false, activity: null };
      return begin("scheduled");
    }),
    crawlActivity: vi.fn(() => active),
    stopCrawl: vi.fn((_reason?: "time_limit") => crawlStatus("paused")),
  };
  return {
    driver,
    startManual() {
      return begin("manual");
    },
    setReady(value: boolean) {
      ready = value;
    },
    setBrowserResult(value: OpenCbgResult | null) {
      browserResult = value;
    },
    finish(value: CrawlStatus) {
      if (!finish) throw new Error("没有运行中的扫描");
      finish(value);
    },
  };
}

describe("计划时间", () => {
  it("每天及每周各运行日可配置最多五个启动时间", () => {
    const plan = parseScanScheduleConfig({
      ...daily(60),
      daily: { startTime: "18:00", additionalStartTimes: ["09:00", "13:00"] },
    });
    expect(plan.daily).toEqual({ startTime: "09:00", additionalStartTimes: ["13:00", "18:00"] });
    expect(scheduledStartsForDay(new Date(local(25, 0)), plan)).toEqual([
      local(25, 9),
      local(25, 13),
      local(25, 18),
    ]);
    expect(() =>
      parseScanScheduleConfig({
        ...daily(30),
        daily: {
          startTime: "08:00",
          additionalStartTimes: ["09:00", "10:00", "11:00", "12:00", "13:00"],
        },
      }),
    ).toThrow("最多设置 5 个");
    expect(() =>
      parseScanScheduleConfig({
        ...daily(30),
        daily: { startTime: "08:00", additionalStartTimes: ["08:00"] },
      }),
    ).toThrow("不能重复");
    const weekly = only(1, 3);
    const retained = parseScanScheduleConfig({
      ...weekly,
      maxDurationMinutes: 60,
      daily: { startTime: "08:00", additionalStartTimes: ["12:00"] },
      days: weekly.days.map((day) =>
        day.weekday === 3 ? { ...day, additionalStartTimes: ["19:00"] } : day,
      ),
    });
    expect(retained.daily.additionalStartTimes).toEqual(["12:00"]);
    expect(retained.days[2]).toMatchObject({ startTime: "19:00", additionalStartTimes: ["22:00"] });
  });

  it("同一天多段必须有时长，并校验每日、跨午夜和每周相邻间隔", () => {
    const two = { ...daily(), daily: { startTime: "09:00", additionalStartTimes: ["13:00"] } };
    expect(() => parseScanScheduleConfig(two)).toThrow("必须填写最长运行时长");
    expect(() => parseScanScheduleConfig({ ...two, maxDurationMinutes: 241 })).toThrow("至少间隔");
    expect(
      parseScanScheduleConfig({ ...two, maxDurationMinutes: 240 }).daily.additionalStartTimes,
    ).toEqual(["13:00"]);
    expect(() =>
      parseScanScheduleConfig({
        ...daily(601),
        daily: { startTime: "09:00", additionalStartTimes: ["23:00"] },
      }),
    ).toThrow("至少间隔");
    const week = only(1, 2);
    expect(() =>
      parseScanScheduleConfig({
        ...week,
        maxDurationMinutes: 120,
        days: week.days.map((day) =>
          day.weekday === 1
            ? { ...day, startTime: "20:00", additionalStartTimes: ["23:00"] }
            : day.weekday === 2
              ? { ...day, startTime: "00:30" }
              : day,
        ),
      }),
    ).toThrow("至少间隔");
  });

  it("校验执行时间、运行日和可选时长", () => {
    expect(parseScanScheduleConfig(config)).toEqual(config);
    expect(parseScanScheduleConfig(daily())).toEqual(daily());
    expect(
      parseScanScheduleConfig({ ...config, maxDurationMinutes: 1500 }).maxDurationMinutes,
    ).toBe(1500);
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

  it("每周在选中日使用各自的多个时间", () => {
    const plan = {
      ...only(1, 3),
      days: only(1, 3).days.map((day) =>
        day.weekday === 1
          ? { ...day, startTime: "09:00", additionalStartTimes: ["13:00"] }
          : day.weekday === 3
            ? { ...day, startTime: "13:00" }
            : day,
      ),
    };
    expect(scheduledStartsForDay(new Date(local(25, 0)), plan)).toEqual([]);
    expect(scheduledStartsForDay(new Date(local(28, 0)), plan)).toEqual([
      local(28, 9),
      local(28, 13),
    ]);
    expect(scheduledStartsForDay(new Date(local(30, 0)), plan)).toEqual([local(30, 13)]);
  });
});

describe("计划持久化", () => {
  it("多个时间点的配置、执行状态和待登录时间在服务重启后保留", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-scan-multi-"));
    const filename = path.join(directory, "scan.sqlite");
    try {
      const first = new ScanScheduleStore(filename);
      first.setConfig(multiDaily());
      first.setMode("enabled");
      first.recordSlot(local(25, 9), "completed", local(25, 9));
      first.setPendingLoginAt(local(25, 13));
      first.close();
      const reopened = new ScanScheduleStore(filename);
      expect(reopened.read().config.daily.additionalStartTimes).toEqual(["13:00"]);
      expect(reopened.slotOutcome(local(25, 9))).toBe("completed");
      expect(reopened.read().pendingLoginAt).toBe(local(25, 13));
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("保存两种执行时间、时长与本日启动记录，重启后不会丢失", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-scan-"));
    const filename = path.join(directory, "scan.sqlite");
    try {
      const first = new ScanScheduleStore(filename);
      const plan = { ...only(1, 3), daily: { startTime: "08:30" }, maxDurationMinutes: 45 };
      first.setConfig(plan);
      first.setMode("enabled");
      first.setEnabledAt(local(28, 8));
      first.setLastScheduledDate(localDateKey(local(28, 9)));
      first.setPendingLoginDate(localDateKey(local(30, 13)));
      first.setLastLoginNotifiedDate(localDateKey(local(30, 13)));
      first.setLastSkippedDate(localDateKey(local(28, 9)));
      first.setNextRunAt(local(30, 22));
      first.close();
      const reopened = new ScanScheduleStore(filename);
      expect(reopened.read()).toMatchObject({
        config: plan,
        mode: "enabled",
        enabledAt: local(28, 8),
        lastScheduledDate: localDateKey(local(28, 9)),
        pendingLoginDate: localDateKey(local(30, 13)),
        pendingLoginAt: local(30, 22),
        lastLoginNotifiedDate: localDateKey(local(30, 13)),
        lastSkippedDate: localDateKey(local(28, 9)),
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
      expect(upgraded.slotOutcome(local(25, 22))).toBe("completed");
      expect(upgraded.read().enabledAt).toBeNull();
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
  it("一天按两个时间点分别执行，完成后只等待下一段", async () => {
    const store = memoryStore(multiDaily());
    let now = local(25, 8);
    const fake = fakeDriver(() => now);
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(store.read().nextRunAt).toBe(local(25, 9));
    now = local(25, 9);
    await scheduler.tick();
    expect(store.slotOutcome(local(25, 9))).toBe("started");
    now = local(25, 10);
    fake.finish(crawlStatus("completed"));
    await vi.waitFor(() => expect(store.read().nextRunAt).toBe(local(25, 13)));
    now = local(25, 13);
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(2);
    expect(store.slotOutcome(local(25, 13))).toBe("started");
    now = local(25, 14);
    fake.finish(crawlStatus("completed"));
    await vi.waitFor(() => expect(store.read().nextRunAt).toBe(local(26, 9)));
  });

  it("登录等待只属于当前时间点，下一时间点到来后跳过旧段", async () => {
    const store = memoryStore(multiDaily());
    let now = local(25, 9);
    const fake = fakeDriver(() => now);
    fake.setReady(false);
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(store.read().pendingLoginAt).toBe(local(25, 9));
    now = local(25, 13);
    fake.setReady(true);
    await scheduler.tick();
    expect(store.slotOutcome(local(25, 9))).toBe("skipped");
    expect(store.read().lastSkippedAt).toBe(local(25, 9));
    expect(store.slotOutcome(local(25, 13))).toBe("started");
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("前一段仍在扫描时跳过重叠时间点，完成后不补跑", async () => {
    const store = memoryStore(multiDaily());
    let now = local(25, 9);
    const fake = fakeDriver(() => now);
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    now = local(25, 13);
    await scheduler.tick();
    expect(store.slotOutcome(local(25, 13))).toBe("skipped");
    now = local(25, 13, 10);
    fake.finish(crawlStatus("completed"));
    await vi.waitFor(() => expect(store.read().nextRunAt).toBe(local(26, 9)));
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("前一段恰好在下个时间点结束时，下一段可以开始", async () => {
    const store = memoryStore(multiDaily());
    let now = local(25, 9);
    const fake = fakeDriver(() => now);
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    now = local(25, 13);
    fake.finish(crawlStatus("completed"));
    await vi.waitFor(() => expect(store.slotOutcome(local(25, 9))).toBe("completed"));
    await scheduler.tick();
    expect(store.slotOutcome(local(25, 13))).toBe("started");
  });

  it("重启后只补当前最近的时间点，不补当天更早的段", async () => {
    const store = memoryStore(multiDaily());
    const now = local(25, 13, 30);
    const fake = fakeDriver(() => now);
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(store.slotOutcome(local(25, 9))).toBe("skipped");
    expect(store.slotOutcome(local(25, 13))).toBe("started");
    const restarted = new ScanScheduler(store, fake.driver, () => now);
    await restarted.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("启动检查跨过下一时间点时不再启动旧段", async () => {
    const store = memoryStore(multiDaily());
    let now = local(25, 12, 59);
    const fake = fakeDriver(() => now);
    const start = fake.driver.startCrawl;
    fake.driver.startCrawl = vi.fn(async (canStart) => {
      now = local(25, 13);
      return start(canStart);
    });
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(fake.driver.crawlActivity()).toBeNull();
    await scheduler.tick();
    expect(store.slotOutcome(local(25, 9))).toBe("skipped");
    expect(store.slotOutcome(local(25, 13))).toBe("started");
  });

  it("修改配置只影响后续时间点，运行中修改时长不延长当前轮", async () => {
    const store = memoryStore(multiDaily());
    let now = local(25, 9);
    const fake = fakeDriver(() => now);
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    now = local(25, 9, 30);
    scheduler.configure({ ...multiDaily(), maxDurationMinutes: 120 });
    await scheduler.tick();
    now = local(25, 10);
    await scheduler.tick();
    expect(fake.driver.stopCrawl).toHaveBeenCalledWith("time_limit");
    fake.finish(crawlStatus("paused"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("time_limit"));
    scheduler.configure({
      ...multiDaily(),
      daily: { startTime: "08:00", additionalStartTimes: ["13:00"] },
    });
    await scheduler.tick();
    expect(store.read().nextRunAt).toBe(local(25, 13));
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("改配置也不能让同一天实际启动超过五段", async () => {
    const plan = {
      ...daily(30),
      daily: { startTime: "09:00", additionalStartTimes: ["11:00", "13:00", "15:00", "17:00"] },
    };
    const store = memoryStore(plan);
    let now = local(25, 9);
    const fake = fakeDriver(() => now);
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    for (const hour of [9, 11, 13, 15, 17]) {
      now = local(25, hour);
      await scheduler.tick();
      now = local(25, hour, 10);
      fake.finish(crawlStatus("completed"));
      await vi.waitFor(() => expect(store.slotOutcome(local(25, hour))).toBe("completed"));
    }
    scheduler.configure({ ...daily(30), daily: { startTime: "19:00" } });
    await scheduler.tick();
    now = local(25, 19);
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(5);
    expect(store.slotOutcome(local(25, 19))).toBe("skipped");
  });

  it("过点后启用等待下一运行日，服务重启也不会补跑启用前错过的任务", async () => {
    const store = memoryStore(daily());
    store.setMode("disabled");
    let now = local(25, 11);
    const fake = fakeDriver(() => now);
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    scheduler.enable();
    await scheduler.tick();
    expect(store.read().enabledAt).toBe(now);
    expect(store.read().lastScheduledDate).toBeNull();
    expect(store.read().nextRunAt).toBe(local(26, 9));
    expect(fake.driver.browserStatus).not.toHaveBeenCalled();

    const restarted = new ScanScheduler(store, fake.driver, () => now);
    await restarted.tick();
    expect(fake.driver.startCrawl).not.toHaveBeenCalled();
    now = local(26, 9);
    await restarted.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("提前启用后服务错过执行时间，恢复时补跑当天一次", async () => {
    const store = memoryStore(daily());
    store.setMode("disabled");
    let now = local(25, 8);
    const fake = fakeDriver(() => now);
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    scheduler.enable();
    await scheduler.tick();
    expect(store.read().nextRunAt).toBe(local(25, 9));

    now = local(25, 11);
    const restarted = new ScanScheduler(store, fake.driver, () => now);
    await restarted.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    expect(store.read().lastScheduledDate).toBe(localDateKey(now));
  });

  it("已有手动采集时关闭计划，不计入定时轮次或执行时长", async () => {
    const store = memoryStore(daily(1));
    let now = local(25, 9);
    const fake = fakeDriver(() => now);
    fake.startManual();
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(store.read().mode).toBe("disabled");
    expect(store.read().lastScheduledDate).toBeNull();
    expect(fake.driver.startCrawl).not.toHaveBeenCalled();
    now = local(25, 9, 2);
    await scheduler.tick();
    expect(fake.driver.stopCrawl).not.toHaveBeenCalled();
    fake.finish(crawlStatus("error"));
    await vi.waitFor(() => expect(fake.driver.crawlActivity()).toBeNull());
    expect(store.read().lastRun).toBeNull();
  });

  it("检查浏览器期间手动采集启动时，不把手动任务认作定时任务", async () => {
    const store = memoryStore(daily(1));
    const now = local(25, 9);
    const fake = fakeDriver(() => now);
    fake.driver.browserStatus.mockImplementationOnce(async () => {
      fake.startManual();
      return browser(true);
    });
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    expect(store.read().mode).toBe("disabled");
    expect(store.read().lastScheduledDate).toBeNull();
    expect(fake.driver.stopCrawl).not.toHaveBeenCalled();
    fake.finish(crawlStatus("error"));
  });

  it("计划关闭时，尚在检查启动条件的定时任务不会再启动", async () => {
    const store = memoryStore(daily());
    const now = local(25, 9);
    const fake = fakeDriver(() => now);
    const start = fake.driver.startCrawl;
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    fake.driver.startCrawl = vi.fn(async (canStart) => {
      scheduler.disable();
      return start(canStart);
    });
    await scheduler.tick();
    expect(fake.driver.crawlActivity()).toBeNull();
    expect(store.read().lastScheduledDate).toBeNull();
    expect(fake.driver.stopCrawl).not.toHaveBeenCalled();
  });

  it("浏览器流程报错时提示处理，恢复计划会重新准备页面", async () => {
    const store = memoryStore(daily());
    const now = local(25, 9);
    const fake = fakeDriver(() => now);
    fake.setBrowserResult({
      ...browser(false),
      workflowStep: "error",
      error: { code: "CBG_ROLE_LIST", message: "网站要求安全验证，请完成验证后重试。" },
    });
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(store.read().mode).toBe("suspended");
    expect(scheduler.status().state).toBe("needs_action");
    expect(fake.driver.startCrawl).not.toHaveBeenCalled();
    scheduler.enable();
    await scheduler.tick();
    expect(fake.driver.openBrowser).toHaveBeenCalledTimes(1);
    fake.setBrowserResult(browser(true));
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("登录失效时保留计划，当天扫码完成后自动执行且只通知一次", async () => {
    const store = memoryStore(daily());
    let now = local(25, 9);
    const fake = fakeDriver(() => now);
    fake.setBrowserResult({ ...browser(false), message: "登录已失效，请重新开始。" });
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    await scheduler.tick();
    expect(store.read().mode).toBe("enabled");
    expect(store.read().pendingLoginDate).toBe(localDateKey(now));
    expect(scheduler.status().state).toBe("waiting_login");
    expect(fake.driver.openBrowser).toHaveBeenCalledTimes(1);
    expect(fake.driver.notifyLogin).toHaveBeenCalledTimes(1);
    expect(fake.driver.startCrawl).not.toHaveBeenCalled();

    now = local(25, 9, 30);
    fake.setBrowserResult(browser(true));
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    expect(store.read().pendingLoginDate).toBeNull();
    expect(store.read().lastScheduledDate).toBe(localDateKey(now));
    now = local(25, 10);
    fake.finish(crawlStatus("completed"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("completed"));
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("扫码超时不关闭计划，重新扫码成功后仍执行当天一轮", async () => {
    const store = memoryStore(daily());
    const now = local(25, 9);
    const fake = fakeDriver(() => now);
    fake.setBrowserResult({ ...browser(false), message: "登录已失效，请重新开始。" });
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    fake.setBrowserResult({
      ...browser(false),
      workflowStep: "error",
      error: {
        code: "CBG_LOGGING_IN",
        message: "等待扫码登录超时，请点击重新开始获取当前二维码。",
      },
    });
    await scheduler.tick();
    expect(store.read().mode).toBe("enabled");
    expect(scheduler.status().state).toBe("waiting_login");
    expect(fake.driver.openBrowser).toHaveBeenCalledTimes(1);
    fake.setBrowserResult(browser(true));
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("过午夜仍未登录则跳过该日，登录后等待下一次计划时间", async () => {
    const store = memoryStore(daily());
    let now = local(25, 23, 30);
    const fake = fakeDriver(() => now);
    fake.setBrowserResult({ ...browser(false), message: "登录已失效，请重新开始。" });
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    const missed = localDateKey(now);
    now = local(26, 0, 1);
    fake.setBrowserResult(browser(true));
    await scheduler.tick();
    expect(store.read().lastSkippedDate).toBe(missed);
    expect(store.read().pendingLoginDate).toBeNull();
    expect(store.read().nextRunAt).toBe(local(26, 9));
    expect(fake.driver.startCrawl).not.toHaveBeenCalled();
    now = local(26, 9);
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("每周计划错过登录后等待下一个选中的星期", async () => {
    const store = memoryStore(only(1, 3));
    let now = local(28, 22); // 周一
    const fake = fakeDriver(() => now);
    fake.setBrowserResult({ ...browser(false), message: "登录已失效，请重新开始。" });
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    now = local(29, 0, 1); // 周二
    fake.setBrowserResult(browser(true));
    await scheduler.tick();
    expect(store.read().lastSkippedDate).toBe(localDateKey(local(28, 22)));
    expect(store.read().nextRunAt).toBe(local(30, 22));
    expect(fake.driver.startCrawl).not.toHaveBeenCalled();
    now = local(30, 22); // 周三
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("启动前跨过午夜时不启动过期的那一轮", async () => {
    const store = memoryStore(daily());
    let now = local(25, 23, 59);
    const fake = fakeDriver(() => now);
    fake.setBrowserResult({ ...browser(false), message: "登录已失效，请重新开始。" });
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    fake.setBrowserResult(browser(true));
    const start = fake.driver.startCrawl;
    fake.driver.startCrawl = vi.fn(async (canStart) => {
      now = local(26, 0, 1);
      return start(canStart);
    });
    await scheduler.tick();
    expect(fake.driver.crawlActivity()).toBeNull();
    await scheduler.tick();
    expect(store.read().lastSkippedDate).toBe(localDateKey(local(25, 23)));
    expect(store.read().nextRunAt).toBe(local(26, 9));
  });

  it("等待登录期间不计入最长运行时长", async () => {
    const store = memoryStore(daily(30));
    let now = local(25, 9);
    const fake = fakeDriver(() => now);
    fake.setBrowserResult({ ...browser(false), message: "登录已失效，请重新开始。" });
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    now = local(25, 9, 20);
    fake.setBrowserResult(browser(true));
    await scheduler.tick();
    now = local(25, 9, 49);
    await scheduler.tick();
    expect(fake.driver.stopCrawl).not.toHaveBeenCalled();
    now = local(25, 9, 50);
    await scheduler.tick();
    expect(fake.driver.stopCrawl).toHaveBeenCalledWith("time_limit");
  });

  it("系统通知失败也不暂停计划", async () => {
    const store = memoryStore(daily());
    const now = local(25, 9);
    const fake = fakeDriver(() => now);
    fake.setBrowserResult({ ...browser(false), message: "登录已失效，请重新开始。" });
    fake.driver.notifyLogin.mockImplementationOnce(() => {
      throw new Error("通知不可用");
    });
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(store.read().mode).toBe("enabled");
    expect(store.read().pendingLoginDate).toBe(localDateKey(now));
  });

  it("服务重启后等待状态保留，同一天不重复通知", async () => {
    const store = memoryStore(daily());
    let now = local(25, 9);
    const fake = fakeDriver(() => now);
    fake.setBrowserResult({ ...browser(false), message: "登录已失效，请重新开始。" });
    const first = new ScanScheduler(store, fake.driver, () => now);
    await first.tick();
    now = local(25, 10);
    const restarted = new ScanScheduler(store, fake.driver, () => now);
    await restarted.tick();
    expect(store.read().pendingLoginDate).toBe(localDateKey(now));
    expect(fake.driver.notifyLogin).toHaveBeenCalledTimes(1);
    now = local(26, 0, 1);
    await restarted.tick();
    expect(store.read().lastSkippedDate).toBe(localDateKey(local(25, 9)));
  });

  it("每天到点启动一次，完成后同日不再启动，次日继续", async () => {
    const store = memoryStore(daily());
    let now = local(25, 8);
    const fake = fakeDriver(() => now);
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
    const fake = fakeDriver(() => now);
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
    const fake = fakeDriver(() => now);
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
    const fake = fakeDriver(() => now);
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
    const fake = fakeDriver(() => now);
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
    const fake = fakeDriver(() => local(25, 9));
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
    const fake = fakeDriver(() => local(25, 9));
    const start = fake.driver.startCrawl;
    fake.driver.startCrawl = vi
      .fn()
      .mockRejectedValueOnce(new Error("已有另一个本地服务正在采集，请先暂停它"))
      .mockImplementation((canStart) => start(canStart));
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
    const fake = fakeDriver(() => local(25, 9));
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
