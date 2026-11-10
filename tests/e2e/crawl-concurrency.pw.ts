import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { crawl, validateCrawlOptions } from "../../server/crawler/runner";
import { createCrawlSource } from "../../server/crawler/source";
import { CrawlStore } from "../../server/crawler/store";
import { MAIN_TABS } from "../../server/crawler/detail";
import {
  CrawlAccessError,
  type CrawlStatus,
  type Listing,
  type SavedRoleRecord,
} from "../../server/crawler/types";
import { browserStatus } from "../fixtures/saved-role";
import { clickForInspection } from "../../server/viewport";

const pages: Record<number, string[]> = { 1: ["a", "b", "c", "d"], 2: ["d", "e"] };
const raw = (id: string) => ({
  game_ordersn: `order-${id}`,
  expire_time: 1900000100 - id.charCodeAt(0),
});

test("新号优先状态显示实际在途，10并发上限不会显示成已满", async ({ page }, testInfo) => {
  let status: CrawlStatus = {
    running: true,
    phase: "collecting",
    message: "本地模拟采集状态",
    latestComplete: { key: "fixture:new", collectedAt: "2026-10-25T05:00:20.000Z" },
    checkpoint: {
      key: "fixture:history",
      savedAt: "2026-10-25T04:21:14.000Z",
      time: null,
      order: "expire_time DESC",
      page: 4,
    },
    captureStrategy: "new-first",
    concurrency: 10,
    newRunning: 0,
    oldRunning: 4,
    newQueued: 0,
    oldQueued: 6,
    page: 1,
    totalPages: 20,
    saved: 0,
    skipped: 0,
    totalSaved: 0,
    database: "fixture-only.sqlite",
  };
  await page.context().route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== "http://capture-status.test") return route.abort();
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      switch (url.pathname) {
        case "/api/browser/settings":
          body = { mode: "daily", connected: true, busy: false };
          break;
        case "/api/browser/status":
          body = browserStatus;
          break;
        case "/api/crawl/head-refresh":
          body = { intervalSeconds: 60, random: false };
          break;
        case "/api/crawl/settings":
          body = { analyzeEquipment: false };
          break;
        case "/api/runtime/settings":
          body = { saveScreenshots: false };
          break;
        case "/api/crawl/status":
          body = status;
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
  await page.goto("http://capture-status.test");
  const panel = page.getByRole("region", { name: "详情采集" });
  const queues = page.getByLabel("采集双队列状态");
  await expect(panel).toContainText("本轮并发上限：10 个角色");
  await expect(queues).toContainText("新号优先 · 当前在途 4 个");
  await expect(queues).toContainText("新号在途 0 · 老号在途 4");
  await expect(queues).toContainText("新号排队 0 · 老号排队 6");
  await expect(queues).not.toContainText("/5");
  await expect(panel).not.toContainText("借用");
  await expect(panel.getByText(/最近完整采集：/)).toContainText("13:00:20");
  await expect(panel.getByText(/历史扫描断点：/)).toContainText("12:21:14");
  await expect(panel).not.toContainText("上次成功入库");
  await panel.screenshot({ path: testInfo.outputPath("old-four-of-ten.png") });
  status = {
    ...status,
    newRunning: 2,
    oldRunning: 3,
    newQueued: 5,
    oldQueued: 10,
    retryTotal: 20,
    retryCompleted: 0,
  };
  await expect(queues).toContainText("新号优先 · 当前在途 5 个");
  await expect(queues).toContainText("新号在途 2 · 老号在途 3");
  await expect(queues).toContainText("新号排队 5 · 老号排队 10");
  await panel.screenshot({ path: testInfo.outputPath("new-first-with-existing-old.png") });
  status = { ...status, phase: "retrying", captureStrategy: undefined };
  await expect(queues).toContainText("已保存任务优先补采 · 当前在途 5 个");
  await expect(queues).not.toContainText("新号优先");
  await panel.screenshot({ path: testInfo.outputPath("saved-capture-first.png") });
  status = { ...status, phase: "collecting", captureStrategy: undefined };
  await expect(queues).not.toContainText("已保存任务优先补采");
  await expect(queues).not.toContainText("新号优先");
  await expect(queues).toContainText("当前在途 5 个");
  status = {
    ...status,
    running: false,
    phase: "paused",
    accessIssue: "login",
    message: new CrawlAccessError("login").message,
    nextHeadCheckAt: "2026-10-25T05:01:00.000Z",
    newRunning: 0,
    oldRunning: 0,
  };
  await expect(panel).toContainText("网站详情要求重新登录，采集已暂停");
  await expect(queues).toContainText("当前在途 0 个");
  await expect(panel).not.toContainText("首页下次检查");
  await expect(panel).not.toContainText("本轮并发上限");
  await panel.screenshot({ path: testInfo.outputPath("paused-for-login.png") });
});
const fixtureListingTime = new Date().toISOString();
const listHtml = (number: number) =>
  `<table id="soldList"><tr id="order_menu"><th><a data_attr_name="expire_time">剩余时间</a></th></tr>${pages[number].map((id) => `<tr><td><a class="soldImg" href="https://xyq.cbg.163.com/equip?s=367&eid=${id}"><img width="40" height="40" data_serverid="367" data_ordersn="order-${id}" data_equip_name="角色${id}" data_price="222" data_selling_time="${fixtureListingTime}"></a></td></tr>`).join("")}</table><div id="pager_bar">第${number}页, 共2页 <a href="javascript:goto(${number === 1 ? 2 : 1})">翻页</a></div>`;
