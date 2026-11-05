import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  run: vi.fn(),
  runStreamed: vi.fn(),
  startThread: vi.fn(),
  options: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  cleanRuntime: vi.fn(),
}));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("../../scripts/codex-runtime.mjs", () => ({ cleanActiveCodexRuntime: mocks.cleanRuntime }));
vi.mock("node:fs/promises", () => ({ mkdtemp: mocks.mkdtemp, rm: mocks.rm }));
vi.mock("./codex-home", () => ({
  codexHomeEnv: () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"].includes(key),
      ),
    );
    return {
      ...env,
      CODEX_HOME: "/private/tmp/cbg-home-fixture",
      CODEX_SQLITE_HOME: "/private/tmp/cbg-home-fixture",
    };
  },
}));
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
  mocks.cleanRuntime.mockResolvedValue([]);
  mocks.run.mockResolvedValue({ finalResponse: "READY" });
  mocks.runStreamed.mockResolvedValue({
    events: (async function* () {
      yield { type: "item.completed", item: { type: "agent_message", text: "READY" } };
      yield { type: "turn.completed", usage: {} };
    })(),
  });
  mocks.startThread.mockReturnValue({ run: mocks.run, runStreamed: mocks.runStreamed });
  requests = [];
  rpcResults = {
    "config/read": { config: { model: "configured-model" } },
    "model/list": {
      data: [
        { model: "configured-model", displayName: "当前默认模型", isDefault: true },
        { model: "gpt-6-luna", displayName: "GPT-6-Luna" },
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
    child.emit("close", 0);
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
  await (await import("./codex-lifecycle")).requestCodexCleanup().catch(() => {});
  vi.unstubAllEnvs();
});

// Failure cases: auth/model discovery or READY/search still use the built-in
// WebSocket provider; a partial built-in override prevents the child from starting;
// or changing transport loses ChatGPT login isolation and existing tool limits.
describe("官方 Codex 登录与 SDK", () => {
  it("单次SDK完成先关闭auth再清缓存，清理失败仍返回原答案", async () => {
    const codex = await import("./codex");
    await codex.codexAccount();
    const child = mocks.spawn.mock.results[0]!.value;
    mocks.cleanRuntime.mockImplementation(async () => {
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      throw new Error("cleanup denied");
    });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await codex.probeCodex("fixture", new AbortController().signal)).toBe("READY");
      expect(warned).toHaveBeenCalledWith(
        "Codex 运行文件清理失败",
        expect.objectContaining({ code: "CODEX_CLEANUP_FAILED" }),
      );
    } finally {
      warned.mockRestore();
    }
    mocks.cleanRuntime.mockResolvedValue([]);
  });

  it("批清理等待未完成登录，cancel穿过pending门后才关闭auth和清缓存", async () => {
    const codex = await import("./codex");
    const { beginCodexBatch } = await import("./codex-lifecycle");
    const login = await codex.startCodexLogin();
    const child = mocks.spawn.mock.results[0]!.value;
    const batch = await beginCodexBatch();
    const finished = batch.finish();
    let pollFinished = false;
    const polling = codex.codexModels().then(() => {
      pollFinished = true;
    });
    await Promise.resolve();
    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.cleanRuntime).not.toHaveBeenCalled();
    await codex.cancelCodexLogin(login.loginId);
    await finished;
    await polling;
    expect(codex.codexLoginStatus(login.loginId).state).toBe("cancelled");
    expect(pollFinished).toBe(true);
    expect(mocks.cleanRuntime).toHaveBeenCalledOnce();
  });

  it("登录超时可在清理pending时取消RPC并释放hold", async () => {
    const codex = await import("./codex");
    const { beginCodexBatch } = await import("./codex-lifecycle");
    vi.useFakeTimers();
    try {
      const login = await codex.startCodexLogin();
      const batch = await beginCodexBatch();
      const finishing = batch.finish();
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      await finishing;
      expect(codex.codexLoginStatus(login.loginId)).toMatchObject({
        state: "error",
        error: "登录等待超时，请重新登录",
      });
      expect(requests.some((request) => request.method === "account/login/cancel")).toBe(true);
      expect(mocks.cleanRuntime).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("批清理等待SDK流终态后关闭后台并清缓存", async () => {
    const codex = await import("./codex");
    const { beginCodexBatch } = await import("./codex-lifecycle");
    let finishStream!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const terminal = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    mocks.runStreamed.mockImplementation(async () => ({
      events: (async function* () {
        markStarted();
        await terminal;
        yield { type: "item.completed", item: { type: "agent_message", text: "READY" } };
        yield { type: "turn.completed", usage: {} };
      })(),
    }));
    const probe = codex.probeCodex("fixture", new AbortController().signal);
    await started;
    const batch = await beginCodexBatch();
    const finishing = batch.finish();
    expect(mocks.cleanRuntime).not.toHaveBeenCalled();
    finishStream();
    expect(await probe).toBe("READY");
    await finishing;
    expect(mocks.cleanRuntime).toHaveBeenCalledOnce();
  });

  it("并发启动登录共用一次初始化与一个hold，取消后清理不会挂起", async () => {
    const codex = await import("./codex");
    const { beginCodexBatch } = await import("./codex-lifecycle");
    const [first, second] = await Promise.all([codex.startCodexLogin(), codex.startCodexLogin()]);
    expect(first.loginId).toBe(second.loginId);
    expect(requests.filter((request) => request.method === "account/login/start")).toHaveLength(1);
    const batch = await beginCodexBatch();
    const finished = batch.finish();
    await codex.cancelCodexLogin(first.loginId);
    await finished;
    expect(mocks.cleanRuntime).toHaveBeenCalledOnce();
  });

  it("登录完成与长批次并存时只延期清理，不阻塞metadata刷新", async () => {
    const codex = await import("./codex");
    const { beginCodexBatch } = await import("./codex-lifecycle");
    const login = await codex.startCodexLogin();
    const child = mocks.spawn.mock.results[0]!.value;
    const batch = await beginCodexBatch();
    send({ method: "account/login/completed", params: { loginId: login.loginId, success: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(codex.codexLoginStatus(login.loginId).state).toBe("completed");
    expect((await codex.codexModels()).some((model) => model.id === "gpt-6-luna")).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.cleanRuntime).not.toHaveBeenCalled();
    await batch.finish();
    expect(mocks.cleanRuntime).toHaveBeenCalledOnce();
  });

  it("服务关停取消登录只释放hold，不反向等待尚未结束的分析批次", async () => {
    const codex = await import("./codex");
    const { beginCodexBatch } = await import("./codex-lifecycle");
    const login = await codex.startCodexLogin();
    const child = mocks.spawn.mock.results[0]!.value;
    const batch = await beginCodexBatch();
    await codex.cancelPendingCodexLogin();
    expect(codex.codexLoginStatus(login.loginId).state).toBe("cancelled");
    expect(child.kill).not.toHaveBeenCalled();
    expect(mocks.cleanRuntime).not.toHaveBeenCalled();
    await batch.finish();
    expect(mocks.cleanRuntime).toHaveBeenCalledOnce();
  });

  it("关闭登录服务等待子进程close后再删除临时目录", async () => {
    const codex = await import("./codex");
    await codex.codexAccount();
    const child = mocks.spawn.mock.results[0]!.value;
    child.kill.mockImplementation(() => {
      child.emit("exit", 0);
      return true;
    });
    let finished = false;
    const closing = codex.shutdownCodex().then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(child.kill).toHaveBeenCalledWith("SIGTERM"));
    expect(finished).toBe(false);
    expect(mocks.rm).not.toHaveBeenCalled();
    child.emit("close", 0);
    await closing;
    expect(finished).toBe(true);
    expect(mocks.rm).toHaveBeenCalledExactlyOnceWith("/private/tmp/cbg-codex-fixture", {
      recursive: true,
      force: true,
    });
  });

  it("登录服务忽略SIGTERM时等待SIGKILL关闭，不提前删除目录", async () => {
    const codex = await import("./codex");
    await codex.codexAccount();
    const child = mocks.spawn.mock.results[0]!.value;
    child.kill.mockImplementation((signal: string) => {
      if (signal === "SIGKILL") {
        child.emit("exit", null, signal);
        child.emit("close", null, signal);
      }
      return true;
    });
    vi.useFakeTimers();
    try {
      const closing = codex.shutdownCodex();
      await vi.advanceTimersByTimeAsync(1_001);
      await closing;
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(mocks.rm).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("无法确认登录服务退出时拒绝关停并保留工作目录", async () => {
    const codex = await import("./codex");
    await codex.codexAccount();
    const child = mocks.spawn.mock.results[0]!.value;
    child.kill.mockReturnValue(true);
    vi.useFakeTimers();
    try {
      const rejected = expect(codex.shutdownCodex()).rejects.toThrow(
        "无法确认 Codex 登录服务进程已关闭",
      );
      await vi.advanceTimersByTimeAsync(3_001);
      await rejected;
      expect(mocks.rm).not.toHaveBeenCalled();
      child.emit("exit", 0);
      child.emit("close", 0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("读取账号时保留可用的工作区标识，缺失时使用空值", async () => {
    rpcResults["account/read"] = {
      account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" },
      workspaceRouting: { chatgptAccountId: "fixture-workspace" },
    };
    const { codexAccount } = await import("./codex");
    expect(await codexAccount()).toMatchObject({ workspaceId: "fixture-workspace" });
    rpcResults["account/read"] = {
      account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" },
      workspaceRouting: null,
    };
    expect(await codexAccount()).toMatchObject({ workspaceId: null });
  });
  it("流直接返回429致命错误时保留原始原因，不误报未完成", async () => {
    mocks.runStreamed.mockResolvedValue({
      events: (async function* () {
        yield {
          type: "error",
          message: "exceeded retry limit, last status: 429 Too Many Requests",
        };
      })(),
    });
    const { requestCodex } = await import("./codex");
    await expect(
      requestCodex("模拟角色", new AbortController().signal, {
        model: "gpt-6-luna",
        outputSchema: {},
        bareRoleReview: true,
      }),
    ).rejects.toThrow("429 Too Many Requests");
    expect(mocks.rm).toHaveBeenCalledOnce();
  });
  it.each(["probe", "bare"])("%s 流收到重连通知后继续等待最终成功", async (mode) => {
    mocks.runStreamed.mockResolvedValue({
      events: (async function* () {
        yield {
          type: "error",
          message: "Reconnecting... 1/1 (last status: 429 Too Many Requests)",
        };
        yield { type: "item.completed", item: { type: "agent_message", text: "READY" } };
        yield { type: "turn.completed", usage: { input_tokens: 7, output_tokens: 3 } };
      })(),
    });
    const { probeCodex, requestCodex } = await import("./codex");
    const signal = new AbortController().signal;
    if (mode === "probe") await expect(probeCodex("fixture", signal)).resolves.toBe("READY");
    else
      await expect(
        requestCodex("fixture", signal, {
          model: "gpt-6-luna",
          outputSchema: {},
          bareRoleReview: true,
        }),
      ).resolves.toMatchObject({
        text: "READY",
        usage: { input_tokens: 7, output_tokens: 3 },
      });
  });
  it("已完成的流不再接收上级取消，避免SDK清理子进程监听后触发未处理AbortError", async () => {
    const controller = new AbortController();
    const lateAbort = vi.fn();
    mocks.runStreamed.mockImplementation(async (_prompt, options) => {
      options.signal.addEventListener("abort", lateAbort);
      return {
        events: (async function* () {
          yield { type: "turn.completed", usage: {} };
        })(),
      };
    });
    const { probeCodex } = await import("./codex");
    await probeCodex("模拟连接", controller.signal);
    controller.abort(new Error("服务关闭"));
    expect(lateAbort).not.toHaveBeenCalled();
  });
  it("执行中的请求继续接收上级取消，并清理临时目录", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    mocks.runStreamed.mockImplementation(async (_prompt, options) => ({
      events: (async function* () {
        await new Promise<void>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
          started();
        });
        yield { type: "turn.completed", usage: {} };
      })(),
    }));
    const { probeCodex } = await import("./codex");
    const result = probeCodex("模拟连接", controller.signal);
    const rejected = expect(result).rejects.toThrow("用户暂停");
    await ready;
    controller.abort(new Error("用户暂停"));
    await rejected;
    expect(mocks.rm).toHaveBeenCalledWith("/private/tmp/cbg-codex-fixture", {
      recursive: true,
      force: true,
    });
  });
  it("已取消的请求不启动SDK，并清理临时目录", async () => {
    const controller = new AbortController();
    controller.abort(new Error("已经暂停"));
    const { probeCodex } = await import("./codex");
    await expect(probeCodex("模拟连接", controller.signal)).rejects.toThrow("已经暂停");
    expect(mocks.startThread).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalledOnce();
  });
  it("默认分析选择官方列表中的 Luna，不改写全局设置", async () => {
    const { codexModel, codexModels } = await import("./codex");
    expect(await codexModel()).toBe("gpt-6-luna");
    expect(await codexModels()).toEqual([
      { id: "configured-model", name: "当前默认模型" },
      { id: "gpt-6-luna", name: "GPT-6-Luna" },
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
    rpcResults["model/list"] = {
      data: [{ model: "other-model", displayName: "另一个模型" }],
      nextCursor: null,
    };
    await expect(codexModel()).rejects.toThrow("不在当前 Codex 模型列表");
  });

  it("发起官方浏览器登录，并接收完成通知", async () => {
    const codex = await import("./codex");
    const login = await codex.startCodexLogin();
    expect(mocks.spawn.mock.calls[0][1]).toContain('cli_auth_credentials_store="file"');
    expect(mocks.spawn.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        'model_provider="openai_http"',
        'model_providers.openai_http={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false}',
      ]),
    );
    expect(mocks.spawn.mock.calls[0][2].env).toMatchObject({
      CODEX_HOME: "/private/tmp/cbg-home-fixture",
      CODEX_SQLITE_HOME: "/private/tmp/cbg-home-fixture",
    });
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
    expect(options.env.CODEX_HOME).toBe("/private/tmp/cbg-home-fixture");
    expect(options.env.CODEX_SQLITE_HOME).toBe("/private/tmp/cbg-home-fixture");
    expect(options.config.forced_login_method).toBe("chatgpt");
    expect(options.config.cli_auth_credentials_store).toBe("file");
    expect(options.codexPathOverride).toMatch(/\/scripts\/codex-stateless\.mjs$/);
    expect(options.config.history).toEqual({ persistence: "none" });
    expect(options.configOverrides).toEqual([
      'model_provider="openai_http"',
      'model_providers.openai_http={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false}',
    ]);
    expect(options.config.model_provider).toBeUndefined();
    expect(options.config.features).toEqual({
      plugins: false,
      skip_host_skill_discovery: true,
      shell_snapshot: false,
      shell_tool: false,
      unified_exec: false,
      hooks: false,
      multi_agent: false,
      apps: false,
    });
    expect(mocks.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: "/private/tmp/cbg-codex-fixture",
        sandboxMode: "read-only",
        approvalPolicy: "never",
      }),
    );
    expect(mocks.runStreamed).toHaveBeenCalledWith("Reply READY.", {
      signal: expect.any(AbortSignal),
    });
    expect(mocks.runStreamed.mock.calls[0][1].signal).not.toBe(signal);
  });

  it("连接测试收到完整完成事件后关闭流，不等待进程的剩余退出时间", async () => {
    const closed = vi.fn();
    mocks.runStreamed.mockResolvedValue({
      events: (async function* () {
        try {
          yield { type: "item.completed", item: { type: "agent_message", text: "READY" } };
          yield { type: "turn.completed", usage: {} };
          await new Promise(() => {});
        } finally {
          closed();
        }
      })(),
    });
    const { probeCodex } = await import("./codex");
    expect(await probeCodex("连接测试", new AbortController().signal)).toBe("READY");
    expect(closed).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it.each(["incomplete", "failed", "cancelled"])(
    "连接测试%s时不接受已经收到的文本",
    async (state) => {
      const controller = new AbortController();
      mocks.runStreamed.mockResolvedValue({
        events: (async function* () {
          yield { type: "item.completed", item: { type: "agent_message", text: "READY" } };
          if (state === "failed") yield { type: "turn.failed", error: { message: "模型请求失败" } };
          if (state === "cancelled") {
            controller.abort(new Error("用户取消验证"));
            yield { type: "turn.completed", usage: {} };
          }
        })(),
      });
      const { probeCodex } = await import("./codex");
      await expect(probeCodex("连接测试", controller.signal)).rejects.toThrow(
        state === "failed"
          ? "模型请求失败"
          : state === "cancelled"
            ? "用户取消验证"
            : "完整完成事件",
      );
    },
  );
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
    expect(mocks.run).toHaveBeenCalledWith("一件商品的完整原文", {
      signal: expect.any(AbortSignal),
      outputSchema: schema,
    });
    expect(result.usage).toMatchObject({ input_tokens: 20, output_tokens: 10 });
  });

  it("Luna 分析向 SDK 传入 max 和 fast，连接验证保持轻量", async () => {
    const { requestCodex, probeCodex } = await import("./codex");
    const signal = new AbortController().signal;
    await requestCodex("商品原文", signal, {
      model: "gpt-6-luna",
      outputSchema: { type: "object" },
    });
    expect(mocks.options.mock.calls[0][0].config.service_tier).toBe("fast");
    expect(mocks.startThread.mock.calls[0][0]).toMatchObject({
      model: "gpt-6-luna",
      modelReasoningEffort: "max",
    });
    await probeCodex("Reply READY.", signal);
    expect(mocks.options.mock.calls[1][0].config.service_tier).toBeUndefined();
    expect(mocks.startThread.mock.calls[1][0].modelReasoningEffort).toBe("low");
  });

  it("裸号核对使用 low/fast，关闭无关工具并在结构化回合完成时返回", async () => {
    let closed = false;
    mocks.runStreamed.mockResolvedValue({
      events: (async function* () {
        try {
          yield {
            type: "item.completed",
            item: { type: "agent_message", text: '{"decision":"PASS"}' },
          };
          yield { type: "turn.completed", usage: { input_tokens: 100, output_tokens: 10 } };
          throw new Error("完成后不应再等待额外输出");
        } finally {
          closed = true;
        }
      })(),
    });
    const { requestCodex } = await import("./codex");
    const signal = new AbortController().signal,
      schema = { type: "object" };
    const response = await requestCodex("裸号核对", signal, {
      model: "gpt-6-luna",
      outputSchema: schema,
      bareRoleReview: true,
    });
    expect(response).toMatchObject({
      text: '{"decision":"PASS"}',
      usage: {
        input_tokens: 100,
        input_scope: "body",
        reasoning_effort: "low",
        completion_mode: "turn.completed",
      },
    });
    expect(mocks.startThread.mock.calls[0][0]).toMatchObject({
      modelReasoningEffort: "low",
      webSearchMode: "disabled",
    });
    expect(mocks.options.mock.calls[0][0].config).toMatchObject({
      service_tier: "fast",
      features: {
        shell_tool: false,
        unified_exec: false,
        hooks: false,
        multi_agent: false,
        apps: false,
      },
    });
    expect(mocks.runStreamed).toHaveBeenCalledWith("裸号核对", {
      signal: expect.any(AbortSignal),
      outputSchema: schema,
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(closed).toBe(true);
  });

  it("裸号结构化流未完成时不能把中途文本作为成功结果", async () => {
    mocks.runStreamed.mockResolvedValue({
      events: (async function* () {
        yield {
          type: "item.completed",
          item: { type: "agent_message", text: '{"decision":"PASS"}' },
        };
      })(),
    });
    const { requestCodex } = await import("./codex");
    await expect(
      requestCodex("裸号核对", new AbortController().signal, {
        model: "gpt-6-luna",
        outputSchema: {},
        bareRoleReview: true,
      }),
    ).rejects.toThrow("完整完成事件");
  });

  it("装备查价启用实时搜索并返回真实搜索事件，不把模型文本当查询记录", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fixture-api-key");
    vi.stubEnv("CODEX_API_KEY", "fixture-codex-key");
    vi.stubEnv("OPENAI_BASE_URL", "https://fixture.invalid");
    const searches = [
      { id: "search-1", type: "web_search", query: "梦幻西游 100级 愤怒 腰带 藏宝阁" },
      { id: "search-2", type: "web_search", query: "100级 愤怒 腰带 8锻 报价" },
    ];
    mocks.run.mockResolvedValue({
      finalResponse: '  {"candidates":[]}  ',
      usage: { input_tokens: 50, output_tokens: 10, cached_input_tokens: 0 },
      items: [
        searches[0],
        { id: "message-1", type: "agent_message", text: "我搜索了另一个关键词" },
        searches[1],
      ],
    });
    const { requestCodexSearch } = await import("./codex");
    const signal = new AbortController().signal;
    const schema = { type: "object" };
    const prompt = "100级愤怒腰带，8锻黑宝石";
    expect(
      await requestCodexSearch(prompt, signal, { model: "test-model", outputSchema: schema }),
    ).toEqual({
      text: '{"candidates":[]}',
      usage: { input_tokens: 50, output_tokens: 10, cached_input_tokens: 0 },
      queries: searches.map((item) => item.query),
      searchItems: searches,
    });
    expect(mocks.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "test-model",
        workingDirectory: "/private/tmp/cbg-codex-fixture",
        sandboxMode: "read-only",
        approvalPolicy: "never",
        webSearchMode: "live",
      }),
    );
    const sdkOptions = mocks.options.mock.calls[0][0];
    expect(sdkOptions.env.OPENAI_API_KEY).toBeUndefined();
    expect(sdkOptions.env.CODEX_API_KEY).toBeUndefined();
    expect(sdkOptions.env.OPENAI_BASE_URL).toBeUndefined();
    expect(sdkOptions.config.features).toMatchObject({
      shell_tool: false,
      unified_exec: false,
      hooks: false,
      multi_agent: false,
      apps: false,
    });
    expect(mocks.run).toHaveBeenCalledWith(expect.stringContaining(prompt), {
      signal: expect.any(AbortSignal),
      outputSchema: schema,
    });
    expect(mocks.rm).toHaveBeenCalledWith("/private/tmp/cbg-codex-fixture", {
      recursive: true,
      force: true,
    });
  });

  it("没有真实搜索事件时保持空查询，交给上层判定查价失败", async () => {
    mocks.run.mockResolvedValue({
      finalResponse: '{"query":"声称已搜索","candidates":[]}',
      items: [
        { id: "message-1", type: "agent_message", text: "已搜索" },
        { id: "search-1", type: "web_search", query: " " },
      ],
    });
    const { requestCodexSearch } = await import("./codex");
    const result = await requestCodexSearch("公开装备条件", new AbortController().signal, {
      model: "test-model",
      outputSchema: { type: "object" },
    });
    expect(result.queries).toEqual([]);
    expect(result.usage).toBeNull();
  });

  it.each(["command_execution", "file_change", "mcp_tool_call"])(
    "查价出现 %s 工具事件时拒绝使用结果",
    async (type) => {
      mocks.run.mockResolvedValue({
        finalResponse: '{"candidates":[]}',
        items: [{ id: "other-tool", type }],
      });
      const { requestCodexSearch } = await import("./codex");
      await expect(
        requestCodexSearch("公开装备条件", new AbortController().signal, {
          model: "test-model",
          outputSchema: { type: "object" },
        }),
      ).rejects.toThrow("搜索以外的工具");
      expect(mocks.rm).toHaveBeenCalled();
    },
  );

  it("查价 SDK 请求失败仍清理隔离目录并保留原错误", async () => {
    mocks.run.mockRejectedValue(new Error("fixture search failed"));
    const { requestCodexSearch } = await import("./codex");
    await expect(
      requestCodexSearch("公开装备条件", new AbortController().signal, {
        model: "test-model",
        outputSchema: { type: "object" },
      }),
    ).rejects.toThrow("fixture search failed");
    expect(mocks.rm).toHaveBeenCalledWith("/private/tmp/cbg-codex-fixture", {
      recursive: true,
      force: true,
    });
  });
});
