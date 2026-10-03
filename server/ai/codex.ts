import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { Codex } from "@openai/codex-sdk";
import type { CodexLogin } from "./types";

type Account = { type: "chatgpt"; email: string | null; planType: string | null };
type Rpc = {
  request: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
  stop: () => void;
};

let server: Promise<Rpc> | null = null;
let login: CodexLogin | null = null;
let loginTimeout: ReturnType<typeof setTimeout> | undefined;

// Subscription requests must not inherit an API key from the Node service.
function codexEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL"].includes(entry[0]),
    ),
  );
}

async function startServer(): Promise<Rpc> {
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const cliDirectory = dirname(sdkRequire.resolve("@openai/codex/package.json"));
  const directory = await mkdtemp(join(tmpdir(), "cbg-codex-auth-"));
  const child = spawn(
    process.execPath,
    [
      join(cliDirectory, "bin", "codex.js"),
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'forced_login_method="chatgpt"',
      "-c",
      'model_provider="openai"',
    ],
    { cwd: directory, env: codexEnvironment(), stdio: ["pipe", "pipe", "pipe"] },
  );
  const pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0;
  let stopped = false;
  const fail = () => {
    if (stopped) return;
    stopped = true;
    server = null;
    for (const task of pending.values()) {
      clearTimeout(task.timer);
      task.reject(new Error("Codex 登录服务已退出，请重试"));
    }
    pending.clear();
    if (login?.state === "pending") {
      login.state = "error";
      login.error = "Codex 登录服务已退出，请重新登录";
      clearTimeout(loginTimeout);
    }
    void rm(directory, { recursive: true, force: true });
  };
  child.on("error", fail);
  child.on("exit", fail);
  child.stdin.on("error", fail);
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: { loginId?: string; success?: boolean; error?: string };
    };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "number") {
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id);
      clearTimeout(task.timer);
      if (message.error) task.reject(new Error(message.error.message));
      else task.resolve(message.result);
    } else if (
      message.method === "account/login/completed" &&
      login?.state === "pending" &&
      message.params?.loginId === login.loginId
    ) {
      clearTimeout(loginTimeout);
      login.state = message.params.success ? "completed" : "error";
      if (!message.params.success) login.error = message.params.error || "ChatGPT 登录失败，请重试";
    }
  });
  const request: Rpc["request"] = <T>(method: string, params = {}) =>
    new Promise<T>((resolve, reject) => {
      if (stopped) return reject(new Error("Codex 登录服务已退出，请重试"));
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("Codex 登录服务响应超时，请重试"));
      }, 20_000);
      pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (!error || !pending.delete(id)) return;
        clearTimeout(timer);
        reject(new Error("无法连接 Codex 登录服务，请重试"));
      });
    });
  const stop = () => {
    child.kill();
    lines.close();
    fail();
  };
  try {
    await request("initialize", {
      clientInfo: { name: "cbg_helper", title: "藏宝阁助手", version: "0.1.0" },
    });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    return { request, stop };
  } catch (error) {
    stop();
    throw error;
  }
}

function authServer() {
  server ||= startServer().catch((error: unknown) => {
    server = null;
    throw error;
  });
  return server;
}

export async function codexAccount() {
  const result = await (
    await authServer()
  ).request<{ account: Account | { type: string } | null }>("account/read", {
    refreshToken: false,
  });
  return result.account?.type === "chatgpt" ? (result.account as Account) : null;
}

export async function startCodexLogin(): Promise<CodexLogin> {
  if (login?.state === "pending") return { ...login };
  const rpc = await authServer();
  const result = await rpc.request<{ loginId: string; authUrl: string }>("account/login/start", {
    type: "chatgpt",
    useHostedLoginSuccessPage: true,
    appBrand: "chatgpt",
  });
  const url = new URL(result.authUrl);
  if (url.protocol !== "https:" || !["auth.openai.com", "chatgpt.com"].includes(url.hostname))
    throw new Error("Codex 返回了无效的官方登录地址");
  login = { ...result, state: "pending" };
  const session = login;
  loginTimeout = setTimeout(() => {
    if (session.state !== "pending") return;
    session.state = "error";
    session.error = "登录等待超时，请重新登录";
    void rpc.request("account/login/cancel", { loginId: session.loginId }).catch(() => {});
  }, 5 * 60_000);
  loginTimeout.unref();
  return { ...session };
}

export function codexLoginStatus(loginId: string): CodexLogin {
  if (!login || login.loginId !== loginId) throw new Error("登录会话已结束，请重新登录");
  return { ...login };
}

export async function cancelCodexLogin(loginId: string) {
  if (login?.loginId === loginId && login.state === "pending") {
    login.state = "cancelled";
    clearTimeout(loginTimeout);
    await (await authServer()).request("account/login/cancel", { loginId });
  }
  return { ok: true };
}

export async function codexModel() {
  const rpc = await authServer();
  const config = await rpc.request<{ config: { model?: string | null } }>("config/read", {
    includeLayers: false,
  });
  if (config.config?.model) return config.config.model;
  const result = await rpc.request<{ data: { model: string; isDefault: boolean }[] }>(
    "model/list",
    { limit: 100 },
  );
  const model = result.data?.find((item) => item.isDefault)?.model;
  if (!model) throw new Error("无法确定当前 Codex 模型，请检查 ChatGPT 登录");
  return model;
}

export async function codexModels() {
  const rpc = await authServer();
  const models: { id: string; name: string }[] = [];
  let cursor: string | undefined;
  do {
    const result = await rpc.request<{
      data: { model: string; displayName: string; hidden?: boolean }[];
      nextCursor: string | null;
    }>("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
    models.push(
      ...result.data
        .filter((item) => !item.hidden)
        .map((item) => ({ id: item.model, name: item.displayName || item.model })),
    );
    cursor = result.nextCursor || undefined;
  } while (cursor);
  return models;
}

export async function requestCodex(
  prompt: string,
  signal: AbortSignal,
  options?: { model: string; outputSchema: unknown },
) {
  const directory = await mkdtemp(join(tmpdir(), "cbg-codex-check-"));
  try {
    const codex = new Codex({
      env: codexEnvironment(),
      config: { forced_login_method: "chatgpt", model_provider: "openai" },
    });
    const thread = codex.startThread({
      ...(options ? { model: options.model } : {}),
      workingDirectory: directory,
      skipGitRepoCheck: true,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      modelReasoningEffort: "low",
    });
    const result = await thread.run(prompt, {
      signal,
      ...(options ? { outputSchema: options.outputSchema } : {}),
    });
    return { text: result.finalResponse.trim(), usage: result.usage ?? null };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function probeCodex(prompt: string, signal: AbortSignal) {
  return (await requestCodex(prompt, signal)).text;
}

export async function shutdownCodex() {
  clearTimeout(loginTimeout);
  const current = server;
  server = null;
  if (current) (await current.catch(() => null))?.stop();
}
