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
    modes: options.modes ?? [options.mode ?? "dedicated"],
    ready: options.ready ?? false,
    busy: options.busy ?? false,
    queryRunning: options.queryRunning ?? false,
    crawlRunning: options.crawlRunning ?? false,
    readFailures: options.readFailures ?? 0,
    browserStates: undefined as unknown[] | undefined,
    statusOverride: undefined as Record<string, unknown> | undefined,
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
          const modes = [route.request().postDataJSON().mode] as BrowserMode[];
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
          if (state.statusOverride) body = { ...(body as object), ...state.statusOverride };
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

const cdpOption = (page: Page) => page.getByRole("checkbox", { name: /^使用日常 Chrome/ });

test("CDP 默认不勾选；选择和刷新只保存配置，不请求浏览器授权", async ({ page }, testInfo) => {
  const state = await mount(page);
  const cdp = cdpOption(page);
  await expect(cdp).not.toBeChecked();
  await expect(
    page.getByRole("region", { name: "浏览器运行方式" }).getByRole("checkbox"),
  ).toHaveCount(1);
  await expect(page.getByRole("region", { name: "浏览器运行方式" }).getByRole("radio")).toHaveCount(
    0,
  );
  await expect(page.locator(".badge")).toHaveText("项目专用浏览器 · 保存登录状态");
  await expect(page.getByRole("region", { name: "浏览器运行方式" })).toContainText(
    "无需日常 Chrome 调试授权",
  );
  await cdp.click();
  await expect(cdp).toBeChecked();
  await page.reload();
  await expect(cdp).toBeChecked();
  expect(state.saves).toEqual([["daily"]]);
  expect(state.opens).toBe(0);
  await cdp.click();
  await expect(cdp).not.toBeChecked();
  expect(state.saves).toEqual([["daily"], ["dedicated"]]);
  expect(state.opens).toBe(0);
  await page
    .getByRole("region", { name: "浏览器运行方式" })
    .screenshot({ path: testInfo.outputPath("cdp-opt-in.png") });
});

test("保存期间禁用查询及采集准备，切换后清空旧 ready 并忽略迟到状态", async ({ page }) => {
  const state = await mount(page, { mode: "daily", ready: true });
  const old = deferred();
  const save = deferred();
  const cdp = cdpOption(page);
  const query = page.locator("#open-cbg-btn");
  const resume = page.getByRole("button", { name: "继续采集 / 检查新增", exact: true });
  const header = page.locator(".status-header-row strong");
  await expect(header).toHaveText("角色列表已就绪");
  await expect(cdp).toBeEnabled();
  await expect(resume).toBeEnabled();
  state.staleStatusGate = old.promise;
  await expect.poll(() => state.staleStatusPending).toBe(true);
  state.saveGate = save.promise;
  await cdp.click();
  await expect(cdp).toBeDisabled();
  await expect(query).toBeDisabled();
  await expect(resume).toBeDisabled();
  expect(state.saves).toEqual([["dedicated"]]);
  expect(state.opens).toBe(0);
  expect(state.captureStarts).toBe(0);
  save.release();
  await expect(cdp).not.toBeChecked();
  await expect(query).toHaveText("开始查询角色");
  old.release();
  await expect.poll(() => state.staleStatusDelivered).toBe(true);
  await expect(header).toHaveText("准备就绪");
  await expect(query).toBeEnabled();
  await query.click();
  await expect.poll(() => state.opens).toBe(1);
  await expect(page.getByText("正在启动或连接项目专用浏览器…", { exact: true })).toBeVisible();
});

test("模式保存失败保留原选择和 ready，显示实际原因后可重试", async ({ page }) => {
  const state = await mount(page, { mode: "daily", ready: true });
  const cdp = cdpOption(page);
  await expect(cdp).toBeChecked();
  state.saveError = "模拟分析任务正在运行，暂不能切换";
  await cdp.click();
  await expect(page.getByRole("alert")).toContainText(state.saveError);
  await expect(cdp).toBeChecked();
  await expect(page.locator(".status-header-row strong")).toHaveText("角色列表已就绪");
  state.saveError = "";
  await cdp.click();
  await expect(cdp).not.toBeChecked();
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(state.saves).toEqual([["dedicated"], ["dedicated"]]);
});

test("后台 busy 禁止切换，业务结束后只读刷新恢复", async ({ page }) => {
  const state = await mount(page, { busy: true });
  await expect(cdpOption(page)).not.toBeChecked();
  await expect(cdpOption(page)).toBeDisabled();
  state.busy = false;
  await expect(cdpOption(page)).toBeEnabled();
  expect(state.saves).toEqual([]);
});

for (const activity of ["queryRunning", "crawlRunning"] as const) {
  test(`${activity} 运行时禁止切换，结束后恢复`, async ({ page }) => {
    const state = await mount(page, { [activity]: true });
    await expect(cdpOption(page)).toBeDisabled();
    state[activity] = false;
    await expect(cdpOption(page)).toBeEnabled();
    expect(state.saves).toEqual([]);
  });
}

test("设置读取失败禁止启动，重新读取不会自动连接 Chrome", async ({ page }) => {
  const state = await mount(page, { readFailures: 1 });
  await expect(page.getByRole("alert")).toContainText("模拟浏览器设置读取失败");
  await expect(cdpOption(page)).toBeDisabled();
  await expect(page.locator("#open-cbg-btn")).toBeDisabled();
  await page.getByRole("button", { name: "重新读取设置" }).click();
  await expect(cdpOption(page)).not.toBeChecked();
  await expect(cdpOption(page)).toBeEnabled();
  expect(state.opens).toBe(0);
});

test("仅在主动勾选 CDP 并点击开始后连接一次日常 Chrome", async ({ page }) => {
  const state = await mount(page);
  await expect(cdpOption(page)).toBeEnabled();
  await cdpOption(page).click();
  await expect(cdpOption(page)).toBeChecked();
  expect(state.opens).toBe(0);
  await page.locator("#open-cbg-btn").click();
  await expect.poll(() => state.opens).toBe(1);
  expect(state.modes).toEqual(["daily"]);
});

const loginQr = (mode: BrowserMode) => ({
  ...browserStatus,
  mode,
  activeBrowserMode: mode,
  running: true,
  workflowStep: "logging_in",
  loginStatus: "logged_out",
  isLoggedIn: false,
  needLogin: true,
  message: `${mode}等待扫码`,
  qrCodeUrl:
    "data:image/svg+xml," +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><text x="10" y="90">${mode}</text></svg>`,
    ),
});

for (const mode of ["dedicated", "daily"] as const) {
  test(`${mode} 只有一个扫码入口，无浏览器切换和第二轮二维码`, async ({ page }) => {
    const state = await mount(page, { mode, queryRunning: true });
    state.statusOverride = loginQr(mode);
    state.browserStates = [loginQr("dedicated"), loginQr("daily")];
    const login = page.getByRole("region", { name: "扫码登录", exact: true });
    await expect(login.getByRole("img", { name: "登录二维码", exact: true })).toHaveAttribute(
      "src",
      loginQr(mode).qrCodeUrl,
    );
    await expect(page.getByRole("img", { name: /登录二维码/ })).toHaveCount(1);
    await expect(page.getByRole("group", { name: "选择登录浏览器" })).toHaveCount(0);
    state.statusOverride = {
      ...browserStatus,
      needLogin: false,
      qrCodeUrl: loginQr(mode).qrCodeUrl,
    };
    await expect(login).toHaveCount(0);
    expect(state.opens).toBe(0);
    expect(state.saves).toEqual([]);
  });
}
