import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import { createCrawlSource } from "./source";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 失败方式：已在首页时复用旧结果、沿用旧到期排序、严格排序失败仍返回列表。
it("真实 Source 即使已在首页，也按显式上架排序调用网站跳页函数刷新", async () => {
  vi.useFakeTimers();
  const go = vi.fn();
  const globals = {
    QueryArgs: { server_type: "3", order_by: "selling_time DESC", page: 1 },
    QueryResult: [],
    goto: go,
  };
  vi.stubGlobal("window", globals);
  vi.stubGlobal("location", { pathname: "/cgi-bin/role_search.py" });
  vi.stubGlobal("document", {
    body: { innerText: "" },
    querySelectorAll: () => [],
    querySelector: (selector: string) =>
      selector === "#pager_bar"
        ? { innerText: "第 1 页 共 1 页" }
        : selector === "#query_result"
          ? { innerText: "没有符合条件" }
          : null,
  });
  const page = {
    isClosed: () => false,
    viewportSize: () => ({ width: 1440, height: 1080 }),
    evaluate: async (fn: (arg: unknown) => unknown, arg?: unknown) => fn(arg),
    waitForFunction: async (fn: (arg: unknown) => unknown, arg: unknown) => {
      expect(fn(arg)).toBe(true);
    },
    locator: (selector: string) => ({
      count: async () => (selector.startsWith("#order_menu") ? 1 : 0),
      first() {
        return this;
      },
    }),
  } as unknown as Page;
  const src = createCrawlSource({
    listPage: page,
    detailPage: page,
    signal: new AbortController().signal,
    preferredOrder: "expire_time DESC",
    onDetailProgress: vi.fn(),
    log: vi.fn(),
  });
  for (let index = 0; index < 2; index++) {
    const pending = expect(src.prepare("selling_time DESC")).resolves.toEqual({
      page: 1,
      totalPages: 1,
      order: "selling_time DESC",
      items: [],
    });
    await vi.runAllTimersAsync();
    await pending;
  }
  expect(go).toHaveBeenCalledTimes(2);
  expect(go).toHaveBeenNthCalledWith(1, 1);
  expect(go).toHaveBeenNthCalledWith(2, 1);
});
