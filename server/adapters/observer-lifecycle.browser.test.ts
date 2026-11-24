import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { chromium, type Browser, type Page } from "playwright-core";
let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture() {
  const page = await browser.newPage();
  await page.route("**/*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<a href="/cgi-bin/login.py?act=logout">退出</a><form><input name="price_min" value="100"></form><div id="query_result">没有符合条件<div id="soldList"></div><div id="pager_bar">第 1 页</div></div><script>window.IsLogin=1;window.QueryArgs={server_type:'1,2,3',page:1,order_by:'selling_time DESC',price_min:'100'};window.QueryResult=[];window.pending=[];window.ajax_with_recommend=options=>{pending.push(options);return 'website-result'};</script>`,
    }),
  );
  await page.goto("https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=role");
  await page.bringToFront();
  await page.evaluate(() => {
    const g = window as unknown as Record<string, any>;
    g.__snapshots = [];
    g.__listeners = [];
    g.__intervals = new Set();
    g.__observers = new Set();
    const interval = window.setInterval.bind(window),
      clear = window.clearInterval.bind(window),
      Observer = window.MutationObserver;
    window.setInterval = ((...args: any[]) => {
      const id = interval(...(args as [TimerHandler, number]));
      g.__intervals.add(id);
      return id;
    }) as typeof setInterval;
    window.clearInterval = (id) => {
      g.__intervals.delete(id);
      clear(id);
    };
    const ownObservers = new WeakSet();
    window.MutationObserver = class extends Observer {
      constructor(callback: MutationCallback) {
        super(callback);
        if (callback.name === "changed") ownObservers.add(this);
      }
      observe(...args: Parameters<MutationObserver["observe"]>) {
        if (ownObservers.has(this)) g.__observers.add(this);
        return super.observe(...args);
      }
      disconnect() {
        g.__observers.delete(this);
        super.disconnect();
      }
    };
    g.chrome = {
      runtime: {
        id: "extension",
        sendMessage: async (message: unknown) => {
          g.__snapshots.push(message);
        },
        onMessage: { addListener: (listener: unknown) => g.__listeners.push(listener) },
      },
    };
    g.__originalFetch = window.fetch;
    g.__originalAjax = g.ajax_with_recommend;
  });
  for (const file of ["isolated.js", "main.js"])
    await page.addScriptTag({
      content: readFileSync(new URL(`../../extension/cbg-access/${file}`, import.meta.url), "utf8"),
    });
  return page;
}
async function command(page: Page, kind: string, observerToken?: string) {
  return page.evaluate(
    ({ kind, observerToken }) =>
      new Promise<any>((resolve) =>
        (window as unknown as Record<string, any>).__listeners[0](
          { kind, observerToken },
          { id: "extension" },
          resolve,
        ),
      ),
    { kind, observerToken },
  );
}
const counts = (page: Page) =>
  page.evaluate(() => {
    const g = window as unknown as Record<string, any>;
    return {
      snapshots: g.__snapshots.length,
      intervals: g.__intervals.size,
      observers: g.__observers.size,
    };
  });
