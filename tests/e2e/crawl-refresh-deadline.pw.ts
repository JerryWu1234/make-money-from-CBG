import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { crawl } from "../../server/crawler/runner";
import { CrawlStore } from "../../server/crawler/store";
import { CAPTURE_VERSION } from "../../server/crawler/compact";
import { MAIN_TABS } from "../../server/crawler/detail";
import {
  SellingOrderUnavailableError,
  type CrawlSource,
  type CrawlStatus,
  type Listing,
  type RoleDetail,
} from "../../server/crawler/types";
import { browserStatus } from "../fixtures/saved-role";

// Failure modes: a full queue postpones refresh; refresh cancels active details;
// partial-page jobs disappear; old labels survive; the completed retry stays
// visible; expired items run; pause/reopen loses data or repeats a detail read.
test("队列满且第2页未扫完→到点刷新→在途完成→暂停重开核验，状态反映5分钟范围", async ({
  page,
}, testInfo) => {
  const database = testInfo.outputPath("capture.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  let store = new CrawlStore(database);
  const settings = { intervalSeconds: 3, random: false, listingAgeMinutes: 5 };
  const listed = (id: number, age = 1): Listing => {
    const time = new Date(Date.now() - age * 60_000).toISOString();
    return {
      key: `1:${id}`,
      serverId: "1",
      eid: String(id),
      ordersn: String(id),
      url: `https://xyq.cbg.163.com/equip?s=1&eid=${id}`,
      sellingTime: time,
      createdTime: time,
      orderTime: time,
      name: `角色${id}`,
      price: "100",
      attrs: {},
      summary: null,
    };
  };
  const rows = new Map([1, 2, 3, 4, 5, 6, 7, 100].map((id) => [id, listed(id)]));
  const expired = listed(99, 6);
  store.observe(rows.get(100)!, "old");
  let status: CrawlStatus = {
    running: false,
    phase: "idle",
    message: "本地模拟已就绪",
    page: 0,
    totalPages: 100,
    saved: 0,
    skipped: 0,
    totalSaved: 0,
    database,
  };
  const active = new Set<string>();
  const gates = new Map<string, () => void>();
  const calls: string[] = [];
  const queries: number[] = [];
  const refreshes: Array<{ completedAt: string; active: string[]; page: number }> = [];
  let maximum = 0;
  let control: AbortController | undefined;
  let completion: Promise<void> | undefined;
  const detail = (item: Listing): RoleDetail => ({
    captureVersion: CAPTURE_VERSION,
    url: item.url,
    collectedAt: new Date().toISOString(),
    raw: {},
    tabs: MAIN_TABS.map((name) => ({
      name,
      text: `${item.name} ${name}`,
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [],
      petCount: 0,
      equipmentEmptyProof: "official-containers",
    })),
    equipmentCapture: {
      version: 1,
      collectedAt: new Date().toISOString(),
      complete: true,
      issues: [],
      emptyProof: "official-containers",
    },
    petCapture: { version: 1, collectedAt: new Date().toISOString(), complete: true, issues: [] },
  });
  const read = (ids: number[], number = 1) => ({
    page: number,
    totalPages: 100,
    order: "expire_time DESC",
    items: ids.map((id) => rows.get(id)!),
  });
  const source: CrawlSource = {
    prepare: async (order) => {
      if (order === "selling_time DESC") throw new SellingOrderUnavailableError();
      return read([1]);
    },
    page: async (number) => {
      queries.push(number);
      if (number !== 2) throw new Error("队列满时不应继续翻到第3页");
      return read([2, 3, 4, 6, 7], 2);
    },
    refresh: async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      refreshes.push({
        completedAt: new Date().toISOString(),
        active: [...active],
        page: status.page,
      });
      return {
        ...read([5, 1, 2, 3, 4, 6, 7]),
        items: [...read([5, 1, 2, 3, 4, 6, 7]).items, expired],
      };
    },
    onShelf: async () => true,
    hover: async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return item;
    },
    detail: async (item) => {
      calls.push(item.key);
      active.add(item.key);
      maximum = Math.max(maximum, active.size);
      try {
        if (["1:1", "1:2", "1:100"].includes(item.key))
          await new Promise<void>((resolve) => gates.set(item.key, resolve));
        return detail(item);
      } finally {
        active.delete(item.key);
      }
    },
  };
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://refresh-deadline.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      switch (url.pathname) {
        case "/api/browser/status":
          body = browserStatus;
          break;
        case "/api/browser/settings":
          body = { mode: "dedicated", connected: true, busy: false };
          break;
        case "/api/runtime/settings":
          body = { saveScreenshots: false };
          break;
        case "/api/crawl/settings":
          body = { analyzeEquipment: false };
          break;
        case "/api/crawl/head-refresh":
          body = settings;
          break;
        case "/api/crawl/status":
          body = status;
          break;
        case "/api/crawl/records":
          body = store.records(Number(url.searchParams.get("page") || 1), 20);
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
        case "/api/crawl/start": {
          const input = route.request().postDataJSON();
          control = new AbortController();
          status = { ...status, running: true, phase: "locating", headRefresh: settings };
          completion = crawl(
            source,
            store,
            control.signal,
            (update) => {
              status = { ...status, ...update };
            },
            { concurrency: input.concurrency, watch: true, headRefresh: settings },
          ).catch((error: unknown) => {
            status = {
              ...status,
              running: false,
              phase: control!.signal.aborted ? "paused" : "error",
              message: String(error),
            };
          });
          body = status;
          break;
        }
        case "/api/crawl/stop":
          control!.abort(new Error("用户暂停采集"));
          await completion;
          body = status;
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
  try {
    await page.goto("http://refresh-deadline.test");
    const panel = page.getByRole("region", { name: "详情采集" });
    const queues = page.getByLabel("采集双队列状态");
    await page.getByLabel("并发抓取数", { exact: true }).fill("2");
    await page.getByRole("button", { name: /开始采集详情|继续采集 \/ 检查新增/ }).click();
    await expect(panel.getByText(/优先处理采集任务：0 \/ 1/)).toBeVisible();
    gates.get("1:100")!();
    await expect.poll(() => active.size).toBe(2);
    await expect(panel.getByText(/正在检查第2页的上架5分钟以内商品/)).toBeVisible();
    await expect(queues).toContainText("上架范围 5 分钟 · 当前在途 2 个");
    await expect(queues).not.toContainText("老号");
    await expect(panel.getByText(/优先处理采集任务/)).toHaveCount(0);
    await panel.screenshot({ path: testInfo.outputPath("before-refresh.png") });
    await expect.poll(() => refreshes.length, { timeout: 10000 }).toBeGreaterThan(0);
    expect(refreshes[0]).toMatchObject({ page: 2, active: ["1:1", "1:2"] });
    await expect.poll(() => status.lastHeadRefreshAt).toBeTruthy();
    expect(Date.parse(status.lastHeadRefreshAt!)).toBeGreaterThanOrEqual(
      Date.parse(refreshes[0].completedAt),
    );
    await expect(panel.getByText(/下次计划刷新：.*最近实际刷新：/)).toBeVisible();
    await expect(panel.getByText(/当前检查第 1 页/)).toBeVisible();
    await panel.screenshot({ path: testInfo.outputPath("refreshed-with-active-details.png") });
    gates.get("1:1")!();
    gates.get("1:2")!();
    await expect.poll(() => store.count(), { timeout: 20000 }).toBe(8);
    expect(maximum).toBe(2);
    expect(store.hasListing(expired.key)).toBe(false);
    expect(calls).toHaveLength(8);
    expect(new Set(calls).size).toBe(8);
    await expect(queues).toContainText("当前在途 0 个 · 范围内排队 0 个");
    await panel.screenshot({ path: testInfo.outputPath("completed-window.png") });
    await page.getByRole("button", { name: "暂停采集", exact: true }).click();
    expect(status.phase).toBe("paused");
    store.close();
    store = new CrawlStore(database);
    expect(store.count()).toBe(8);
    expect(store.retryItems()).toHaveLength(0);
    const sql = "SELECT key,status,selling_time FROM listings ORDER BY key;";
    await writeFile(testInfo.outputPath("verify.sql"), sql + "\n");
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          settings,
          maximum,
          queries,
          refreshes,
          calls,
          lastHeadRefreshAt: status.lastHeadRefreshAt,
          rows: store.db.prepare(sql).all(),
          repeat:
            "vp run build && vp exec playwright test tests/e2e/crawl-refresh-deadline.pw.ts --workers=1 --output=/tmp/cbg-refresh-deadline-e2e",
          verify: "sqlite3 capture.sqlite < verify.sql",
          scope:
            "真实crawler、SQLite及React；3秒刷新代替等待3分钟，列表和详情为受控数据，不访问官网或模型",
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    control?.abort(new Error("测试清理"));
    gates.forEach((release) => release());
    await completion;
    store.close();
  }
});
