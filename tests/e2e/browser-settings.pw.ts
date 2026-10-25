import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { browserStatus, crawlStatus } from "../fixtures/saved-role";
import type { BrowserMode } from "../../src/BrowserSettings";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function mount(
  page: Page,
  options: {
    mode?: BrowserMode;
    modes?: BrowserMode[];
    ready?: boolean;
    busy?: boolean;
    queryRunning?: boolean;
    crawlRunning?: boolean;
    readFailures?: number;
  } = {},
) {
  const state = {
    mode: options.mode ?? ("dedicated" as BrowserMode),
    modes:
      options.modes ?? (options.mode ? [options.mode] : (["dedicated", "daily"] as BrowserMode[])),
    ready: options.ready ?? false,
    busy: options.busy ?? false,
    queryRunning: options.queryRunning ?? false,
    crawlRunning: options.crawlRunning ?? false,
    readFailures: options.readFailures ?? 0,
    browserStates: undefined as unknown[] | undefined,
    saveError: "",
    settingsReads: 0,
    statusReads: 0,
    opens: 0,
    captureStarts: 0,
    saves: [] as BrowserMode[][],
    saveGate: undefined as Promise<void> | undefined,
    staleStatusGate: undefined as Promise<void> | undefined,
    staleStatusPending: false,
    staleStatusDelivered: false,
  };
  const idle = {
    ...browserStatus,
    connected: false,
    isLoggedIn: false,
    loginStatus: "unknown",
    workflowStep: "idle",
    message: "请重新开始查询",
  };
  const settings = () => ({
    mode: state.mode,
    modes: state.modes,
    connected: state.ready,
    busy: state.busy || state.queryRunning || state.crawlRunning,
  });
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    // Built assets and all API responses are fixtures; never reach 5173 or daily Chrome.
    if (url.origin !== "http://browser-settings.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      switch (url.pathname) {
        case "/api/browser/settings":
          state.settingsReads++;
          if (state.readFailures > 0) {
            state.readFailures--;
            return route.fulfill({ status: 500, json: { error: "模拟浏览器设置读取失败" } });
          }
          body = settings();
          break;
        case "/api/browser/settings/save": {
          const modes = route.request().postDataJSON().modes as BrowserMode[];
          state.saves.push(modes);
          if (state.saveGate) await state.saveGate;
          if (state.saveError)
            return route.fulfill({ status: 409, json: { error: state.saveError } });
          state.modes = modes;
          state.mode = modes[0];
          state.ready = false;
          body = settings();
          break;
        }
        case "/api/browser/status": {
          state.statusReads++;
          if (state.staleStatusGate) {
            const gate = state.staleStatusGate;
            state.staleStatusGate = undefined;
            state.staleStatusPending = true;
            await gate;
            await route.fulfill({ json: browserStatus });
            state.staleStatusDelivered = true;
            return;
          }
          body = state.queryRunning
            ? { ...idle, running: true, workflowStep: "connecting" }
            : state.ready
              ? browserStatus
              : idle;
          if (state.browserStates) body = { ...(body as object), browsers: state.browserStates };
          break;
        }
        case "/api/browser/open":
          state.opens++;
          state.queryRunning = true;
          body = { ...idle, running: true, workflowStep: "connecting" };
          break;
        case "/api/crawl/status":
          body = {
            ...crawlStatus(state.crawlRunning, true),
            checkpoint: {
              key: "fixture:saved",
              time: "2026-10-24T00:00:00Z",
              order: "expire_time DESC",
              page: 1,
              savedAt: "2026-10-24T00:00:00Z",
            },
          };
          break;
        case "/api/crawl/start":
          state.captureStarts++;
          state.crawlRunning = true;
          body = crawlStatus(true, true);
          break;
        case "/api/crawl/settings":
          body = { analyzeEquipment: false };
          break;
        case "/api/runtime/settings":
          body = { saveScreenshots: false };
          break;
        case "/api/crawl/records":
          body = { page: 1, total: 0, totalPages: 1, items: [] };
          break;
        case "/api/scan/status":
          body = {
            config: {
              scheduleType: "daily",
              daily: { startTime: "09:00" },
              days: [],
              maxDurationMinutes: null,
            },
            mode: "disabled",
            state: "disabled",
            message: "未启用",
            timezone: "Asia/Shanghai",
          };
          break;
        default:
          throw new Error("未模拟接口：" + url.pathname);
      }
      return route.fulfill({ json: body });
    }
    const file = path.join("dist", url.pathname === "/" ? "index.html" : url.pathname);
    return route.fulfill({
      contentType: file.endsWith(".js")
        ? "application/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(file),
    });
  });
  await page.goto("http://browser-settings.test");
  return state;
}

