import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Browser, Page } from "playwright-core";
import { parseDevToolsEndpoint } from "./chrome";

const { connectOverCDP, readFile, openWorkTransport, transport } = vi.hoisted(() => ({
  connectOverCDP: vi.fn(),
  readFile: vi.fn(),
  openWorkTransport: vi.fn(),
  transport: { close: vi.fn() },
}));
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP } }));
vi.mock("node:fs/promises", () => ({ readFile }));
vi.mock("./work-transport", () => ({ openWorkTransport }));

beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("cbg.browser-session.v1"));
  vi.resetModules();
  vi.clearAllMocks();
  readFile.mockResolvedValue("9345\n/devtools/browser/test\n");
  openWorkTransport.mockResolvedValue(transport);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("cbg.browser-session.v1"));
  vi.unstubAllEnvs();
});

describe("日常浏览器连接", () => {
  it("从用户配置发布的地址连接，支持非默认端口", () => {
    expect(parseDevToolsEndpoint("9345\n/devtools/browser/1234-5678\n")).toBe(
      "ws://127.0.0.1:9345/devtools/browser/1234-5678",
    );
  });
  it.each([
    "9222",
    "NaN\n/devtools/browser/a",
    "65536\n/devtools/browser/a",
    "9222\n//example.test/browser",
    "9222\n/devtools/browser/a?other=1",
  ])("拒绝无效调试地址 %s", (value) => {
    expect(() => parseDevToolsEndpoint(value)).toThrow();
  });
  it("状态查询不尝试建立新连接或启动浏览器", async () => {
    const { getBrowser, getCbgPage } = await import("./session");
    await expect(getBrowser()).rejects.toThrow("浏览器未连接");
    expect(getCbgPage()).toBeNull();
    expect(connectOverCDP).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });
  it("并发开始只连接一次，等待首次浏览器授权", async () => {
    const { getBrowser } = await import("./session");
    const browser = { on: vi.fn(), isConnected: () => true };
    connectOverCDP.mockResolvedValue(browser);
    const connected = await Promise.all([getBrowser(true), getBrowser(true)]);
    expect(connected).toEqual([browser, browser]);
    expect(connectOverCDP).toHaveBeenCalledExactlyOnceWith(transport, {
      timeout: 15000,
      noDefaults: true,
    });
    expect(openWorkTransport).toHaveBeenCalledExactlyOnceWith(
      "ws://127.0.0.1:9345/devtools/browser/test",
    );
  });
  it("服务模块重载仍复用同一连接，不重复请求 Chrome 授权", async () => {
    const first = await import("./session");
    const browser = { on: vi.fn(), isConnected: () => true };
    connectOverCDP.mockResolvedValue(browser);
    expect(await first.getBrowser(true)).toBe(browser);
    vi.resetModules();
    const reloaded = await import("./session");
    expect(await reloaded.getBrowser()).toBe(browser);
    expect(connectOverCDP).toHaveBeenCalledOnce();
    expect(openWorkTransport).toHaveBeenCalledOnce();
  });
  it("连接建立中重载不会启动第二次握手，断开后仍必须显式重连", async () => {
    const first = await import("./session");
    const browser = { on: vi.fn(), isConnected: () => true };
    let finish!: (value: typeof browser) => void;
    connectOverCDP.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const initial = first.getBrowser(true);
    await vi.waitFor(() => expect(connectOverCDP).toHaveBeenCalledOnce());
    vi.resetModules();
    const reloaded = await import("./session");
    const resumed = reloaded.getBrowser(true);
    finish(browser);
    expect(await Promise.all([initial, resumed])).toEqual([browser, browser]);
    expect(openWorkTransport).toHaveBeenCalledOnce();
    browser.on.mock.calls.find(([event]) => event === "disconnected")![1]();
    await expect(reloaded.getBrowser()).rejects.toThrow("浏览器未连接");
    expect(reloaded.getCbgPage()).toBeNull();
  });
  it("握手成功后的初始化超时不会误报为等待 Chrome 授权", async () => {
    const { getBrowser } = await import("./session");
    connectOverCDP.mockRejectedValue(new Error("Timeout 60000ms exceeded"));
    await expect(getBrowser(true)).rejects.toThrow("已连接 Chrome 调试服务，但初始化工作连接失败");
    expect(transport.close).toHaveBeenCalledOnce();
  });
  it("握手失败时不初始化 Playwright，重试会重新建立连接", async () => {
    const { getBrowser } = await import("./session");
    openWorkTransport.mockRejectedValueOnce(new Error("握手超时"));
    await expect(getBrowser(true)).rejects.toThrow("Chrome 调试连接尚未建立");
    expect(connectOverCDP).not.toHaveBeenCalled();
    connectOverCDP.mockResolvedValue({ on: vi.fn(), isConnected: () => true });
    await getBrowser(true);
    expect(openWorkTransport).toHaveBeenCalledTimes(2);
  });
  it("创建隐藏后台页面，沿用默认用户上下文，只复用自己的工作页", async () => {
    const { createBackgroundPage, getCbgPage } = await import("./session");
    const oldPage = { isClosed: () => false } as Page;
    const pages = [oldPage];
    const targetSend = vi.fn(async (command: string) =>
      command === "Target.getTargetInfo"
        ? { targetInfo: { targetId: "worker" } }
        : { windowId: 12, bounds: { windowState: "normal" } },
    );
    const targetDetach = vi.fn();
    const context = {
      pages: () => pages,
      newCDPSession: vi.fn(async () => ({ send: targetSend, detach: targetDetach })),
    };
    const closed = vi.fn(() => false);
    const worker = {
      isClosed: closed,
      context: () => context,
      once: vi.fn(),
      viewportSize: () => null,
      setViewportSize: vi.fn(),
    } as unknown as Page;
    const send = vi.fn(async () => {
      pages.push(worker);
      return { targetId: "worker" };
    });
    const detach = vi.fn();
    const browser = {
      contexts: () => [context],
      newBrowserCDPSession: async () => ({ send, detach }),
    } as unknown as Browser;
    expect(await createBackgroundPage(browser)).toBe(worker);
    expect(send).toHaveBeenCalledExactlyOnceWith("Target.createTarget", {
      url: "about:blank",
      hidden: true,
      forTab: false,
      background: true,
      focus: false,
    });
    expect(getCbgPage()).toBe(worker);
    expect(detach).not.toHaveBeenCalled();
    expect(await createBackgroundPage(browser)).toBe(worker);
    expect(send).toHaveBeenCalledOnce();
    vi.resetModules();
    const reloaded = await import("./session");
    expect(reloaded.getCbgPage()).toBe(worker);
    expect(await reloaded.createBackgroundPage(browser)).toBe(worker);
    expect(send).toHaveBeenCalledOnce();
    closed.mockReturnValue(true);
    expect(reloaded.getCbgPage()).toBeNull();
    expect(context.newCDPSession).not.toHaveBeenCalledWith(oldPage);
  });
});

