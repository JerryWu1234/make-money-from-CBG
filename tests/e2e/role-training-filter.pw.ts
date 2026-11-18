import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { accessState } from "../fixtures/access-state";
import { browserStatus, crawlStatus } from "../fixtures/saved-role";

type Settings = { minTotal: number | null };
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function mount(
  page: Page,
  file: string,
  initial: Settings = { minTotal: 8 },
  holdRead?: Promise<void>,
) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(initial));
  const state = {
    failRead: false,
    failSave: false,
    readOverride: undefined as unknown,
    saveOverride: undefined as unknown,
    holdRead,
    holdSave: undefined as Promise<void> | undefined,
    writes: [] as Settings[],
    otherMutations: [] as string[],
    readSaved: async (): Promise<Settings> => JSON.parse(await readFile(file, "utf8")),
  };
  const overview = {
    counts: { total: 0, complete: 0, waitingDetail: 0, pendingDetail: 0, failedDetail: 0 },
    captureActivity: { running: true, phase: "capturing" },
    run: null,
    activeRun: null,
    runs: [],
    ranking: [],
    history: [],
    rankingPagination: { page: 1, totalPages: 1, total: 0 },
    records: { page: 1, totalPages: 1, total: 0, items: [] },
    results: { page: 1, totalPages: 1, total: 0, items: [] },
  };
  // Built UI + isolated file-backed mock API. No official site or running service is contacted.
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://role-training-ui.test") return route.abort();
    if (url.pathname === "/api/crawl/role-training-filter") {
      if (state.holdRead) await state.holdRead;
      if (state.failRead)
        return route.fulfill({ status: 503, json: { error: "模拟读取筛选失败" } });
      return route.fulfill({ json: state.readOverride ?? (await state.readSaved()) });
    }
    if (url.pathname === "/api/crawl/role-training-filter/save") {
      expect(route.request().method()).toBe("POST");
      const body = route.request().postDataJSON() as Settings;
      state.writes.push(body);
      if (state.holdSave) await state.holdSave;
      if (state.failSave)
        return route.fulfill({ status: 500, json: { error: "模拟保存筛选失败" } });
      await writeFile(file, JSON.stringify(body));
      return route.fulfill({ json: state.saveOverride ?? body });
    }
    if (url.pathname.startsWith("/api/")) {
      if (route.request().method() !== "GET") state.otherMutations.push(url.pathname);
      const responses: Record<string, unknown> = {
        "/api/access/status": accessState,
        "/api/browser/status": browserStatus,
        "/api/browser/settings": { mode: "dedicated", connected: true, busy: false },
        "/api/runtime/settings": { saveScreenshots: false },
        "/api/crawl/settings": { analyzeEquipment: false },
        "/api/crawl/status": crawlStatus(true, true),
        "/api/crawl/records": { page: 1, total: 0, totalPages: 1, items: [] },
        "/api/crawl/head-refresh": {
          intervalSeconds: 60,
          random: false,
          listingAgeMinutes: 10,
        },
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
        "/api/analysis/progress": overview,
        "/api/analysis/status": overview,
        "/api/ai/status": { codex: { state: "unconfigured" }, deepseek: { state: "unconfigured" } },
        "/api/ai/models": { provider: "codex", defaultModel: null, models: [] },
      };
      if (!(url.pathname in responses)) throw new Error("未模拟接口：" + url.pathname);
      return route.fulfill({ json: responses[url.pathname] });
    }
    const asset = path.join(
      "dist",
      url.pathname === "/" || url.pathname === "/analysis-preview" ? "index.html" : url.pathname,
    );
    return route.fulfill({
      contentType: asset.endsWith(".js")
        ? "application/javascript"
        : asset.endsWith(".css")
          ? "text/css"
          : "text/html",
      body: await readFile(asset),
    });
  });
  await page.goto("http://role-training-ui.test");
  return state;
}

test("四修40/0/空设置保存并重载恢复，不启动采集或修改分析设置", async ({ page }, info) => {
  const state = await mount(page, info.outputPath("filter.json"));
  const panel = page.getByRole("region", { name: "采集前置筛选" });
  const input = panel.getByLabel("人物四修总和 ≥", { exact: true });
  const save = panel.getByRole("button", { name: "保存前置筛选" });
  await expect(input).toHaveValue("8");
  await input.fill("40");
  await save.click();
  await expect(panel.getByRole("status")).toContainText("已保存，下次开始或继续采集时生效");
  expect(await state.readSaved()).toEqual({ minTotal: 40 });
  await expect(panel).toContainText("上次确认的设置：人物四修总和 ≥ 40");
  await expect(panel).toContainText("当前采集运行保持原设置");
  const screenshot = info.outputPath("role-training-filter-ui.png");
  await panel.screenshot({ path: screenshot });
  await info.attach("模拟API隔离页面：采集前置筛选保存40", {
    path: screenshot,
    contentType: "image/png",
  });
  await page.reload();
  await expect(input).toHaveValue("40");
  await input.fill("0");
  await save.click();
  await expect.poll(state.readSaved).toEqual({ minTotal: 0 });
  await page.reload();
  await expect(input).toHaveValue("0");
  await input.fill("");
  await save.click();
  await expect.poll(state.readSaved).toEqual({ minTotal: null });
  await page.reload();
  await expect(input).toHaveValue("");
  await expect(panel).toContainText("上次确认的设置：不限");
  expect(state.writes).toEqual([{ minTotal: 40 }, { minTotal: 0 }, { minTotal: null }]);
  expect(state.otherMutations).toEqual([]);
  await page.getByRole("link", { name: "商品分析", exact: true }).click();
  await expect(page.getByRole("heading", { name: "商品分析", exact: true })).toBeVisible();
  await expect(panel).toHaveCount(0);
});

