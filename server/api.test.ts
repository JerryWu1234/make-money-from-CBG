import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  isCrawling: vi.fn(),
  clearCrawl: vi.fn(),
  startCrawl: vi.fn(),
  equipmentAnalysisSettings: vi.fn(),
  setEquipmentAnalysis: vi.fn(),
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
  checkPet: vi.fn(),
  checkPetGear: vi.fn(),
  equipmentCheckImported: vi.fn(),
  startAnalysis: vi.fn(),
  confirmSchoolFormula: vi.fn(),
  analysisOverview: vi.fn(),
  savedRecords: vi.fn(),
  markRecommendationViewed: vi.fn(),
  aiProvider: vi.fn(),
}));
vi.mock("./crawler/controller", () => mocks);
vi.mock("./crawler/schedule", () => mocks);
vi.mock("./browser", () => mocks);
vi.mock("./analysis/controller", () => ({
  ...mocks,
  analysisOverviewAsync: mocks.analysisOverview,
}));
vi.mock("./ai-connection", () => mocks);
vi.mock("./analysis/equipment-check", () => mocks);
vi.mock("./analysis/pet-check", () => mocks);
vi.mock("./analysis/pet-gear-check", () => mocks);
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
    return { ...mocks, analysisOverviewAsync: mocks.analysisOverview };
  });
  vi.doMock("./analysis/equipment-check", () => {
    mocks.equipmentCheckImported();
    return mocks;
  });
  mocks.isCrawling.mockReturnValue(false);
  mocks.isAnalyzing.mockReturnValue(false);
  mocks.aiProvider.mockReturnValue("codex");
  mocks.scanScheduleStatus.mockReturnValue({ mode: "disabled" });
  mocks.enableScanSchedule.mockReturnValue({ mode: "enabled" });
  mocks.checkCbgStatus.mockResolvedValue({
    running: false,
    isLoggedIn: true,
    workflowStep: "completed",
  });
});

it.each(["complete", "tasks", "all"])("采集记录接口把 %s 范围传入服务端分页", async (scope) => {
  mocks.savedRecords.mockReturnValue({ total: 0, items: [] });
  const req = request(`/api/crawl/records?page=2&pageSize=20&scope=${scope}`);
  req.method = "GET";
  const res = response();
  await (await import("./api")).apiMiddleware(req, res, vi.fn());
  expect(res.statusCode).toBe(200);
  expect(mocks.savedRecords).toHaveBeenCalledWith(2, 20, scope);
});

it("正式商品分析接口转交完整范围，拒绝无效范围", async () => {
  const req = request("/api/analysis/status?scope=complete");
  req.method = "GET";
  await (await import("./api")).apiMiddleware(req, response(), vi.fn());
  expect(mocks.analysisOverview).toHaveBeenCalledWith(
    expect.objectContaining({ scope: "complete" }),
    expect.any(AbortSignal),
  );
  for (const path of ["/api/analysis/status", "/api/crawl/records"]) {
    const invalid = request(`${path}?scope=unknown`);
    invalid.method = "GET";
    const res = response();
    await (await import("./api")).apiMiddleware(invalid, res, vi.fn());
    expect(res.statusCode).toBe(400);
  }
});

it("分析状态接口等待异步汇总结果，不提前返回空Promise对象", async () => {
  let finish!: (value: unknown) => void;
  mocks.analysisOverview.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const req = request("/api/analysis/status");
  req.method = "GET";
  const res = response();
  const pending = (await import("./api")).apiMiddleware(req, res, vi.fn());
  while (!finish) await Promise.resolve();
  expect(res.end).not.toHaveBeenCalled();
  finish({ ranking: [], records: { total: 707 } });
  await pending;
  expect(JSON.parse(res.end.mock.calls[0][0])).toMatchObject({ records: { total: 707 } });
});

it("记录页明确跳过推荐榜，默认请求仍保留推荐计算", async () => {
  const api = await import("./api");
  for (const includeRanking of ["false", "true"]) {
    const req = request(`/api/analysis/status?includeRanking=${includeRanking}`);
    req.method = "GET";
    await api.apiMiddleware(req, response(), vi.fn());
    const options = mocks.analysisOverview.mock.lastCall![0];
    if (includeRanking === "false") expect(options).toMatchObject({ includeRanking: false });
    else expect(options).not.toHaveProperty("includeRanking");
  }
});

