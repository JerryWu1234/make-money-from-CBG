import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  parseScanScheduleConfig,
  type ScanScheduleConfig,
} from "../../server/crawler/schedule-time";
import { browserStatus, crawlStatus, rolePage } from "../fixtures/saved-role";

test("定时计划选择、清空、删除时间并保存刷新", async ({ page, browser }, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const schedule = {
    config: {
      scheduleType: "daily",
      daily: { startTime: "09:00" },
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        enabled: true,
        startTime: "09:00",
      })),
      maxDurationMinutes: null,
    } as ScanScheduleConfig,
    mode: "disabled",
    state: "disabled",
    message: "定时计划未启用。",
    timezone: "Asia/Shanghai",
    issue: null,
    nextRunAt: null,
    lastRun: null,
  };
  const saved: ScanScheduleConfig[] = [];
  let statusReads = 0;
  // Only count calls; the actual Chrome picker still runs unchanged.
  await page.addInitScript(() => {
    const showPicker = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "showPicker")!
      .value as (this: HTMLInputElement) => void;
    const calls: string[] = [];
    Object.assign(window, { timePickerCalls: calls });
    HTMLInputElement.prototype.showPicker = function () {
      calls.push(this.getAttribute("aria-label") ?? "");
      return showPicker.call(this);
    };
  });
  // This browser loads the real build, with local fixture APIs and no outside traffic.
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-ui.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      switch (url.pathname) {
        case "/api/runtime/settings":
          body = { saveScreenshots: false };
          break;
        case "/api/browser/settings":
          body = { mode: "daily", connected: true, busy: false };
          break;
        case "/api/browser/status":
          body = browserStatus;
          break;
        case "/api/crawl/settings":
          body = { analyzeEquipment: false };
          break;
        case "/api/crawl/status":
          body = crawlStatus(false, true);
          break;
        case "/api/crawl/records":
          body = rolePage(1, true, "complete");
          break;
        case "/api/scan/status":
          statusReads++;
          body = schedule;
          break;
        case "/api/scan/configure":
          schedule.config = parseScanScheduleConfig(route.request().postDataJSON());
          saved.push(structuredClone(schedule.config));
          body = schedule;
          break;
        default:
          throw new Error(`未模拟的测试接口：${url.pathname}`);
      }
      return route.fulfill({ json: body });
    }
    const filename = path.join("dist", url.pathname === "/" ? "index.html" : url.pathname);
    return route.fulfill({
      contentType: filename.endsWith(".js")
        ? "application/javascript"
        : filename.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(filename),
    });
  });

  await page.goto("http://cbg-ui.test");
  const plan = page.getByRole("region", { name: "定时循环扫描" });
  const dailyTime = (index: number) => plan.getByLabel(`每天执行时间 ${index}`, { exact: true });
  await expect(dailyTime(1)).toHaveValue("09:00");
  await dailyTime(1).click();
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as { timePickerCalls: string[] }).timePickerCalls),
    )
    .toContain("每天执行时间 1");
  await plan.screenshot({ path: testInfo.outputPath("native-time-picker.png") });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(dailyTime(1)).not.toHaveValue("09:00");
  assert.equal(saved.length, 0, "choosing a time must not save the schedule");

  await plan.getByRole("button", { name: "+ 添加执行时间" }).click();
  await dailyTime(2).fill("11:00");
  await plan.getByRole("button", { name: "+ 添加执行时间" }).click();
  await dailyTime(3).fill("13:00");
  await plan.screenshot({ path: testInfo.outputPath("time-actions.png") });
  await plan.getByRole("button", { name: "删除每天执行时间 2", exact: true }).click();
  await expect(dailyTime(2)).toHaveValue("13:00");
  await expect(plan.locator('input[type="time"]')).toHaveCount(2);
  await plan.getByRole("button", { name: "删除每天执行时间 1", exact: true }).click();
  await expect(dailyTime(1)).toHaveValue("13:00");
  await expect(plan.locator('input[type="time"]')).toHaveCount(1);
  await plan.getByRole("button", { name: "+ 添加执行时间" }).click();
  await plan.getByRole("button", { name: "删除每天执行时间 2", exact: true }).click();
  await expect(plan.locator('input[type="time"]')).toHaveCount(1);

  await plan.getByRole("button", { name: "清空每天执行时间 1", exact: true }).click();
  await expect(dailyTime(1)).toHaveValue("");
  const readsBeforePolling = statusReads;
  await expect.poll(() => statusReads).toBeGreaterThan(readsBeforePolling);
  await expect(dailyTime(1)).toHaveValue("");
  await plan.getByRole("button", { name: "保存设置", exact: true }).click();
  assert.equal(
    await dailyTime(1).evaluate((input: HTMLInputElement) => input.validity.valueMissing),
    true,
  );
  assert.equal(saved.length, 0, "empty required time must not send a save request");
  await page.keyboard.press("Escape");
  await dailyTime(1).fill("08:30");
  await plan.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  assert.deepEqual(schedule.config.daily, { startTime: "08:30" });
  await page.reload();
  await expect(dailyTime(1)).toHaveValue("08:30");
  await expect(plan.locator('input[type="time"]')).toHaveCount(1);
  await plan.screenshot({ path: testInfo.outputPath("daily-time-saved.png") });

  await plan.getByRole("radio", { name: "每周循环", exact: true }).check();
  const monday = plan
    .locator(".scan-schedule-day-row")
    .filter({ has: page.getByRole("checkbox", { name: "周一", exact: true }) });
  await monday.getByRole("button", { name: "+ 添加执行时间" }).click();
  await plan.getByLabel("周一执行时间 2", { exact: true }).fill("12:00");
  await plan.getByRole("button", { name: "删除周一执行时间 1", exact: true }).click();
  await expect(plan.getByLabel("周一执行时间 1", { exact: true })).toHaveValue("12:00");
  await expect(monday.locator('input[type="time"]')).toHaveCount(1);
  await monday.getByRole("button", { name: "+ 添加执行时间" }).click();
  await plan.getByRole("button", { name: "删除周一执行时间 2", exact: true }).click();
  await expect(monday.locator('input[type="time"]')).toHaveCount(1);
  await plan.getByRole("checkbox", { name: "周二", exact: true }).uncheck();
  await expect(plan.getByLabel("周二执行时间 1", { exact: true })).toBeDisabled();
  await expect(
    plan.getByRole("button", { name: "清空周二执行时间 1", exact: true }),
  ).toBeDisabled();
  await plan.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect.poll(() => saved.length).toBe(2);
  assert.deepEqual(schedule.config.days[0], { weekday: 1, enabled: true, startTime: "12:00" });
  await page.reload();
  await expect(plan.getByLabel("周一执行时间 1", { exact: true })).toHaveValue("12:00");
  await expect(plan.getByLabel("周一执行时间 2", { exact: true })).toHaveCount(0);
  await expect(plan.getByRole("checkbox", { name: "周二", exact: true })).not.toBeChecked();
  await plan.screenshot({ path: testInfo.outputPath("weekly-time-saved.png") });
  assert.deepEqual(pageErrors, []);
  const evidence = {
    repeat: "vp run build && vp exec playwright test tests/e2e/scan-schedule.pw.ts --workers=1",
    browser: browser.version(),
    source: "real built UI in Chrome; local fixture APIs; all other origins blocked",
    checks: [
      "native showPicker called without replacing its behavior",
      "native picker changes time with arrow key, without typing",
      "daily middle/first/last removal",
      "daily and weekly 2-to-1 removal",
      "clear survives status polling",
      "required time blocks save",
      "save and reload",
      "disabled weekday stays disabled",
    ],
    limits: [
      "native browser popup may not appear in page screenshots",
      "no real schedule execution or source-site collection tested",
    ],
    saved,
    pageErrors,
  };
  const evidencePath = testInfo.outputPath("schedule-time-evidence.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  await testInfo.attach("schedule-time-evidence", {
    path: evidencePath,
    contentType: "application/json",
  });
});
