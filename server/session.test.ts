import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Browser, Page } from "playwright-core";
import { parseDevToolsEndpoint } from "./chrome";
import { browserControl, browserSettings, saveBrowserSettings } from "./browser-settings";
import { openDedicatedBrowser } from "./dedicated-browser";
import { captureBrowserStep } from "./browser-evidence";

const { connectOverCDP, readFile, openWorkTransport, verifyCdpEndpoint, transport } = vi.hoisted(
  () => ({
    connectOverCDP: vi.fn(),
    readFile: vi.fn(),
    openWorkTransport: vi.fn(),
    verifyCdpEndpoint: vi.fn(),
    transport: { close: vi.fn() },
  }),
);
vi.mock("playwright-core", () => ({ chromium: { connectOverCDP } }));
vi.mock("node:fs/promises", () => ({ readFile }));
vi.mock("./work-transport", () => ({ openWorkTransport }));
vi.mock("./dedicated-browser", () => ({ openDedicatedBrowser: vi.fn() }));
vi.mock("./browser-evidence", () => ({
  captureBrowserStep: vi.fn(),
  registerBrowserEvidence: vi.fn(),
}));
vi.mock("./browser-settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./browser-settings")>()),
  browserSettings: vi.fn(),
  saveBrowserSettings: vi.fn(),
}));
vi.mock("./chrome", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chrome")>()),
  verifyCdpEndpoint,
}));

beforeEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("cbg.browser-session.v1"));
  vi.resetModules();
  vi.clearAllMocks();
  browserControl.changing = false;
  browserControl.pending = 0;
  vi.mocked(browserSettings).mockReturnValue({ mode: "daily" });
  vi.mocked(saveBrowserSettings).mockImplementation((mode) => ({
    mode: mode as "daily" | "dedicated",
  }));
  readFile.mockResolvedValue("9345\n/devtools/browser/test\n");
  openWorkTransport.mockResolvedValue(transport);
  verifyCdpEndpoint.mockResolvedValue(undefined);
});

