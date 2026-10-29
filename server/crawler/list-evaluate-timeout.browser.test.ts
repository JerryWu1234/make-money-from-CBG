import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { createHiddenPage } from "../session";
import { openWorkTransport } from "../work-transport";
import { CAPTURE_VERSION } from "./compact";
import { readListings } from "./page";
import { crawl } from "./runner";
import { createCrawlSource } from "./source";
import { CrawlStore } from "./store";
import type { Listing, RoleDetail } from "./types";

// 只隔离日志落盘；定位、evaluate、超时和采集调度均使用真实实现。
vi.mock("../diagnostics", () => ({ diagnostics: { record: vi.fn() } }));
vi.mock("../browser-evidence", () => ({
  captureBrowserStep: vi.fn().mockResolvedValue(undefined),
  registerBrowserEvidence: vi.fn(),
}));

/**
 * 复现命令：vp test server/crawler/list-evaluate-timeout.browser.test.ts
 * macOS Codex 中必须在沙箱外运行；Chrome 使用临时配置，SQLite 使用内存库。
 *
 * 对照：同一可见商品正常完成原生悬停。
 * 故障注入：暂扣 DOM.resolveNode 指令；旧实现会产生原生 30 秒超时。
 * 不 mock evaluate/hover，不创建或手工抛出 TimeoutError，不自动重跑失败商品。
 *
 * 这是“已解析到可见节点后句柄转换停顿”的受控复现，不证明线上同一指令停顿。
 * 修复后：不发送该句柄转换指令，真实悬停一次完成并进入详情入库。
 * 详情使用独立夹具；浏览器操作、列表调度和 SQLite 入库使用真实实现。
 * artifacts/ 下保留运行报告、协议记录和前后截图。
 */
const targetKey = "133:202610231500113-133-OSUWYRGDRWSS";
const listUrl = "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py";
const fixture = `<!doctype html><meta charset="utf-8">
<style>body{font:20px sans-serif;padding:32px}a.soldImg{display:block;width:520px;height:60px;margin:16px;background:#eef3ff}</style>
<h1>隔离复现：节点可见，但元素句柄转换停顿</h1>
<p>全部请求由本地模拟页面响应，不访问真实藏宝阁。</p>
<div id="order_menu"><a data_attr_name="expire_time">到期时间</a></div>
<div id="soldList"></div><div id="pager_bar"></div><p id="hover-result">尚未悬停</p>
<script>
window.QueryArgs={server_type:'3',page:1,order_by:'expire_time DESC'};
window.fixtureMouseovers=0;
const rows=[['1','baseline','已保存的首页角色'],['133','202610231500113-133-OSUWYRGDRWSS','21138978'],['413','after-target','失败商品之后的角色']];
window.goto=function(number){
  QueryArgs.page=number;
  document.querySelector('#pager_bar').textContent='第 '+number+' 页 共 2 页';
  document.querySelector('#soldList').innerHTML=(number===1?rows.slice(0,1):rows.slice(1)).map(([s,eid,name])=>
    '<a class="soldImg" href="https://xyq.cbg.163.com/equip?s='+s+'&eid='+eid+'" data_equip_name="'+name+'" data_price="100" data_selling_time="2026-10-25T02:29:50Z">'+name+'</a>'
  ).join('');
};
document.querySelector('#soldList').addEventListener('mouseover',event=>{
  if(event.target.closest('a')?.href.includes('eid=202610231500113-133-OSUWYRGDRWSS') && event.isTrusted){
    window.fixtureMouseovers++;
    document.querySelector('#hover-result').textContent='原生悬停已完成';
  }
});
goto(1);
</script>`;

let persistent: BrowserContext | undefined;
let connection: Browser | undefined;
let profile: string | undefined;
let transport: Awaited<ReturnType<typeof openWorkTransport>>;

const completeDetail = (row: Listing): RoleDetail => ({
  captureVersion: CAPTURE_VERSION,
  url: row.url,
  collectedAt: new Date().toISOString(),
  raw: {},
  tabs: [],
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
});

beforeAll(async () => {
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "0");
  profile = await mkdtemp(path.join(os.tmpdir(), "cbg-evaluate-repro-"));
  persistent = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const [port, endpoint] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  transport = await openWorkTransport(`ws://127.0.0.1:${port}${endpoint}`);
  connection = await chromium.connectOverCDP(transport, { noDefaults: true });
}, 30_000);

