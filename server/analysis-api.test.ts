import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  analysisOverview: vi.fn(),
  analysisProgress: vi.fn(),
  analysisDetail: vi.fn(),
  startAnalysis: vi.fn(),
  resumeAnalysis: vi.fn(),
  pauseAnalysis: vi.fn(),
  analysisSettings: vi.fn(),
  saveAnalysisSettings: vi.fn(),
  record: vi.fn(),
}));
vi.mock("./analysis/controller", () => ({
  ...mocks,
  analysisOverviewAsync: mocks.analysisOverview,
}));
vi.mock("./ai-connection", () => ({
  aiProvider: (value: unknown) => {
    if (value !== "codex" && value !== "deepseek") throw new Error("请选择 Codex 或 DeepSeek");
    return value;
  },
}));
vi.mock("./diagnostics", () => ({ diagnostics: { record: mocks.record } }));
function request(url: string, body?: unknown, origin = "http://127.0.0.1:5173") {
  return Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), {
    url,
    method: body === undefined ? "GET" : "POST",
    headers: { host: "127.0.0.1:5173", origin },
  }) as IncomingMessage;
}
function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    destroyed: false,
    setHeader: vi.fn(),
    end: vi.fn(),
  });
}
beforeEach(() => vi.resetAllMocks());
describe("商品分析 HTTP 链路", () => {
  it("只查装备的启动选项必须是布尔值并传入批次", async () => {
    const { apiMiddleware } = await import("./api");
    await apiMiddleware(
      request("/api/analysis/start", { provider: "codex", equipmentOnly: true }),
      response() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.startAnalysis).toHaveBeenCalledWith(
      "codex",
      false,
      false,
      undefined,
      1,
      undefined,
      true,
      10,
    );
    mocks.startAnalysis.mockClear();
    for (const equipmentOnly of ["true", 1, null, {}]) {
      const invalid = response();
      await apiMiddleware(
        request("/api/analysis/start", { provider: "codex", equipmentOnly }),
        invalid as unknown as ServerResponse,
        vi.fn(),
      );
      expect(invalid.statusCode).toBe(500);
    }
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
  });
  it("设置接口接收完整中文Prompt，其他操作保留小请求限制", async () => {
    const { apiMiddleware } = await import("./api");
    const input = { template: "估值规则".repeat(2000), settings: {}, baseHash: "current" };
    mocks.saveAnalysisSettings.mockReturnValue({ profile: { hash: "updated" } });
    const saved = response();
    await apiMiddleware(
      request("/api/analysis/settings/save", input),
      saved as unknown as ServerResponse,
      vi.fn(),
    );
    expect(saved.statusCode).toBe(200);
    expect(mocks.saveAnalysisSettings).toHaveBeenCalledWith(input);
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
    await apiMiddleware(
      request("/api/analysis/settings"),
      response() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.analysisSettings).toHaveBeenCalledOnce();
    const oversized = response();
    await apiMiddleware(
      request("/api/analysis/start", input),
      oversized as unknown as ServerResponse,
      vi.fn(),
    );
    expect(oversized.statusCode).toBe(500);
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
    await apiMiddleware(
      request("/api/analysis/start", { provider: "codex", sample: true }),
      response() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.startAnalysis).toHaveBeenCalledWith(
      "codex",
      false,
      true,
      undefined,
      1,
      undefined,
      false,
      10,
    );
  });
  it("开始请求指定提供方，刷新状态不会启动 SDK", async () => {
    mocks.startAnalysis.mockResolvedValue({ id: "run", provider: "deepseek" });
    mocks.analysisOverview.mockReturnValue({ run: null });
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(
      request("/api/analysis/start", { provider: "deepseek" }),
      res as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.startAnalysis).toHaveBeenCalledWith(
      "deepseek",
      false,
      false,
      undefined,
      1,
      undefined,
      false,
      10,
    );
    await apiMiddleware(
      request("/api/analysis/status?provider=deepseek&page=2&search=宝宝&filter=failed"),
      response() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.analysisOverview).toHaveBeenCalledWith(
      {
        provider: "deepseek",
        page: 2,
        resultsPage: 1,
        summary: true,
        showViewed: false,
        search: "宝宝",
        filter: "failed",
        runId: undefined,
      },
      expect.any(AbortSignal),
    );
    expect(mocks.startAnalysis).toHaveBeenCalledTimes(1);
  });
  it("实时进度走独立轻量接口，不执行记录和排名汇总", async () => {
    mocks.analysisProgress.mockReturnValue({ run: { completed: 42 }, activeRun: null });
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(
      request("/api/analysis/progress?provider=codex&scope=complete"),
      res as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.analysisProgress).toHaveBeenCalledWith({
      provider: "codex",
      runId: undefined,
      scope: "complete",
    });
    expect(mocks.analysisOverview).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
  it("开始分析传入所选模型，默认留空；无效类型不会启动队列", async () => {
    const { apiMiddleware } = await import("./api");
    await apiMiddleware(
      request("/api/analysis/start", { provider: "codex", model: "other-model", sample: true }),
      response() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.startAnalysis).toHaveBeenCalledWith(
      "codex",
      false,
      true,
      "other-model",
      1,
      undefined,
      false,
      10,
    );
    mocks.startAnalysis.mockClear();
    const invalid = response();
    await apiMiddleware(
      request("/api/analysis/start", { provider: "codex", model: { id: "other-model" } }),
      invalid as unknown as ServerResponse,
      vi.fn(),
    );
    expect(invalid.statusCode).toBe(500);
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
  });
  it("试分析数量限制为1到3件，非法数量不会发起AI调用", async () => {
    const { apiMiddleware } = await import("./api");
    await apiMiddleware(
      request("/api/analysis/start", {
        provider: "codex",
        sample: true,
        sampleSize: 3,
        model: "gpt-6-luna",
      }),
      response() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.startAnalysis).toHaveBeenCalledWith(
      "codex",
      false,
      true,
      "gpt-6-luna",
      3,
      undefined,
      false,
      10,
    );
    mocks.startAnalysis.mockClear();
    for (const sampleSize of [0, 4, 1.5, "3", null]) {
      const invalid = response();
      await apiMiddleware(
        request("/api/analysis/start", { provider: "codex", sample: true, sampleSize }),
        invalid as unknown as ServerResponse,
        vi.fn(),
      );
      expect(invalid.statusCode).toBe(500);
    }
    const withoutSample = response();
    await apiMiddleware(
      request("/api/analysis/start", { provider: "codex", sampleSize: 3 }),
      withoutSample as unknown as ServerResponse,
      vi.fn(),
    );
    expect(withoutSample.statusCode).toBe(500);
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
  });
  it("关闭浏览器连接不取消持久化的后台队列", async () => {
    const res = response();
    mocks.startAnalysis.mockImplementation(() => {
      res.destroyed = true;
      res.emit("close");
      return { id: "run" };
    });
    const { apiMiddleware } = await import("./api");
    await apiMiddleware(
      request("/api/analysis/start", { provider: "codex" }),
      res as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.pauseAnalysis).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);
  });
  it("继续和重试绑定原批次，不接受浏览器替换其提供方", async () => {
    const { apiMiddleware } = await import("./api");
    await apiMiddleware(
      request("/api/analysis/resume", { runId: "run", provider: "deepseek" }),
      response() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.resumeAnalysis).toHaveBeenLastCalledWith("run", false, undefined);
    await apiMiddleware(
      request("/api/analysis/retry", { runId: "run" }),
      response() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.resumeAnalysis).toHaveBeenLastCalledWith("run", true, undefined);
  });
  it("导出的是数据库中的当次完整原文和完整请求", async () => {
    mocks.analysisDetail.mockReturnValue({
      inputHash: "hash",
      inputText: "原文\n宝宝1\n宝宝8",
      promptHash: "prompt-hash",
      promptText: "规则\n完整原文",
    });
    const { apiMiddleware } = await import("./api");
    const original = response();
    await apiMiddleware(
      request("/api/analysis/input?taskId=task"),
      original as unknown as ServerResponse,
      vi.fn(),
    );
    expect(original.setHeader).toHaveBeenCalledWith("Content-Type", "text/plain; charset=utf-8");
    expect(original.end).toHaveBeenCalledWith("原文\n宝宝1\n宝宝8");
    const prompt = response();
    await apiMiddleware(
      request("/api/analysis/input?taskId=task&kind=prompt"),
      prompt as unknown as ServerResponse,
      vi.fn(),
    );
    expect(prompt.end).toHaveBeenCalledWith("规则\n完整原文");
  });
  it("跨域来源和未知提供方不能启动分析", async () => {
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(
      request("/api/analysis/start", { provider: "codex" }, "https://untrusted.invalid"),
      res as unknown as ServerResponse,
      vi.fn(),
    );
    expect(res.statusCode).toBe(403);
    await apiMiddleware(
      request("/api/analysis/start", { provider: "other" }),
      response() as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.startAnalysis).not.toHaveBeenCalled();
  });
});
