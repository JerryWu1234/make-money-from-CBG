import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { crawl, validateCrawlOptions } from "../../server/crawler/runner";
import { createCrawlSource } from "../../server/crawler/source";
import { CrawlStore } from "../../server/crawler/store";
import { MAIN_TABS } from "../../server/crawler/detail";
import type { CrawlStatus, SavedRoleRecord } from "../../server/crawler/types";
import { browserStatus } from "../fixtures/saved-role";

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
});
const listHtml = (number: number) =>
  `<table id="soldList"><tr id="order_menu"><th><a data_attr_name="expire_time">剩余时间</a></th></tr>${pages[number].map((id) => `<tr><td><a class="soldImg" href="https://xyq.cbg.163.com/equip?s=367&eid=${id}"><img width="40" height="40" data_serverid="367" data_ordersn="order-${id}" data_equip_name="角色${id}" data_price="222" data_selling_time="2026-09-07 12:00:00"></a></td></tr>`).join("")}</table><div id="pager_bar">第${number}页, 共2页 <a href="javascript:goto(${number === 1 ? 2 : 1})">翻页</a></div>`;
const listDocument = `<meta charset="utf-8"><script>var IsLogin=1,LoginInfo={login:1},QueryArgs={server_type:'3',page:1,order_by:'expire_time DESC'},QueryResult=${JSON.stringify(pages[1].map(raw))};var records=${JSON.stringify(Object.fromEntries(Object.entries(pages).map(([n, ids]) => [n, ids.map(raw)])))};function goto(n){fetch('/mock-list?page='+n).then(r=>r.text()).then(html=>{document.getElementById('query_result').innerHTML=html;QueryArgs.page=n;QueryResult=records[n]})}</script><div id="query_result">${listHtml(1)}</div>`;
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

// 失败方式：页面未传并发数、详情页串号、暂停后仍落库、续采丢失排队项、跨页重复入库。
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
    await expect(count).toHaveValue("10");
    await expect(count).toHaveAttribute("min", "2");
    await expect(count).toHaveAttribute("step", "2");
    const start = page.getByRole("button", { name: /开始采集详情|继续采集 \/ 检查新增/ });
    await expect(start).toBeEnabled();
    await count.fill("4");
    await start.click();
    // 首次准备列表及逐项悬停带有真实节流，等待条件成立后再检查实际在途数。
    await expect.poll(() => active, { timeout: 30000 }).toBe(4);
    await expect(page.getByText(/定时检查首页新增/)).toBeVisible();
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
            "vp run build && vp exec playwright test tests/e2e/crawl-concurrency.pw.ts --workers=1",
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
