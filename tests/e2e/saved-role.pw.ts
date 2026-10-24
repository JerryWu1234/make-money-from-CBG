import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import {
  browserStatus,
  crawlStatus,
  petSkills,
  rolePage,
  roleRecord,
  roleUrl,
} from "../fixtures/saved-role";

test("已采集角色详情、分页和刷新恢复", async ({ page }, testInfo) => {
  let running = true;
  let ready = false;
  let detailReads = 0;
  let browserStatusReads = 0;
  let browserOpenReads = 0;
  const schedule = {
    config: {
      scheduleType: "weekly",
      daily: { startTime: "09:00" },
      days: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        enabled: true,
        startTime: "09:00",
      })),
      maxDurationMinutes: null as number | null,
    },
    mode: "disabled",
    issue: null,
    nextRunAt: null as number | null,
    lastRun: null,
    state: "disabled",
    message: "定时计划未启用。",
    timezone: "Asia/Shanghai",
  };

  // 构建产物与接口都由测试本地提供；其他来源一律阻断。
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://cbg-ui.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      if (url.pathname === "/api/crawl/detail") {
        const key = url.searchParams.get("key") ?? "";
        if (key === "a") detailReads++;
        body = roleRecord(key, ready);
      } else if (url.pathname === "/api/crawl/records") {
        body = rolePage(
          Number(url.searchParams.get("page") || 1),
          ready,
          url.searchParams.get("scope") as "complete" | "tasks",
        );
      } else if (url.pathname === "/api/crawl/status") {
        body = crawlStatus(running, ready);
      } else if (url.pathname === "/api/crawl/settings") {
        body = { analyzeEquipment: false };
      } else if (url.pathname === "/api/scan/status") {
        body = schedule;
      } else if (url.pathname === "/api/scan/configure") {
        schedule.config = route.request().postDataJSON();
        if (schedule.mode === "enabled")
          schedule.nextRunAt = new Date(
            schedule.config.scheduleType === "daily"
              ? "2026-09-27T00:30:00Z"
              : "2026-09-28T14:00:00Z",
          ).getTime();
        body = schedule;
      } else if (url.pathname === "/api/scan/enable") {
        schedule.mode = "enabled";
        schedule.state = "waiting_window";
        schedule.message = "等待下一次计划执行。";
        schedule.nextRunAt = new Date("2026-09-28T14:00:00Z").getTime();
        body = schedule;
      } else if (url.pathname === "/api/scan/disable") {
        schedule.mode = "disabled";
        schedule.state = "disabled";
        schedule.nextRunAt = null;
        body = schedule;
      } else if (url.pathname === "/api/browser/status") {
        browserStatusReads++;
        body = browserStatus;
      } else if (url.pathname === "/api/browser/open") {
        browserOpenReads++;
        body = { error: "刷新不应重新开始登录流程" };
      } else {
        throw new Error(`未模拟的测试接口：${url.pathname}`);
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
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
  for (const day of ["周二", "周四", "周六", "周日"])
    await plan.getByRole("checkbox", { name: day }).uncheck();
  await plan.getByLabel("周一执行时间").fill("22:00");
  await plan.getByLabel("周三执行时间").fill("10:00");
  await plan.getByLabel("周五执行时间").fill("15:00");
  await plan.getByLabel("最长运行时长（分钟，可选）").fill("45");
  await expect(plan.getByRole("button", { name: "启用计划" })).toBeDisabled();
  await plan.getByRole("button", { name: "保存设置" }).click();
  await expect(plan).toContainText("计划状态：已关闭");
  await plan.screenshot({ path: testInfo.outputPath("scan-schedule.png") });
  assert.equal(schedule.config.maxDurationMinutes, 45);
  assert.deepEqual(
    schedule.config.days
      .filter((day) => day.enabled)
      .map(({ weekday, startTime }) => ({ weekday, startTime })),
    [
      { weekday: 1, startTime: "22:00" },
      { weekday: 3, startTime: "10:00" },
      { weekday: 5, startTime: "15:00" },
    ],
  );
  await plan.getByRole("radio", { name: "每天循环" }).check();
  await plan.getByLabel("每天执行时间").fill("08:30");
  await plan.getByLabel("最长运行时长（分钟，可选）").fill("");
  await plan.getByRole("button", { name: "保存设置" }).click();
  assert.equal(schedule.config.scheduleType, "daily");
  assert.deepEqual(schedule.config.daily, { startTime: "08:30" });
  assert.equal(schedule.config.maxDurationMinutes, null);
  await plan.screenshot({ path: testInfo.outputPath("scan-schedule-daily.png") });
  await plan.getByRole("radio", { name: "每周循环" }).check();
  await expect(plan.getByLabel("周一执行时间")).toHaveValue("22:00");
  await plan.getByLabel("最长运行时长（分钟，可选）").fill("60");
  await plan.getByRole("button", { name: "保存设置" }).click();
  assert.equal(schedule.config.scheduleType, "weekly");
  assert.deepEqual(schedule.config.daily, { startTime: "08:30" });
  assert.equal(schedule.config.maxDurationMinutes, 60);
  await page.getByText("正在读取标签 4/7：召唤兽/孩子", { exact: true }).waitFor();
  assert.match(await page.locator(".crawl-panel").innerText(), /本页进度：1 \/ 15/);
  await expect(page.getByRole("button", { name: /角色a ·/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "采集任务", exact: true })).toHaveCount(0);
  ready = true;
  await page.getByRole("button", { name: /角色a ·/ }).waitFor({ timeout: 6000 });
  await page.getByRole("button", { name: /角色a ·/ }).click();
  await page.getByRole("tab", { name: "人物/修炼", exact: true }).waitFor({ timeout: 6000 });
  assert.ok(detailReads >= 1, "completed record should appear through list polling");
  assert.equal(await page.getByRole("tab").count(), 8);
  assert.match(await page.getByRole("tabpanel").innerText(), /估价资料清单/);
  await page.getByRole("tab", { name: "召唤兽/孩子", exact: true }).click();

  await expect(page.locator(".pet-card")).toHaveCount(8);
  await expect(page.locator(".pet-card").nth(7)).toContainText("宝宝8");
  for (const skill of petSkills) {
    await expect(page.locator(".pet-card").nth(7)).toContainText(skill);
  }
  await expect(page.locator(".pet-card").nth(7)).toContainText("速度：27");
  assert.match(await page.getByRole("tabpanel").innerText(), /已采集 8 \/ 8 只/);
  assert.doesNotMatch(
    await page.getByRole("tabpanel").innerText(),
    /skill_type|equip_level|riderSkill/,
  );
  await page.getByRole("tab", { name: "道具/法宝", exact: true }).click();
  assert.match(await page.getByRole("tabpanel").innerText(), /特技：罗汉金钟/);
  assert.equal(await page.locator(".detail-item").count(), 2);
  assert.match(await page.locator(".detail-item").nth(1).innerText(), /防御：90/);
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  await expect(page.getByRole("button", { name: /角色a ·/ })).toBeFocused();
  await page.getByRole("button", { name: /角色a ·/ }).click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Escape");
  assert.ok(
    await page
      .getByRole("button", { name: /角色a ·/ })
      .evaluate((el) => el === document.activeElement),
  );
  const listScroll = await page
    .locator(".saved-roles .role-table-scroll")
    .evaluate((el) => el.scrollTop);
  await page
    .locator(".saved-role-table tbody tr")
    .filter({ hasText: "角色b" })
    .locator("td")
    .nth(2)
    .click();
  await page.getByRole("tab", { name: "估价概览", exact: true }).waitFor();
  assert.equal(
    await page.getByRole("tab", { name: "估价概览", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await page.screenshot({ path: testInfo.outputPath("role-drawer-desktop.png") });
  await page.mouse.click(35, 200);
  assert.equal(await page.getByRole("dialog").count(), 0);
  await page.getByRole("button", { name: /角色b ·/ }).click();
  await page.getByRole("tab", { name: "估价概览", exact: true }).waitFor();
  await page.getByRole("tab", { name: "估价概览", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    await page.getByRole("tab", { name: "人物/修炼", exact: true }).getAttribute("aria-selected"),
    "true",
  );
  await page.getByRole("button", { name: "关闭角色详情" }).click();
  assert.equal(
    await page.locator(".saved-roles .role-table-scroll").evaluate((el) => el.scrollTop),
    listScroll,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /角色b ·/ }).click();
  await page.getByRole("tab", { name: "估价概览", exact: true }).waitFor();
  const drawer = await page.getByRole("dialog").boundingBox();
  assert.ok(drawer && drawer.width <= 390 && drawer.x >= 0);
  await page.screenshot({ path: testInfo.outputPath("role-drawer-mobile.png") });
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1100, height: 1000 });

  const results = page.getByRole("region", { name: "已采集角色" });
  await expect(results.getByText("共 45 条", { exact: false })).toBeVisible();
  assert.match(await results.innerText(), /测试服/);
  assert.match(await results.innerText(), /总修100/);
  assert.match(await results.innerText(), /2026/);
  const sourceLink = results.getByRole("link", { name: "打开原页 ↗" }).first();
  assert.equal(await sourceLink.getAttribute("href"), roleUrl("a"));
  assert.equal(await sourceLink.getAttribute("target"), "_blank");
  await results.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByRole("button", { name: /角色k21 ·/ }).waitFor();
  await results.getByRole("button", { name: "下一页", exact: true }).click();
  await page.getByRole("button", { name: /角色k45 ·/ }).waitFor();
  assert.equal(await results.locator("tbody tr").count(), 5);
  await page.getByRole("button", { name: /角色k45 ·/ }).click();
  await page.getByRole("dialog").waitFor();
  assert.match(page.url(), /recordsPage=3/);
  assert.match(page.url(), /record=k45/);
  running = false;
  const statusReadsBeforeReload = browserStatusReads;
  const openReadsBeforeReload = browserOpenReads;
  await page.reload();
  await expect(plan.getByLabel("周一执行时间")).toHaveValue("22:00");
  await expect(plan.getByLabel("周三执行时间")).toHaveValue("10:00");
  await expect(plan.getByLabel("最长运行时长（分钟，可选）")).toHaveValue("60");
  await expect(plan.getByRole("checkbox", { name: "周二" })).not.toBeChecked();
  await page.getByRole("button", { name: /角色k45 ·/ }).waitFor();
  await page.getByRole("dialog").waitFor();
  assert.ok(browserStatusReads > statusReadsBeforeReload, "reload should verify browser status");
  assert.equal(browserOpenReads, openReadsBeforeReload, "reload should not restart login");
  assert.equal(await results.locator("tbody tr").count(), 5);
  assert.match(await results.innerText(), /共 45 条/);
  await results.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath("crawl-detail-ui.png") });
  await page.getByRole("button", { name: "关闭角色详情" }).click();
  await expect(plan.getByRole("button", { name: "启用计划" })).toBeEnabled();
  await plan.getByRole("button", { name: "启用计划" }).click();
  await expect(plan).toContainText("计划状态：等待执行");
});
