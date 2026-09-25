import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenCbgResult } from "../types";
import { ScanScheduler } from "./schedule";
import { ScanScheduleStore } from "./schedule-store";
import { nextScanTime, parseScanScheduleConfig, scanWindow } from "./schedule-time";
import type { CrawlStatus } from "./types";

const config = { startTime: "22:00", endTime: "02:00", intervalMinutes: 10 };
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
    expect(() => parseScanScheduleConfig({ ...config, endTime: "22:00" })).toThrow("不能相同");
    expect(() => parseScanScheduleConfig({ ...config, startTime: "25:00" })).toThrow("格式错误");
  });

  it("跨午夜窗口在次日 02:00 截止", () => {
    expect(scanWindow(local(25, 23), config).active).toBe(true);
    expect(scanWindow(local(26, 1), config).active).toBe(true);
    expect(scanWindow(local(26, 2), config).active).toBe(false);
    expect(nextScanTime(local(26, 2), config)).toBe(local(26, 22));
  });

  it("本轮结束加间隔越过窗口时，排到下次开始", () => {
    expect(nextScanTime(local(26, 1, 45), config)).toBe(local(26, 1, 45));
    expect(nextScanTime(local(26, 2, 5), config)).toBe(local(26, 22));
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