it("publishes an explicit unready transition until this bind receives MAIN, and does not hide a real invalid age", async () => {
  const page = await fixture();
  try {
    await command(page, "bind");
    const first = await page.evaluate(
      () => (window as unknown as Record<string, any>).__snapshots[0].payload,
    );
    expect(first).toMatchObject({ access: "unknown", loading: true });
    expect(first.listing).toBeUndefined();
    expect(first.authenticated).toBeUndefined();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as Record<string, any>).__snapshots.at(-1).payload.listing
              ?.serverType,
        ),
      )
      .toBe("1,2,3");
    await page.evaluate(
      () => ((window as unknown as Record<string, any>).QueryArgs.server_type = ""),
    );
    await command(page, "capture");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as Record<string, any>).__snapshots.at(-1).payload.listing
              ?.serverType,
        ),
      )
      .toBe("");
    // The actual render is observable; the runtime's unchanged strict decoder must reject it.
    expect(
      await page.evaluate(
        () => (window as unknown as Record<string, any>).__snapshots.at(-1).payload.loading,
      ),
    ).toBe(false);
  } finally {
    await page.close();
  }
});
it("starts dormant, coalesces mutation bursts and cancels delayed capture and hooks on stop/rebind/pagehide", async () => {
  const page = await fixture();
  try {
    expect(await counts(page)).toEqual({ snapshots: 0, intervals: 0, observers: 0 });
    await command(page, "bind");
    await expect.poll(async () => (await counts(page)).intervals).toBe(1);
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as Record<string, any>).__snapshots.at(-1).payload.authenticated,
        ),
      )
      .toBe(true);
    await page.waitForTimeout(150);
    await page.evaluate(() => {
      const g = window as unknown as Record<string, any>;
      g.__snapshots.length = 0;
      const input = document.querySelector<HTMLInputElement>('input[name="price_min"]')!;
      input.value = "200";
      for (let index = 0; index < 100; index++)
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect.poll(async () => (await counts(page)).snapshots).toBe(1);
    await page.waitForTimeout(200);
    expect((await counts(page)).snapshots).toBe(1);
    await page.evaluate(() =>
      document.querySelector("input")!.dispatchEvent(new Event("input", { bubbles: true })),
    );
    await command(page, "stop");
    const stopped = (await counts(page)).snapshots;
    await expect.poll(async () => (await counts(page)).intervals).toBe(0);
    expect((await counts(page)).observers).toBe(0);
    await page.waitForTimeout(200);
    expect((await counts(page)).snapshots).toBe(stopped);
    expect(
      await page.evaluate(() => {
        const g = window as unknown as Record<string, any>;
        return window.fetch === g.__originalFetch && g.ajax_with_recommend === g.__originalAjax;
      }),
    ).toBe(true);
    await command(page, "bind");
    await command(page, "bind");
    await expect.poll(async () => (await counts(page)).intervals).toBe(1);
    expect((await counts(page)).observers).toBe(1);
    await page.evaluate(() => window.dispatchEvent(new Event("pagehide")));
    await expect.poll(async () => (await counts(page)).intervals).toBe(0);
    expect((await counts(page)).observers).toBe(0);
  } finally {
    await page.close();
  }
});
it("keeps bounded real-read heartbeats fresh without changing semantic revision or old callback receipt times", async () => {
  const page = await fixture();
  try {
    await command(page, "bind");
    await expect.poll(async () => (await counts(page)).intervals).toBe(1);
    await page.evaluate(() => {
      const g = window as unknown as Record<string, any>;
      g.ajax_with_recommend({
        data: { act: "overall_search_role", page: 1 },
        onSuccess() {
          return 7;
        },
      });
      g.pending[0].onSuccess({ status: 0, msg: [] });
    });
    await expect
      .poll(async () =>
        page.evaluate(
          () =>
            (window as unknown as Record<string, any>).__snapshots.at(-1).payload.business.length,
        ),
      )
      .toBe(1);
    await page.waitForTimeout(150);
    const before = await page.evaluate(
      () => (window as unknown as Record<string, any>).__snapshots.at(-1).payload,
    );
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (window as unknown as Record<string, any>).__snapshots.at(-1).payload.observedAt,
          ),
        { timeout: 6000 },
      )
      .not.toBe(before.observedAt);
    const after = await page.evaluate(
      () => (window as unknown as Record<string, any>).__snapshots.at(-1).payload,
    );
    expect(after.revision).toBe(before.revision);
    expect(after.business).toEqual(before.business);
    expect(Date.parse(after.observedAt) - Date.parse(before.observedAt)).toBeGreaterThanOrEqual(
      3000,
    );
  } finally {
    await page.close();
  }
}, 10000);
it("ignores stale-token cleanup and old callbacks after a newer binding starts", async () => {
  const page = await fixture();
  try {
    const first = await command(page, "bind");
    await page.evaluate(() => {
      const g = window as unknown as Record<string, any>;
      g.__callbackCalls = 0;
      g.ajax_with_recommend({
        data: { act: "overall_search_role", page: 1 },
        onSuccess() {
          g.__callbackCalls++;
          return 9;
        },
      });
      g.__oldCallback = g.pending[0].onSuccess;
    });
    const second = await command(page, "bind");
    expect(second.observerToken).not.toBe(first.observerToken);
    expect(await command(page, "stop", first.observerToken)).toMatchObject({
      ok: false,
      error: "stale-observer-token",
    });
    expect(await command(page, "capture", first.observerToken)).toMatchObject({
      ok: false,
      error: "stale-observer-token",
    });
    expect(
      await page.evaluate(() =>
        (window as unknown as Record<string, any>).__oldCallback({ status: 0, msg: [] }),
      ),
    ).toBe(9);
    await command(page, "capture", second.observerToken);
    await expect.poll(async () => (await counts(page)).intervals).toBe(1);
    expect((await counts(page)).observers).toBe(1);
    expect(
      await page.evaluate(() => {
        const g = window as unknown as Record<string, any>;
        return { calls: g.__callbackCalls, business: g.__snapshots.at(-1).payload.business };
      }),
    ).toEqual({ calls: 1, business: [] });
    await command(page, "stop", second.observerToken);
    await expect.poll(async () => (await counts(page)).intervals).toBe(0);
    expect((await counts(page)).observers).toBe(0);
  } finally {
    await page.close();
  }
});
