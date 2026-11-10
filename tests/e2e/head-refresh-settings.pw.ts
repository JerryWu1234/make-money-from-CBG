import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { HeadRefreshSettingsStore } from "../../server/crawler/head-refresh-settings";
import { browserStatus, crawlStatus } from "../fixtures/saved-role";
import { crawl } from "../../server/crawler/runner";
import { CrawlStore } from "../../server/crawler/store";
import { CAPTURE_VERSION } from "../../server/crawler/compact";
import type { CrawlSource, CrawlStatus, Listing, RoleDetail } from "../../server/crawler/types";

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
    .toEqual({ intervalSeconds: 90, random: false, listingAgeMinutes: 10 });
  await expect(panel.getByRole("status")).toContainText("已保存");
  await unit.selectOption("60");
  await time.fill("10");
  await random.check();
  await save.click();
  await expect
    .poll(() => state.store.get())
    .toEqual({ intervalSeconds: 600, random: true, listingAgeMinutes: 10 });
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
    .toEqual({ intervalSeconds: 3600, random: true, listingAgeMinutes: 10 });
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
  expect(state.store.get()).toEqual({ intervalSeconds: 60, random: false, listingAgeMinutes: 10 });
  await expect(panel).toContainText("当前已保存：每1分钟刷新一次");
  state.failSave = false;
  await save.click();
  await expect
    .poll(() => state.store.get())
    .toEqual({ intervalSeconds: 600, random: true, listingAgeMinutes: 10 });
  await random.uncheck();
  await save.click();
  await expect
    .poll(() => state.store.get())
    .toEqual({ intervalSeconds: 600, random: false, listingAgeMinutes: 10 });
});

test("设置读取失败时禁止提交默认值，重新读取后恢复", async ({ page }, testInfo) => {
  const state = await mount(page, testInfo.outputPath("head-refresh.json"));
  state.store.save({ intervalSeconds: 3600, random: true, listingAgeMinutes: 10 });
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

test("上架多少分钟以内默认10，可保存重载，拒绝零和小数，运行中保存不触发采集", async ({
  page,
}, testInfo) => {
  const state = await mount(page, testInfo.outputPath("head-refresh.json"));
  const panel = page.getByRole("region", { name: "列表首页刷新设置" });
  const pages = panel.getByLabel("上架多少分钟以内", { exact: true });
  const save = panel.getByRole("button", { name: "保存刷新设置" });
  await expect(save).toBeEnabled();
  await expect(pages).toHaveValue("10");
  for (const invalid of ["0", "1.5"]) {
    await pages.fill(invalid);
    await save.click();
    await expect(panel.getByRole("alert")).toContainText("上架时间范围必须是1至10080分钟的整数");
  }
  expect(state.saves).toBe(0);
  await pages.fill("7");
  await panel.getByLabel("时间单位").selectOption("1");
  await panel.getByLabel("刷新间隔", { exact: true }).fill("1");
  await save.click();
  await expect.poll(() => state.store.get().listingAgeMinutes).toBe(7);
  state.store = new HeadRefreshSettingsStore(testInfo.outputPath("head-refresh.json"));
  await page.reload();
  await expect(pages).toHaveValue("7");
  await expect(panel).toContainText("只采上架7分钟以内");
  await expect(panel).toContainText("上架时间可能混排");
  await expect(panel).toContainText("遇到第一条超出范围的商品就结束本轮");
  expect(state.starts).toBe(0);
  await panel.screenshot({ path: testInfo.outputPath("listing-age-settings.png") });

  // Use the UI's persisted settings with the real crawler and an isolated SQLite.
  // Lists/details are fixtures; no website, model, or running local service is used.
  const database = testInfo.outputPath("listing-window.sqlite");
  const store = new CrawlStore(database);
  const control = new AbortController();
  const listed = (id: number, minutes: number): Listing => {
    const time = new Date(Date.now() - minutes * 60_000).toISOString();
    return {
      key: `1:${id}`,
      serverId: "1",
      eid: String(id),
      ordersn: String(id),
      url: `https://xyq.cbg.163.com/equip?s=1&eid=${id}`,
      sellingTime: time,
      createdTime: time,
      orderTime: time,
      name: String(id),
      price: "100",
      attrs: {},
      summary: null,
    };
  };
  const current = listed(1, 1),
    old = listed(2, 8);
  let rows = [current, old];
  const captured: string[] = [];
  const states: Partial<CrawlStatus>[] = [];
  let refreshed = 0;
  const read = () => ({ page: 1, totalPages: 30, order: "selling_time DESC", items: rows });
  const source: CrawlSource = {
    prepare: async () => read(),
    refresh: async () => {
      refreshed++;
      return read();
    },
    page: async () => {
      throw new Error("遇到超窗角色后不应继续翻页");
    },
    hover: async (item) => item,
    onShelf: async () => true,
    detail: async (item): Promise<RoleDetail> => {
      captured.push(item.key);
      return {
        captureVersion: CAPTURE_VERSION,
        url: item.url,
        collectedAt: new Date().toISOString(),
        tabs: [],
        raw: {},
        equipmentCapture: {
          version: 1,
          collectedAt: new Date().toISOString(),
          complete: true,
          issues: [],
          emptyProof: "official-containers",
        },
        petCapture: {
          version: 1,
          collectedAt: new Date().toISOString(),
          complete: true,
          issues: [],
        },
      };
    },
  };
  const completion = crawl(source, store, control.signal, (state) => states.push(state), {
    watch: true,
    concurrency: 2,
    headRefresh: state.store.get(),
  }).catch((error: unknown) => error);
  try {
    await expect.poll(() => store.count()).toBe(1);
    expect(store.hasListing(old.key)).toBe(false);
    expect(states.some((state) => state.message?.includes("等待下次刷新"))).toBe(true);
    const added = listed(3, 0);
    rows = [added, current, old];
    await expect.poll(() => store.count()).toBe(2);
    expect(refreshed).toBeGreaterThanOrEqual(1);
    expect(captured).toEqual([current.key, added.key]);
    control.abort(new Error("测试暂停"));
    await completion;
    const records = store.db
      .prepare("SELECT key,status,selling_time FROM listings ORDER BY key")
      .all();
    await writeFile(
      testInfo.outputPath("listing-window-evidence.json"),
      JSON.stringify(
        {
          scope: "UI settings + real crawler/SQLite; local fixtures only",
          settings: state.store.get(),
          refreshed,
          captured,
          states,
          records,
        },
        null,
        2,
      ),
    );
    await testInfo.attach("保存分钟范围到刷新后新增采集的完整证据", {
      path: testInfo.outputPath("listing-window-evidence.json"),
      contentType: "application/json",
    });
  } finally {
    control.abort();
    await completion;
    store.close();
  }
  const reopened = new CrawlStore(database);
  try {
    expect(reopened.count()).toBe(2);
  } finally {
    reopened.close();
  }
});
