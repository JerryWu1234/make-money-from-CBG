import { DatabaseSync } from "node:sqlite";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vite-plus/test";
import { bindOfficialPage, markOfficialAuthenticated, officialGovernor } from "./official-access";
const selected = vi.hoisted(() => ({ page: null as Page | null }));
vi.mock("./session", () => ({ getCbgPage: () => selected.page }));
vi.mock("./browser-settings", () => ({
  browserSettings: () => ({ mode: "dedicated", showWorkPages: true }),
}));
let browser: Browser;
const resources: Array<{ page: Page; db: DatabaseSync }> = [];
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterEach(async () => {
  for (const { page, db } of resources.splice(0)) {
    await page.close();
    db.close();
  }
});
afterAll(async () => {
  await browser?.close();
});
async function fixture() {
  const db = new DatabaseSync(":memory:"),
    gate = officialGovernor(db);
  const state = gate.read();
  gate.updatePolicy(
    { ...state.policy, version: 2, minIntervalMs: 0, maxActionsPerWindow: 100 },
    state.revision,
  );
  const page = await browser.newPage();
  selected.page = page;
  resources.push({ page, db });
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<html><script>window.IsLogin=0</script><div id="loginContainer"><img class="qrcode"/>请扫码登录</div></html>',
    }),
  );
  return { page, gate };
}
it("首次扫码生命周期不会被当作登录吊销；认证后的登录丢失持久暂停", async () => {
  const { page, gate } = await fixture();
  await bindOfficialPage(page, { runId: "initial-login", sourceKind: "workflow" });
  await page.goto("https://xyq.cbg.163.com/");
  await page.waitForTimeout(350);
  expect(gate.read().state).toBe("ready");
  await page.evaluate(() => {
    (window as unknown as { IsLogin: number }).IsLogin = 1;
    document.querySelector("#loginContainer")?.remove();
  });
  markOfficialAuthenticated(page);
  await page.evaluate(() => {
    (window as unknown as { IsLogin: number }).IsLogin = 0;
    document.body.innerHTML = '<div id="loginContainer">请扫码登录</div>';
  });
  await expect((await import("./crawler/page")).assertAvailable(page)).rejects.toMatchObject({
    kind: "login",
  });
  await expect.poll(() => gate.read().state, { timeout: 5000 }).toBe("needs_action");
  expect(gate.read().reasons.some((reason) => reason.code === "login")).toBe(true);
});
it("打开已有登录风险的人工处理页不会重报同一风险或撤销其恢复许可", async () => {
  const { page, gate } = await fixture();
  const stopped = gate.reportRisk({ reason: "login" });
  const owner = gate.acquireOwner("recovery-test"),
    token = gate.beginRecovery(stopped.revision, owner);
  await bindOfficialPage(page, {
    runId: "recovery",
    sourceKind: "recovery",
    recoveryToken: token.token,
  });
  // The binding has its own owner, so make the token for that actual owner.
  const { officialPageContext } = await import("./official-access");
  const context = officialPageContext(page)!;
  const actualToken = gate.beginRecovery(stopped.revision, context);
  await bindOfficialPage(page, {
    runId: "recovery",
    sourceKind: "recovery",
    recoveryToken: actualToken.token,
  });
  await page.goto("https://xyq.cbg.163.com/");
  await page.waitForTimeout(350);
  expect(gate.read().revision).toBe(stopped.revision);
  expect(gate.read().stopEpoch).toBe(stopped.stopEpoch);
});

it("T02/T05 初始工作流DOM提交/选择逐次入账，暂停后不能绕过许可点击", async () => {
  const { page, gate } = await fixture();
  await bindOfficialPage(page, { runId: "workflow-budget", sourceKind: "workflow" });
  await page.goto("https://xyq.cbg.163.com/");
  await page.evaluate(() => {
    (window as unknown as { IsLogin: number }).IsLogin = 1;
    document.body.innerHTML =
      '<button id="query">查询</button><ul id="server_type_panel"><li>1年以内服</li><li>1到3年服</li><li>3年以上服</li></ul>';
    document.querySelector("#query")!.addEventListener("click", () => {
      document.body.dataset.clicks = String(Number(document.body.dataset.clicks || 0) + 1);
    });
    for (const choice of document.querySelectorAll("li"))
      choice.addEventListener("click", () => choice.classList.toggle("on"));
  });
  markOfficialAuthenticated(page);
  const { clickInWorkPage, selectServerAge } = await import("./workflow");
  await clickInWorkPage(page, "#query");
  await selectServerAge(page, "#server_type_panel");
  expect(
    gate.db
      .prepare("SELECT COUNT(*) AS n FROM access_permits WHERE authorized_at IS NOT NULL")
      .get()?.n,
  ).toBe(5);
  gate.reportRisk({ reason: "verification" });
  await expect(clickInWorkPage(page, "#query")).rejects.toThrow();
  expect(await page.evaluate(() => document.body.dataset.clicks)).toBe("1");
  expect(
    gate.db
      .prepare("SELECT COUNT(*) AS n FROM access_permits WHERE authorized_at IS NOT NULL")
      .get()?.n,
  ).toBe(5);
});