describe("项目专用浏览器会话", () => {
  const dedicated = () => {
    let connected = true;
    const browser = {
      on: vi.fn(),
      isConnected: () => connected,
      close: vi.fn(async () => {
        connected = false;
      }),
    };
    const context = {
      browser: () => browser,
      close: vi.fn(async () => {
        connected = false;
      }),
    };
    vi.mocked(browserSettings).mockReturnValue({ mode: "dedicated" });
    vi.mocked(openDedicatedBrowser).mockImplementation(async () => {
      connected = true;
      return context as never;
    });
    return { browser, context };
  };

  it("状态查询不启动浏览器，并发开始只启动一个持久上下文且模块重载后继续复用", async () => {
    const { browser } = dedicated();
    const first = await import("./session");
    expect(first.browserSessionSettings()).toEqual({
      mode: "dedicated",
      connected: false,
      busy: false,
    });
    await expect(first.getBrowser()).rejects.toThrow("浏览器未连接");
    expect(openDedicatedBrowser).not.toHaveBeenCalled();
    expect(await Promise.all([first.getBrowser(true), first.getBrowser(true)])).toEqual([
      browser,
      browser,
    ]);
    vi.resetModules();
    expect(await (await import("./session")).getBrowser()).toBe(browser);
    expect(openDedicatedBrowser).toHaveBeenCalledOnce();
    expect(readFile).not.toHaveBeenCalled();
    expect(openWorkTransport).not.toHaveBeenCalled();
    expect(connectOverCDP).not.toHaveBeenCalled();
  });

  it("断开后状态轮询不会重新启动，下一次明确开始才恢复", async () => {
    const { browser } = dedicated();
    const session = await import("./session");
    await session.getBrowser(true);
    browser.on.mock.calls.find(([event]) => event === "disconnected")![1]();
    await expect(session.getBrowser()).rejects.toThrow("浏览器未连接");
    expect(openDedicatedBrowser).toHaveBeenCalledOnce();
    await session.getBrowser(true);
    expect(openDedicatedBrowser).toHaveBeenCalledTimes(2);
  });

  it("忙时拒绝切换，保存失败保留旧连接，切换期间不让新请求取得旧连接", async () => {
    const { browser, context } = dedicated();
    const session = await import("./session");
    await session.getBrowser(true);
    const reset = vi.fn();
    await expect(session.changeBrowserMode("daily", () => true, reset)).rejects.toThrow("请先暂停");
    expect(saveBrowserSettings).not.toHaveBeenCalled();
    vi.mocked(saveBrowserSettings).mockImplementationOnce(() => {
      throw new Error("磁盘已满");
    });
    await expect(session.changeBrowserMode("daily", () => false, reset)).rejects.toThrow(
      "磁盘已满",
    );
    expect(await session.getBrowser()).toBe(browser);
    expect(context.close).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    let finish!: () => void;
    context.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const changing = session.changeBrowserMode("daily", () => false, reset);
    await vi.waitFor(() => expect(context.close).toHaveBeenCalledOnce());
    await expect(session.getBrowser(true)).rejects.toThrow("浏览器正在切换");
    await expect(session.changeBrowserMode("daily", () => false, reset)).rejects.toThrow(
      "请先暂停",
    );
    finish();
    await changing;
    expect(reset).toHaveBeenCalledOnce();
    expect(browserControl.changing).toBe(false);
    expect(session.browserSessionSettings().connected).toBe(false);
  });

  it("关闭旧上下文失败后释放切换锁，但不会再提供旧连接", async () => {
    const { context, browser } = dedicated();
    const session = await import("./session");
    await session.getBrowser(true);
    context.close.mockRejectedValueOnce(new Error("关闭失败"));
    browser.close.mockRejectedValueOnce(new Error("浏览器兜底关闭也失败"));
    await expect(session.changeBrowserMode("daily", () => false, vi.fn())).rejects.toThrow(
      "关闭失败",
    );
    expect(browserControl.changing).toBe(false);
    await expect(session.getBrowser()).rejects.toThrow("浏览器未连接");
    await session.shutdownBrowserSession();
    expect(context.close).toHaveBeenCalledTimes(2);
  });

  it("服务退出期间晚完成的启动立即关闭配置，不留下后台浏览器", async () => {
    const { context } = dedicated();
    let finish!: (value: typeof context) => void;
    vi.mocked(openDedicatedBrowser).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve as never;
        }),
    );
    const session = await import("./session");
    const connection = session.getBrowser(true);
    const rejected = expect(connection).rejects.toThrow("本地服务正在关闭");
    const shutdown = session.shutdownBrowserSession();
    finish(context);
    await rejected;
    await shutdown;
    expect(context.close).toHaveBeenCalledOnce();
    await expect(session.getBrowser(true)).rejects.toThrow("本地服务正在关闭");
    expect(openDedicatedBrowser).toHaveBeenCalledOnce();
  });

  it("退出时晚完成的启动首次关闭失败，仍由关停流程重试清理", async () => {
    const { context, browser } = dedicated();
    context.close.mockRejectedValueOnce(new Error("首次关闭失败"));
    browser.close.mockRejectedValueOnce(new Error("首次浏览器兜底关闭失败"));
    let finish!: (value: typeof context) => void;
    vi.mocked(openDedicatedBrowser).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve as never;
        }),
    );
    const session = await import("./session");
    const connection = session.getBrowser(true);
    const rejected = expect(connection).rejects.toThrow("首次关闭失败");
    const shutdown = session.shutdownBrowserSession();
    finish(context);
    await rejected;
    await shutdown;
    expect(context.close).toHaveBeenCalledTimes(2);
  });

  it("服务退出后同进程重新监听可以重置生命周期并再次启动", async () => {
    dedicated();
    const session = await import("./session");
    await session.getBrowser(true);
    expect(() => session.resetBrowserSessionLifecycle()).toThrow("旧浏览器会话尚未关闭");
    await session.shutdownBrowserSession();
    session.resetBrowserSessionLifecycle();
    await session.getBrowser(true);
    expect(openDedicatedBrowser).toHaveBeenCalledTimes(2);
  });

  it("重复退出只关闭一次持久上下文", async () => {
    const { context } = dedicated();
    const session = await import("./session");
    await session.getBrowser(true);
    await Promise.all([session.shutdownBrowserSession(), session.shutdownBrowserSession()]);
    expect(context.close).toHaveBeenCalledOnce();
  });

  it("上下文重试关闭直接返回但浏览器仍连接时，关闭持有的专用Browser兜底", async () => {
    const { context, browser } = dedicated();
    const session = await import("./session");
    await session.getBrowser(true);
    context.close
      .mockRejectedValueOnce(new Error("上下文关闭失败"))
      .mockResolvedValueOnce(undefined);
    browser.close.mockRejectedValueOnce(new Error("首次Browser关闭失败"));
    await expect(session.changeBrowserMode("daily", () => false, vi.fn())).rejects.toThrow(
      "上下文关闭失败",
    );
    await session.shutdownBrowserSession();
    expect(context.close).toHaveBeenCalledTimes(2);
    expect(browser.close).toHaveBeenCalledTimes(2);
    expect(browser.isConnected()).toBe(false);
  });

  it("专用工作页共用持久上下文，并记录开页步骤", async () => {
    const { context } = dedicated();
    const page = {
      viewportSize: () => ({ width: 1440, height: 1080 }),
      isClosed: () => false,
      close: vi.fn(),
    };
    Object.assign(context, { newPage: vi.fn().mockResolvedValue(page) });
    const session = await import("./session");
    const browser = await session.getBrowser(true);
    expect(await session.createBackgroundPage(browser)).toBe(page);
    expect(await session.createBackgroundPage(browser)).toBe(page);
    expect(await session.createHiddenPage(browser)).toBe(page);
    expect(
      (context as typeof context & { newPage: ReturnType<typeof vi.fn> }).newPage,
    ).toHaveBeenCalledTimes(2);
    expect(captureBrowserStep).toHaveBeenCalledWith(page, {
      flow: "browser",
      stage: "page.created",
    });
  });

  it("无Browser句柄时释放专用配置，后续可明确重试", async () => {
    const { context } = dedicated();
    vi.mocked(openDedicatedBrowser).mockResolvedValueOnce({
      ...context,
      browser: () => null,
    } as never);
    const session = await import("./session");
    await expect(session.getBrowser(true)).rejects.toThrow("项目专用浏览器连接未建立");
    expect(context.close).toHaveBeenCalledOnce();
    await session.getBrowser(true);
    expect(openDedicatedBrowser).toHaveBeenCalledTimes(2);
  });

  it("旧连接稍晚断开不会清掉新专用连接", async () => {
    const old = {
      on: vi.fn(),
      isConnected: () => true,
      close: vi.fn().mockResolvedValue(undefined),
    };
    connectOverCDP.mockResolvedValueOnce(old);
    const session = await import("./session");
    await session.getBrowser(true);
    const { browser } = dedicated();
    await session.changeBrowserMode("dedicated", () => false, vi.fn());
    expect(old.close).toHaveBeenCalledOnce();
    await session.getBrowser(true);
    old.on.mock.calls.find(([event]) => event === "disconnected")![1]();
    expect(await session.getBrowser()).toBe(browser);
    expect(session.browserSessionSettings()).toMatchObject({ mode: "dedicated", connected: true });
  });
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
    await expect(getBrowser(true)).rejects.toThrow(
      "Chrome 调试端口已启动，但连接未获授权或握手失败",
    );
    expect(connectOverCDP).not.toHaveBeenCalled();
    connectOverCDP.mockResolvedValue({ on: vi.fn(), isConnected: () => true });
    await getBrowser(true);
    expect(openWorkTransport).toHaveBeenCalledTimes(2);
  });
  it("调试地址残留时保留端口诊断，修复后重读地址再连接", async () => {
    const { getBrowser } = await import("./session");
    verifyCdpEndpoint.mockRejectedValueOnce(new Error("Chrome 调试端口 9345 未启动"));
    await expect(getBrowser(true)).rejects.toThrow("Chrome 调试端口 9345 未启动");
    expect(openWorkTransport).not.toHaveBeenCalled();
    expect(connectOverCDP).not.toHaveBeenCalled();
    readFile.mockResolvedValue("9456\n/devtools/browser/new-session\n");
    connectOverCDP.mockResolvedValue({ on: vi.fn(), isConnected: () => true });
    await getBrowser(true);
    expect(openWorkTransport).toHaveBeenCalledExactlyOnceWith(
      "ws://127.0.0.1:9456/devtools/browser/new-session",
    );
  });
  it.each([false, true])(
    "创建工作页（可见=%s），沿用默认用户上下文，只复用自己的页面",
    async (visible) => {
      vi.stubEnv("CBG_SHOW_WORK_PAGES", visible ? "1" : "0");
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
        hidden: !visible,
        forTab: false,
        background: !visible,
        focus: visible,
        ...(visible ? { newWindow: true } : {}),
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
    },
  );
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