it("分析状态接口传递独立的推荐榜页码", async () => {
  const req = request("/api/analysis/status?page=1&rankingPage=3");
  req.method = "GET";
  await (await import("./api")).apiMiddleware(req, response(), vi.fn());
  expect(mocks.analysisOverview).toHaveBeenCalledWith(
    expect.objectContaining({ page: 1, rankingPage: 3 }),
    expect.any(AbortSignal),
  );
});

it("明确确认飞升公式只保存当前角色的确认，不启动或修改分析批次", async () => {
  const productKeys = ["159:one", "377:two"];
  mocks.confirmSchoolFormula.mockReturnValue({ confirmed: 2, productKeys });
  const res = response();
  await (
    await import("./api")
  ).apiMiddleware(
    request("/api/analysis/school-formula/confirm", { productKeys, confirmed: true }),
    res,
    vi.fn(),
  );
  expect(mocks.confirmSchoolFormula).toHaveBeenCalledWith(productKeys, true);
  expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ confirmed: 2, productKeys });
  expect(mocks.startAnalysis).not.toHaveBeenCalled();
  expect(mocks.resumeAnalysis).not.toHaveBeenCalled();
});

it("飞升公式未经明确确认时保留校验错误，不启动模型", async () => {
  mocks.confirmSchoolFormula.mockImplementation(() => {
    throw Object.assign(new Error("请明确确认沿用原公式"), {
      name: "SchoolFormulaConfirmationError",
    });
  });
  const res = response();
  await (
    await import("./api")
  ).apiMiddleware(
    request("/api/analysis/school-formula/confirm", { productKeys: ["159:one"] }),
    res,
    vi.fn(),
  );
  expect(res.statusCode).toBe(400);
  expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ error: "请明确确认沿用原公式" });
  expect(mocks.startAnalysis).not.toHaveBeenCalled();
});

describe("关键操作请求日志", () => {
  it("记录继续分析的到达和返回，关联同一次请求且不保存请求体", async () => {
    const res = response();
    await (
      await import("./api")
    ).apiMiddleware(
      request("/api/analysis/resume", { runId: "batch", secret: "private-value" }),
      res,
      vi.fn(),
    );
    res.emit("finish");
    res.emit("close");
    const received = mocks.record.mock.calls.find(([event]) => event === "api.control_received")!;
    expect(received[1]).toEqual({
      requestId: expect.any(String),
      route: "/api/analysis/resume",
      method: "POST",
    });
    expect(mocks.record).toHaveBeenCalledWith("api.control_finished", {
      requestId: received[1].requestId,
      route: "/api/analysis/resume",
      status: 200,
      durationMs: expect.any(Number),
    });
    expect(mocks.record).not.toHaveBeenCalledWith("api.control_closed", expect.anything());
    expect(JSON.stringify(mocks.record.mock.calls)).not.toContain("private-value");
  });

  it.each([403, 405])("在启动流程前拒绝请求时仍记录返回状态 %s", async (status) => {
    const req = request("/api/browser/open");
    if (status === 403) req.headers.origin = "http://other.local";
    else req.method = "GET";
    const res = response();
    await (await import("./api")).apiMiddleware(req, res, vi.fn());
    res.emit("finish");
    expect(mocks.record).toHaveBeenCalledWith("api.control_received", expect.anything());
    expect(mocks.record).toHaveBeenCalledWith(
      "api.control_finished",
      expect.objectContaining({ status, route: "/api/browser/open" }),
    );
    expect(mocks.checkCbgStatus).not.toHaveBeenCalled();
  });

  it("客户端提前断开时只记录一次关闭，状态轮询不产生操作日志", async () => {
    let resolve!: () => void;
    mocks.resumeAnalysis.mockReturnValue(
      new Promise<void>((done) => {
        resolve = done;
      }),
    );
    const res = response();
    const { apiMiddleware } = await import("./api");
    const pending = apiMiddleware(
      request("/api/analysis/resume", { runId: "batch" }),
      res,
      vi.fn(),
    );
    await vi.waitFor(() => expect(mocks.resumeAnalysis).toHaveBeenCalled());
    res.emit("close");
    resolve();
    await pending;
    res.emit("finish");
    expect(
      mocks.record.mock.calls.filter(([event]) => event === "api.control_closed"),
    ).toHaveLength(1);
    expect(mocks.record).not.toHaveBeenCalledWith("api.control_finished", expect.anything());
    mocks.record.mockClear();
    const req = request("/api/analysis/status");
    req.method = "GET";
    await apiMiddleware(req, response(), vi.fn());
    expect(mocks.record).not.toHaveBeenCalled();
  });
});

