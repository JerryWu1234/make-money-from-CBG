import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { ExtensionNativeRuntime } from "./extension-native";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});

it("waits for actual MAIN arguments after ISOLATED publishes a same-action DOM commit", async () => {
  const page = await browser.newPage();
  const db = new DatabaseSync(":memory:");
  const snapshots: any[] = [],
    writes: any[] = [];
  let bound = false,
    sequence = 0,
    ingress = Promise.resolve();
  const runtime = new ExtensionNativeRuntime({
    db,
    socketPath: "/private/tmp/not-started-role-query-browser.sock",
    stopEpoch: () => 0,
    onRisk: () => {},
    runAction: async (_plan, dispatch) => dispatch(),
  });
  const internals = runtime as any;
  const forward = (message: any) => {
    const envelope = {
      version: 1,
      connectionEpoch: "browser-query-connection",
      messageId: `message-${++sequence}`,
      sequence,
      ...message,
    };
    ingress = ingress.then(() => internals.receive(envelope));
    return ingress;
  };
  const command = (kind: string, plan?: unknown) =>
    page.evaluate(
      ({ kind, plan }) =>
        new Promise<any>((resolve) => {
          (window as any).__listener({ kind, plan }, { id: "extension" }, resolve);
        }),
      { kind, plan },
    );
  const nativeResult = (message: any, result: Record<string, unknown>) =>
    internals.receive({
      kind: "input-result",
      actionId: message.actionId || message.plan?.actionId,
      ...result,
    });
  internals.socket = {
    destroyed: false,
    destroy: () => {},
    write: (line: string) => {
      const message = JSON.parse(line);
      writes.push(message);
      void (async () => {
        if (message.kind === "activity")
          await nativeResult(message, {
            ok: true,
            active: message.command !== "end",
            activityId: message.activity.activityId,
          });
        else if (message.kind === "resume") await nativeResult(message, { ok: true });
        else if (message.command === "locate")
          await nativeResult(message, await command("locate", message.plan));
        else if (message.command === "execute") {
          const prepared = await command("prepare", message.plan);
          if (!prepared.ok)
            return nativeResult(message, { ok: false, posted: false, error: prepared.error });
          await page.locator("#btn_search").click(); // Offline site action, no native OS input.
          await nativeResult(message, { ok: true, posted: true });
        }
      })().catch((error) =>
        nativeResult(message, { ok: false, posted: false, error: error.message }),
      );
    },
  };
  let query: Promise<unknown> | undefined;
  try {
    await page.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `
      <a href="/cgi-bin/login.py?act=logout">退出</a>
      <form><input id="price_min" name="price_min" value="120" aria-label="最低价格"></form>
      <button id="btn_search" type="button">搜索</button>
      <div id="LoadingCover" style="display:none">正在读取</div>
      <div id="query_result">没有符合条件<div id="soldList"></div><div id="pager_bar">第 1 页</div></div>
      <span id="main-signal"></span>
      <script>
      window.IsLogin=1;
      window.QueryArgs={server_type:'1,2,3',page:1,order_by:'selling_time DESC',price_min:'100'};
      window.QueryResult=[];window.__searchClicks=0;
      document.getElementById('btn_search').onclick=()=>{
        window.__searchClicks++;
        document.getElementById('LoadingCover').style.display='block';
        setTimeout(()=>{
          document.getElementById('soldList').textContent='本次结果';
          document.getElementById('LoadingCover').style.display='none';
        },150);
      };
      window.__releaseMain=()=>{
        window.QueryArgs.price_min='120';
        document.getElementById('main-signal').textContent='真实参数已更新';
      };
      </script>`,
      }),
    );
    await page.goto("https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=role");
    await page.bringToFront();
    await page.exposeFunction("__observerMessage", async (message: any) => {
      snapshots.push(structuredClone(message));
      if (bound) await forward(message);
    });
    await page.evaluate(() => {
      (window as any).chrome = {
        runtime: {
          id: "extension",
          sendMessage: (message: unknown) => (window as any).__observerMessage(message),
          onMessage: {
            addListener: (listener: unknown) => {
              (window as any).__listener = listener;
            },
          },
        },
      };
    });
    for (const file of ["isolated.js", "main.js"])
      await page.addScriptTag({
        content: readFileSync(
          new URL(`../../extension/cbg-access/${file}`, import.meta.url),
          "utf8",
        ),
      });
    const binding = await command("bind");
    await forward({ kind: "status", payload: { ...binding, bound: true } });
    const pending = [...snapshots];
    bound = true;
    for (const message of pending) await forward(message);
    await expect.poll(async () => (await runtime.snapshot()).queryArgs?.price_min).toBe("100");
    let settled = false;
    query = runtime.query({ kind: "query" }, { kind: "page", page: 1 }).then((snapshot) => {
      settled = true;
      return snapshot;
    });
    void query.catch(() => {});
    const completed = () =>
      db.prepare("SELECT count(*) n FROM access_bridge_commands WHERE state='completed'").get()!.n;
    await expect
      .poll(() =>
        snapshots.some(
          (message) =>
            message.payload?.listingCommit?.actionId &&
            message.payload.listingCommitted &&
            message.payload.queryArgs?.price_min === "100" &&
            message.payload.roleQueryControls?.price_min?.value === "120",
        ),
      )
      .toBe(true);
    await ingress;
    expect(settled).toBe(false);
    expect(completed()).toBe(0);
    await page.evaluate(() => (window as any).__releaseMain());
    await command("capture");
    const result = (await query) as Awaited<ReturnType<typeof runtime.query>>;
    expect(result.queryArgs?.price_min).toBe("120");
    expect(result.roleQueryControls?.price_min?.value).toBe("120");
    expect(completed()).toBe(1);
    expect(writes.filter((message) => message.command === "execute")).toHaveLength(1);
    expect(await page.evaluate(() => (window as any).__searchClicks)).toBe(1);
  } finally {
    await runtime.stop("browser regression finished");
    await query?.catch(() => {});
    bound = false;
    await page.close();
    await ingress;
    db.close();
  }
});
