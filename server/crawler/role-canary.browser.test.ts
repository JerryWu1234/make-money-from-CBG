import { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { bindOfficialPage, officialGovernor } from "../official-access";
import { beginPageQuery, QueryHealthError, queryPageContext } from "../query-health/runtime";
import { QueryHealthStore } from "../query-health/store";
import { readListings } from "./page";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});

const fixture = `<!doctype html><meta charset="utf-8"><script>window.IsLogin=1;</script>
<form id="searchForm">
 <input name="price_min"><input name="price_max"><input name="level_min"><input name="level_max">
 <button type="submit">搜索角色</button>
</form>
<div id="order_menu"><a href="#" data_attr_name="expire_time">到期时间</a><a href="#" data_attr_name="selling_time">上架时间</a></div>
<div id="query_result"><div id="soldList"></div><div id="pager_bar"></div></div>
<script>
window.QueryArgs={server_type:'1,2,3',page:1,order_by:'expire_time DESC'};
window.QueryResult=[];window.fixtureEmpty=false;window.fixtureCalls=[];window.fixtureCommits=0;
function render(){
 const empty=fixtureEmpty&&!!QueryArgs.price_min;
 QueryResult=empty?[]:[{game_ordersn:'fixture-order'}];
 document.querySelector('#soldList').innerHTML=empty?'<p>没有符合条件</p>':'<a class="soldImg" style="display:block;width:200px;height:50px" href="https://xyq.cbg.163.com/equip?s=1&eid=fixture-role" data_ordersn="fixture-order" data_price="100">角色</a>';
 document.querySelector('#pager_bar').innerHTML='第 '+QueryArgs.page+' 页 共 2 页 <a href="javascript:goto(1)">1</a> <a href="javascript:goto(2)">2</a>';
 fixtureCommits++;
}
window.goto=function(n){QueryArgs.page=n;fixtureCalls.push(['page',n]);setTimeout(render,35)};
document.querySelector('#searchForm').onsubmit=e=>{
 e.preventDefault();QueryArgs={server_type:'1,2,3',page:1,order_by:'selling_time DESC'};
 for(const input of document.querySelectorAll('form input'))if(input.value)QueryArgs[input.name]=input.value;
 fixtureCalls.push(['query',QueryArgs.price_min||'',e.isTrusted]);setTimeout(render,35);
};
for(const node of document.querySelectorAll('#order_menu a'))node.onclick=e=>{
 e.preventDefault();QueryArgs.order_by=node.getAttribute('data_attr_name')+' DESC';QueryArgs.page=1;
 fixtureCalls.push(['sort',QueryArgs.order_by,e.isTrusted]);setTimeout(render,35);
};render();
</script>`;

async function selectNarrow(page: Page) {
  const change = async (action: () => Promise<void>) => {
    const before = await page.evaluate(() => Number(Reflect.get(window, "fixtureCommits")));
    await action();
    await page.waitForFunction(
      (previous) => Number(Reflect.get(window, "fixtureCommits")) > previous,
      before,
    );
  };
  await page.locator('input[name="price_min"]').fill("100");
  await change(() => page.locator('button[type="submit"]').click());
  await change(() => page.locator('[data_attr_name="expire_time"]').click());
  await change(() => page.locator('#pager_bar a[href="javascript:goto(2)"]').click());
}

it("T09/T10 real form target empty → broader Canary data → exact query/order/page restored, all progress frozen", async () => {
  const db = new DatabaseSync(":memory:");
  const gate = officialGovernor(db);
  const state = gate.read();
  gate.updatePolicy(
    {
      ...state.policy,
      version: 2,
      minIntervalMs: 0,
      maxActionsPerWindow: 100000,
      canaryEnabled: true,
      diagnosticMaxActions: 256,
    },
    state.revision,
  );
  const page = await browser.newPage();
  try {
    await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: fixture }));
    await bindOfficialPage(page, { runId: "role-canary", sourceKind: "crawl-list" });
    await page.goto("http://role-canary.fixture/list");
    // Baselines are accepted from real fixture pages before the anomaly.
    expect((await readListings(page)).items).toHaveLength(1);
    await selectNarrow(page);
    expect((await readListings(page)).items).toHaveLength(1);
    await page.evaluate(() => {
      Reflect.set(window, "fixtureEmpty", true);
    });
    const narrow = {
      category: "role",
      server: "all",
      serverAge: "1,2,3",
      conditions: { server_type: "1,2,3", price_min: "100" },
      page: 2,
      sort: "expire_time DESC",
    };
    beginPageQuery(page, narrow);
    await page.locator('#pager_bar a[href="javascript:goto(2)"]').click();
    await page.waitForFunction(() =>
      document.querySelector("#soldList")?.textContent?.includes("没有符合条件"),
    );
    await expect(readListings(page)).rejects.toBeInstanceOf(QueryHealthError);

    const actual = await page.evaluate(() => ({
      args: Reflect.get(window, "QueryArgs"),
      calls: Reflect.get(window, "fixtureCalls"),
      input: (document.querySelector('input[name="price_min"]') as HTMLInputElement).value,
    }));
    expect(actual.args).toMatchObject({
      server_type: "1,2,3",
      price_min: "100",
      order_by: "expire_time DESC",
      page: 2,
    });
    expect(actual.input).toBe("100");
    expect(actual.calls.filter((call: unknown[]) => call[0] === "query")).toEqual([
      ["query", "100", true],
      ["query", "100", true],
      ["query", "", true],
      ["query", "100", true],
    ]);
    const diagnostics = db
      .prepare(
        "SELECT purpose,result,accepted FROM query_health_results WHERE purpose!='ordinary' ORDER BY received_at",
      )
      .all();
    expect(diagnostics).toEqual([
      { purpose: "target_review", result: "empty", accepted: 0 },
      { purpose: "canary", result: "data", accepted: 0 },
      { purpose: "restoration", result: "empty", accepted: 0 },
    ]);
    const event = db
      .prepare(
        "SELECT event_id,target_claimed,canary_claimed,restoration_claimed,cursor_json,original_snapshot_json FROM query_diagnostic_events",
      )
      .get()!;
    expect(event).toMatchObject({
      target_claimed: 1,
      canary_claimed: 1,
      restoration_claimed: 1,
      cursor_json: '{"page":2,"order":"expire_time DESC"}',
    });
    expect(JSON.parse(String(event.original_snapshot_json))).toMatchObject({
      revision: expect.stringContaining(":1:"),
      conditions: narrow.conditions,
      fields: { price_min: "100" },
      page: 2,
      sort: narrow.sort,
    });
    const reopened = new QueryHealthStore(db);
    for (const step of ["target", "canary", "restoration"] as const)
      expect(reopened.claim(String(event.event_id), step)).toBe(false);
    expect(gate.read().state).toBe("needs_action");
    expect(() =>
      gate.withProgress(queryPageContext(page)!, () => {
        throw new Error("must never commit");
      }),
    ).toThrow();
    const evidence = db
      .prepare("SELECT evidence_json FROM access_evidence WHERE reason='query_manual_verification'")
      .get();
    expect(JSON.parse(String(evidence?.evidence_json)).restoration).toBe(
      "original_query_verified_task_paused",
    );
    expect(
      db.prepare("SELECT used_actions FROM access_diagnostic_plans").get()?.used_actions,
    ).toBeGreaterThan(0);
  } finally {
    await page.close();
    db.close();
  }
}, 30000);
