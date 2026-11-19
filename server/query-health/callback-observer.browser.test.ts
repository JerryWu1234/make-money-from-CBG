import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it, vi } from "vite-plus/test";
import { chromium, type Browser } from "playwright-core";
import { AccessGovernor, type AccessContext } from "../access";
import { CBG_ORIGIN } from "../access/response-classifier";
import { watchCrawlAccess } from "../crawler/access-guard";
import { activateQueryObservation, installQueryCallbackObservation } from "./callback-observer";
import { beginPageQuery, bindQueryPage } from "./runtime";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});

it.each([
  ["chunked", "请先登录", "login"],
  ["chunked", "请完成验证码验证", "verification"],
  ["chunked", "访问过于频繁", "frequency"],
  ["gzip", "请先登录", "login"],
  ["gzip", "请完成验证码验证", "verification"],
  ["gzip", "访问过于频繁", "frequency"],
])(
  "%s HTTP200 JSONP refusal %s stops shared access without a detached body copy",
  async (encoding, msg, reason) => {
    const page = await browser.newPage();
    const db = new DatabaseSync(":memory:");
    const governor = new AccessGovernor(db);
    const owner = governor.acquireOwner("callback-browser");
    const context: AccessContext = {
      ...owner,
      runId: "run",
      queryId: "initial",
      pageId: "page",
      pageGeneration: 1,
      browserSessionEpoch: "browser",
      stopEpoch: 0,
      sourceKind: "market-equipment",
    };
    governor.registerPage(context);
    const control = new AbortController();
    const networkAccess = vi.fn();
    const observed = vi.fn();
    let dispose: (() => Promise<void>) | undefined;
    try {
      await page.route("**/*", async (route) => {
        if (new URL(route.request().url()).pathname === "/cgi-bin/recommend.py") {
          const script =
            "websiteJsonp(" +
            JSON.stringify({ status: 12, msg, token: "website-secret", fp: "full-fingerprint" }) +
            ");";
          await route.fulfill({
            status: 200,
            headers: {
              "content-type": "application/javascript; charset=utf-8",
              ...(encoding === "gzip"
                ? { "content-encoding": "gzip" }
                : { "transfer-encoding": "chunked" }),
            },
            // DevTools response fulfillment supplies the decoded representation.
            body: script,
          });
        } else {
          await route.fulfill({
            contentType: "text/html",
            body: `<body>market<script>
          window.IsLogin=1; window.LoginInfo={login:1};
          window.calls=0; window.callbackCalls=0; window.callbackThis={website:1};
          window.ajax_with_recommend=function(options, suffix) {
            window.calls++; window.originalThis=this; window.originalSuffix=suffix;
            window.websiteJsonp=function(result) {
              window.callbackReturn=options.onSuccess.call(window.callbackThis,result,7);
            };
            const script=document.createElement('script'); script.src='/cgi-bin/recommend.py'; document.head.append(script);
            return 41;
          };
        </script></body>`,
          });
        }
      });
      await page.goto(CBG_ORIGIN + "/equip_search.html");
      bindQueryPage(page, governor, context);
      await installQueryCallbackObservation(page, "Equipment");
      const query = beginPageQuery(page, {
        category: "equipment",
        server: "367",
        serverAge: "3",
        conditions: {},
        page: 1,
        sort: "default",
      })!;
      await activateQueryObservation(page, query.queryId);
      dispose = await watchCrawlAccess(page, control.signal, networkAccess, observed);
      const returned = await page.evaluate(() => {
        const g = window as unknown as Record<string, any>;
        return g.ajax_with_recommend.call(
          g,
          {
            data: { page: 1 },
            onSuccess: function (this: unknown, ...args: unknown[]) {
              g.callbackCalls++;
              g.callbackThisPreserved = this === g.callbackThis;
              g.callbackArgsPreserved =
                (args[0] as { token: string }).token === "website-secret" && args[1] === 7;
              return 99;
            },
          },
          "suffix",
        );
      });
      expect(returned).toBe(41);
      await vi.waitFor(() =>
        expect(governor.read().reasons.map((item) => item.code)).toEqual([reason]),
      );
      await vi.waitFor(async () =>
        expect(await page.evaluate(() => Reflect.get(window, "callbackReturn"))).toBe(99),
      );
      expect(
        await page.evaluate(() => {
          const g = window as unknown as Record<string, unknown>;
          return {
            calls: g.calls,
            callbackCalls: g.callbackCalls,
            callbackThisPreserved: g.callbackThisPreserved,
            callbackArgsPreserved: g.callbackArgsPreserved,
            originalSuffix: g.originalSuffix,
          };
        }),
      ).toEqual({
        calls: 1,
        callbackCalls: 1,
        callbackThisPreserved: true,
        callbackArgsPreserved: true,
        originalSuffix: "suffix",
      });
      expect(networkAccess).not.toHaveBeenCalled();
      expect(observed).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "unknown", reason: "body_unavailable" }),
        expect.anything(),
        expect.anything(),
      );
      const evidence = db.prepare("SELECT context_json,evidence_json FROM access_evidence").get()!;
      expect(JSON.parse(evidence.context_json as string).queryId).toBe(query.queryId);
      expect(JSON.stringify(evidence)).not.toMatch(/website-secret|full-fingerprint|proof/);
    } finally {
      await dispose?.();
      await page.close();
      db.close();
    }
  },
);