describe("并发创建后台页", () => {
  const browserPages = (firstViewport: () => Promise<void>) => {
    const pages: Page[] = [];
    const workers: Page[] = [];
    const context = {
      pages: () => pages,
      newCDPSession: vi.fn(async (page: Page) => ({
        send: vi.fn(async () => ({ targetInfo: { targetId: String(workers.indexOf(page)) } })),
        detach: vi.fn(),
      })),
    };
    const createSession = vi.fn(async () => ({
      send: vi.fn(async () => {
        const index = workers.length;
        const page = {
          isClosed: () => false,
          context: () => context,
          once: vi.fn(),
          viewportSize: () => null,
          setViewportSize: vi.fn(async () => {
            if (index === 0) await firstViewport();
          }),
        } as unknown as Page;
        workers.push(page);
        pages.push(page);
        return { targetId: String(index) };
      }),
      detach: vi.fn(),
    }));
    return {
      browser: {
        contexts: () => [context],
        newBrowserCDPSession: createSession,
      } as unknown as Browser,
      createSession,
      workers,
    };
  };
  it.each([undefined, "original"])(
    "采集和查价同时建页时分别返回自己的页，并恢复兼容开关 %s",
    async (previous) => {
      vi.stubEnv("PW_CHROMIUM_ATTACH_TO_OTHER", previous);
      const { createHiddenPage } = await import("./session");
      let entered!: () => void, finish!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const { browser, createSession, workers } = browserPages(async () => {
        entered();
        await gate;
      });
      const collecting = createHiddenPage(browser);
      const pricing = createHiddenPage(browser);
      await ready;
      expect(createSession).toHaveBeenCalledOnce();
      expect(process.env.PW_CHROMIUM_ATTACH_TO_OTHER).toBe("1");
      finish();
      expect(await Promise.all([collecting, pricing])).toEqual(workers);
      expect(workers).toHaveLength(2);
      expect(process.env.PW_CHROMIUM_ATTACH_TO_OTHER).toBe(previous);
    },
  );
  it("创建失败后仍执行下一次创建，兼容开关不残留", async () => {
    vi.stubEnv("PW_CHROMIUM_ATTACH_TO_OTHER", undefined);
    const { createHiddenPage } = await import("./session");
    const { browser, createSession, workers } = browserPages(async () => {});
    createSession.mockResolvedValueOnce({
      send: vi.fn(async () => {
        throw new Error("创建失败");
      }),
      detach: vi.fn(),
    });
    const failed = expect(createHiddenPage(browser)).rejects.toThrow("创建失败");
    const next = createHiddenPage(browser);
    await failed;
    expect(await next).toBe(workers[0]);
    expect(process.env.PW_CHROMIUM_ATTACH_TO_OTHER).toBeUndefined();
  });
});