const listDocument = `<meta charset="utf-8"><script>var IsLogin=1,LoginInfo={login:1},QueryArgs={server_type:'1,2,3',page:1,order_by:'expire_time DESC'},QueryResult=${JSON.stringify(pages[1].map(raw))};var records=${JSON.stringify(Object.fromEntries(Object.entries(pages).map(([n, ids]) => [n, ids.map(raw)])))};function goto(n){fetch('/mock-list?page='+n).then(r=>r.text()).then(html=>{document.getElementById('query_result').innerHTML=html;QueryArgs.page=n;QueryResult=records[n]})}</script><div id="query_result">${listHtml(1)}</div>`;
const detailDocument = (id: string) => {
  const gear = `<div id="RoleEquip"><a data_equip_name="武器${id}" data_equip_category="武器" data_equip_desc="等级 100#r伤害 +420" data_tip_box="RoleEquipTipsBox"><img width="40" height="40" onmouseover="RoleEquipTipsBox.style.display='block';RoleEquipTipsBox.innerText='武器${id}\\n等级 100\\n伤害 +420'" onmouseout="RoleEquipTipsBox.style.display='none'"></a></div>`;
  const tabs = Object.fromEntries(
    MAIN_TABS.map((name) => [
      name,
      name === "道具/法宝"
        ? gear
        : name === "召唤兽/孩子"
          ? "<p>召唤兽(0/10)</p>"
          : name === "技能"
            ? "<p>师门技能</p>" +
              ["一", "二", "三", "四", "五", "六", "七"]
                .map(
                  (suffix) =>
                    `<p>150</p><img width="30" height="30" data_skill_type="school_skill" data_equip_name="测试技能${suffix}" data_equip_level="150"><p>测试技能${suffix}</p>`,
                )
                .join("") +
              "<p>生活技能</p>"
            : `<p>${name}：模拟角色${id}</p>`,
    ]),
  );
  return `<meta charset="utf-8"><script>var IsLogin=1,LoginInfo={login:1},EquipInfo={eid:'${id}',server_id:367};window.decode_desc=v=>v;window.RoleInfoParser=class{constructor(){this.raw_info={AllRider:{},jinjie_rider_info:{isJinJie:0},all_skills:{201:140},i3FlyLv:0};this.result={shenqi:false,basic_info:{is_gold_id:false}}}};var content=${JSON.stringify(tabs)};function show(name){document.getElementById('panel').innerHTML=content[name]}</script><section><nav>${MAIN_TABS.map((name) => `<button onclick="show('${name}')">${name}</button>`).join("")}</nav><div id="panel">${"模拟角色完整资料。".repeat(30)}</div><div id="RoleEquipTipsBox" style="display:none"></div><textarea id="equip_desc_value" hidden>fixture-source-${id}</textarea></section>`;
};

