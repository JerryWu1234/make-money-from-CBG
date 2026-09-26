import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenCbgResult } from "../types";
import { ScanScheduler } from "./schedule";
import { ScanScheduleStore } from "./schedule-store";
import { nextScanTime, parseScanScheduleConfig, scanWindow } from "./schedule-time";
import type { CrawlStatus } from "./types";

const config = {
  scheduleType: "weekly" as const,
  daily: { startTime: "09:00", endTime: "23:00" },
  days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    enabled: true,
    startTime: "22:00",
    endTime: "02:00",
  })),
  intervalMinutes: 10,
};
const only = (...weekdays: number[]) => ({
  ...config,
  days: config.days.map((day) => ({ ...day, enabled: weekdays.includes(day.weekday) })),
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
  message: phase === "completed" ? "本轮完成" : "采集失败",
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

function memoryStore() {
  const store = new ScanScheduleStore(":memory:");
  created.push(store);
  store.setConfig(config);
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
    stopCrawl: vi.fn(() => crawlStatus("paused")),
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

describe("定时窗口", () => {
  it("验证时间和最短间隔，允许跨午夜", () => {
    expect(parseScanScheduleConfig(config)).toEqual(config);
    expect(() => parseScanScheduleConfig({ ...config, intervalMinutes: 9 })).toThrow("10 分钟");
    expect(() => parseScanScheduleConfig(only())).toThrow("至少选择一天");
    expect(() =>
      parseScanScheduleConfig({
        ...config,
        scheduleType: "daily",
        daily: { startTime: "08:00", endTime: "08:00" },
      }),
    ).toThrow("每天开始和结束时间不能相同");
    expect(() =>
      parseScanScheduleConfig({
        ...config,
        days: config.days.map((day) => (day.weekday === 1 ? { ...day, endTime: "22:00" } : day)),
      }),
    ).toThrow("周一开始和结束时间不能相同");
    expect(() =>
      parseScanScheduleConfig({
        ...config,
        days: config.days.map((day) => (day.weekday === 1 ? { ...day, startTime: "25:00" } : day)),
      }),
    ).toThrow("周一开始时间格式错误");
    expect(() => parseScanScheduleConfig({ ...config, days: config.days.slice(1) })).toThrow(
      "完整设置",
    );
  });

  it("跨午夜窗口在次日 02:00 截止", () => {
    expect(scanWindow(local(25, 23), config).active).toBe(true);
    expect(scanWindow(local(26, 1), config).active).toBe(true);
    expect(scanWindow(local(26, 2), config).active).toBe(false);
    expect(nextScanTime(local(26, 2), config)).toBe(local(26, 22));
  });

  it("每天循环使用同一时段，每天都能启动并支持跨午夜", () => {
    const daily = {
      ...only(),
      scheduleType: "daily" as const,
      daily: { startTime: "22:00", endTime: "02:00" },
    };
    expect(parseScanScheduleConfig(daily)).toEqual(daily);
    expect(scanWindow(local(25, 23), daily).active).toBe(true); // 周五
    expect(scanWindow(local(26, 1), daily).active).toBe(true); // 周六凌晨
    expect(scanWindow(local(26, 22), daily).active).toBe(true); // 周六仍会启动
    expect(nextScanTime(local(27, 2), daily)).toBe(local(27, 22));
  });

  it("本轮结束加间隔越过窗口时，排到下次开始", () => {
    expect(nextScanTime(local(26, 1, 45), config)).toBe(local(26, 1, 45));
    expect(nextScanTime(local(26, 2, 5), config)).toBe(local(26, 22));
  });

  it("只在选中的星期启动，跨午夜时间仍属于开始那天", () => {
    const weekly = only(1, 3, 5);
    expect(scanWindow(local(25, 23), weekly).active).toBe(true); // 周五
    expect(scanWindow(local(26, 1), weekly).active).toBe(true); // 周六凌晨仍是周五窗口
    expect(scanWindow(local(26, 22), weekly).active).toBe(false);
    expect(nextScanTime(local(26, 2), weekly)).toBe(local(28, 22)); // 下周一
    expect(nextScanTime(local(28, 1), only(7))).toBe(local(28, 1));
  });

  it("各运行日按自己的开始和结束时间执行", () => {
    const weekly = {
      ...only(1, 3),
      days: only(1, 3).days.map((day) =>
        day.weekday === 1
          ? { ...day, startTime: "09:00", endTime: "11:00" }
          : day.weekday === 3
            ? { ...day, startTime: "13:00", endTime: "15:00" }
            : day,
      ),
    };
    expect(scanWindow(local(28, 10), weekly).active).toBe(true); // 周一
    expect(scanWindow(local(30, 10), weekly).active).toBe(false); // 周三尚未开始
    expect(nextScanTime(local(30, 10), weekly)).toBe(local(30, 13));
  });
});

describe("计划持久化", () => {
  it("保存设置和上轮结果，服务重新打开后仍可恢复", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-scan-"));
    const filename = path.join(directory, "scan.sqlite");
    try {
      const first = new ScanScheduleStore(filename);
      first.setConfig(config);
      first.setMode("enabled");
      first.setNextRunAt(local(26, 22));
      first.recordRun({
        startedAt: new Date(local(25, 22)).toISOString(),
        endedAt: new Date(local(25, 23)).toISOString(),
        outcome: "completed",
        saved: 2,
        skipped: 3,
        failed: 1,
        message: "本轮完成",
      });
      first.close();
      const reopened = new ScanScheduleStore(filename);
      expect(reopened.read()).toMatchObject({
        config,
        mode: "enabled",
        nextRunAt: local(26, 22),
        lastRun: { outcome: "completed", saved: 2 },
      });
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("读取旧版每日和每周计划时保留原来的循环规则", () => {
    const store = new ScanScheduleStore(":memory:");
    created.push(store);
    store.db
      .prepare("UPDATE scan_schedule SET config_json=? WHERE id=1")
      .run(JSON.stringify({ startTime: "09:00", endTime: "23:00", intervalMinutes: 30 }));
    expect(store.read().config).toMatchObject({
      scheduleType: "daily",
      daily: { startTime: "09:00", endTime: "23:00" },
    });
    expect(store.read().config.days.every((day) => day.enabled)).toBe(true);
    store.db.prepare("UPDATE scan_schedule SET config_json=? WHERE id=1").run(
      JSON.stringify({
        weekdays: [1, 3, 5],
        startTime: "09:00",
        endTime: "23:00",
        intervalMinutes: 30,
      }),
    );
    expect(
      store
        .read()
        .config.days.filter((day) => day.enabled)
        .map((day) => day.weekday),
    ).toEqual([1, 3, 5]);
    expect(store.read().config.scheduleType).toBe("weekly");
    store.db
      .prepare("UPDATE scan_schedule SET config_json=? WHERE id=1")
      .run(JSON.stringify({ days: config.days, intervalMinutes: 10 }));
    expect(store.read().config).toMatchObject({
      scheduleType: "weekly",
      daily: { startTime: "09:00", endTime: "23:00" },
      days: config.days,
    });
  });

  it("切换循环方式时，两套时段设置都能持久保存", () => {
    const store = memoryStore();
    const daily = {
      ...only(1, 3, 5),
      scheduleType: "daily" as const,
      daily: { startTime: "08:30", endTime: "20:30" },
    };
    store.setConfig(parseScanScheduleConfig(daily));
    expect(store.read().config).toEqual(daily);
    store.setConfig(parseScanScheduleConfig({ ...daily, scheduleType: "weekly" }));
    expect(store.read().config).toEqual({ ...daily, scheduleType: "weekly" });
  });

  it("两个本地服务只能有一个计划调度者，过期后可接管", () => {
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
  it("从每周切到每天循环时，当天时段内立即启动", async () => {
    const store = memoryStore();
    store.setConfig(only(1));
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => local(25, 22)); // 周五
    await scheduler.tick();
    expect(fake.driver.startCrawl).not.toHaveBeenCalled();
    scheduler.configure({
      ...only(1),
      scheduleType: "daily",
      daily: { startTime: "21:00", endTime: "23:00" },
    });
    await vi.waitFor(() => expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1));
  });

  it("未选中日不准备浏览器，到所选日的开始时间才启动", async () => {
    const store = memoryStore();
    store.setConfig(only(1));
    let now = local(25, 22); // 周五
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(fake.driver.browserStatus).not.toHaveBeenCalled();
    expect(store.read().nextRunAt).toBe(local(28, 22));
    now = local(28, 22); // 下周一
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("时段内重启立即运行一轮，完成后按间隔再运行且不重叠", async () => {
    const store = memoryStore();
    store.setNextRunAt(local(26, 1, 30));
    let now = local(25, 22);
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    now = local(25, 22, 5);
    fake.finish(crawlStatus("completed"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("completed"));
    expect(store.read().nextRunAt).toBe(local(25, 22, 15));
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
    now = local(25, 22, 15);
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(2);
  });

  it("未登录只发起一次登录，准备完成后自动扫描", async () => {
    const store = memoryStore();
    const fake = fakeDriver();
    fake.setReady(false);
    const scheduler = new ScanScheduler(store, fake.driver, () => local(25, 22));
    await scheduler.tick();
    await scheduler.tick();
    expect(fake.driver.openBrowser).toHaveBeenCalledTimes(1);
    expect(fake.driver.startCrawl).not.toHaveBeenCalled();
    fake.setReady(true);
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("到结束时间让当前轮完成，随后等待次日窗口", async () => {
    const store = memoryStore();
    let now = local(25, 23, 55);
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => now);
    await scheduler.tick();
    now = local(26, 2, 5);
    await scheduler.tick();
    expect(scheduler.status().state).toBe("running");
    fake.finish(crawlStatus("completed"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("completed"));
    expect(store.read().nextRunAt).toBe(local(26, 22));
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("重启后旧采集锁暂未过期时等待并重试", async () => {
    const store = memoryStore();
    const fake = fakeDriver();
    const start = fake.driver.startCrawl;
    fake.driver.startCrawl = vi
      .fn()
      .mockRejectedValueOnce(new Error("已有另一个本地服务正在采集，请先暂停它"))
      .mockImplementation(() => start());
    const scheduler = new ScanScheduler(store, fake.driver, () => local(25, 22));
    await scheduler.tick();
    expect(scheduler.status().state).toBe("waiting_lock");
    expect(store.read().mode).toBe("enabled");
    await scheduler.tick();
    expect(fake.driver.startCrawl).toHaveBeenCalledTimes(2);
    expect(scheduler.status().state).toBe("running");
  });

  it("致命错误暂停计划；手动关闭后不被本轮结束重新启用", async () => {
    const store = memoryStore();
    const fake = fakeDriver();
    const scheduler = new ScanScheduler(store, fake.driver, () => local(25, 22));
    await scheduler.tick();
    fake.finish(crawlStatus("error"));
    await vi.waitFor(() => expect(store.read().mode).toBe("suspended"));
    expect(store.read().issue).toContain("采集失败");

    scheduler.enable();
    await vi.waitFor(() => expect(fake.driver.startCrawl).toHaveBeenCalledTimes(2));
    scheduler.disable();
    fake.finish(crawlStatus("paused"));
    await vi.waitFor(() => expect(store.read().lastRun?.outcome).toBe("paused"));
    expect(store.read().mode).toBe("disabled");
  });
});