afterAll(async () => {
  await connection?.close();
  await persistent?.close();
  if (profile) await rm(profile, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("句柄转换指令不可用时仍一次悬停成功，第2页商品完成入库且不重试", async () => {
  const parent = path.resolve("artifacts/list-evaluate-timeout-repro");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "run-"));
  const page = await createHiddenPage(connection!);
  page.setDefaultTimeout(30_000);
  const store = new CrawlStore(":memory:");
  const events: { event: string; data?: Record<string, unknown> }[] = [];
  const updates: unknown[] = [];
  const control = new AbortController();
  const completed = new Error("测试已完成两个详情入库");
  const source = createCrawlSource({
    listPage: page,
    detailPage: page,
    signal: control.signal,
    onDetailProgress: () => {},
    log: (event, data) => events.push({ event, data }),
  });
  const detail = vi.spyOn(source, "detail").mockImplementation(async (row) => completeDetail(row));
  const send = transport.send.bind(transport);
  let armed = false;
  let held: Parameters<typeof transport.send>[0] | undefined;
  let targetAttempts = 0;
  let targetNativeHoverCalls = 0;
  const locate = page.locator.bind(page);
  const locatorSpy = vi.spyOn(page, "locator").mockImplementation((selector, options) => {
    const matches = locate(selector, options);
    if (selector.includes("eid=202610231500113-133-OSUWYRGDRWSS")) {
      const hover = matches.hover.bind(matches);
      vi.spyOn(matches, "hover").mockImplementation((options) => {
        targetNativeHoverCalls++;
        return hover(options);
      });
    }
    return matches;
  });
  let failure: Error | undefined;
  let failureElapsedMs = 0;
  transport.send = (message) => {
    if (armed && message.method === "DOM.resolveNode") {
      armed = false;
      held = message;
      return; // 暂扣真实CDP命令；不伪造响应或异常。
    }
    send(message);
  };
  try {
    await page.route("**/*", (route) =>
      route.request().url() === listUrl
        ? route.fulfill({ contentType: "text/html; charset=utf-8", body: fixture })
        : route.abort(),
    );
    await page.goto(listUrl);
    const baseline = (await readListings(page)).items[0]!;
    store.observe(baseline);
    expect(store.save(baseline, completeDetail(baseline))).toBe(true);

    // 先证明同一目标、相同页面与原生动作在没有注入故障时可以成功。
    const target = (await source.page(2)).items.find((row) => row.key === targetKey)!;
    await expect(source.hover(target)).resolves.toMatchObject({ key: targetKey });
    expect(await page.evaluate(() => Reflect.get(window, "fixtureMouseovers"))).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(directory, "control.png") });
    await page.evaluate(() => {
      Reflect.set(window, "fixtureMouseovers", 0);
      document.querySelector("#hover-result")!.textContent = "故障组：尚未完成目标悬停";
    });
    targetNativeHoverCalls = 0;
    events.length = 0;

    const hover = source.hover.bind(source);
    source.hover = async (row) => {
      if (row.key === targetKey) {
        targetAttempts++;
        armed = true;
      }
      return hover(row);
    };
    const started = Date.now();
    try {
      // 使用正常排序回退、首页检查、历史翻页、商品悬停和调度流程。
      await crawl(
        source,
        store,
        control.signal,
        (update) => {
          updates.push(update);
          // 持续扫描没有自然终点；两条新商品落库后主动结束测试，不重跑采集。
          if (update.saved === 2) control.abort(completed);
        },
        { watch: true, concurrency: 10, headIntervalMs: 60_000 },
      );
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failure = error;
      failureElapsedMs = Date.now() - started;
    }
    await page.evaluate(
      (message) => {
        document.querySelector("#hover-result")!.textContent = message;
      },
      failure === completed
        ? "修复验证：一次原生悬停成功，两条新商品已入库"
        : `验证失败：${failure?.message.split("\n")[0] ?? "采集异常结束"}`,
    );
    await page.screenshot({ path: path.join(directory, "failure.png") });
    const current = await readListings(page);
    const diagnostic = events.find((entry) => entry.event === "list.hover_timeout");
    const report = {
      reproduction: "controlled CDP command delay; not a confirmed historical root cause",
      heldCommand: held ? { method: held.method, id: held.id, sessionId: held.sessionId } : null,
      error:
        failure && failure !== completed ? { name: failure.name, message: failure.message } : null,
      failureElapsedMs,
      targetAttempts,
      targetNativeHoverCalls,
      targetStillVisible: await page.locator(`a[href="${target.url}"]`).isVisible(),
      targetMouseovers: await page.evaluate(() => Reflect.get(window, "fixtureMouseovers")),
      currentPage: current.page,
      targetPersisted: store.detail(targetKey) !== null,
      detailCalls: detail.mock.calls.length,
      checkpoint: store.checkpoint() ?? null,
      events,
      updates,
    };
    await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
    console.log("EVALUATE_TIMEOUT_REPRO_EVIDENCE", directory);
    expect(failure).toBe(completed);
    expect(held).toBeUndefined();
    expect(diagnostic).toBeUndefined();
    expect(report.targetStillVisible).toBe(true);
    // 重排也可能产生额外mouseover；是否重试按实际原生hover调用次数判断。
    expect(report.targetMouseovers).toBeGreaterThan(0);
    expect(targetNativeHoverCalls).toBe(1);
    expect(events.some((entry) => entry.event.startsWith("list.hover_re"))).toBe(false);
    expect(targetAttempts).toBe(1);
    expect(detail.mock.calls.map(([row]) => row.key)).toEqual([targetKey, "413:after-target"]);
    expect(store.detail(targetKey)).toMatchObject({ status: "complete" });
    expect(store.count()).toBe(3);
    expect(store.checkpoint()?.page).toBe(2);
    expect(store.backfillComplete()).toBe(false);
  } finally {
    armed = false;
    transport.send = send;
    if (held) send(held);
    locatorSpy.mockRestore();
    await page.close();
    store.close();
  }
}, 90_000);