// 失败方式：点击 RPC 重叠、网络等待占用点击锁、多页串号、标签漏读、重开数据库后资料不完整。
for (const concurrency of [2, 6, 10]) {
  test(`${concurrency}页点击逐个派发，网络并发读取后完整入库并重开核验`, async ({
    context,
  }, testInfo) => {
    test.setTimeout(90000);
    const origin = "http://127.0.0.1:17777";
    const ids = Array.from({ length: concurrency }, (_, index) => String.fromCharCode(97 + index));
    const listings: Listing[] = ids.map((id) => ({
      key: `367:${id}`,
      serverId: "367",
      eid: id,
      ordersn: `order-${id}`,
      url: `${origin}/equip?s=367&eid=${id}`,
      sellingTime: null,
      createdTime: null,
      orderTime: null,
      name: `模拟角色${id}`,
      price: "222",
      attrs: {},
      summary: null,
    }));
    const database = testInfo.outputPath(`${concurrency}-role-capture.sqlite`);
    const workers = await Promise.all(ids.map(() => context.newPage()));
    const listPage = await context.newPage();
    let store: CrawlStore | undefined = new CrawlStore(database);
    const control = new AbortController();
    let releaseClick!: () => void;
    const clickGate = new Promise<void>((resolve) => {
      releaseClick = resolve;
    });
    let firstClick!: () => void;
    const firstClickRequest = new Promise<void>((resolve) => {
      firstClick = resolve;
    });
    let releaseLoading!: () => void;
    const loadingGate = new Promise<void>((resolve) => {
      releaseLoading = resolve;
    });
    const loading = new Set<string>();
    const dispatches: Array<{ phase: string; eid: string; inFlight: number }> = [];
    let phase = "probe";
    let inFlight = 0;
    let maximum = 0;
    const prototype = Object.getPrototypeOf(workers[0].locator("button"));
    const evaluateAll: Locator["evaluateAll"] = prototype.evaluateAll;
    // Hold the actual CDP evaluation open; an event handler counter alone cannot show RPC overlap.
    prototype.evaluateAll = async function (
      this: Locator,
      ...args: Parameters<Locator["evaluateAll"]>
    ) {
      const [callback] = args;
      if (typeof callback !== "function" || !/\.click\(\)/.test(String(callback)))
        return evaluateAll.apply(this, args);
      const eid = new URL(this.page().url()).searchParams.get("eid")!;
      maximum = Math.max(maximum, ++inFlight);
      dispatches.push({ phase, eid, inFlight });
      try {
        return await evaluateAll.call(
          this,
          async (elements, metadata) => {
            const { source, phase } = metadata as { source: string; phase: string };
            // oxlint-disable-next-line typescript/no-implied-eval -- Run the original click callback inside the gated browser RPC.
            const dispatch = new Function("elements", `return (${source})(elements)`);
            const clicked: unknown = dispatch(elements);
            await fetch(`/click-rpc?phase=${phase}`);
            return clicked;
          },
          { source: String(callback), phase },
        );
      } finally {
        inFlight--;
      }
    };
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== origin) return route.abort();
      if (url.pathname === "/click-rpc") {
        if (url.searchParams.get("phase") === "probe") {
          firstClick();
          await clickGate;
        }
        return route.fulfill({ body: "done" });
      }
      if (url.pathname === "/tab-ready") {
        loading.add(url.searchParams.get("eid")!);
        if (loading.size === ids.length) releaseLoading();
        await loadingGate;
        return route.fulfill({ body: "ready" });
      }
      if (url.pathname !== "/equip") return route.abort();
      const id = url.searchParams.get("eid")!;
      // All first-tab loads must start before any can finish. Locking a whole tab read deadlocks here.
      const gatedFirstTab = `<script>const render=show;show=name=>{render(name);if(name===${JSON.stringify(MAIN_TABS[0])})fetch('/tab-ready?eid=${id}')}</script>`;
      return route.fulfill({
        contentType: "text/html",
        body: detailDocument(id) + gatedFirstTab,
      });
    });
    let capture: Promise<void[]> | undefined;
    let probe: Promise<void[]> | undefined;
    try {
      await Promise.all(workers.map((worker, index) => worker.goto(listings[index].url)));
      probe = Promise.all(
        workers.map((worker) =>
          clickForInspection(worker.getByText("技能", { exact: true }), control.signal),
        ),
      );
      await firstClickRequest;
      expect(maximum, `${concurrency}个调用已同时发起；仅1个点击RPC可以进入浏览器`).toBe(1);
      releaseClick();
      await probe;
      expect(dispatches).toHaveLength(concurrency);
      phase = "capture";
      const available = workers.slice(1);
      const source = createCrawlSource({
        listPage,
        detailPage: workers[0],
        createDetailPage: async () => available.shift()!,
        signal: control.signal,
        onDetailProgress: () => {},
        log: () => {},
      });
      capture = Promise.all(
        listings.map(async (item) => {
          store!.observe(item);
          const detail = await source.detail(item);
          expect(detail.tabs.map((tab) => tab.name)).toEqual(MAIN_TABS);
          expect(detail.valuation!.source.eid).toBe(item.eid);
          store!.save(item, detail);
        }),
      );
      await capture;
      expect([...loading].sort()).toEqual(ids);
      expect(maximum).toBe(1);
      expect(dispatches.filter((entry) => entry.phase === "capture")).toHaveLength(
        concurrency * MAIN_TABS.length,
      );
      store.close();
      store = new CrawlStore(database);
      expect(store.count()).toBe(concurrency);
      const records = listings.map((item) => {
        const record = store!.detail(item.key) as SavedRoleRecord;
        expect(record.status).toBe("complete");
        expect(record.listing.eid).toBe(item.eid);
        expect(record.detail!.valuation!.source).toMatchObject({ serverId: "367", eid: item.eid });
        expect(record.detail!.tabs.map((tab) => tab.name)).toEqual(MAIN_TABS);
        expect(record.detail!.tabs.find((tab) => tab.name === "人物/修炼")!.text).toContain(
          `模拟角色${item.eid}`,
        );
        expect(record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].name).toBe(
          `武器${item.eid}`,
        );
        expect(record.detail!.tabs.find((tab) => tab.name === "技能")!.items).toHaveLength(7);
        expect(record.detail!.equipmentCapture!.complete).toBe(true);
        expect(record.detail!.petCapture!.complete).toBe(true);
        return record;
      });
      const sql =
        "SELECT key,status,json_extract(detail_json,'$.valuation.source.eid') AS eid,json_array_length(json_extract(detail_json,'$.tabs')) AS tabs FROM listings ORDER BY key;";
      await writeFile(testInfo.outputPath("verify.sql"), sql + "\n");
      await writeFile(
        testInfo.outputPath("evidence.json"),
        JSON.stringify(
          {
            fixture: true,
            concurrency,
            repeat: `vp exec playwright test tests/e2e/crawl-concurrency.pw.ts --grep '${concurrency}页点击逐个派发' --workers=1`,
            verify: `sqlite3 ${path.basename(database)} < verify.sql`,
            database: path.basename(database),
            clickRpcMaximum: maximum,
            dispatches,
            firstTabLoadingGate: {
              scope: "验证各页网络加载可并行；标签内容同步更新，不验证延迟标签内容就绪。",
              expected: ids.length,
              arrived: [...loading].sort(),
              released: true,
            },
            rows: store.db.prepare(sql).all(),
            records,
          },
          null,
          2,
        ),
      );
      store.close();
      store = undefined;
      await testInfo.attach(`${concurrency}页采集验证结果`, {
        path: testInfo.outputPath("evidence.json"),
        contentType: "application/json",
      });
      await testInfo.attach(`可重开的${concurrency}角色数据库`, {
        path: database,
        contentType: "application/vnd.sqlite3",
      });
    } finally {
      releaseClick();
      releaseLoading();
      control.abort(new Error("测试清理"));
      await Promise.allSettled([...(probe ? [probe] : []), ...(capture ? [capture] : [])]);
      prototype.evaluateAll = evaluateAll;
      await Promise.allSettled([...workers, listPage].map((worker) => worker.close()));
      store?.close();
    }
  });
}

