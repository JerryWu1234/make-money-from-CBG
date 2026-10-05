import { EventEmitter } from "node:events";
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
  analysisControllerImported: vi.fn(),
  resumeAnalysis: vi.fn(),
  prepareAnalysisClient: vi.fn(),
  checkEquipment: vi.fn(),
  equipmentCheckImported: vi.fn(),
}));
vi.mock("./crawler/controller", () => mocks);
vi.mock("./crawler/schedule", () => mocks);
vi.mock("./browser", () => mocks);
vi.mock("./analysis/controller", () => mocks);
vi.mock("./ai-connection", () => mocks);
vi.mock("./analysis/equipment-check", () => mocks);
vi.mock("./diagnostics", () => ({ diagnostics: { record: mocks.record } }));

function request(pathname: string, body: Record<string, unknown> = {}) {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    url: pathname,
    method: "POST",
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

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
  vi.doMock("./analysis/controller", () => {
    mocks.analysisControllerImported();
    return mocks;
  });
  vi.doMock("./analysis/equipment-check", () => {
    mocks.equipmentCheckImported();
    return mocks;
  });
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

describe("指定商品装备查价接口", () => {
  it("取消监听注册前响应已关闭时，不加载查价服务或分析队列", async () => {
    const { apiMiddleware } = await import("./api");
    const res = response();
    res.destroyed = true;
    res.emit("close");
    await apiMiddleware(
      request("/api/analysis/equipment/check", {
        productKey: "product-1",
        equipmentKey: "equipment-2",
      }),
      res,
      vi.fn(),
    );
    expect(mocks.equipmentCheckImported).not.toHaveBeenCalled();
    expect(mocks.checkEquipment).not.toHaveBeenCalled();
    expect(mocks.analysisControllerImported).not.toHaveBeenCalled();
    expect(mocks.resumeAnalysis).not.toHaveBeenCalled();
    expect(mocks.prepareAnalysisClient).not.toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);
    expect(res.end).not.toHaveBeenCalled();
  });

  it("传递指定商品和装备，并直接返回查价结果，不加载分析队列或准备 AI", async () => {
    const input = { productKey: "product-1", equipmentKey: "equipment-2" };
    const result = { target: input, candidates: [], issues: [] };
    mocks.checkEquipment.mockResolvedValue(result);
    const { apiMiddleware } = await import("./api");
    const res = response();
    const next = vi.fn();
    await apiMiddleware(request("/api/analysis/equipment/check", input), res, next);
    expect(res.statusCode).toBe(200);
    expect(res.end).toHaveBeenCalledWith(JSON.stringify(result));
    expect(mocks.checkEquipment).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal));
    expect(mocks.checkEquipment.mock.calls[0][1].aborted).toBe(false);
    expect(res.listenerCount("close")).toBe(0);
    expect(next).not.toHaveBeenCalled();
    expect(mocks.analysisControllerImported).not.toHaveBeenCalled();
    expect(mocks.resumeAnalysis).not.toHaveBeenCalled();
    expect(mocks.prepareAnalysisClient).not.toHaveBeenCalled();
  });

  it("返回查价服务的校验错误，并清除取消监听", async () => {
    const input = { productKey: "", equipmentKey: "equipment-2" };
    const error = new Error("productKey 必须是非空字符串，且不超过100字");
    mocks.checkEquipment.mockRejectedValue(error);
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request("/api/analysis/equipment/check", input), res, vi.fn());
    expect(mocks.checkEquipment).toHaveBeenCalledWith(input, expect.any(AbortSignal));
    expect(res.statusCode).toBe(500);
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ error: error.message }));
    expect(mocks.record).toHaveBeenCalledWith("api.error", {
      route: "/api/analysis/equipment/check",
      error,
    });
    expect(res.listenerCount("close")).toBe(0);
    expect(mocks.analysisControllerImported).not.toHaveBeenCalled();
    expect(mocks.resumeAnalysis).not.toHaveBeenCalled();
    expect(mocks.prepareAnalysisClient).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"])(
    "连接关闭后取消查价，等待清理后 %s，且不写入已销毁响应",
    async (outcome) => {
      let begin!: () => void;
      let finishCleanup!: () => void;
      let signal!: AbortSignal;
      const started = new Promise<void>((resolve) => {
        begin = resolve;
      });
      const cleanup = new Promise<void>((resolve) => {
        finishCleanup = resolve;
      });
      mocks.checkEquipment.mockImplementation(async (_input, requestSignal: AbortSignal) => {
        signal = requestSignal;
        begin();
        await cleanup;
        if (outcome === "reject") throw new Error("查价已取消");
        return { candidates: [], issues: [] };
      });
      const { apiMiddleware } = await import("./api");
      const res = response();
      let completed = false;
      const pending = apiMiddleware(
        request("/api/analysis/equipment/check", {
          productKey: "product-1",
          equipmentKey: "equipment-2",
        }),
        res,
        vi.fn(),
      ).then(() => {
        completed = true;
      });
      await started;
      const cancel = res.listeners("close")[0];
      const removeListener = vi.spyOn(res, "removeListener");
      expect(signal.aborted).toBe(false);
      res.destroyed = true;
      res.emit("close");
      expect(signal.aborted).toBe(true);
      expect(completed).toBe(false);
      expect(res.end).not.toHaveBeenCalled();
      expect(removeListener).not.toHaveBeenCalledWith("close", cancel);

      finishCleanup();
      await pending;
      expect(completed).toBe(true);
      expect(removeListener).toHaveBeenCalledWith("close", cancel);
      expect(res.listenerCount("close")).toBe(0);
      expect(res.end).not.toHaveBeenCalled();
      expect(mocks.analysisControllerImported).not.toHaveBeenCalled();
      expect(mocks.resumeAnalysis).not.toHaveBeenCalled();
      expect(mocks.prepareAnalysisClient).not.toHaveBeenCalled();
    },
  );
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
