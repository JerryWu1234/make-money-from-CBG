import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  aiStatus: vi.fn(),
  aiModels: vi.fn(),
  verifyAi: vi.fn(),
  startCodexLogin: vi.fn(),
  codexLoginStatus: vi.fn(),
  cancelCodexLogin: vi.fn(),
  record: vi.fn(),
}));
vi.mock("./ai-connection", () => ({
  ...mocks,
  aiProvider: (value: unknown) => {
    if (value !== "codex" && value !== "deepseek") throw new Error("请选择 Codex 或 DeepSeek");
    return value;
  },
}));
vi.mock("./diagnostics", () => ({ diagnostics: { record: mocks.record } }));

function request(path: string, body: string, origin = "http://127.0.0.1:5173") {
  return Object.assign(Readable.from([body]), {
    url: path,
    method: "POST",
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

describe("AI HTTP 接口", () => {
  it("模型列表显式绑定提供方，读取时不会触发验证调用", async () => {
    const { apiMiddleware } = await import("./api");
    const req = request("/api/ai/models?provider=codex", "");
    req.method = "GET";
    const options = { provider: "codex", defaultModel: "configured-model", models: [] };
    mocks.aiModels.mockResolvedValue(options);
    const res = response();
    await apiMiddleware(req, res as unknown as ServerResponse, vi.fn());
    expect(mocks.aiModels).toHaveBeenCalledWith("codex");
    expect(res.end).toHaveBeenCalledWith(JSON.stringify(options));
    expect(mocks.verifyAi).not.toHaveBeenCalled();
  });

  it("请求显式绑定所选服务", async () => {
    mocks.verifyAi.mockResolvedValue({ state: "connected", response: "READY" });
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(
      request("/api/ai/verify", '{"provider":"deepseek","apiKey":"test-key"}'),
      res as unknown as ServerResponse,
      vi.fn(),
    );
    expect(mocks.verifyAi).toHaveBeenCalledWith(
      "deepseek",
      { provider: "deepseek", apiKey: "test-key" },
      expect.any(AbortSignal),
    );
    expect(res.end).toHaveBeenCalledWith(JSON.stringify({ state: "connected", response: "READY" }));
  });

  it("浏览器断开时中止后端验证", async () => {
    const res = response();
    mocks.verifyAi.mockImplementation((_provider, _body, signal: AbortSignal) => {
      res.emit("close");
      expect(signal.aborted).toBe(true);
      return { state: "error" };
    });
    const { apiMiddleware } = await import("./api");
    await apiMiddleware(
      request("/api/ai/verify", '{"provider":"codex"}'),
      res as unknown as ServerResponse,
      vi.fn(),
    );
    expect(res.listenerCount("close")).toBe(0);
  });

  it("跨域页面不能配置凭据或发起模型调用", async () => {
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(
      request("/api/ai/verify", '{"provider":"deepseek"}', "https://example.invalid"),
      res as unknown as ServerResponse,
      vi.fn(),
    );
    expect(res.statusCode).toBe(403);
    expect(mocks.verifyAi).not.toHaveBeenCalled();
  });

  it("格式错误的密钥请求不会把请求正文写进错误或日志", async () => {
    const { apiMiddleware } = await import("./api");
    const res = response();
    await apiMiddleware(
      request("/api/ai/verify", '{"apiKey":"test-private-key",broken'),
      res as unknown as ServerResponse,
      vi.fn(),
    );
    expect(vi.mocked(res.end).mock.calls.flat().join("")).not.toContain("test-private-key");
    expect(mocks.record.mock.calls[0][1].error.message).toBe("请求格式错误");
    expect(mocks.verifyAi).not.toHaveBeenCalled();
  });
});
