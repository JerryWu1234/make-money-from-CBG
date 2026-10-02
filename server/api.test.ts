import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  isCrawling: vi.fn(),
  clearCrawl: vi.fn(),
  startCrawl: vi.fn(),
  disableScanSchedule: vi.fn(),
  scanScheduleStatus: vi.fn(),
  enableScanSchedule: vi.fn(),
  checkCbgStatus: vi.fn(),
  record: vi.fn(),
  isAnalyzing: vi.fn(),
}));
vi.mock("./crawler/controller", () => mocks);
vi.mock("./crawler/schedule", () => mocks);
vi.mock("./browser", () => mocks);
vi.mock("./analysis/controller", () => mocks);
vi.mock("./diagnostics", () => ({ diagnostics: { record: mocks.record } }));

function request(pathname: string) {
  return Object.assign(Readable.from(["{}"]), {
    url: pathname,
    method: "POST",
    headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
  }) as IncomingMessage;
}

function response() {
  return {
    statusCode: 200,
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as ServerResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isCrawling.mockReturnValue(false);
  mocks.isAnalyzing.mockReturnValue(false);
  mocks.scanScheduleStatus.mockReturnValue({ mode: "disabled" });
  mocks.enableScanSchedule.mockReturnValue({ mode: "enabled" });
  mocks.checkCbgStatus.mockResolvedValue({
    running: false,
    isLoggedIn: true,
    workflowStep: "completed",
  });
});

describe("采集接口与定时计划", () => {
  it("未登录或角色列表未就绪时拒绝启用计划", async () => {
    mocks.checkCbgStatus.mockResolvedValueOnce({
      running: true,
      isLoggedIn: false,
      workflowStep: "logging_in",
    });
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request("/api/scan/enable"), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(mocks.enableScanSchedule).not.toHaveBeenCalled();

    mocks.checkCbgStatus.mockResolvedValueOnce({
      running: false,
      isLoggedIn: true,
      workflowStep: "role_list",
    });
    const unfinished = response();
    await apiMiddleware(request("/api/scan/enable"), unfinished, vi.fn());
    expect(unfinished.statusCode).toBe(409);
    expect(mocks.enableScanSchedule).not.toHaveBeenCalled();
  });

  it("已登录且角色列表就绪时可启用计划", async () => {
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request("/api/scan/enable"), res, vi.fn());
    expect(res.statusCode).toBe(200);
    expect(mocks.enableScanSchedule).toHaveBeenCalledTimes(1);
  });

  it("计划暂停后可在未登录时恢复，以便重新准备登录", async () => {
    mocks.scanScheduleStatus.mockReturnValue({ mode: "suspended" });
    const { apiMiddleware } = await import("./api");
    await apiMiddleware(request("/api/scan/enable"), response(), vi.fn());
    expect(mocks.checkCbgStatus).not.toHaveBeenCalled();
    expect(mocks.enableScanSchedule).toHaveBeenCalledTimes(1);
  });

  it("手动采集中拒绝启用计划", async () => {
    mocks.isCrawling.mockReturnValue(true);
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request("/api/scan/enable"), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(mocks.enableScanSchedule).not.toHaveBeenCalled();
  });

  it("采集中拒绝清空，不清数据也不关闭计划", async () => {
    mocks.isCrawling.mockReturnValue(true);
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request("/api/crawl/clear"), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(mocks.clearCrawl).not.toHaveBeenCalled();
    expect(mocks.disableScanSchedule).not.toHaveBeenCalled();
  });

  it("手动采集真正启动后才关闭计划", async () => {
    const { apiMiddleware } = await import("./api");
    mocks.startCrawl.mockResolvedValueOnce({ status: { running: true }, started: false });
    await apiMiddleware(request("/api/crawl/start"), response(), vi.fn());
    expect(mocks.disableScanSchedule).not.toHaveBeenCalled();
    mocks.startCrawl.mockResolvedValueOnce({ status: { running: true }, started: true });
    await apiMiddleware(request("/api/crawl/start"), response(), vi.fn());
    expect(mocks.disableScanSchedule).toHaveBeenCalledTimes(1);
  });
  it("分析仍在执行时拒绝清空，不删除数据也不关闭计划", async () => {
    mocks.isAnalyzing.mockReturnValue(true);
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request("/api/crawl/clear"), res, vi.fn());
    expect(res.statusCode).toBe(409);
    expect(mocks.clearCrawl).not.toHaveBeenCalled();
    expect(mocks.disableScanSchedule).not.toHaveBeenCalled();
  });
});
