import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { HeadRefreshSettingsStore } from "../../server/crawler/head-refresh-settings";
import { browserStatus, crawlStatus } from "../fixtures/saved-role";

async function mount(page: Page, file: string) {
  const state = {
    store: new HeadRefreshSettingsStore(file),
    failSave: false,
    failRead: false,
    saves: 0,
    starts: 0,
  };
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    // 仅本地构建和临时配置文件；禁止请求真实官网或运行中的项目服务。
    if (url.origin !== "http://head-refresh-ui.test") return route.abort();
    if (url.pathname === "/api/crawl/head-refresh")
      return state.failRead
        ? route.fulfill({ status: 503, json: { error: "模拟读取失败" } })
        : route.fulfill({ json: state.store.get() });
    if (url.pathname === "/api/crawl/head-refresh/save") {
      state.saves++;
      if (state.failSave) return route.fulfill({ status: 500, json: { error: "模拟保存失败" } });
      return route.fulfill({ json: state.store.save(route.request().postDataJSON()) });
    }
    if (url.pathname === "/api/crawl/start") state.starts++;
    if (url.pathname.startsWith("/api/")) {
      const responses: Record<string, unknown> = {
        "/api/browser/status": browserStatus,
        "/api/browser/settings": { mode: "dedicated", connected: true, busy: false },
        "/api/runtime/settings": { saveScreenshots: false },
        "/api/crawl/settings": { analyzeEquipment: false },
        "/api/crawl/status": crawlStatus(true, true),
        "/api/crawl/records": { page: 1, total: 0, totalPages: 1, items: [] },
        "/api/scan/status": {
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
        },
      };
      if (!(url.pathname in responses)) throw new Error("未模拟接口：" + url.pathname);
      return route.fulfill({ json: responses[url.pathname] });
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
  await page.goto("http://head-refresh-ui.test");
  return state;
}

test("固定秒、10分钟随机和1小时随机保存并跨配置重载恢复，运行中保存不会启动采集", async ({
  page,
}, testInfo) => {
  const file = testInfo.outputPath("head-refresh.json");
  const state = await mount(page, file);
  const panel = page.getByRole("region", { name: "列表首页刷新设置" });
  const time = panel.getByLabel("刷新间隔", { exact: true });
  const unit = panel.getByLabel("时间单位");
  const random = panel.getByLabel("在设定时间内随机刷新");
  const save = panel.getByRole("button", { name: "保存刷新设置" });
  await expect(save).toBeEnabled();
  await unit.selectOption("1");
  await time.fill("90");
  await save.click();
  await expect
    .poll(() => state.store.get())
    .toEqual({ intervalSeconds: 90, random: false, initialPages: 5 });
  await expect(panel.getByRole("status")).toContainText("已保存");
  await unit.selectOption("60");
  await time.fill("10");
  await random.check();
  await save.click();
  await expect
    .poll(() => state.store.get())
    .toEqual({ intervalSeconds: 600, random: true, initialPages: 5 });
  state.store = new HeadRefreshSettingsStore(file);
  await page.reload();
  await expect(time).toHaveValue("10");
  await expect(unit).toHaveValue("60");
  await expect(random).toBeChecked();
  await expect(panel).toContainText("当前已保存：每轮在1秒至10分钟之间随机");
  await unit.selectOption("3600");
  await time.fill("1");
  await save.click();
  await expect
    .poll(() => state.store.get())
    .toEqual({ intervalSeconds: 3600, random: true, initialPages: 5 });
  await expect(panel.getByRole("status")).toContainText("下次开始或继续采集时生效");
  expect(state.starts).toBe(0);
  await panel.screenshot({ path: testInfo.outputPath("head-refresh-settings.png") });
});

test("无效输入不提交；写入失败保留已保存值，可重试和取消随机", async ({ page }, testInfo) => {
  const state = await mount(page, testInfo.outputPath("head-refresh.json"));
  const panel = page.getByRole("region", { name: "列表首页刷新设置" });
  const time = panel.getByLabel("刷新间隔", { exact: true });
  const random = panel.getByLabel("在设定时间内随机刷新");
  const save = panel.getByRole("button", { name: "保存刷新设置" });
  await expect(save).toBeEnabled();
  await time.fill("0");
  await save.click();
  await expect(panel.getByRole("alert")).toContainText("1秒至7天");
  expect(state.saves).toBe(0);
  await time.fill("10");
  await random.check();
  state.failSave = true;
  await save.click();
  await expect(panel.getByRole("alert")).toContainText("模拟保存失败");
  expect(state.store.get()).toEqual({ intervalSeconds: 60, random: false, initialPages: 5 });
  await expect(panel).toContainText("当前已保存：每1分钟刷新一次");
  state.failSave = false;
  await save.click();
  await expect
    .poll(() => state.store.get())
    .toEqual({ intervalSeconds: 600, random: true, initialPages: 5 });
  await random.uncheck();
  await save.click();
  await expect
    .poll(() => state.store.get())
    .toEqual({ intervalSeconds: 600, random: false, initialPages: 5 });
});

test("设置读取失败时禁止提交默认值，重新读取后恢复", async ({ page }, testInfo) => {
  const state = await mount(page, testInfo.outputPath("head-refresh.json"));
  state.store.save({ intervalSeconds: 3600, random: true, initialPages: 5 });
  state.failRead = true;
  await page.reload();
  const panel = page.getByRole("region", { name: "列表首页刷新设置" });
  await expect(panel.getByRole("alert")).toContainText("模拟读取失败");
  await expect(panel.getByRole("button", { name: "保存刷新设置" })).toBeDisabled();
  state.failRead = false;
  await panel.getByRole("button", { name: "重新读取刷新设置" }).click();
  await expect(panel.getByLabel("刷新间隔", { exact: true })).toHaveValue("1");
  await expect(panel.getByLabel("时间单位")).toHaveValue("3600");
  await expect(panel.getByLabel("在设定时间内随机刷新")).toBeChecked();
});

test("首次采集页数默认5，可保存重载，拒绝零和小数，运行中保存不触发采集", async ({
  page,
}, testInfo) => {
  const state = await mount(page, testInfo.outputPath("head-refresh.json"));
  const panel = page.getByRole("region", { name: "列表首页刷新设置" });
  const pages = panel.getByLabel("首次采集页数", { exact: true });
  const save = panel.getByRole("button", { name: "保存刷新设置" });
  await expect(save).toBeEnabled();
  await expect(pages).toHaveValue("5");
  for (const invalid of ["0", "1.5"]) {
    await pages.fill(invalid);
    await save.click();
    await expect(panel.getByRole("alert")).toContainText("首次采集页数必须是1至1000的整数");
  }
  expect(state.saves).toBe(0);
  await pages.fill("7");
  await save.click();
  await expect.poll(() => state.store.get().initialPages).toBe(7);
  state.store = new HeadRefreshSettingsStore(testInfo.outputPath("head-refresh.json"));
  await page.reload();
  await expect(pages).toHaveValue("7");
  await expect(panel).toContainText("首次最多7页");
  await expect(panel).toContainText("上轮旧号边界");
  expect(state.starts).toBe(0);
  await panel.screenshot({ path: testInfo.outputPath("initial-pages-settings.png") });
});
