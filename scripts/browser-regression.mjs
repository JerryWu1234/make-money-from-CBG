import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { chromium } from "playwright-core";
import {
  authenticated,
  equipment,
  fallback,
  home,
  html,
  idleCrawlStatus,
  login,
  roleForm,
  roleResults,
} from "../tests/fixtures/browser-site.mjs";

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
  let apiState = { ...disconnectedState("点击开始查询"), workflowStep: "idle", running: false };
  let apiFailure = false;
  /** @type {Promise<import("../server/types").OpenCbgResult> | undefined} */
  let workflow;
  let workPage;
  let startCount = 0;
  const stages = [];
  let searchArgs;
  let sessionReady = false;
  const requests = [];
  // 所有网络请求只使用本地固定数据，绝不访问真实网站或日常浏览器。
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === "http://127.0.0.1:4399") {
      if (url.pathname.startsWith("/api/crawl/")) {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify(idleCrawlStatus),
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
    if (url.pathname === "/") body = home;
    else if (url.pathname.endsWith("show_login.py"))
      body = login.replace(
        "location.href='/cgi-bin/query.py'",
        "location.href='/cgi-bin/equip_detail.py'",
      );
    else if (url.pathname.endsWith("equip_detail.py")) {
      // 模拟角色已提交、网站 6 秒后才登录成功的真实导航，不重复点击。
      await new Promise((resolve) => setTimeout(resolve, 6000));
      sessionReady = true;
      // 登录回跳可能落在商品详情页，该页没有 #cross_server_buy 入口。
      body = authenticated("<main>登录回跳的商品详情页，没有跨服购买按钮</main>");
    } else if (url.pathname.endsWith("equipquery.py"))
      body = sessionReady ? equipment : html("尚未登录", false);
    else if (url.searchParams.get("act") === "show_search_role_form") body = roleForm;
    else if (request.method() === "POST") {
      const data = new URLSearchParams(request.postData());
      assert.equal(data.get("act"), "show_role_search_result");
      searchArgs = JSON.parse(data.get("args"));
      body = roleResults;
    } else body = fallback;
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
  assert.ok(requests.includes("/cgi-bin/equip_detail.py"));
  assert.deepEqual(searchArgs, { server_type: "3" });
  assert.equal(result.roleList.rows.length, 1);
  assert.equal(result.isLoggedIn, true);
  assert.ok(stages.indexOf("cross_server") < stages.indexOf("server_age"));
  assert.ok(stages.indexOf("server_age") < stages.indexOf("role_search"));
  assert.ok(stages.indexOf("role_search") < stages.indexOf("role_list"));
  assert.ok(requests.includes("/cgi-bin/equipquery.py?act=show_overall_search_equip"));
  assert.equal(await helper.locator("a[target='_blank']").count(), 0);
  console.log(
    "PASS: login redirects to a detail page without a cross-server link; one submission reaches cross-server → 3+ years → role search → results in one work page",
  );
  await helper.screenshot({ path: "/tmp/cbg-role-results-regression.png", fullPage: true });

  // Failure cases: stale cookies bypass authentication, or a valid server session asks for QR again.
  const loginRequestsBefore = requests.filter(
    (url) => url === "/" || url.includes("show_login.py"),
  ).length;
  const reusePage = await context.newPage();
  const reuseStates = [];
  const reused = await runFixedWorkflow(reusePage, (state) => reuseStates.push(state));
  assert.equal(reused.isLoggedIn, true);
  assert.equal(reused.roleList.rows.length, 1);
  assert.ok(!reuseStates.some((state) => state.qrCodeUrl || state.step === "waiting_qr"));
  const loginRequestsAfter = requests.filter(
    (url) => url === "/" || url.includes("show_login.py"),
  ).length;
  assert.equal(loginRequestsAfter, loginRequestsBefore);
  await reusePage.screenshot({ path: "/tmp/cbg-login-reuse-regression.png", fullPage: true });
  await writeFile(
    "/tmp/cbg-login-reuse-regression.json",
    JSON.stringify(
      {
        scenario: "隔离模拟网站；首次未登录须扫码，重建工作页后复用有效服务端登录",
        firstLoginConfirmed: result.isLoggedIn,
        reusedLoginConfirmed: reused.isLoggedIn,
        roleRows: reused.roleList.rows.length,
        loginRequestsBefore,
        loginRequestsAfter,
        repeatedQR: reuseStates.some((state) => state.qrCodeUrl || state.step === "waiting_qr"),
        repeatCommand: "node scripts/browser-regression.mjs",
      },
      null,
      2,
    ),
  );
  await reusePage.close();
  console.log(
    "PASS: a fresh work page reuses the verified server login without repeating QR or entering the default server",
  );

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
  await helper
    .locator(".workflow-alert")
    .filter({ hasText: /^测试本地服务暂时断开$/ })
    .waitFor();
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
