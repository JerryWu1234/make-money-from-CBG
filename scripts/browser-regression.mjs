import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { chromium } from "playwright-core";

async function moduleUrl(file, replacements = {}) {
  let source = ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const [name, url] of Object.entries(replacements))
    source = source.replaceAll(`from "${name}"`, `from "${url}"`);
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}
const stateUrl = await moduleUrl("server/page-state.ts");
const { readPageSnapshot, buildPageState, disconnectedState } = await import(stateUrl);
const { runFixedWorkflow, readRoleList } = await import(
  await moduleUrl("server/workflow.ts", {
    "./config": await moduleUrl("server/config.ts"),
    "./page-state": stateUrl,
  })
);
const { createBackgroundPage } = await import(
  await moduleUrl("server/session.ts", {
    "./chrome": await moduleUrl("server/chrome.ts"),
    "./work-transport": await moduleUrl("server/work-transport.ts"),
    "./diagnostics": await moduleUrl("server/diagnostics.ts"),
    "./viewport": await moduleUrl("server/viewport.ts"),
    "./config": await moduleUrl("server/config.ts"),
    "playwright-core": import.meta.resolve("playwright-core"),
  })
);
const directory = await mkdtemp(path.join(os.tmpdir(), "cbg-flow-regression-"));
let persistent;
let browser;
try {
  persistent = await chromium.launchPersistentContext(directory, {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ["--remote-debugging-port=0"],
  });
  const [port, endpoint] = (await readFile(path.join(directory, "DevToolsActivePort"), "utf8"))
    .trim()
    .split("\n");
  browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, {
    noDefaults: true,
  });
  const context = browser.contexts()[0];
  context.setDefaultTimeout(10000);
  const html = (body, loggedIn = false) => `<meta charset="utf-8"><title>隔离测试藏宝阁</title>
    <script>var IsLogin=${loggedIn ? 1 : 0};var LoginInfo=${loggedIn ? JSON.stringify({ login: 1, nickname: "测试角色", server_name: "测试服务器", roleid: "123" }) : "{}"};</script>${body}`;
  const login = html(`<div id="loginContainer">
    <div id="qrcode"><canvas width="160" height="160"></canvas></div>
    <div class="popupDialog" style="display:none">其他服务器有角色 <button onclick="this.parentElement.style.display='none'; document.querySelector('#roles').style.display='block'">我知道了</button></div>
    <div id="roles" style="display:none"><ul id="role_list_panel"><li id="role_el_123"><img alt="角色" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" onclick="window.roleSelected=true">测试角色</li></ul>
      <a id="login_btn" onclick="if(!window.roleSelected) throw Error('未选角色'); window.submits=(window.submits||0)+1; sessionStorage.setItem('submits',window.submits); location.href='/cgi-bin/query.py'">进入服务器</a></div>
    </div><script>addEventListener('test-scan',()=>{document.querySelector('#qrcode').style.display='none';document.querySelector('.popupDialog').style.display='block'})</script>`);
  const authenticated = (body) =>
    html(
      `<a href="show_login.py">通用登录入口</a><a href="logout.py?act=logout">退出</a>${body}`,
      true,
    );
  const equipment =
    authenticated(`<ul id="server_type_panel"><li>3年以上服</li><li class="on">1到3年服</li><li>1年内服</li></ul>
    <script>document.querySelectorAll('#server_type_panel li').forEach(li=>li.onclick=()=>li.classList.toggle('on'))</script>
    <a id="sub_role" href="/cgi-bin/xyq_overall_search.py?act=show_search_role_form" onclick="if(document.querySelectorAll('#server_type_panel li.on').length!==1||document.querySelector('#server_type_panel li.on').innerText!=='3年以上服'){event.preventDefault();throw Error('开服时间未选择')}" target="_blank">角色搜索</a>`);
  const roleForm =
    authenticated(`<script>var QueryArgs={serverid:'367'};</script><div id="advance_search_box"><button class="js_form_title" data-title="转服搜索" onclick="document.querySelector('#server_type').style.display='block'">转服搜索</button>
    <ul id="server_type" style="display:none"><li data_value="1" class="on"><span>1年以内服</span></li><li data_value="2"><span>1到3年服</span></li><li data_value="3"><span>3年以上服</span></li></ul></div>
    <form name="query_form" method="post" target="_blank" action="/cgi-bin/xyq_overall_search.py"><input name="act" value="show_role_search_result"><input name="args" id="query_args"></form>
    <a id="btn_do_query" onclick="document.querySelector('#query_args').value=JSON.stringify({serverid:'367',server_type:[...document.querySelectorAll('#server_type li.on')].map(li=>li.getAttribute('data_value')).join(',')});document.query_form.submit()">全服搜索</a>
    <script>document.querySelectorAll('#server_type li').forEach(li=>li.onclick=()=>li.classList.toggle('on'))</script>`);
  const roleResults =
    authenticated(`<script>var QueryArgs={server_type:'3'};var CaptchaCheck={need_captcha:false};</script>
    <div id="query_result">加载中</div><script>setTimeout(()=>{document.querySelector('#query_result').innerHTML='<table id="soldList"><tr><th>角色</th><th>等级</th><th>服务器</th><th>价格</th></tr><tr><td>测试剑侠客</td><td>175</td><td>测试服务器</td><td>¥ 10,000</td></tr></table>'},500)</script>`);
  let apiState = { ...disconnectedState("点击开始查询"), workflowStep: "idle", running: false };
  let apiFailure = false;
  /** @type {Promise<import("../server/types").OpenCbgResult> | undefined} */
  let workflow;
  let workPage;
  let startCount = 0;
  const stages = [];
  let searchArgs;
  const requests = [];
  // 所有网络请求只使用本地固定数据，绝不访问真实网站或日常浏览器。
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === "http://127.0.0.1:4399") {
      if (url.pathname.startsWith("/api/crawl/")) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            running: false,
            phase: "idle",
            message: "采集待开始",
            page: 0,
            totalPages: 0,
            saved: 0,
            skipped: 0,
            totalSaved: 0,
            database: "test.sqlite",
            recent: [],
          }),
        });
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (url.pathname.endsWith("/open")) {
          startCount++;
          apiState = { ...apiState, running: true, workflowStep: "connecting", message: "连接中" };
          workflow = runFixedWorkflow(workPage, (update) => {
            apiState = { ...apiState, ...update };
            stages.push(update.workflowStep);
          }).then((result) => {
            apiState = result;
            return result;
          });
          // 保留异步失败，供下面 await workflow 报告，不产生未处理 rejection。
          workflow.catch(() => {});
        }
        await route.fulfill({
          status: apiFailure ? 503 : 200,
          contentType: "application/json",
          body: JSON.stringify(apiFailure ? { error: "测试本地服务暂时断开" } : apiState),
        });
      } else {
        const file = path.join("dist", url.pathname === "/" ? "index.html" : url.pathname);
        await route.fulfill({
          contentType: file.endsWith(".js")
            ? "application/javascript"
            : file.endsWith(".css")
              ? "text/css"
              : "text/html",
          body: await readFile(file),
        });
      }
      return;
    }
    if (url.origin !== "https://xyq.cbg.163.com") {
      await route.abort();
      return;
    }
    requests.push(url.pathname + url.search);
    let body;
    if (url.pathname === "/")
      body = html(
        '<a id="server_pos_1_a" href="/cgi-bin/show_login.py" target="_blank">测试服务器</a>',
      );
    else if (url.pathname.endsWith("show_login.py")) body = login;
    else if (url.pathname.endsWith("query.py") && !url.pathname.endsWith("equipquery.py")) {
      // 模拟角色已提交、网站 6 秒后才登录成功的真实导航，不重复点击。
      await new Promise((resolve) => setTimeout(resolve, 6000));
      body = authenticated(
        '<a id="cross_server_buy" href="/cgi-bin/equipquery.py?act=show_overall_search_equip" target="_blank">跨服购买</a>',
      );
    } else if (url.pathname.endsWith("equipquery.py")) body = equipment;
    else if (url.searchParams.get("act") === "show_search_role_form") body = roleForm;
    else if (request.method() === "POST") {
      const data = new URLSearchParams(request.postData());
      assert.equal(data.get("act"), "show_role_search_result");
      searchArgs = JSON.parse(data.get("args"));
      body = roleResults;
    } else body = html("测试页面");
    await route.fulfill({ contentType: "text/html; charset=utf-8", body });
  });
  workPage = await createBackgroundPage(browser);
  await workPage.goto("https://xyq.cbg.163.com/test");
  await context.addCookies([
    { name: "is_user_login", value: "1", domain: "xyq.cbg.163.com", path: "/" },
    { name: "login_user_urs", value: "old@example.test", domain: "xyq.cbg.163.com", path: "/" },
    { name: "last_login_roleid", value: "123", domain: "xyq.cbg.163.com", path: "/" },
  ]);
  await workPage.setContent(
    html('<a href="?act=logout">残留退出入口</a><span>old@example.test</span>'),
  );
  await workPage.evaluate(() => {
    window.LoginInfo = { login: 1, nickname: "历史角色", urs: "old@example.test" };
  });
  let snapshot = buildPageState(await workPage.evaluate(readPageSnapshot));
  assert.equal(snapshot.isLoggedIn, false);
  assert.equal(snapshot.accountUrs, undefined);
  console.log(
    "PASS: explicit logged-out response overrides stale cookies, account text and logout entry",
  );
  await workPage.setContent(authenticated('<div id="qrcode">扫码</div>'));
  assert.equal(buildPageState(await workPage.evaluate(readPageSnapshot)).isLoggedIn, false);
  await workPage.setContent(
    authenticated(
      '<div style="display:none" id="loginContainer"><div id="qrcode"></div><li id="role_el_123">旧角色</li></div>',
    ),
  );
  assert.equal(buildPageState(await workPage.evaluate(readPageSnapshot)).isLoggedIn, true);
  console.log(
    "PASS: visible QR blocks completion; hidden widgets and generic login link do not reject a confirmed login",
  );

  const helper = context.pages().find((page) => page !== workPage);
  assert.ok(helper);
  await helper.goto("http://127.0.0.1:4399/");
  await helper.getByText("准备就绪", { exact: true }).waitFor();
  assert.equal(await helper.locator(".step-completed").count(), 0);
  for (const text of ["藏宝阁首页", "推荐商品", "全服角色", "全服装备"])
    assert.equal(await helper.getByText(text, { exact: true }).count(), 0);
  await helper.locator("#open-cbg-btn").click();
  await helper.getByAltText("藏宝阁登录二维码").waitFor();
  assert.equal(await helper.locator("#open-cbg-btn").isDisabled(), true);
  assert.equal(helper.url(), "http://127.0.0.1:4399/");
  assert.equal(context.pages().length, 2);
  assert.equal(await helper.getByText("已登录", { exact: true }).count(), 0);
  console.log(
    "PASS: start stays in helper, QR remains visible during asynchronous workflow, old shortcuts removed",
  );
  await workPage.evaluate(() => dispatchEvent(new Event("test-scan")));
  const result = await workflow;
  await helper.getByText("角色列表已就绪", { exact: true }).waitFor();
  assert.equal(startCount, 1);
  assert.equal(context.pages().length, 2);
  assert.equal(await workPage.evaluate(() => sessionStorage.getItem("submits")), "1");
  assert.deepEqual(searchArgs, { server_type: "3" });
  assert.equal(result.roleList.rows.length, 1);
  assert.equal(result.isLoggedIn, true);
  assert.ok(stages.indexOf("cross_server") < stages.indexOf("server_age"));
  assert.ok(stages.indexOf("server_age") < stages.indexOf("role_search"));
  assert.ok(stages.indexOf("role_search") < stages.indexOf("role_list"));
  assert.ok(requests.includes("/cgi-bin/equipquery.py?act=show_overall_search_equip"));
  assert.equal(await helper.locator("a[target='_blank']").count(), 0);
  console.log(
    "PASS: delayed login succeeds after one submission; fixed cross-server → 3+ years → role search → result flow uses one work page",
  );
  await helper.screenshot({ path: "/tmp/cbg-role-results-regression.png", fullPage: true });

  await workPage.evaluate(() => {
    window.QueryArgs.server_type = "1,3";
  });
  await assert.rejects(readRoleList(workPage), /未保留/);
  await workPage.evaluate(() => {
    window.QueryArgs.server_type = "3";
    document.querySelector("#query_result").innerHTML =
      '<table id="soldList"><tr><th>角色</th></tr></table>';
  });
  await assert.rejects(readRoleList(workPage), /尚未加载/);
  await workPage.evaluate(() => {
    window.QueryArgs.serverid = "367";
  });
  await assert.rejects(readRoleList(workPage), /仍限定单个服务器/);
  await workPage.evaluate(() => {
    delete window.QueryArgs.serverid;
    document.querySelector("#query_result").innerHTML = "没有符合条件的商品";
  });
  assert.equal((await readRoleList(workPage)).rows.length, 0);
  console.log(
    "PASS: incorrect filter and unfinished table are rejected; explicit empty result is supported",
  );

  apiFailure = true;
  await helper.getByText("测试本地服务暂时断开", { exact: true }).waitFor();
  assert.equal(await helper.getByText("测试角色", { exact: true }).count(), 0);
  assert.equal(await helper.locator(".role-table").count(), 0);
  apiFailure = false;
  await helper.getByText("角色列表已就绪", { exact: true }).waitFor();
  assert.equal(await helper.getByText("测试本地服务暂时断开", { exact: true }).count(), 0);
  apiState = {
    ...disconnectedState("筛选条件未生效"),
    workflowStep: "error",
    running: false,
    error: { code: "CBG_SERVER_AGE", message: "筛选条件未生效" },
  };
  await helper.getByText("错误编号：CBG_SERVER_AGE", { exact: true }).waitFor();
  assert.equal(await helper.locator("#open-cbg-btn").isDisabled(), false);
  assert.equal(await helper.locator(".role-table").count(), 0);
  console.log(
    "PASS: transport errors hide unconfirmed identity/results, successful polling recovers, step errors remain visible and retryable",
  );
} finally {
  await browser?.close();
  await persistent?.close();
  await rm(directory, { recursive: true, force: true });
}
