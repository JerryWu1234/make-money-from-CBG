import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  browserSessionSettings: vi.fn(),
  changeBrowserMode: vi.fn(),
  changeBrowserModes: vi.fn(),
  getBrowser: vi.fn(),
  isBrowserWorkflowRunning: vi.fn(),
  resetBrowserWorkflow: vi.fn(),
  isCrawling: vi.fn(),
  isAnalyzing: vi.fn(),
  startCrawl: vi.fn(),
  startAnalysis: vi.fn(),
  openCbg: vi.fn(),
  checkEquipment: vi.fn(),
  disableScanSchedule: vi.fn(),
  record: vi.fn(),
}));
vi.mock("./session", () => mocks);
vi.mock("./cbg", () => mocks);
vi.mock("./browser", () => mocks);
vi.mock("./crawler/controller", () => mocks);
vi.mock("./crawler/schedule", () => mocks);
vi.mock("./analysis/controller", () => mocks);
vi.mock("./analysis/equipment-check", () => mocks);
vi.mock("./diagnostics", () => ({ diagnostics: { record: mocks.record } }));

function request(pathname: string, method = "GET", body: Record<string, unknown> = {}) {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    url: pathname,
    method,
    headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
  }) as IncomingMessage;
}

function response() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    destroyed: false,
    setHeader: vi.fn(),
    end: vi.fn(),
  });
  return res as typeof res & ServerResponse;
}

async function invoke(req: IncomingMessage) {
  const res = response();
  const next = vi.fn();
  await (await import("./api")).apiMiddleware(req, res, next);
  expect(next).not.toHaveBeenCalled();
  return res;
}

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  const { browserControl } = await import("./browser-settings");
  browserControl.pending = 0;
  browserControl.changing = false;
  mocks.browserSessionSettings.mockReturnValue({
    mode: "dedicated",
    connected: false,
    busy: false,
  });
  mocks.isBrowserWorkflowRunning.mockReturnValue(false);
  mocks.isCrawling.mockReturnValue(false);
  mocks.isAnalyzing.mockReturnValue(false);
  mocks.changeBrowserMode.mockImplementation(
    async (mode: "daily" | "dedicated", busy: () => boolean, reset: () => void) => {
      if (busy())
        throw Object.assign(new Error("请先等待浏览器任务结束"), {
          name: "BrowserSessionBusyError",
        });
      reset();
      mocks.browserSessionSettings.mockReturnValue({ mode, connected: false, busy: false });
    },
  );
});

describe("browser settings API", () => {
  it("只读取模式与状态，不连接或启动浏览器", async () => {
    mocks.browserSessionSettings.mockReturnValue({ mode: "daily", connected: true, busy: false });
    const res = await invoke(request("/api/browser/settings"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
      mode: "daily",
      connected: true,
      busy: false,
    });
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
    expect(mocks.getBrowser).not.toHaveBeenCalled();
    expect(mocks.openCbg).not.toHaveBeenCalled();
    expect(mocks.changeBrowserMode).not.toHaveBeenCalled();
    expect(mocks.resetBrowserWorkflow).not.toHaveBeenCalled();
  });

  it.each(["session", "workflow", "capture", "analysis", "pending"])(
    "%s 忙时的只读接口返回 busy，不调用连接入口",
    async (source) => {
      const { browserControl } = await import("./browser-settings");
      if (source === "session")
        mocks.browserSessionSettings.mockReturnValue({
          mode: "dedicated",
          connected: false,
          busy: true,
        });
      if (source === "workflow") mocks.isBrowserWorkflowRunning.mockReturnValue(true);
      if (source === "capture") mocks.isCrawling.mockReturnValue(true);
      if (source === "analysis") mocks.isAnalyzing.mockReturnValue(true);
      if (source === "pending") browserControl.pending = 1;
      try {
        const res = await invoke(request("/api/browser/settings"));
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ busy: true });
        expect(mocks.getBrowser).not.toHaveBeenCalled();
        expect(mocks.changeBrowserMode).not.toHaveBeenCalled();
      } finally {
        browserControl.pending = 0;
      }
    },
  );

  it.each([undefined, null, "", "unknown", "DAILY", " daily ", true, 0, {}, []])(
    "拒绝无效的运行方式 %j，不尝试切换",
    async (mode) => {
      const res = await invoke(request("/api/browser/settings/save", "POST", { mode }));
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ error: "浏览器运行方式无效" });
      expect(mocks.changeBrowserMode).not.toHaveBeenCalled();
      expect(mocks.resetBrowserWorkflow).not.toHaveBeenCalled();
    },
  );

  it.each(["workflow", "capture", "analysis", "pending"])(
    "%s 忙时把实时 busy 回调交给 session，并返回 409 保留查询状态",
    async (source) => {
      const { browserControl } = await import("./browser-settings");
      if (source === "workflow") mocks.isBrowserWorkflowRunning.mockReturnValue(true);
      if (source === "capture") mocks.isCrawling.mockReturnValue(true);
      if (source === "analysis") mocks.isAnalyzing.mockReturnValue(true);
      if (source === "pending") browserControl.pending = 1;
      try {
        const res = await invoke(request("/api/browser/settings/save", "POST", { mode: "daily" }));
        expect(res.statusCode).toBe(409);
        expect(mocks.changeBrowserMode).toHaveBeenCalledExactlyOnceWith(
          "daily",
          expect.any(Function),
          mocks.resetBrowserWorkflow,
        );
        expect(mocks.changeBrowserMode.mock.calls[0][1]()).toBe(true);
        expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
          error: "请先等待浏览器任务结束",
        });
        expect(mocks.resetBrowserWorkflow).not.toHaveBeenCalled();
        expect(mocks.getBrowser).not.toHaveBeenCalled();
      } finally {
        browserControl.pending = 0;
      }
    },
  );

  it.each(["daily", "dedicated"])("成功保存 %s 并将查询重置交给 session", async (mode) => {
    const res = await invoke(request("/api/browser/settings/save", "POST", { mode }));
    expect(res.statusCode).toBe(200);
    expect(mocks.changeBrowserMode).toHaveBeenCalledExactlyOnceWith(
      mode,
      expect.any(Function),
      mocks.resetBrowserWorkflow,
    );
    expect(mocks.changeBrowserMode.mock.calls[0][1]()).toBe(false);
    expect(mocks.resetBrowserWorkflow).toHaveBeenCalledOnce();
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ mode, connected: false, busy: false });
    expect(mocks.getBrowser).not.toHaveBeenCalled();
  });

  it("切换自身持有锁时转交 session 的忙错误，返回 409", async () => {
    mocks.changeBrowserMode.mockRejectedValue(
      Object.assign(new Error("浏览器正在切换，请稍后重试"), {
        name: "BrowserSessionBusyError",
      }),
    );
    const res = await invoke(request("/api/browser/settings/save", "POST", { mode: "daily" }));
    expect(res.statusCode).toBe(409);
    expect(mocks.resetBrowserWorkflow).not.toHaveBeenCalled();
  });

  it("真实切换错误返回 500，不把持久化失败报告为成功", async () => {
    mocks.changeBrowserMode.mockRejectedValue(new Error("模式写入失败"));
    const res = await invoke(request("/api/browser/settings/save", "POST", { mode: "daily" }));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ error: "模式写入失败" });
    expect(mocks.resetBrowserWorkflow).not.toHaveBeenCalled();
  });
});

