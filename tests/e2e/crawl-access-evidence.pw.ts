import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { DiagnosticLog, diagnostics, watchWorkPage } from "../../server/diagnostics";
import { refreshList } from "../../server/crawler/page";
import { watchCrawlAccess } from "../../server/crawler/access-guard";

// Failure modes: unfinished clicks reported as completed; HTTP 200 business errors
// lost; pending queries mistaken for later cancellation; secrets retained; logging
// changes access decisions. All pages and responses below are isolated fixtures.
for (const mode of ["success", "business-error", "timeout"] as const) {
  test(`刷新恢复排序取证：${mode}，关联鼠标、查询、页面提示并导出`, async ({ page }, info) => {
    const log = new DiagnosticLog(info.outputPath("logs"));
    const originalRecord = diagnostics.record.bind(diagnostics);
    diagnostics.record = log.record.bind(log);
    const control = new AbortController();
    let visits = 0;
    let releaseQuery!: () => void;
    const pendingQuery = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    let closing: Promise<void> | undefined;
    let clicks: unknown;
    let dispose: (() => Promise<void>) | undefined;
    const screenshot = info.outputPath("final.png");
    const events = () =>
      log.export().events as Array<{
        sequence: number;
        event: string;
        data: Record<string, unknown>;
      }>;
    try {
      await page.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        // No real website, local service, production database or user Chrome profile.
        if (url.origin !== "http://crawl-evidence.test") return route.abort();
        if (url.pathname === "/cgi-bin/recommend.py") {
          if (mode === "timeout") {
            await pendingQuery;
            return route.abort().catch(() => {});
          }
          return route.fulfill({
            contentType: "application/javascript",
            body: `Request.JSONP.request_map.request_1(${JSON.stringify({
              status: mode === "success" ? 1 : 0,
              msg: mode === "success" ? "" : "访问过于频繁 fixture@example.test",
              cookie: "secret-response-cookie",
              equip_list: [{ private: "secret-role-data" }],
            })});`,
          });
        }
        if (url.pathname !== "/list") return route.abort();
        visits++;
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: `<style>a{display:block;width:220px;height:40px}</style>
          <h1>本地模拟：${mode}</h1>
          <div id="order_menu"><a data_attr_name="expire_time" href="#">出售剩余时间</a></div>
          <div id="query_result"></div>
          <script>
          window.IsLogin=1;window.LoginInfo={login:1};window.clicks=[];
          window.QueryArgs={server_type:'1,2,3',page:${visits === 1 ? 3 : 1},order_by:${JSON.stringify(visits === 1 ? "expire_time DESC" : "")}};
          function render(){document.querySelector('#query_result').innerHTML=
            '<div id="soldList"><a class="soldImg" href="https://xyq.cbg.163.com/equip?s=1&eid=fixture">角色</a></div><div id="pager_bar">第 '+QueryArgs.page+' 页 共 30 页</div>';}
          render();let timer;
          window.Request={JSONP:{request_map:{request_1(result){clearTimeout(timer);
            if(result.status===1)render();else document.querySelector('#query_result').innerHTML='<p>'+result.msg+'</p>';}}}};
          document.querySelector('#order_menu a').onclick=function(event){event.preventDefault();
            clicks.push({trusted:event.isTrusted,x:event.clientX,y:event.clientY});
            QueryArgs.order_by='expire_time DESC';QueryArgs.page=1;
            const script=document.createElement('script');
            script.src='/cgi-bin/recommend.py?page=1&order_by=expire_time%20DESC&token=secret-query';
            document.head.appendChild(script);
            timer=setTimeout(()=>{document.querySelector('#query_result').innerHTML='<p>系统繁忙，请稍后再试</p>';},300);
          };
          </script>`,
        });
      });
      watchWorkPage(page, "list");
      await page.goto("http://crawl-evidence.test/list");
      dispose = await watchCrawlAccess(page, control.signal, (error) => {
        control.abort(error);
        closing = (async () => {
          clicks = await page.evaluate(() => Reflect.get(window, "clicks"));
          await page.screenshot({ path: screenshot });
          releaseQuery();
          await page.close();
        })();
      });
      if (mode === "success") {
        await expect(refreshList(page, control.signal, "expire_time DESC")).resolves.toMatchObject({
          page: 1,
          order: "expire_time DESC",
        });
        expect(control.signal.aborted).toBe(false);
        clicks = await page.evaluate(() => Reflect.get(window, "clicks"));
        await page.screenshot({ path: screenshot });
      } else {
        await expect(refreshList(page, control.signal, "expire_time DESC")).rejects.toThrow();
        await closing;
        expect(control.signal.reason).toMatchObject({ kind: "busy" });
      }
      expect(clicks).toEqual([expect.objectContaining({ trusted: true })]);
      const mouse = events().filter((event) => event.event === "list.sort_click");
      expect(mouse.map((event) => event.data.phase)).toEqual(["dispatching", "completed"]);
      expect(mouse[0]!.data.method).toBe("page.mouse.click");
      const query = events().find(
        (event) => event.event === "list.query" && event.data.phase === "started",
      )!;
      expect(query.data.pageId).toBe(mouse[0]!.data.pageId);
      if (mode === "timeout") {
        const evidence = events().find((event) => event.event === "crawl.access_evidence")!;
        expect(evidence.data).toMatchObject({
          lastQueryId: query.data.requestId,
          lastQueryPhase: "started",
          matchedText: "系统繁忙",
          region: "#query_result",
        });
        // Closing a page need not emit requestfailed; the pending state at close
        // is evidence too. Never invent a network failure from a page closure.
        for (const failed of events().filter(
          (event) => event.event === "list.query" && event.data.phase === "failed",
        ))
          expect(failed.sequence).toBeGreaterThan(evidence.sequence);
        expect(events().find((event) => event.event === "page.closed")!.sequence).toBeGreaterThan(
          evidence.sequence,
        );
      } else {
        await expect
          .poll(() => events().some((event) => event.event === "list.query_result"))
          .toBe(true);
        expect(events()).toContainEqual(
          expect.objectContaining({
            event: "list.query_result",
            data: expect.objectContaining({
              requestId: query.data.requestId,
              httpStatus: 200,
              status: mode === "success" ? 1 : 0,
              format: "jsonp",
              expectedCallback: true,
            }),
          }),
        );
      }
      const report = {
        scope: "local fixture only",
        mode,
        simulatedTimeoutMs: 300,
        clicks,
        log: log.export(),
      };
      expect(JSON.stringify(report)).not.toMatch(/secret-|fixture@example/);
      const artifact = info.outputPath("evidence.json");
      await writeFile(artifact, JSON.stringify(report, null, 2));
      await info.attach("鼠标到查询与暂停的完整证据", {
        path: artifact,
        contentType: "application/json",
      });
      await info.attach("最终页面", { path: screenshot, contentType: "image/png" });
    } finally {
      releaseQuery();
      await closing;
      await dispose?.();
      await page.close();
      diagnostics.record = originalRecord;
    }
  });
}