it("首页装备开关读写不启动采集、登录或分析", async () => {
  const { apiMiddleware } = await import("./api");
  mocks.equipmentAnalysisSettings.mockReturnValue({ analyzeEquipment: false });
  const read = request("/api/crawl/settings");
  read.method = "GET";
  const res = response();
  await apiMiddleware(read, res, vi.fn());
  expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ analyzeEquipment: false });
  mocks.setEquipmentAnalysis.mockReturnValue({ analyzeEquipment: true });
  const saved = response();
  await apiMiddleware(
    request("/api/crawl/settings/save", { analyzeEquipment: true }),
    saved,
    vi.fn(),
  );
  expect(mocks.setEquipmentAnalysis).toHaveBeenCalledWith(true);
  expect(JSON.parse(saved.end.mock.calls[0][0])).toEqual({ analyzeEquipment: true });
  expect(mocks.startCrawl).not.toHaveBeenCalled();
  expect(mocks.startAnalysis).not.toHaveBeenCalled();
  expect(mocks.checkCbgStatus).not.toHaveBeenCalled();
});

describe("分析并发设置", () => {
  it.each([undefined, 2])("开始分析传入并发数 %s，未设置时默认10", async (concurrency) => {
    const res = response();
    await (
      await import("./api")
    ).apiMiddleware(
      request("/api/analysis/start", { provider: "codex", concurrency }),
      res,
      vi.fn(),
    );
    expect(mocks.startAnalysis).toHaveBeenCalledWith(
      "codex",
      false,
      false,
      undefined,
      1,
      undefined,
      false,
      concurrency ?? 10,
    );
    expect(res.statusCode).toBe(200);
  });
  it.each(["resume", "retry"])("%s 保留批次或传入新的并发数", async (action) => {
    const { apiMiddleware } = await import("./api");
    for (const concurrency of [undefined, 2]) {
      await apiMiddleware(
        request(`/api/analysis/${action}`, { runId: "batch", concurrency }),
        response(),
        vi.fn(),
      );
      expect(mocks.resumeAnalysis).toHaveBeenLastCalledWith(
        "batch",
        action === "retry",
        concurrency,
      );
    }
  });
  it.each(["start", "resume", "retry"])("%s 拒绝无效并发配置", async (action) => {
    const { apiMiddleware } = await import("./api");
    for (const concurrency of [0, -1, 1.5, "3", null]) {
      const res = response();
      await apiMiddleware(
        request(`/api/analysis/${action}`, { provider: "codex", runId: "batch", concurrency }),
        res,
        vi.fn(),
      );
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ error: "分析并发数必须是正整数" });
    }
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
    expect(mocks.resumeAnalysis).not.toHaveBeenCalled();
  });
});