it.each([
  ["/api/browser/settings", "POST"],
  ["/api/browser/settings/save", "GET"],
])("%s 保持方法和来源检查", async (pathname, method) => {
  const unsupported = await invoke(request(pathname, method));
  expect(unsupported.statusCode).toBe(405);
  const crossOrigin = request(pathname, method === "POST" ? "GET" : "POST", { mode: "daily" });
  crossOrigin.headers.origin = "http://untrusted.example";
  const forbidden = await invoke(crossOrigin);
  expect(forbidden.statusCode).toBe(403);
  expect(mocks.changeBrowserMode).not.toHaveBeenCalled();
  expect(mocks.getBrowser).not.toHaveBeenCalled();
});

it.each([
  "/api/browser/open",
  "/api/crawl/start",
  "/api/analysis/start",
  "/api/analysis/equipment/check",
])("模式切换锁阻止 %s 启动，并在拒绝后释放 pending", async (pathname) => {
  const { browserControl } = await import("./browser-settings");
  browserControl.changing = true;
  try {
    const res = await invoke(request(pathname, "POST"));
    expect(res.statusCode).toBe(409);
    expect(browserControl.pending).toBe(0);
    expect(mocks.openCbg).not.toHaveBeenCalled();
    expect(mocks.startCrawl).not.toHaveBeenCalled();
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
    expect(mocks.checkEquipment).not.toHaveBeenCalled();
    expect(mocks.getBrowser).not.toHaveBeenCalled();
  } finally {
    browserControl.changing = false;
  }
});

it("控制请求尚未完成或 HTTP 已断开时保留 pending，业务结束后才释放", async () => {
  const { browserControl } = await import("./browser-settings");
  let started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  let finish!: (value: { started: boolean; status: { running: boolean } }) => void;
  const held = new Promise<{ started: boolean; status: { running: boolean } }>(
    (resolve) => (finish = resolve),
  );
  mocks.startCrawl.mockImplementation(() => {
    started();
    return held;
  });
  const res = response();
  const api = (await import("./api")).apiMiddleware;
  const running = api(request("/api/crawl/start", "POST"), res, vi.fn());
  try {
    await entered;
    expect(browserControl.pending).toBe(1);
    res.destroyed = true;
    res.emit("close");
    expect(browserControl.pending).toBe(1);
    const save = await invoke(request("/api/browser/settings/save", "POST", { mode: "daily" }));
    expect(save.statusCode).toBe(409);
    expect(mocks.resetBrowserWorkflow).not.toHaveBeenCalled();
    expect(browserControl.pending).toBe(1);
  } finally {
    finish({ started: false, status: { running: true } });
    await running;
  }
  expect(browserControl.pending).toBe(0);
});

it("兼容单元素 modes 保存，但拒绝双开、空选择和重复值", async () => {
  mocks.changeBrowserModes.mockImplementation(async (modes) => {
    mocks.browserSessionSettings.mockReturnValue({
      mode: modes[0],
      modes,
      connected: false,
      busy: false,
    });
  });
  const res = await invoke(request("/api/browser/settings/save", "POST", { modes: ["daily"] }));
  expect(res.statusCode).toBe(200);
  expect(mocks.changeBrowserModes).toHaveBeenCalledExactlyOnceWith(
    ["daily"],
    expect.any(Function),
    mocks.resetBrowserWorkflow,
  );
  expect(JSON.parse(res.end.mock.calls[0][0]).modes).toEqual(["daily"]);
  for (const modes of [[], ["dedicated", "daily"], ["daily", "daily"], ["chrome"], null, "daily"]) {
    const invalid = await invoke(request("/api/browser/settings/save", "POST", { modes }));
    expect(invalid.statusCode).toBe(400);
  }
  expect(mocks.changeBrowserModes).toHaveBeenCalledOnce();
});
