import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  run: vi.fn(),
  startThread: vi.fn(),
  options: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({ mkdtemp: mocks.mkdtemp, rm: mocks.rm }));
vi.mock("@openai/codex-sdk", () => ({
  Codex: vi.fn(function (options: unknown) {
    mocks.options(options);
    return { startThread: mocks.startThread };
  }),
}));

let send: (message: unknown) => void;
let requests: { id: number; method: string; params: Record<string, unknown> }[];
let rpcResults: Record<string, unknown>;

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.mkdtemp.mockResolvedValue("/private/tmp/cbg-codex-fixture");
  mocks.rm.mockResolvedValue(undefined);
  mocks.run.mockResolvedValue({ finalResponse: "READY" });
  mocks.startThread.mockReturnValue({ run: mocks.run });
  requests = [];
  rpcResults = {
    "config/read": { config: { model: "configured-model" } },
    "model/list": {
      data: [
        { model: "configured-model", displayName: "当前默认模型", isDefault: true },
        { model: "other-model", displayName: "另一个模型" },
        { model: "hidden-model", displayName: "隐藏模型", hidden: true },
      ],
      nextCursor: null,
    },
  };
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  child.kill.mockImplementation(() => {
    child.emit("exit", 0);
    return true;
  });
  send = (message) => child.stdout.write(JSON.stringify(message) + "\n");
  child.stdin.on("data", (data: Buffer) => {
    const message = JSON.parse(data.toString()) as (typeof requests)[number];
    requests.push(message);
    if (message.id === undefined) return;
    const result =
      message.method === "account/login/start"
        ? { loginId: "fixture-login", authUrl: "https://auth.openai.com/oauth/authorize?fixture=1" }
        : rpcResults[message.method] || {};
    send({ id: message.id, result });
  });
  mocks.spawn.mockReturnValue(child);
});

afterEach(async () => {
  await (await import("./codex")).shutdownCodex();
  vi.unstubAllEnvs();
});

describe("官方 Codex 登录与 SDK", () => {
  it("模型选择读取官方列表，默认沿用用户配置，不改写全局设置", async () => {
    const { codexModel, codexModels } = await import("./codex");
    expect(await codexModel()).toBe("configured-model");
    expect(await codexModels()).toEqual([
      { id: "configured-model", name: "当前默认模型" },
      { id: "other-model", name: "另一个模型" },
    ]);
    expect(requests.find((request) => request.method === "model/list")?.params).toEqual({
      limit: 100,
      includeHidden: false,
    });
    expect(
      requests.some(
        (request) => request.method.startsWith("config/") && request.method.endsWith("write"),
      ),
    ).toBe(false);
    rpcResults["config/read"] = { config: { model: null } };
    expect(await codexModel()).toBe("configured-model");
  });

  it("发起官方浏览器登录，并接收完成通知", async () => {
    const codex = await import("./codex");
    const login = await codex.startCodexLogin();
    expect(login.state).toBe("pending");
    expect(login.authUrl).toMatch(/^https:\/\/auth\.openai\.com\//);
    expect(requests.find((request) => request.method === "account/login/start")?.params.type).toBe(
      "chatgpt",
    );
    send({ method: "account/login/completed", params: { loginId: login.loginId, success: true } });
    expect(codex.codexLoginStatus(login.loginId).state).toBe("completed");
  });

  it("取消只取消待完成登录，不退出用户已有的全局账号", async () => {
    const codex = await import("./codex");
    const login = await codex.startCodexLogin();
    await codex.cancelCodexLogin(login.loginId);
    expect(codex.codexLoginStatus(login.loginId).state).toBe("cancelled");
    expect(requests.some((request) => request.method === "account/login/cancel")).toBe(true);
    expect(requests.some((request) => request.method === "account/logout")).toBe(false);
    send({ method: "account/login/completed", params: { loginId: login.loginId, success: true } });
    expect(codex.codexLoginStatus(login.loginId).state).toBe("cancelled");
  });

  it("SDK 使用 ChatGPT 登录并隔离商品目录和 API Key", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-api-key");
    vi.stubEnv("CODEX_API_KEY", "fixture-codex-key");
    const { probeCodex } = await import("./codex");
    const signal = new AbortController().signal;
    expect(await probeCodex("Reply READY.", signal)).toBe("READY");
    const options = mocks.options.mock.calls[0][0];
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.CODEX_API_KEY).toBeUndefined();
    expect(options.config.forced_login_method).toBe("chatgpt");
    expect(mocks.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/private/tmp/cbg-codex-fixture",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }),
    );
    expect(mocks.run).toHaveBeenCalledWith("Reply READY.", { signal });
  });
  it("完整商品调用传入固定模型、结构化输出约束并返回用量", async () => {
    mocks.run.mockResolvedValue({
      finalResponse: '{"summary":"fixture"}',
      usage: { input_tokens: 20, output_tokens: 10, cached_input_tokens: 0 },
    });
    const { requestCodex } = await import("./codex");
    const signal = new AbortController().signal;
    const schema = { type: "object" };
    const result = await requestCodex("一件商品的完整原文", signal, {
      model: "test-model",
      outputSchema: schema,
    });
    expect(mocks.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        webSearchMode: "disabled",
      }),
    );
    expect(mocks.run).toHaveBeenCalledWith("一件商品的完整原文", { signal, outputSchema: schema });
    expect(result.usage).toMatchObject({ input_tokens: 20, output_tokens: 10 });
  });
});