test("默认两种方式均勾选，取消其中一种后刷新保留多选配置", async ({ page }, testInfo) => {
  const state = await mount(page);
  const dedicated = page.getByRole("checkbox", { name: /^项目专用浏览器/ });
  const daily = page.getByRole("checkbox", { name: /^连接日常 Chrome/ });
  await expect(dedicated).toBeChecked();
  await expect(daily).toBeChecked();
  await expect(page.locator(".badge")).toHaveText("专用浏览器 + 日常 Chrome · 同时启动");
  await expect(page.getByRole("region", { name: "浏览器运行方式" })).toContainText(
    "登录过期仍需扫码",
  );
  expect(state.saves).toEqual([]);
  await page.reload();
  await expect(dedicated).toBeChecked();
  await dedicated.click();
  await expect(daily).toBeChecked();
  await expect(dedicated).not.toBeChecked();
  await expect(page.locator(".badge")).toContainText("复用日常浏览器登录状态");
  await page.reload();
  await expect(daily).toBeChecked();
  await expect(page.getByRole("region", { name: "浏览器运行方式" })).toContainText(
    "Chrome 可能再次要求允许",
  );
  expect(state.saves).toEqual([["daily"]]);
  await page
    .getByRole("region", { name: "浏览器运行方式" })
    .screenshot({ path: testInfo.outputPath("browser-options.png") });
});

test("保存期间禁用查询及采集准备，切换后清空旧ready并忽略迟到状态", async ({ page }, testInfo) => {
  const state = await mount(page, { mode: "daily", ready: true });
  const old = deferred();
  const save = deferred();
  const dedicated = page.getByRole("checkbox", { name: /^项目专用浏览器/ });
  const daily = page.getByRole("checkbox", { name: /^连接日常 Chrome/ });
  const query = page.locator("#open-cbg-btn");
  const resume = page.getByRole("button", { name: "继续采集 / 检查新增", exact: true });
  const header = page.locator(".status-header-row strong");
  await expect(header).toHaveText("角色列表已就绪");
  await expect(daily).toBeEnabled();
  await expect(resume).toBeEnabled();
  state.staleStatusGate = old.promise;
  await expect.poll(() => state.staleStatusPending).toBe(true);
  state.saveGate = save.promise;
  await dedicated.click();
  await expect(dedicated).toBeDisabled();
  await expect(daily).toBeChecked();
  await expect(query).toBeDisabled();
  await expect(resume).toBeDisabled();
  expect(state.saves).toEqual([["dedicated", "daily"]]);
  expect(state.opens).toBe(0);
  expect(state.captureStarts).toBe(0);
  save.release();
  await expect(dedicated).toBeChecked();
  await expect(query).toHaveText("开始查询角色");
  await expect(header).toHaveText("准备就绪");
  old.release();
  await expect.poll(() => state.staleStatusDelivered).toBe(true);
  await expect(header).toHaveText("准备就绪");
  await expect(query).toBeEnabled();
  expect(state.opens).toBe(0);
  expect(state.captureStarts).toBe(0);
  await page
    .getByRole("region", { name: "浏览器运行方式" })
    .screenshot({ path: testInfo.outputPath("switched-dedicated.png") });
  await query.click();
  await expect.poll(() => state.opens).toBe(1);
  await expect(page.getByText("正在启动或连接项目专用浏览器…", { exact: true })).toBeVisible();
});

test("切换失败保持原方式与原ready，显示服务原因后可重试", async ({ page }) => {
  const state = await mount(page, { mode: "daily", ready: true });
  const dedicated = page.getByRole("checkbox", { name: /^项目专用浏览器/ });
  const daily = page.getByRole("checkbox", { name: /^连接日常 Chrome/ });
  await expect(daily).toBeChecked();
  state.saveError = "模拟分析任务正在运行，暂不能切换";
  await dedicated.click();
  await expect(page.getByRole("alert")).toContainText(state.saveError);
  await expect(daily).toBeChecked();
  await expect(dedicated).not.toBeChecked();
  await expect(page.locator(".status-header-row strong")).toHaveText("角色列表已就绪");
  await expect(page.locator("#open-cbg-btn")).toBeEnabled();
  state.saveError = "";
  await dedicated.click();
  await expect(dedicated).toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.saves).toEqual([
    ["dedicated", "daily"],
    ["dedicated", "daily"],
  ]);
});