describe("指定商品试分析", () => {
  it("宝宝装备表单诊断沿用请求取消，不启动AI或分析队列", async () => {
    const input = { productKey: "941:role", mode: "discover" };
    const result = { mode: "discover", inventory: { items: [] }, form: { controls: [] } };
    mocks.checkPetGear.mockResolvedValue(result);
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request("/api/analysis/pet-gear/check", input), res, vi.fn());
    expect(mocks.checkPetGear).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal));
    expect(res.end).toHaveBeenCalledWith(JSON.stringify(result));
    expect(res.listenerCount("close")).toBe(0);
    expect(mocks.analysisControllerImported).not.toHaveBeenCalled();
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
  });
  it("宝宝单项诊断沿用请求校验，不准备AI或创建分析批次", async () => {
    const input = { productKey: "941:role", petKey: "召唤兽/孩子:1" };
    mocks.checkPet.mockResolvedValue({ queries: ["全服"] });
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request("/api/analysis/pet/check", input), res, vi.fn());
    expect(mocks.checkPet.mock.calls[0][0]).toEqual(input);
    expect(mocks.checkPet.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
    expect(mocks.prepareAnalysisClient).not.toHaveBeenCalled();
  });
  it("传递明确商品列表，不替换成列表第一件", async () => {
    const input = { provider: "codex", sample: true, sampleSize: 1, productKeys: ["462:target"] };
    mocks.startAnalysis.mockResolvedValue({ id: "selected-run", total: 1 });
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request("/api/analysis/start", input), res, vi.fn());
    expect(mocks.startAnalysis).toHaveBeenCalledWith(
      "codex",
      false,
      true,
      undefined,
      1,
      ["462:target"],
      false,
      10,
    );
    expect(res.statusCode).toBe(200);
  });

  it.each([
    { sample: false, productKeys: ["a"] },
    { sample: true, productKeys: [] },
    { sample: true, sampleSize: 2, productKeys: ["a", "a"] },
    { sample: true, productKeys: ["a", "b"] },
    { sample: true, productKeys: [" a "] },
    { sample: true, productKeys: [42] },
  ])("拒绝不明确的商品选择 %j，不开始分析", async (input) => {
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request("/api/analysis/start", input), res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
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
  it.each(["/api/crawl/start", "/api/crawl/backfill"])("%s 传入配置的并发数", async (pathname) => {
    const { apiMiddleware } = await import("./api");
    mocks.startCrawl.mockResolvedValue({
      status: { running: true, concurrency: 2 },
      started: true,
    });
    const res = response();
    await apiMiddleware(request(pathname, { concurrency: 2 }), res, vi.fn());
    expect(mocks.startCrawl).toHaveBeenCalledWith("manual", undefined, {
      backfillOnly: pathname.endsWith("backfill"),
      keys: undefined,
      concurrency: 2,
    });
    expect(res.statusCode).toBe(200);
  });
  it.each([0, -1, 1, 3, 5, 1.5, "3", null])(
    "拒绝无效并发数 %j，不启动采集",
    async (concurrency) => {
      const { apiMiddleware } = await import("./api");
      const res = response();
      await apiMiddleware(request("/api/crawl/start", { concurrency }), res, vi.fn());
      expect(res.statusCode).toBe(500);
      expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({
        error: "并发数必须是正偶数（2、4、6…）",
      });
      expect(mocks.startCrawl).not.toHaveBeenCalled();
      expect(mocks.disableScanSchedule).not.toHaveBeenCalled();
    },
  );
  it("仅明确单商品补采可请求完整刷新", async () => {
    const { apiMiddleware } = await import("./api");
    const key = "33:target";
    mocks.startCrawl.mockResolvedValueOnce({ status: { running: true }, started: true });
    await apiMiddleware(
      request("/api/crawl/backfill", { keys: [key], refresh: true }),
      response(),
      vi.fn(),
    );
    expect(mocks.startCrawl).toHaveBeenCalledExactlyOnceWith("manual", undefined, {
      backfillOnly: true,
      keys: [key],
      refresh: true,
    });
  });
  it.each([
    ["/api/crawl/start", { keys: ["33:target"], refresh: true }],
    ["/api/crawl/backfill", { refresh: true }],
    ["/api/crawl/backfill", { keys: [], refresh: true }],
    ["/api/crawl/backfill", { keys: ["33:target", "34:other"], refresh: true }],
    ["/api/crawl/backfill", { keys: [" "], refresh: true }],
    ["/api/crawl/backfill", { keys: ["33:target "], refresh: true }],
    ["/api/crawl/backfill", { keys: ["33:target"], refresh: "true" }],
  ])("拒绝无单商品边界的刷新：%s %j", async (pathname, body) => {
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(request(pathname, body), res, vi.fn());
    expect(res.statusCode).toBe(500);
    expect(mocks.startCrawl).not.toHaveBeenCalled();
    expect(mocks.disableScanSchedule).not.toHaveBeenCalled();
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

// Failure cases: view requests reach analysis execution, GET defaults expose viewed
// products, or the show-viewed option is not forwarded to the ranking filter.
it("推荐查看接口仅保存标记，读取默认隐藏且支持显示已查看", async () => {
  const { apiMiddleware } = await import("./api");
  mocks.markRecommendationViewed.mockReturnValue({ key: "product", viewed: true });
  const res = response();
  await apiMiddleware(
    request("/api/analysis/recommendation/view", { key: "product" }),
    res,
    vi.fn(),
  );
  expect(mocks.markRecommendationViewed).toHaveBeenCalledWith("product");
  expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ key: "product", viewed: true });
  for (const show of [false, true]) {
    const read = request("/api/analysis/status" + (show ? "?showViewed=true" : ""));
    read.method = "GET";
    mocks.analysisOverview.mockReturnValue({ ranking: [] });
    await apiMiddleware(read, response(), vi.fn());
    expect(mocks.analysisOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ showViewed: show }),
      expect.any(AbortSignal),
    );
  }
  expect(mocks.startAnalysis).not.toHaveBeenCalled();
});