it("T04 恢复要求新页面的正向登录证据，空白同源页不能清除暂停", async () => {
  const { page, gate } = await fixture();
  await bindOfficialPage(page, { runId: "start", sourceKind: "workflow" });
  await page.goto("https://xyq.cbg.163.com/");
  const stopped = gate.reportRisk({ reason: "login" });
  await page.unroute("**/*");
  let body = "<html><title>未知错误页面</title><body>请求未完成</body></html>";
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html", body }));
  const { recoverOfficialAccess } = await import("./official-access");
  await expect(recoverOfficialAccess(stopped.revision, ["login"])).rejects.toThrow("正向登录证据");
  expect(gate.read().state).toBe("needs_action");
  body =
    '<html><script>window.IsLogin=1;window.LoginInfo={login:1}</script><body><a href="/cgi-bin/equipquery.py?act=logout">退出登录</a>已登录的官网首页</body></html>';
  await expect(recoverOfficialAccess(stopped.revision, ["login"])).resolves.toMatchObject({
    state: "ready",
    reasons: [],
  });
});

it("T08/T11 角色初始查询和翻页的接受身份与实际派发/请求相同", async () => {
  const { page, gate } = await fixture();
  await page.unroute("**/*");
  const stamp = new Date().toISOString();
  const anchor = (n: number) =>
    `<a class="soldImg" style="display:block;width:180px;height:50px" href="https://xyq.cbg.163.com/equip?s=1&eid=role-${n}" data_ordersn="order-${n}" data_selling_time="${stamp}" data_price="100">角色${n}</a>`;
  await page.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/cgi-bin/recommend.py")
      return route.fulfill({ json: { status: 0, msg: [{ game_ordersn: "order-2" }] } });
    return route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<html><meta charset="utf-8"><script>window.IsLogin=1;window.QueryArgs={server_type:'1,2,3',page:1,order_by:'selling_time DESC'};window.QueryResult=[{game_ordersn:'order-1'}];window.goto=n=>fetch('/cgi-bin/recommend.py?server_type=1%2C2%2C3&order_by=selling_time%20DESC&page='+n).then(r=>r.json()).then(r=>{QueryArgs.page=n;QueryResult=r.msg;document.querySelector('#soldList').innerHTML=${JSON.stringify(anchor(2))};document.querySelector('#pager_bar').innerHTML='第2页 共2页';});</script><body><div id="query_result"><div id="soldList">${anchor(1)}</div><div id="pager_bar">第1页 共2页 <a href="javascript:goto(2)">下一页</a></div></div></body></html>`,
    });
  });
  await bindOfficialPage(page, { runId: "query-run", sourceKind: "workflow" });
  const { beginRoleListQuery, readListings, gotoPage } = await import("./crawler/page");
  const { queryPageContext } = await import("./query-health/runtime");
  beginRoleListQuery(page, 1, { initial: true, sort: "" });
  await page.goto("https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py");
  await readListings(page);
  const first = queryPageContext(page)!.queryId;
  expect(
    gate.db
      .prepare(
        "SELECT COUNT(*) AS n FROM access_permits WHERE json_extract(context_json,'$.queryId')=?",
      )
      .get(first)?.n,
  ).toBe(1);
  expect((await gotoPage(page, 2, new AbortController().signal)).page).toBe(2);
  const second = queryPageContext(page)!.queryId;
  await expect
    .poll(
      () =>
        gate.db
          .prepare(
            "SELECT COUNT(*) AS n FROM access_requests WHERE json_extract(context_json,'$.queryId')=?",
          )
          .get(second)?.n,
    )
    .toBe(1);
  expect(
    gate.db.prepare("SELECT accepted FROM access_queries WHERE query_id=?").get(second)?.accepted,
  ).toBe(1);
}, 20000);