// 失败方式：页面未传并发数、详情页串号、暂停后仍落库、续采丢失排队项、跨页重复入库。
// 失败方式：网络变化终止整个队列、重试无上限、失败商品被误发布、续采丢失任务或重复完整商品。
for (const persistent of [false, true]) {
  test(`导航网络变化：${persistent ? "三次失败后其他商品继续，重开数据库续采" : "首次失败后恢复完整采集"}`, async ({
    context,
  }, testInfo) => {
    test.setTimeout(120000);
    const ids = ["a", "b", "c"];
    const listings: Listing[] = ids.map((id) => ({
      key: `367:${id}`,
      serverId: "367",
      eid: id,
      ordersn: `order-${id}`,
      url: `https://xyq.cbg.163.com/equip?s=367&eid=${id}`,
      sellingTime: null,
      createdTime: null,
      orderTime: null,
      name: `模拟角色${id}`,
      price: "222",
      attrs: {},
      summary: null,
    }));
    const database = testInfo.outputPath("capture.sqlite");
    await mkdir(path.dirname(database), { recursive: true });
    let store = new CrawlStore(database);
    const workers = await Promise.all([context.newPage(), context.newPage()]);
    const listPage = await context.newPage();
    const control = new AbortController();
    const navigations: Array<{ phase: string; address: string; injected: boolean }> = [];
    let phase = "initial";
    let failures = 0;
    const originals = workers.map((worker) => worker.goto.bind(worker));
    workers.forEach((worker, index) => {
      worker.goto = async (address, options) => {
        const inject =
          phase === "initial" && address === listings[0].url && (persistent || failures === 0);
        navigations.push({ phase, address, injected: inject });
        if (inject) {
          failures++;
          // Inject the exact Playwright error; do not change the machine's real network.
          throw new Error(`page.goto: net::ERR_NETWORK_CHANGED at ${address}`);
        }
        return originals[index](address, options);
      };
    });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== "https://xyq.cbg.163.com" || url.pathname !== "/equip")
        return route.abort();
      return route.fulfill({
        contentType: "text/html",
        body: detailDocument(url.searchParams.get("eid")!),
      });
    });
    const readRows = () =>
      listings.map((item) => {
        const record = store.detail(item.key) as SavedRoleRecord;
        return {
          key: item.key,
          status: record.status,
          error: record.error,
          eid: record.detail?.valuation?.source.eid,
          tabs: record.detail?.tabs.map((tab) => tab.name),
          equipmentComplete: record.detail?.equipmentCapture?.complete,
          petsComplete: record.detail?.petCapture?.complete,
        };
      });
    const run = async () => {
      const source = createCrawlSource({
        listPage,
        detailPage: workers[0],
        createDetailPage: async () => workers[1],
        signal: control.signal,
        onDetailProgress: () => {},
        log: () => {},
      });
      const updates: Array<Partial<CrawlStatus>> = [];
      await crawl(source, store, control.signal, (update) => updates.push(update), {
        backfillOnly: true,
        concurrency: 2,
      });
      expect(updates.at(-1)?.phase).toBe("completed");
      expect(updates[0]?.concurrency).toBe(2);
      return updates.at(-1);
    };
    try {
      listings.forEach((item) => store.observe(item));
      const initialStatus = await run();
      expect(failures).toBe(persistent ? 3 : 1);
      const initialNavigations = navigations.filter(({ phase }) => phase === "initial");
      expect(initialNavigations.filter(({ address }) => address === listings[0].url)).toHaveLength(
        persistent ? 3 : 2,
      );
      expect(initialNavigations.filter(({ address }) => address === "about:blank")).toHaveLength(
        failures,
      );
      store.close();
      store = new CrawlStore(database);
      const initialRows = readRows();
      expect(store.count()).toBe(persistent ? 2 : 3);
      expect(initialRows.slice(1).every((row) => row.status === "complete")).toBe(true);
      if (persistent) {
        expect(initialRows[0].status).toBe("failed");
        expect(initialRows[0].error).toContain("ERR_NETWORK_CHANGED");
        expect(store.retryItems().map(({ key }) => key)).toEqual([listings[0].key]);
        phase = "resume";
        await run();
        expect(
          navigations.filter(({ phase }) => phase === "resume").map(({ address }) => address),
        ).toEqual([listings[0].url]);
        store.close();
        store = new CrawlStore(database);
      }
      const finalRows = readRows();
      expect(store.count()).toBe(3);
      expect(store.retryItems()).toEqual([]);
      finalRows.forEach((row, index) => {
        expect(row.status).toBe("complete");
        expect(row.eid).toBe(ids[index]);
        expect(row.tabs).toEqual(MAIN_TABS);
        expect(row.equipmentComplete).toBe(true);
        expect(row.petsComplete).toBe(true);
      });
      await writeFile(
        testInfo.outputPath("verify.sql"),
        "SELECT key,status,error FROM listings ORDER BY key;\nSELECT COUNT(*) AS complete FROM listings WHERE status='complete';\n",
      );
      await writeFile(
        testInfo.outputPath("evidence.json"),
        JSON.stringify(
          {
            fixture: true,
            fault: "Injected page.goto ERR_NETWORK_CHANGED; not a real network switch",
            persistent,
            initialStatus,
            initialRows,
            finalRows,
            navigations,
            repeat:
              "vp exec playwright test tests/e2e/crawl-concurrency.pw.ts --grep 导航网络变化 --workers=1",
            verify: "sqlite3 capture.sqlite < verify.sql",
          },
          null,
          2,
        ),
      );
      await testInfo.attach("网络恢复采集回执", {
        path: testInfo.outputPath("evidence.json"),
        contentType: "application/json",
      });
    } finally {
      control.abort(new Error("测试清理"));
      workers.forEach((worker, index) => {
        worker.goto = originals[index];
      });
      await Promise.all([...workers, listPage].map((page) => page.close()));
      store.close();
    }
  });
}

