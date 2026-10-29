import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { codexHomeEnv } from "./codex-home";

export type CodexPoolEvent = { method: string; params?: unknown; error?: Error };
export type CodexPoolTransport = {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  subscribe(listener: (event: CodexPoolEvent) => void): () => void;
  close(): Promise<void>;
};
/** A JSON-RPC error response confirms that the request was rejected by app-server. */
export class CodexPoolRpcError extends Error {}
type AnalysisOptions = { bareRoleReview?: boolean };
type Response = { text: string; usage: unknown };
type TurnEvents = { text?: string; usage?: unknown; status?: string; error?: string };
type Slot = {
  busy: boolean;
  threadId?: string;
  bare?: boolean;
  directory?: string;
  firstTurnId?: string;
  persistentDirty?: boolean;
  current?: {
    turns: Map<string, TurnEvents>;
    expected?: string;
    done: Promise<TurnEvents>;
    resolve: (value: TurnEvents) => void;
    reject: (error: Error) => void;
    abort: AbortController;
    interrupted: boolean;
    terminal: boolean;
    startSent: boolean;
    promise?: Promise<Response>;
  };
};
type Waiter = {
  resolve: (lease: CodexLease) => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  abort: () => void;
};

/** Only clean threads may be claimed; a crash leaves the claimed thread isolated. */
class PersistentThreads {
  private readonly db: DatabaseSync;
  private readonly account: string;
  private readonly workspaces: string;
  constructor(path: string, accountId: string) {
    if (!accountId.trim()) throw new Error("Codex 账号标识缺失，无法复用会话");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.workspaces = join(dirname(path), "cbg-pool-workspaces");
    mkdirSync(this.workspaces, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.workspaces).isDirectory())
      throw new Error("Codex 会话目录无效，已暂停分析");
    this.account = createHash("sha256").update(accountId).digest("hex");
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`CREATE TABLE IF NOT EXISTS reusable_threads (
      id TEXT PRIMARY KEY, account TEXT NOT NULL, model TEXT NOT NULL,
      bare INTEGER NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, workspace TEXT
    )`);
    const columns = this.db.prepare("PRAGMA table_info(reusable_threads)").all();
    if (!columns.some((column) => column.name === "workspace"))
      this.db.exec("ALTER TABLE reusable_threads ADD COLUMN workspace TEXT");
  }
  claim(model: string, bare: boolean): { id: string; workspace: string } | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare(
          "SELECT id,workspace FROM reusable_threads WHERE account=? AND model=? AND bare=? AND version=2 AND state='clean' ORDER BY id LIMIT 1",
        )
        .get(this.account, model, Number(bare));
      if (!row) {
        this.db.exec("COMMIT");
        return undefined;
      }
      const id = String(row.id);
      this.dirty(id);
      this.db.exec("COMMIT");
      return { id, workspace: String(row.workspace) };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async createWorkspace() {
    return await mkdtemp(join(this.workspaces, "thread-"));
  }
  async restoreWorkspace(name: string) {
    if (!/^thread-[A-Za-z0-9]+$/.test(name)) throw new Error("Codex 会话目录无效，已暂停分析");
    const directory = join(this.workspaces, name);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!lstatSync(directory).isDirectory()) throw new Error("Codex 会话目录无效，已暂停分析");
    await this.clearWorkspace(directory);
    return directory;
  }
  async clearWorkspace(directory: string) {
    if (dirname(directory) !== this.workspaces || !lstatSync(directory).isDirectory())
      throw new Error("Codex 会话目录无效，已暂停分析");
    for (const entry of await readdir(directory))
      await rm(join(directory, entry), { recursive: true, force: true });
  }
  add(id: string, model: string, bare: boolean, directory: string) {
    const workspace = basename(directory);
    if (dirname(directory) !== this.workspaces || !/^thread-[A-Za-z0-9]+$/.test(workspace))
      throw new Error("Codex 会话目录无效，已暂停分析");
    this.db
      .prepare(
        "INSERT INTO reusable_threads(id,account,model,bare,version,state,workspace) VALUES(?,?,?,?,2,'dirty',?)",
      )
      .run(id, this.account, model, Number(bare), workspace);
  }
  dirty(id: string) {
    const result = this.db
      .prepare("UPDATE reusable_threads SET state='dirty' WHERE id=? AND state='clean'")
      .run(id);
    if (result.changes !== 1) throw new Error("Codex 持久会话状态无效，已暂停分析");
  }
  clean(id: string) {
    const result = this.db
      .prepare("UPDATE reusable_threads SET state='clean' WHERE id=? AND state='dirty'")
      .run(id);
    if (result.changes !== 1) throw new Error("Codex 持久会话状态无效，已暂停分析");
  }
  close() {
    this.db.close();
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function asError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}
function usageFrom(value: unknown): Record<string, number> | null {
  const last = object(object(value).last);
  const fields: Record<string, string> = {
    inputTokens: "input_tokens",
    cachedInputTokens: "cached_input_tokens",
    outputTokens: "output_tokens",
    reasoningOutputTokens: "reasoning_output_tokens",
    cacheWriteInputTokens: "cache_write_input_tokens",
  };
  const result: Record<string, number> = {};
  for (const [source, target] of Object.entries(fields))
    if (typeof last[source] === "number") result[target] = last[source] as number;
  return Object.keys(result).length ? result : null;
}