test("读取中及读取失败禁提交默认值，重试后恢复且采集页仍可使用", async ({ page }, info) => {
  const gate = deferred();
  const state = await mount(page, info.outputPath("filter.json"), { minTotal: 88 }, gate.promise);
  const panel = page.getByRole("region", { name: "采集前置筛选" });
  const input = panel.getByLabel("人物四修总和 ≥", { exact: true });
  const save = panel.getByRole("button", { name: "保存前置筛选" });
  try {
    await expect(input).toBeDisabled();
    await expect(save).toBeDisabled();
    await expect(panel.getByRole("status")).toContainText("正在读取");
    expect(state.writes).toEqual([]);
  } finally {
    gate.release();
    state.holdRead = undefined;
  }
  await expect(input).toHaveValue("88");
  state.failRead = true;
  await page.reload();
  await expect(panel.getByRole("alert")).toContainText("模拟读取筛选失败");
  await expect(input).toBeDisabled();
  await expect(save).toBeDisabled();
  await expect(page.getByRole("heading", { name: "详情采集与续采", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "列表首页刷新设置" })).toBeVisible();
  state.failRead = false;
  await panel.getByRole("button", { name: "重新读取筛选设置" }).click();
  await expect(input).toHaveValue("88");
  await expect(save).toBeEnabled();
  expect(state.writes).toEqual([]);
});

test("本地拒绝负数小数溢出且保留草稿，写失败保留草稿可重试", async ({ page }, info) => {
  const state = await mount(page, info.outputPath("filter.json"));
  const panel = page.getByRole("region", { name: "采集前置筛选" });
  const input = panel.getByLabel("人物四修总和 ≥", { exact: true });
  const save = panel.getByRole("button", { name: "保存前置筛选" });
  await expect(input).toBeEnabled();
  for (const invalid of ["-1", "1.5", "1e2", "9007199254740992", "word"]) {
    await input.fill(invalid);
    await save.click();
    await expect(panel.getByRole("alert")).toContainText("非负整数");
    await expect(input).toHaveValue(invalid);
  }
  expect(state.writes).toEqual([]);
  state.failSave = true;
  await input.fill("41");
  await save.click();
  await expect(panel.getByRole("alert")).toContainText("模拟保存筛选失败");
  await expect(input).toHaveValue("41");
  await expect(panel).toContainText("上次确认的设置：人物四修总和 ≥ 8");
  expect(await state.readSaved()).toEqual({ minTotal: 8 });
  state.failSave = false;
  await save.click();
  await expect(panel.getByRole("status")).toContainText("已保存");
  expect(await state.readSaved()).toEqual({ minTotal: 41 });
  expect(state.otherMutations).toEqual([]);
});

test("保存回执不能覆盖保存期间新编辑的草稿", async ({ page }, info) => {
  const state = await mount(page, info.outputPath("filter.json"));
  const panel = page.getByRole("region", { name: "采集前置筛选" });
  const input = panel.getByLabel("人物四修总和 ≥", { exact: true });
  const save = panel.getByRole("button", { name: "保存前置筛选" });
  await expect(input).toBeEnabled();
  const gate = deferred();
  state.holdSave = gate.promise;
  try {
    await input.fill("40");
    await save.click();
    await expect.poll(() => state.writes.length).toBe(1);
    await expect(panel.getByRole("button", { name: "正在保存…" })).toBeDisabled();
    await expect(input).toBeEnabled();
    await input.fill("45");
  } finally {
    gate.release();
    state.holdSave = undefined;
  }
  await expect(panel.getByRole("status")).toContainText("当前输入尚未保存");
  await expect(input).toHaveValue("45");
  expect(await state.readSaved()).toEqual({ minTotal: 40 });
  await expect(panel).toContainText("上次确认的设置：人物四修总和 ≥ 40");
  await save.click();
  await expect.poll(state.readSaved).toEqual({ minTotal: 45 });
  expect(state.writes).toEqual([{ minTotal: 40 }, { minTotal: 45 }]);
});

test("无效服务响应不能被当作不限或保存成功", async ({ page }, info) => {
  const state = await mount(page, info.outputPath("filter.json"));
  state.readOverride = { minTotal: "40" };
  await page.reload();
  const panel = page.getByRole("region", { name: "采集前置筛选" });
  const input = panel.getByLabel("人物四修总和 ≥", { exact: true });
  const save = panel.getByRole("button", { name: "保存前置筛选" });
  await expect(panel.getByRole("alert")).toContainText("读取采集前置筛选返回无效");
  await expect(save).toBeDisabled();
  state.readOverride = undefined;
  await panel.getByRole("button", { name: "重新读取筛选设置" }).click();
  await expect(input).toHaveValue("8");
  await input.fill("40");
  state.saveOverride = { minTotal: 1.5 };
  await save.click();
  await expect(panel.getByRole("alert")).toContainText("保存采集前置筛选返回无效");
  await expect(input).toHaveValue("40");
  await expect(panel).toContainText("上次确认的设置：人物四修总和 ≥ 8");
  state.saveOverride = { minTotal: 41 };
  await save.click();
  await expect(panel.getByRole("alert")).toContainText("保存结果与提交值不一致");
  await expect(input).toHaveValue("40");
});