test("配置并发抓取→暂停→改为2并发续采→翻页去重入库", async ({ page, context }, testInfo) => {
  test.setTimeout(240000);
  const database = testInfo.outputPath("capture.sqlite");
  await mkdir(path.dirname(database), { recursive: true });
  const store = new CrawlStore(database);
  let status: CrawlStatus = {
    running: false,
    phase: "idle",
    message: "模拟官网列表已就绪",
    page: 0,
    totalPages: 0,
    saved: 0,
    skipped: 0,
    totalSaved: 0,
    database,
  };
  let control: AbortController | undefined;
  let completion: Promise<void> | undefined;
  let active = 0;
  const runs: Array<{ concurrency: number; maximum: number; pages: number }> = [];
  const overview = () => ({
    ...status,
    totalSaved: store.count(),
    checkpoint: store.checkpoint(),
    recent: store.recent(),
  });
  const listPage = await context.newPage();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === "https://xyq.cbg.163.com") {
      const body =
        url.pathname === "/list"
          ? listDocument
          : url.pathname === "/mock-list"
            ? listHtml(Number(url.searchParams.get("page")))
            : detailDocument(url.searchParams.get("eid")!);
      return route.fulfill({ contentType: "text/html", body });
    }
    if (url.origin !== "http://cbg-ui.test") return route.abort();
    if (url.pathname === "/api/runtime/settings")
      return route.fulfill({ json: { saveScreenshots: false } });
    if (url.pathname === "/api/browser/settings")
      return route.fulfill({ json: { mode: "daily", connected: true, busy: false } });
    if (url.pathname.startsWith("/api/")) {
      let body: unknown;
      switch (url.pathname) {
        case "/api/browser/status":
          body = browserStatus;
          break;
        case "/api/crawl/head-refresh":
          body = { intervalSeconds: 60, random: false };
          break;
        case "/api/crawl/settings":
          body = { analyzeEquipment: false };
          break;
        case "/api/crawl/status":
          body = overview();
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
          const options = route.request().postDataJSON();
          validateCrawlOptions(options);
          control = new AbortController();
          const signal = control.signal;
          const run = { concurrency: options.concurrency, maximum: 0, pages: 0 };
          runs.push(run);
          const workers: Page[] = [];
          const createDetailPage = async () => {
            const worker = await context.newPage();
            workers.push(worker);
            run.pages++;
            return worker;
          };
          const source = createCrawlSource({
            listPage,
            detailPage: await createDetailPage(),
            createDetailPage,
            signal,
            onDetailProgress: (message) => {
              status = { ...status, detailProgress: message };
            },
            log: () => {},
          });
          const read = source.detail;
          source.detail = async (item) => {
            active++;
            run.maximum = Math.max(run.maximum, active);
            try {
              return await read(item);
            } finally {
              active--;
            }
          };
          status = { ...status, running: true, phase: "locating", saved: 0, skipped: 0 };
          completion = crawl(
            source,
            store,
            signal,
            (update) => {
              status = { ...status, ...update };
            },
            { ...options, watch: true },
          )
            .catch((error: unknown) => {
              status = {
                ...status,
                running: false,
                phase: signal.aborted ? "paused" : "error",
                message: String(error),
              };
            })
            .finally(async () => {
              await Promise.allSettled(workers.map((worker) => worker.close()));
            });
          body = overview();
          break;
        }
        case "/api/crawl/stop":
          control!.abort(new Error("用户暂停采集"));
          await completion;
          body = overview();
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
    await listPage.goto("https://xyq.cbg.163.com/list");
    await page.goto("http://cbg-ui.test/");
    const count = page.getByRole("spinbutton", { name: "并发抓取数" });
    await expect(count).toHaveValue("6");
    await expect(count).toHaveAttribute("min", "2");
    await expect(count).toHaveAttribute("step", "2");
    const start = page.getByRole("button", { name: /开始采集详情|继续采集 \/ 检查新增/ });
    await expect(start).toBeEnabled();
    await count.fill("4");
    await start.click();
    // 首次准备列表及逐项悬停带有真实节流，等待条件成立后再检查实际在途数。
    await expect.poll(() => active, { timeout: 30000 }).toBe(4);
    await expect(page.getByText(/仅采上架10分钟以内的商品/)).toBeVisible();
    await expect(page.getByLabel("采集双队列状态")).toContainText("新号优先 · 当前在途 4 个");
    expect(status.captureStrategy).toBe("new-first");
    expect(status.newLimit).toBeUndefined();
    expect(status.oldLimit).toBeUndefined();
    await expect(count).toBeDisabled();
    await page.getByRole("button", { name: "暂停采集", exact: true }).click();
    await expect(count).toBeEnabled();
    expect(store.count()).toBe(0);
    expect(store.retryItems()).toHaveLength(4);
    expect(active).toBe(0);
    for (const invalid of ["0", "1", "3", "5"]) {
      await count.fill(invalid);
      await start.click();
      await expect(page.getByRole("alert")).toHaveText("并发数必须是正偶数（2、4、6…）");
    }
    expect(runs).toHaveLength(1);
    await count.fill("2");
    await start.click();
    await expect.poll(() => store.count(), { timeout: 180000 }).toBe(5);
    await expect(page.getByLabel("采集双队列状态")).toContainText("新号优先");
    await expect(page.getByText(/首页下次检查/)).toBeVisible();
    await page.getByRole("button", { name: "暂停采集", exact: true }).click();
    await completion;
    expect(status.phase).toBe("paused");
    expect(store.count()).toBe(5);
    expect(runs.map((run) => run.maximum)).toEqual([4, 2]);
    expect(runs.map((run) => run.pages)).toEqual([4, 2]);
    const records = ["a", "b", "c", "d", "e"].map((id) => {
      const record = store.detail(`367:${id}`) as SavedRoleRecord;
      expect(record.status).toBe("complete");
      expect(record.detail!.valuation!.source.eid).toBe(id);
      expect(record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items![0].name).toBe(
        `武器${id}`,
      );
      return { id, status: record.status, eid: record.detail!.valuation!.source.eid };
    });
    await page
      .getByRole("region", { name: "详情采集" })
      .screenshot({ path: testInfo.outputPath("completed.png") });
    await writeFile(
      testInfo.outputPath("evidence.json"),
      JSON.stringify(
        {
          fixture: true,
          repeat:
            "vp run build && vp exec playwright test tests/e2e/crawl-concurrency.pw.ts --grep '配置并发抓取' --workers=1",
          runs,
          records,
          checkpoint: store.checkpoint(),
          pending: store.retryItems().length,
        },
        null,
        2,
      ),
    );
    await testInfo.attach("并发采集验证结果", {
      path: testInfo.outputPath("evidence.json"),
      contentType: "application/json",
    });
  } finally {
    control?.abort(new Error("测试清理"));
    await completion;
    await listPage.close();
    store.close();
  }
});