test("服务busy时禁用选择，分析结束后自动重新读取并恢复", async ({ page }) => {
  const state = await mount(page, { busy: true });
  const daily = page.getByRole("checkbox", { name: /^连接日常 Chrome/ });
  await expect(page.getByRole("checkbox", { name: /^项目专用浏览器/ })).toBeChecked();
  await expect(daily).toBeDisabled();
  await expect(page.getByRole("region", { name: "浏览器运行方式" })).toContainText("请先暂停任务");
  state.busy = false;
  await expect(daily).toBeEnabled();
  expect(state.settingsReads).toBeGreaterThanOrEqual(2);
  expect(state.saves).toEqual([]);
});

for (const activity of ["queryRunning", "crawlRunning"] as const) {
  test(`${activity === "queryRunning" ? "查询" : "采集"}运行期间禁用选择，结束后恢复`, async ({
    page,
  }) => {
    const state = await mount(page, { [activity]: true });
    const daily = page.getByRole("checkbox", { name: /^连接日常 Chrome/ });
    await expect(page.getByRole("checkbox", { name: /^项目专用浏览器/ })).toBeChecked();
    await expect(daily).toBeDisabled();
    state[activity] = false;
    await expect(daily).toBeEnabled();
    expect(state.saves).toEqual([]);
  });
}

test("设置加载失败阻止查询，重新读取成功后恢复默认方式", async ({ page }) => {
  const state = await mount(page, { readFailures: 1 });
  const dedicated = page.getByRole("checkbox", { name: /^项目专用浏览器/ });
  await expect(page.getByRole("alert")).toContainText("模拟浏览器设置读取失败");
  await expect(dedicated).toBeDisabled();
  await expect(page.locator("#open-cbg-btn")).toBeDisabled();
  await page.getByRole("button", { name: "重新读取设置" }).click();
  await expect(dedicated).toBeChecked();
  await expect(dedicated).toBeEnabled();
  await expect(page.locator("#open-cbg-btn")).toBeEnabled();
  expect(state.settingsReads).toBe(2);
  expect(state.saves).toEqual([]);
  expect(state.opens).toBe(0);
});

test("两种可同时勾选并开始，至少保留一种方式", async ({ page }) => {
  const state = await mount(page);
  const dedicated = page.getByRole("checkbox", { name: /^项目专用浏览器/ });
  const daily = page.getByRole("checkbox", { name: /^连接日常 Chrome/ });
  await expect(dedicated).toBeEnabled();
  await dedicated.click();
  await expect(dedicated).not.toBeChecked();
  await expect(daily).toBeEnabled();
  await daily.click();
  await expect(page.getByRole("alert")).toContainText("请至少保留一种浏览器方式");
  await expect(daily).toBeChecked();
  await dedicated.click();
  await expect(dedicated).toBeChecked();
  await expect(daily).toBeChecked();
  await expect(dedicated).toBeEnabled();
  await page.locator("#open-cbg-btn").click();
  await expect.poll(() => state.opens).toBe(1);
  expect(state.modes).toEqual(["dedicated", "daily"]);
});

test("两路状态独立显示，专用浏览器扫码不遮住已就绪日常浏览器", async ({ page }) => {
  const state = await mount(page, { ready: true });
  state.browserStates = [
    {
      ...browserStatus,
      mode: "dedicated",
      running: true,
      isLoggedIn: false,
      workflowStep: "logging_in",
      message: "专用浏览器请扫码",
      qrCodeUrl:
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E",
    },
    { ...browserStatus, mode: "daily", running: false, message: "日常角色列表就绪" },
  ];
  const dedicated = page.getByRole("region", { name: "专用浏览器状态", exact: true });
  const daily = page.getByRole("region", { name: "日常 Chrome 状态", exact: true });
  await expect(dedicated).toContainText("专用浏览器请扫码");
  await expect(dedicated.getByRole("img")).toBeVisible();
  await expect(daily).toContainText("角色列表已就绪");
  await expect(
    page.getByRole("button", { name: "继续采集 / 检查新增", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("#open-cbg-btn")).toBeDisabled();
});