async function startTransport(): Promise<CodexPoolTransport> {
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const cliDirectory = dirname(sdkRequire.resolve("@openai/codex/package.json"));
  const directory = await mkdtemp(join(tmpdir(), "cbg-codex-pool-"));
  const env = codexHomeEnv();
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
      'cli_auth_credentials_store="file"',
      "-c",
      'model_provider="openai"',
    ],
    {
      cwd: directory,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  let childExited = false;
  let childClosed = false;
  child.once("exit", () => {
    childExited = true;
  });
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      childClosed = true;
      resolve();
    });
  });
  const waitClosed = async (milliseconds: number) => {
    if (childClosed) return true;
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), milliseconds);
      void closed.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  };
  const terminate = async () => {
    if (childClosed) return;
    if (childExited) {
      if (await waitClosed(2_000)) return;
      throw new Error("Codex 分析服务已退出，但无法确认子进程关闭");
    }
    if (process.platform === "win32" && child.pid) {
      // Windows has no process-group signal; terminate only this child's process tree.
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          killer.kill();
          resolve();
        }, 2_000);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        killer.once("error", done);
        killer.once("close", done);
      });
      if (await waitClosed(2_000)) return;
      throw new Error("无法确认 Codex 分析服务进程树已关闭");
    }
    const signal = (name: NodeJS.Signals) => {
      if (childExited || childClosed) return;
      if (!child.pid) {
        child.kill(name);
        return;
      }
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM");
    if (await waitClosed(1_000)) return;
    // Once the leader exits its PID can be reused; never signal the old group again.
    if (childExited) throw new Error("Codex 分析服务已退出，但无法确认子进程关闭");
    signal("SIGKILL");
    if (await waitClosed(2_000)) return;
    throw new Error("无法确认 Codex 分析服务进程树已关闭");
  };
  const listeners = new Set<(event: CodexPoolEvent) => void>();
  const pending = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextId = 0;
  let stopped: Error | undefined;
  const fail = (error: Error) => {
    if (stopped) return;
    stopped = error;
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
    for (const listener of listeners) listener({ method: "$closed", error });
  };
  child.on("error", (error) => fail(error));
  child.on("exit", () => fail(new Error("Codex 分析服务已退出，请重试")));
  child.stdin.on("error", (error) => fail(error));
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = object(JSON.parse(line));
    } catch {
      fail(new Error("Codex 分析服务返回了无效消息"));
      return;
    }
    if (
      (typeof message.id === "number" || typeof message.id === "string") &&
      typeof message.method === "string"
    ) {
      // The analysis client never approves an unexpected server request.
      child.stdin.write(
        JSON.stringify({ id: message.id, error: { code: -32600, message: "Not supported" } }) +
          "\n",
      );
      return;
    }
    if (typeof message.id === "number") {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) {
        const detail = object(message.error).message;
        item.reject(
          new CodexPoolRpcError(typeof detail === "string" && detail ? detail : "Codex 请求失败"),
        );
      } else item.resolve(message.result);
    } else if (typeof message.method === "string") {
      for (const listener of listeners)
        listener({ method: message.method, params: message.params });
    }
  });
  const request: CodexPoolTransport["request"] = (method, params) =>
    new Promise((resolve, reject) => {
      if (stopped) return reject(stopped);
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex ${method} 响应超时`));
      }, 20_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (!error || !pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  const transport: CodexPoolTransport = {
    request,
    subscribe(listener) {
      listeners.add(listener);
      if (stopped) listener({ method: "$closed", error: stopped });
      return () => listeners.delete(listener);
    },
    async close() {
      fail(new Error("Codex 分析服务已关闭"));
      try {
        await terminate();
      } finally {
        lines.close();
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
  try {
    await request("initialize", {
      clientInfo: { name: "cbg_helper", title: "藏宝阁助手", version: "0.1.0" },
    });
    child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
    return transport;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

export type CodexLease = {
  run(
    prompt: string,
    schema: unknown,
    signal: AbortSignal,
    options?: AnalysisOptions,
  ): Promise<Response>;
  release(persisted: boolean): Promise<void>;
};

/** One reusable conversation per slot; history is reverted only after the caller persists the result. */
export class CodexPool {
  private readonly slots: Slot[] = [];
  private readonly waiters: Waiter[] = [];
  private transport?: Promise<CodexPoolTransport>;
  private unsubscribe?: () => void;
  private failure?: Error;
  private closed = false;
  private readonly persistent?: PersistentThreads;
  constructor(
    private readonly size: number,
    private readonly model: string,
    private readonly createTransport: () => Promise<CodexPoolTransport> = startTransport,
    persistence?: { statePath: string; accountId: string },
  ) {
    if (!Number.isSafeInteger(size) || size < 1) throw new Error("分析并发数必须是正整数");
    if (persistence)
      this.persistent = new PersistentThreads(persistence.statePath, persistence.accountId);
  }
  private fail(error: Error) {
    this.failure ||= error;
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal.removeEventListener("abort", waiter.abort);
      waiter.reject(this.failure);
    }
  }
  private check() {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("Codex 会话池已关闭");
  }
  private async rpc() {
    this.check();
    this.transport ||= this.createTransport().then((transport) => {
      this.unsubscribe = transport.subscribe((event) => this.onEvent(event));
      return transport;
    });
    try {
      const transport = await this.transport;
      this.check();
      return transport;
    } catch (error) {
      this.fail(asError(error));
      throw error;
    }
  }
  private onEvent(event: CodexPoolEvent) {
    if (event.method === "$closed") {
      const error = event.error || new Error("Codex 分析服务已退出，请重试");
      this.fail(error);
      for (const slot of this.slots) slot.current?.reject(error);
      return;
    }
    const params = object(event.params);
    const slot = this.slots.find((item) => item.threadId === params.threadId);
    const current = slot?.current;
    if (!current) return;
    const turn = object(params.turn);
    const id = typeof params.turnId === "string" ? params.turnId : turn.id;
    if (typeof id !== "string" || (current.expected && id !== current.expected)) return;
    const data = current.turns.get(id) || {};
    current.turns.set(id, data);
    if (event.method === "item/completed") {
      const item = object(params.item);
      if (item.type === "agentMessage" && typeof item.text === "string") data.text = item.text;
    } else if (event.method === "thread/tokenUsage/updated") {
      data.usage = usageFrom(params.tokenUsage);
    } else if (event.method === "error" && params.willRetry === false) {
      const detail = object(params.error).message;
      data.error = typeof detail === "string" && detail ? detail : "Codex 分析失败";
    } else if (event.method === "turn/completed") {
      data.status = typeof turn.status === "string" ? turn.status : "invalid";
      const detail = object(turn.error).message;
      data.error = typeof detail === "string" && detail ? detail : data.error || "";
    }
    if (current.expected === id && data.status) {
      current.terminal = true;
      current.resolve(data);
    }
  }
  async acquire(signal: AbortSignal): Promise<CodexLease> {
    this.check();
    signal.throwIfAborted();
    let slot = this.slots.find((item) => !item.busy);
    if (!slot && this.slots.length < this.size) {
      slot = { busy: false };
      this.slots.push(slot);
    }
    if (slot) return this.lease(slot);
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason);
        },
      };
      this.waiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      if (signal.aborted) waiter.abort();
    });
  }
  private lease(slot: Slot): CodexLease {
    slot.busy = true;
    let running = false;
    let released: Promise<void> | undefined;
    return {
      run: (prompt, schema, signal, options = {}) => {
        if (running || released) return Promise.reject(new Error("该 Codex 会话正在使用或已释放"));
        running = true;
        const promise = this.run(slot, prompt, schema, signal, options);
        // The caller can stop awaiting on abort; release still waits for the real terminal event.
        promise.then(
          () => {
            running = false;
          },
          () => {
            running = false;
          },
        );
        if (slot.current) slot.current.promise = promise;
        return promise;
      },
      release: (persisted) => {
        released ||= this.release(slot, persisted);
        return released;
      },
    };
  }
  private async run(
    slot: Slot,
    prompt: string,
    schema: unknown,
    signal: AbortSignal,
    options: AnalysisOptions,
  ): Promise<Response> {
    this.check();
    signal.throwIfAborted();
    const bare = options.bareRoleReview === true;
    if (slot.threadId && slot.bare !== bare) {
      const error = new Error("Codex 会话分析范围已变化，请重新开始分析");
      this.fail(error);
      throw error;
    }
    let resolve!: (value: TurnEvents) => void;
    let reject!: (error: Error) => void;
    const current: NonNullable<Slot["current"]> = {
      turns: new Map(),
      done: new Promise<TurnEvents>((ok, fail) => {
        resolve = ok;
        reject = fail;
      }),
      resolve,
      reject,
      abort: new AbortController(),
      interrupted: false,
      terminal: false,
      startSent: false,
    };
    current.done.catch(() => {});
    slot.current = current;
    const abortSignal = AbortSignal.any([signal, current.abort.signal]);
    let cancelDeadline: ReturnType<typeof setTimeout> | undefined;
    const interrupt = () => {
      if (!current.expected || current.terminal || current.interrupted || !slot.threadId) return;
      current.interrupted = true;
      cancelDeadline = setTimeout(() => {
        const failure = new Error("Codex 取消超时，会话已隔离");
        this.fail(failure);
        current.reject(failure);
      }, 10_000);
      void this.rpc()
        .then((rpc) =>
          rpc.request("turn/interrupt", { threadId: slot.threadId, turnId: current.expected }),
        )
        .catch((error: unknown) => {
          const failure = asError(error);
          this.fail(failure);
          current.reject(failure);
        });
    };
    abortSignal.addEventListener("abort", interrupt, { once: true });
    try {
      const rpc = await this.rpc();
      abortSignal.throwIfAborted();
      let claimed = false;
      if (!slot.threadId && this.persistent) {
        const existing = this.persistent.claim(this.model, bare);
        if (existing) {
          claimed = true;
          slot.persistentDirty = true;
          try {
            slot.directory = await this.persistent.restoreWorkspace(existing.workspace);
            abortSignal.throwIfAborted();
            const resumed = object(
              await rpc.request("thread/resume", {
                threadId: existing.id,
                cwd: slot.directory,
                model: this.model,
                modelProvider: "openai",
                sandbox: "read-only",
                approvalPolicy: "never",
                config: {
                  web_search: "disabled",
                  ...(bare
                    ? {
                        features: {
                          shell_tool: false,
                          unified_exec: false,
                          hooks: false,
                          multi_agent: false,
                          apps: false,
                        },
                      }
                    : {}),
                },
                ...(this.model === "gpt-6-luna" ? { serviceTier: "fast" } : {}),
              }),
            );
            if (object(resumed.thread).id !== existing.id)
              throw new Error("Codex 恢复会话返回了错误 ID");
            const history = object(
              await rpc.request("thread/turns/list", { threadId: existing.id, limit: 1 }),
            );
            if (!Array.isArray(history.data) || history.data.length)
              throw new Error("Codex 恢复会话历史未清空，会话已隔离");
            slot.threadId = existing.id;
            slot.bare = bare;
          } catch (error) {
            this.fail(asError(error));
            throw error;
          }
        }
      }
      if (!this.persistent && !slot.directory)
        slot.directory = await mkdtemp(join(tmpdir(), "cbg-codex-check-"));
      if (!slot.threadId) {
        slot.directory ||= this.persistent
          ? await this.persistent.createWorkspace()
          : await mkdtemp(join(tmpdir(), "cbg-codex-check-"));
        abortSignal.throwIfAborted();
        let start: Record<string, unknown>;
        try {
          start = object(
            await rpc.request("thread/start", {
              model: this.model,
              modelProvider: "openai",
              cwd: slot.directory,
              sandbox: "read-only",
              approvalPolicy: "never",
              config: {
                web_search: "disabled",
                ...(bare
                  ? {
                      features: {
                        shell_tool: false,
                        unified_exec: false,
                        hooks: false,
                        multi_agent: false,
                        apps: false,
                      },
                    }
                  : {}),
              },
              ...(this.model === "gpt-6-luna" ? { serviceTier: "fast" } : {}),
            }),
          );
        } catch (error) {
          // A timed-out start may already have created a session: do not allocate a replacement.
          this.fail(asError(error));
          throw error;
        }
        const threadId = object(start.thread).id;
        if (
          typeof threadId !== "string" ||
          !threadId ||
          this.slots.some((item) => item !== slot && item.threadId === threadId)
        ) {
          const error = new Error("Codex 会话返回无效或重复 ID，已暂停分析");
          this.fail(error);
          throw error;
        }
        slot.threadId = threadId;
        slot.bare = bare;
        try {
          this.persistent?.add(threadId, this.model, bare, slot.directory);
          claimed = !!this.persistent;
          slot.persistentDirty = claimed;
        } catch (error) {
          this.fail(asError(error));
          throw error;
        }
      }
      abortSignal.throwIfAborted();
      if (this.persistent && !claimed) {
        try {
          this.persistent.dirty(slot.threadId);
          slot.persistentDirty = true;
        } catch (error) {
          this.fail(asError(error));
          throw error;
        }
      }
      current.startSent = true;
      const started = object(
        await rpc.request("turn/start", {
          threadId: slot.threadId,
          input: [{ type: "text", text: prompt }],
          cwd: slot.directory,
          outputSchema: schema,
          effort: bare || this.model !== "gpt-6-luna" ? "low" : "max",
        }),
      );
      const id = object(started.turn).id;
      if (typeof id !== "string" || !id) throw new Error("Codex 分析未返回有效 turn ID");
      current.expected = id;
      slot.firstTurnId ||= id;
      const already = current.turns.get(id);
      if (already?.status) {
        current.terminal = true;
        current.resolve(already);
      }
      if (abortSignal.aborted) interrupt();
      const done = await current.done;
      abortSignal.throwIfAborted();
      if (done.status !== "completed") throw new Error(done.error || "Codex 分析未完成，请重试");
      if (typeof done.text !== "string") throw new Error("Codex 分析未返回完整结果，请重试");
      return {
        text: done.text.trim(),
        usage: bare
          ? {
              ...object(done.usage),
              input_scope: "body",
              reasoning_effort: "low",
              completion_mode: "turn.completed",
            }
          : (done.usage ?? null),
      };
    } catch (error) {
      // An unknown start outcome cannot safely be assigned to another role.
      if (current.startSent && !current.expected) {
        if (error instanceof CodexPoolRpcError && current.turns.size === 0)
          current.startSent = false;
        else this.fail(asError(error));
      }
      throw error;
    } finally {
      abortSignal.removeEventListener("abort", interrupt);
      clearTimeout(cancelDeadline);
    }
  }
  private async release(slot: Slot, persisted: boolean) {
    const current = slot.current;
    if (current?.promise) await current.promise.catch(() => {});
    if (!persisted) {
      const error = new Error("分析结果未保存，Codex 会话已隔离");
      this.fail(error);
      throw error;
    }
    try {
      this.check();
      if (current?.startSent && (!current.expected || !current.terminal || !slot.threadId))
        throw new Error("Codex 分析状态未确认，会话已隔离");
      if (slot.firstTurnId) {
        if (!slot.threadId) throw new Error("Codex 会话缺少有效 ID");
        const rpc = await this.rpc();
        await rpc.request("thread/revert", {
          threadId: slot.threadId,
          beforeTurnId: slot.firstTurnId,
        });
        const history = object(
          await rpc.request("thread/turns/list", { threadId: slot.threadId, limit: 1 }),
        );
        if (!Array.isArray(history.data) || history.data.length)
          throw new Error("Codex 会话历史未清空，会话已隔离");
      }
      if (slot.directory) {
        if (this.persistent) await this.persistent.clearWorkspace(slot.directory);
        else await rm(slot.directory, { recursive: true, force: true });
      }
      if (slot.threadId && this.persistent && slot.persistentDirty) {
        this.persistent.clean(slot.threadId);
        slot.persistentDirty = false;
        slot.threadId = undefined;
        slot.bare = undefined;
      }
      slot.directory = undefined;
      slot.firstTurnId = undefined;
      slot.current = undefined;
      slot.busy = false;
      while (this.waiters.length) {
        const waiter = this.waiters.shift()!;
        waiter.signal.removeEventListener("abort", waiter.abort);
        if (waiter.signal.aborted) {
          waiter.reject(waiter.signal.reason);
          continue;
        }
        waiter.resolve(this.lease(slot));
        break;
      }
    } catch (error) {
      this.fail(asError(error));
      throw error;
    }
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error("Codex 会话池已关闭"));
    for (const slot of this.slots) slot.current?.abort.abort(new Error("Codex 会话池已关闭"));
    try {
      if (this.transport) {
        const transport = await this.transport.catch(() => undefined);
        if (transport) await transport.close();
      }
    } finally {
      this.unsubscribe?.();
      this.persistent?.close();
    }
  }
}
