import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { createHiddenPage } from "../session";
import { openWorkTransport } from "../work-transport";
import { hoverListing, readListings, type ListingHoverDiagnostic } from "./page";
import { createCrawlSource } from "./source";
import { CrawlStore } from "./store";
import { crawl } from "./runner";
import { CAPTURE_VERSION } from "./compact";
import type { SavedRoleRecord } from "./types";

vi.mock("../diagnostics", () => ({ diagnostics: { record: vi.fn() } }));
vi.mock("../browser-evidence", () => ({
  captureBrowserStep: vi.fn(),
  registerBrowserEvidence: vi.fn(),
}));

// Regression for a controlled native-hover handle delay, not proof of a historical command.
// Only a temporary profile and an offline fixture are used. Run outside the macOS sandbox.
const key = "583:202605281800113-583-ZLDRYSFTFKJK";
const html = `<!doctype html><meta charset="utf-8"><style>a{display:block;margin:40px;width:400px;height:80px;background:#ddf}</style>
<div id="soldList"><a class="soldImg" href="https://xyq.cbg.163.com/equip?s=583&eid=202605281800113-583-ZLDRYSFTFKJK" data_equip_name="88088059" data_price="100" onmouseover="window.inspected=event.isTrusted">模拟商品88088059</a></div>
<div id="pager_bar">第1页 共1页</div>
<script>
window.QueryArgs={server_type:'3',page:1,order_by:'expire_time DESC'};
window.fixtureRefreshes=0;
window.goto=(number)=>{
  QueryArgs.page=number;
  document.querySelector('#pager_bar').textContent='第'+number+'页 共1页';
  // Refresh commits new nodes even when the same product remains on the page.
  const list=document.querySelector('#soldList');
  list.replaceWith(list.cloneNode(true));
  window.fixtureRefreshes++;
};
</script>`;
let profile: string;
let persistent: BrowserContext | undefined;
let connection: Browser | undefined;
let transport: Awaited<ReturnType<typeof openWorkTransport>>;
beforeAll(async () => {
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "0");
  profile = await mkdtemp(path.join(os.tmpdir(), "cbg-hover-handle-repro-"));
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

it("原生hover取句柄不可用时校验DOM后执行一次可信悬停，不重试商品", async () => {
  const parent = path.resolve("artifacts/list-hover-handle-timeout-repro");
  await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(path.join(parent, "run-"));
  const page = await createHiddenPage(connection!);
  await page.setContent(html);
  const item = (await readListings(page)).items[0];
  expect(item.key).toBe(key);
  const control = new AbortController();
  const signal = control.signal;
  await hoverListing(page, item, signal);
  await page.evaluate(() => Reflect.set(window, "inspected", false));
  const recovered: string[] = [];
  const send = transport.send.bind(transport);
  let held: Parameters<typeof transport.send>[0] | undefined;
  const commands: { method?: string; handleRead: boolean }[] = [];
  transport.send = (message) => {
    const args = message.params?.arguments as { value?: unknown }[] | undefined;
    const handleRead =
      message.method === "Runtime.callFunctionOn" &&
      !!args?.some(
        (arg) =>
          typeof arg.value === "string" && /^\(?r\)?\s*=>\s*r\.element$/.test(arg.value.trim()),
      );
    commands.push({ method: message.method, handleRead });
    if (handleRead && !held) {
      held = message;
      return;
    }
    send(message);
  };
  const diagnostics: ListingHoverDiagnostic[] = [];
  const store = new CrawlStore(":memory:");
  const source = createCrawlSource({
    listPage: page,
    detailPage: page,
    signal,
    onDetailProgress: () => {},
    log: (event, data) => {
      if (event === "list.hover_recovered") recovered.push(String(data?.stage));
      if (event === "list.hover_timeout")
        diagnostics.push({ ...data, event: "timeout" } as ListingHoverDiagnostic);
    },
  });
  let attempts = 0;
  const hover = source.hover.bind(source);
  source.hover = (row) => {
    attempts++;
    return hover(row);
  };
  const detail = vi.spyOn(source, "detail").mockImplementation(async (row) => ({
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
    petCapture: { version: 1, collectedAt: new Date().toISOString(), complete: true, issues: [] },
  }));
  const completed = new Error("已完成故障目标入库");
  let failure: Error | undefined;
  const started = Date.now();
  try {
    await crawl(
      source,
      store,
      signal,
      (state) => {
        if (state.saved === 1) control.abort(completed);
      },
      { watch: true, concurrency: 6 },
    );
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    if (error !== completed) failure = error;
  } finally {
    transport.send = send;
    // Release only the delayed protocol response for cleanup; never rerun hover.
    if (held) send(held);
  }
  const elapsedMs = Date.now() - started;
  const snapshot = await page.locator("#soldList a.soldImg").evaluateAll((elements) =>
    elements.map((el) => ({
      visible: el.checkVisibility(),
      rect: el.getBoundingClientRect().toJSON(),
    })),
  );
  const report = {
    reproduction:
      "controlled native-hover handle-read delay; historical protocol delay unconfirmed",
    key,
    held: held ? { method: held.method, id: held.id } : null,
    error: failure ? { name: failure.name, message: failure.message } : null,
    elapsedMs,
    listRefreshes: await page.evaluate(() => Reflect.get(window, "fixtureRefreshes")),
    attempts,
    detailCalls: detail.mock.calls.length,
    persisted: (store.detail(key) as SavedRoleRecord | null)?.status === "complete",
    productCount: store.count(),
    diagnostics,
    recovered,
    inspected: await page.evaluate(() => Reflect.get(window, "inspected")),
    snapshot,
    commands,
  };
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n");
  await page.screenshot({ path: path.join(directory, "fixture.png") });
  console.log("HOVER_HANDLE_REPRO_EVIDENCE", directory);
  store.close();
  expect(held).toBeDefined();
  expect(report.listRefreshes).toBe(1);
  expect(report.attempts).toBe(1);
  expect(report.detailCalls).toBe(1);
  expect(report.persisted).toBe(true);
  expect(report.productCount).toBe(1);
  expect(failure).toBeUndefined();
  expect(recovered).toEqual(["handle"]);
  expect(report.inspected).toBe(true);
  expect(diagnostics).toEqual([]);
  expect(snapshot).toEqual([expect.objectContaining({ visible: true })]);
  expect(commands.filter((command) => command.handleRead)).toHaveLength(1);
}, 20_000);
