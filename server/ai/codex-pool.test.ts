import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EventEmitter, once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  CodexPool,
  CodexPoolRpcError,
  type CodexPoolEvent,
  type CodexPoolTransport,
} from "./codex-pool";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("./codex-home", () => ({
  codexHomeEnv: () => ({
    CODEX_HOME: "/private/tmp/cbg-pool-fixture",
    CODEX_SQLITE_HOME: "/private/tmp/cbg-pool-fixture",
  }),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: spawnMock,
}));

// Reusing a thread, unloading before persistence or terminal cancellation, crossing
// events between roles, or losing queued work would invalidate stateless analysis.
class FakeTransport implements CodexPoolTransport {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly histories = new Map<string, string[]>();
  readonly turns = new Map<string, { threadId: string; prompt: string }>();
  listeners = new Set<(event: CodexPoolEvent) => void>();
  failUnsubscribe = false;
  private nextThread = 0;
  private nextTurn = 0;

  subscribe(listener: (event: CodexPoolEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(method: string, params: unknown) {
    for (const listener of this.listeners) listener({ method, params });
  }
  async request(method: string, params: Record<string, unknown>) {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      expect(params.ephemeral).toBe(true);
      const id = `thread-${++this.nextThread}`;
      this.histories.set(id, []);
      return { thread: { id, ephemeral: true } };
    }
    if (method === "turn/start") {
      const id = `turn-${++this.nextTurn}`;
      const threadId = String(params.threadId);
      const input = params.input as { text: string }[];
      this.turns.set(id, { threadId, prompt: input[0]!.text });
      this.histories.get(threadId)!.push(id);
      this.emit("turn/started", { threadId, turn: { id, status: "inProgress" } });
      return { turn: { id, status: "inProgress" } };
    }
    if (method === "thread/unsubscribe") {
      if (this.failUnsubscribe) throw new Error("unsubscribe failed");
      this.histories.delete(String(params.threadId));
      return { status: "unsubscribed" };
    }
    if (method === "turn/interrupt") return {};
    throw new Error(`unexpected method ${method}`);
  }
  finish(
    turnId: string,
    text: string,
    status: "completed" | "failed" | "interrupted" = "completed",
  ) {
    const { threadId } = this.turns.get(turnId)!;
    if (status === "completed") {
      this.emit("item/completed", {
        threadId,
        turnId,
        item: { type: "agentMessage", id: `item-${turnId}`, text },
      });
      this.emit("thread/tokenUsage/updated", {
        threadId,
        turnId,
        tokenUsage: {
          last: {
            inputTokens: 11,
            cachedInputTokens: 2,
            outputTokens: 4,
            reasoningOutputTokens: 1,
          },
        },
      });
    }
    this.emit("turn/completed", {
      threadId,
      turn: {
        id: turnId,
        status,
        ...(status === "failed" ? { error: { message: "failed" } } : {}),
      },
    });
  }
  async close() {
    for (const listener of this.listeners)
      listener({ method: "$closed", error: new Error("server closed") });
    this.histories.clear();
  }
}

const pools: CodexPool[] = [];
function create(size = 1) {
  const transport = new FakeTransport();
  const createTransport = vi.fn(async () => transport);
  const pool = new CodexPool(size, "gpt-6-luna", createTransport);
  pools.push(pool);
  return { pool, transport, createTransport };
}
async function turns(transport: FakeTransport, count: number) {
  await vi.waitFor(() => expect(transport.turns.size).toBe(count));
  return [...transport.turns.entries()];
}
afterEach(async () => {
  await Promise.allSettled(pools.splice(0).map((pool) => pool.close()));
  spawnMock.mockReset();
  vi.useRealTimers();
});

describe("Codex 无状态请求池", () => {
  it("逐条条件提高到high且不开放工具，随后普通裸号核对仍为low", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const schema = { type: "object" };
    const requests = [
      { conditionReview: true },
      { conditionReview: true, bareRoleReview: true },
      { bareRoleReview: true },
    ];
    for (const [index, options] of requests.entries()) {
      const lease = await pool.acquire(signal);
      const pending = lease.run("当前商品", schema, signal, options);
      const [id] = (await turns(transport, index + 1))[index]!;
      transport.finish(id, "result");
      const response = await pending;
      const thread = transport.calls.filter((call) => call.method === "thread/start").at(-1)!;
      const turn = transport.calls.filter((call) => call.method === "turn/start").at(-1)!;
      expect(thread.params).toMatchObject({
        ephemeral: true,
        model: "gpt-6-luna",
        sandbox: "read-only",
        approvalPolicy: "never",
        baseInstructions: expect.stringContaining("Do not use tools"),
        config: {
          web_search: "disabled",
          features: {
            shell_tool: false,
            unified_exec: false,
            hooks: false,
            multi_agent: false,
            apps: false,
          },
        },
      });
      const effort = options.conditionReview ? "high" : "low";
      expect(turn.params).toMatchObject({ effort, outputSchema: schema });
      expect(response.usage).toMatchObject({
        input_scope: options.conditionReview ? "role-conditions" : "body",
        reasoning_effort: effort,
      });
      await lease.release(true);
    }
  });

  it("10 路请求独立并发，保存后卸载；下一批全新会话且复用同一服务", async () => {
    const { pool, transport, createTransport } = create(10);
    const signal = new AbortController().signal;
    const seen = new Set<string>();
    for (let batch = 0; batch < 2; batch++) {
      const leases = await Promise.all(Array.from({ length: 10 }, () => pool.acquire(signal)));
      const pending = leases.map((lease, i) =>
        lease.run(`role-${batch}-${i}`, {}, signal, { bareRoleReview: true }),
      );
      const started = (await turns(transport, (batch + 1) * 10)).slice(batch * 10);
      for (const [id, turn] of started) {
        expect(seen.has(turn.threadId)).toBe(false);
        seen.add(turn.threadId);
        transport.emit("item/completed", {
          threadId: turn.threadId,
          turnId: "different-turn",
          item: { type: "agentMessage", text: "wrong-role" },
        });
        transport.emit("error", {
          threadId: turn.threadId,
          turnId: id,
          error: { message: "reconnecting" },
          willRetry: true,
        });
      }
      for (const [id, turn] of [...started].reverse())
        transport.finish(id, `answer:${turn.prompt}`);
      const results = await Promise.all(pending);
      expect(results.map((result) => result.text)).toEqual(
        Array.from({ length: 10 }, (_, i) => `answer:role-${batch}-${i}`),
      );
      expect(results[0]!.usage).toMatchObject({
        input_tokens: 11,
        output_tokens: 4,
        input_scope: "body",
      });
      expect(transport.histories.size).toBe(10);
      await Promise.all(leases.map((lease) => lease.release(true)));
      expect(transport.histories.size).toBe(0);
    }
    expect(seen.size).toBe(20);
    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(
      transport.calls.every(
        (call) => !["thread/resume", "thread/revert", "thread/turns/list"].includes(call.method),
      ),
    ).toBe(true);
  });

  it("失败重试每次新建并卸载会话，不累积上次输入或工作文件", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const ids = new Set<string>();
    for (let index = 0; index < 4; index++) {
      const pending = lease.run("role-a", {}, signal);
      const failed = index < 3 ? expect(pending).rejects.toThrow("failed") : undefined;
      const [id, turn] = (await turns(transport, index + 1))[index]!;
      ids.add(turn.threadId);
      const directory = String(
        transport.calls.filter((call) => call.method === "thread/start").at(-1)!.params.cwd,
      );
      await writeFile(join(directory, "previous-role.txt"), "fixture");
      transport.finish(id, index < 3 ? "" : "answer-a", index < 3 ? "failed" : "completed");
      if (failed) {
        await failed;
        expect(existsSync(directory)).toBe(false);
        expect(transport.histories.size).toBe(0);
      } else {
        expect((await pending).text).toBe("answer-a");
        expect(existsSync(directory)).toBe(true);
        await lease.release(true);
        expect(existsSync(directory)).toBe(false);
      }
    }
    expect(ids.size).toBe(4);
  });

  it("成功答案等待保存，不能在同租约提交另一个请求覆盖结果", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const pending = lease.run("role-a", {}, signal);
    const [[id]] = await turns(transport, 1);
    transport.finish(id!, "answer-a");
    expect((await pending).text).toBe("answer-a");
    await expect(lease.run("role-b", {}, signal)).rejects.toThrow("尚未保存");
    expect(transport.turns.size).toBe(1);
    expect(transport.histories.size).toBe(1);
    await lease.release(true);
    expect(transport.histories.size).toBe(0);
  });

  it("结果保存失败仍卸载临时会话并停止派发", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const pending = lease.run("role-a", {}, signal);
    const [[id]] = await turns(transport, 1);
    transport.finish(id!, "answer-a");
    expect((await pending).text).toBe("answer-a");
    await expect(lease.release(false)).rejects.toThrow("分析结果未保存");
    expect(transport.histories.size).toBe(0);
    await expect(pool.acquire(signal)).rejects.toThrow("分析结果未保存");
  });

  it("取消等待终态后卸载，释放之前不会派发排队角色", async () => {
    const { pool, transport } = create();
    const controller = new AbortController();
    const lease = await pool.acquire(controller.signal);
    const run = lease.run("role-a", {}, controller.signal);
    const rejected = expect(run).rejects.toThrow("paused");
    const [[id]] = await turns(transport, 1);
    let acquired = false;
    const waiting = pool.acquire(new AbortController().signal).then((next) => {
      acquired = true;
      return next;
    });
    controller.abort(new Error("paused"));
    await vi.waitFor(() =>
      expect(transport.calls.some((call) => call.method === "turn/interrupt")).toBe(true),
    );
    const release = lease.release(true);
    expect(transport.calls.some((call) => call.method === "thread/unsubscribe")).toBe(false);
    expect(acquired).toBe(false);
    transport.finish(id!, "", "interrupted");
    await rejected;
    await release;
    expect(transport.histories.size).toBe(0);
    await (await waiting).release(true);
  });

  it("取消后未收到终态时停止派发，关闭服务后删除工作目录", async () => {
    const { pool, transport } = create();
    const controller = new AbortController();
    const lease = await pool.acquire(controller.signal);
    const pending = lease.run("role-a", {}, controller.signal);
    await turns(transport, 1);
    const directory = String(
      transport.calls.find((call) => call.method === "thread/start")!.params.cwd,
    );
    vi.useFakeTimers();
    const rejected = expect(pending).rejects.toThrow("取消超时");
    controller.abort(new Error("paused"));
    const released = expect(lease.release(true)).rejects.toThrow("取消超时");
    await vi.advanceTimersByTimeAsync(10_001);
    await Promise.all([rejected, released]);
    expect(transport.histories.size).toBe(1);
    expect(existsSync(directory)).toBe(true);
    await pool.close();
    expect(existsSync(directory)).toBe(false);
  });

  it.each(["unsubscribe failed", "invalid response"])(
    "卸载失败隔离池且不覆盖已返回答案：%s",
    async (reason) => {
      const { pool, transport } = create();
      const signal = new AbortController().signal;
      const lease = await pool.acquire(signal);
      const pending = lease.run("role-a", {}, signal);
      const [[id]] = await turns(transport, 1);
      transport.finish(id!, "saved-answer");
      expect((await pending).text).toBe("saved-answer");
      if (reason === "unsubscribe failed") transport.failUnsubscribe = true;
      else {
        const original = transport.request.bind(transport);
        transport.request = async (method, params) =>
          method === "thread/unsubscribe" ? {} : original(method, params);
      }
      await expect(lease.release(true)).rejects.toThrow();
      await expect(pool.acquire(signal)).rejects.toThrow();
    },
  );

  it("turn/start 明确429拒绝时卸载旧线程，允许同租约用新线程重试", async () => {
    const { pool, transport } = create();
    const original = transport.request.bind(transport);
    let denied = false;
    transport.request = async (method, params) => {
      if (method === "turn/start" && !denied) {
        denied = true;
        throw new CodexPoolRpcError("429 rate limit");
      }
      return original(method, params);
    };
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    await expect(lease.run("role-a", {}, signal)).rejects.toThrow("429 rate limit");
    expect(transport.histories.size).toBe(0);
    const retry = lease.run("role-a", {}, signal);
    const [[id]] = await turns(transport, 1);
    transport.finish(id!, "answer-a");
    expect((await retry).text).toBe("answer-a");
    await lease.release(true);
    expect(transport.calls.filter((call) => call.method === "thread/start")).toHaveLength(2);
  });

  it.each(["timeout", "error after started"])(
    "turn/start 结果不明确时隔离会话：%s",
    async (reason) => {
      const { pool, transport } = create();
      const original = transport.request.bind(transport);
      transport.request = async (method, params) => {
        if (method === "turn/start") {
          if (reason === "error after started") {
            transport.emit("turn/started", {
              threadId: params.threadId,
              turn: { id: "unknown-turn", status: "inProgress" },
            });
            throw new CodexPoolRpcError("429 after started");
          }
          throw new Error("response timeout");
        }
        return original(method, params);
      };
      const signal = new AbortController().signal;
      const lease = await pool.acquire(signal);
      await expect(lease.run("role-a", {}, signal)).rejects.toThrow();
      await expect(lease.release(true)).rejects.toThrow();
      await expect(pool.acquire(signal)).rejects.toThrow();
      expect(transport.calls.some((call) => call.method === "thread/unsubscribe")).toBe(false);
    },
  );

  it("turn/start 响应前的完成事件仍按正确 turn ID 收集", async () => {
    const { pool, transport } = create();
    const original = transport.request.bind(transport);
    transport.request = async (method, params) => {
      const result = await original(method, params);
      if (method === "turn/start")
        transport.finish((result as { turn: { id: string } }).turn.id, "early-answer");
      return result;
    };
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    expect((await lease.run("role-a", {}, signal)).text).toBe("early-answer");
    await lease.release(true);
  });

  it("释放后的旧租约和取消的排队任务不能占用新角色", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const old = await pool.acquire(signal);
    const controller = new AbortController();
    const waiting = pool.acquire(controller.signal);
    const rejected = expect(waiting).rejects.toThrow("canceled");
    controller.abort(new Error("canceled"));
    await rejected;
    await old.release(true);
    const current = await pool.acquire(signal);
    await expect(old.run("old-role", {}, signal)).rejects.toThrow();
    const pending = current.run("new-role", {}, signal);
    const [[id]] = await turns(transport, 1);
    transport.finish(id!, "new-answer");
    expect((await pending).text).toBe("new-answer");
    await current.release(true);
  });

  it("服务退出使执行与排队请求失败，不能派发新角色", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const run = lease.run("role-a", {}, signal);
    const waiting = pool.acquire(signal);
    const rejectedRun = expect(run).rejects.toThrow("server exited");
    const rejectedWaiting = expect(waiting).rejects.toThrow("server exited");
    await turns(transport, 1);
    for (const listener of transport.listeners)
      listener({ method: "$closed", error: new Error("server exited") });
    await Promise.all([rejectedRun, rejectedWaiting]);
    await expect(lease.release(true)).rejects.toThrow("server exited");
  });

  it("极大合法并发只为实际任务创建槽位", async () => {
    const { pool, transport } = create(Number.MAX_SAFE_INTEGER);
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const pending = lease.run("only-role", {}, signal);
    const [[id]] = await turns(transport, 1);
    transport.finish(id!, "answer");
    expect((await pending).text).toBe("answer");
    await lease.release(true);
    expect(transport.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
  });
  it("服务未确认临时会话时不提交角色资料", async () => {
    const { pool, transport } = create();
    const original = transport.request.bind(transport);
    transport.request = async (method, params) => {
      const result = await original(method, params);
      return method === "thread/start" ? { thread: { id: "thread-1", ephemeral: false } } : result;
    };
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    await expect(lease.run("private-role", {}, signal)).rejects.toThrow("未创建无状态会话");
    expect(transport.turns.size).toBe(0);
    await expect(pool.acquire(signal)).rejects.toThrow("未创建无状态会话");
  });

  it("新建与卸载共享生命周期队列，活动请求仍可完成和取消", async () => {
    const { pool, transport } = create(3);
    const signal = new AbortController().signal;
    const saved = await pool.acquire(signal);
    const activeController = new AbortController();
    const active = await pool.acquire(activeController.signal);
    const savedRun = saved.run("saved-role", {}, signal);
    const activeRun = active.run("active-role", {}, activeController.signal);
    const rejected = expect(activeRun).rejects.toThrow("paused");
    const started = await turns(transport, 2);
    const savedId = started.find(([, turn]) => turn.prompt === "saved-role")![0];
    const activeId = started.find(([, turn]) => turn.prompt === "active-role")![0];
    transport.finish(savedId, "saved-answer");
    await savedRun;
    const original = transport.request.bind(transport);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const lifecycle: string[] = [];
    let inFlight = 0;
    let maximum = 0;
    transport.request = async (method, params) => {
      if (!["thread/start", "thread/unsubscribe"].includes(method)) return original(method, params);
      lifecycle.push(method);
      maximum = Math.max(maximum, ++inFlight);
      try {
        if (lifecycle.length === 1) await gate;
        return await original(method, params);
      } finally {
        inFlight--;
      }
    };
    const released = saved.release(true);
    await vi.waitFor(() => expect(lifecycle).toEqual(["thread/unsubscribe"]));
    const next = await pool.acquire(signal);
    const nextRun = next.run("next-role", {}, signal);
    activeController.abort(new Error("paused"));
    await vi.waitFor(() =>
      expect(transport.calls.some((call) => call.method === "turn/interrupt")).toBe(true),
    );
    transport.finish(activeId!, "", "interrupted");
    unblock();
    await Promise.all([released, rejected]);
    const [nextId] = (await turns(transport, 3))[2]!;
    expect(maximum).toBe(1);
    transport.finish(nextId, "next-answer");
    expect((await nextRun).text).toBe("next-answer");
    await Promise.all([active.release(true), next.release(true)]);
  });

  it("排队的新建请求取消后不发送，正在新建时取消会卸载而不提交turn", async () => {
    const { pool, transport } = create(2);
    const original = transport.request.bind(transport);
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let starting = false;
    transport.request = async (method, params) => {
      if (method === "thread/start") {
        starting = true;
        await gate;
      }
      return original(method, params);
    };
    const firstController = new AbortController();
    const first = await pool.acquire(firstController.signal);
    const firstRun = first.run("first", {}, firstController.signal);
    const firstRejected = expect(firstRun).rejects.toThrow("first canceled");
    await vi.waitFor(() => expect(starting).toBe(true));
    const secondController = new AbortController();
    const second = await pool.acquire(secondController.signal);
    const secondRun = second.run("second", {}, secondController.signal);
    const secondRejected = expect(secondRun).rejects.toThrow("second canceled");
    secondController.abort(new Error("second canceled"));
    await secondRejected;
    firstController.abort(new Error("first canceled"));
    unblock();
    await firstRejected;
    await Promise.all([first.release(true), second.release(true)]);
    expect(transport.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
    expect(transport.turns.size).toBe(0);
    expect(transport.histories.size).toBe(0);
  });

  // Failure cases: close returns while the native child is still alive; SIGTERM is ignored;
  // an already-exited process is signalled again; or an uncertain shutdown deletes its cwd.
  it
    .skipIf(process.platform === "win32")
    .each([
      "normal",
      "ignore SIGTERM",
      "already exited",
      "leader exited before child",
      "shutdown timeout",
    ])(
    "stdio 实际父子进程全部退出后才完成关闭：%s",
    async (mode) => {
      const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const childIgnoresTerm = [
        "ignore SIGTERM",
        "leader exited before child",
        "shutdown timeout",
      ].includes(mode);
      const grandchildScript = `${childIgnoresTerm ? "process.on('SIGTERM',()=>{});" : ""}require('node:fs').writeFileSync('fixture-child-ready','1');setInterval(()=>{},1000)`;
      const fixture = `
        const {spawn}=require('node:child_process');
        const fs=require('node:fs');
        const child=spawn(process.execPath,['-e',${JSON.stringify(grandchildScript)}],{stdio:'inherit'});
        fs.writeFileSync('fixture-child.pid',String(child.pid));
        ${["ignore SIGTERM", "shutdown timeout"].includes(mode) ? "process.on('SIGTERM',()=>{});" : ""}
        let input=''; const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
        process.stdin.on('data',chunk=>{input+=chunk;let end;while((end=input.indexOf('\\n'))>=0){
          const m=JSON.parse(input.slice(0,end));input=input.slice(end+1);
          if(m.method==='initialize') send({id:m.id,result:{}});
          if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-1',ephemeral:true}}});
          if(m.method==='turn/start') {send({id:m.id,result:{turn:{id:'turn-1'}}});send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',text:'ok'}}});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});}
          if(m.method==='thread/unsubscribe') send({id:m.id,result:{status:'unsubscribed'}});
        }});
        setInterval(()=>{},1000);
      `;
      let child: ReturnType<typeof real.spawn> | undefined;
      let directory = "";
      let detached: unknown;
      let grandchild = 0;
      let restoreKill: (() => void) | undefined;
      let fixtureClosed = false;
      spawnMock.mockImplementation(
        (_command: string, _args: string[], options: { cwd: string; detached?: boolean }) => {
          directory = options.cwd;
          detached = options.detached;
          child = real.spawn(process.execPath, ["-e", fixture], { ...options, detached: true });
          child.once("close", () => {
            fixtureClosed = true;
          });
          return child;
        },
      );
      const pool = new CodexPool(1, "gpt-6-luna");
      pools.push(pool);
      try {
        const signal = new AbortController().signal;
        const lease = await pool.acquire(signal);
        expect((await lease.run("role", {}, signal)).text).toBe("ok");
        expect(spawnMock.mock.calls[0]![1]).toContain('cli_auth_credentials_store="file"');
        expect(spawnMock.mock.calls[0]![1]).toEqual(
          expect.arrayContaining([
            'model_provider="openai_http"',
            'model_providers.openai_http={name="OpenAI",wire_api="responses",requires_openai_auth=true,supports_websockets=false}',
          ]),
        );
        expect(spawnMock.mock.calls[0]![2].env).toMatchObject({
          CODEX_HOME: "/private/tmp/cbg-pool-fixture",
          CODEX_SQLITE_HOME: "/private/tmp/cbg-pool-fixture",
        });
        await lease.release(true);
        grandchild = Number(await readFile(join(directory, "fixture-child.pid"), "utf8"));
        await vi.waitFor(() =>
          expect(existsSync(join(directory, "fixture-child-ready"))).toBe(true),
        );
        expect(child?.pid).toBeGreaterThan(0);
        expect(grandchild).toBeGreaterThan(0);
        expect(detached).toBe(true);
        if (mode === "already exited") {
          const closed = once(child!, "close");
          process.kill(-child!.pid!, "SIGTERM");
          await closed;
          const spy = vi.spyOn(process, "kill");
          restoreKill = () => spy.mockRestore();
          await pool.close();
          expect(spy).not.toHaveBeenCalled();
          restoreKill();
          restoreKill = undefined;
        } else if (mode === "leader exited before child") {
          const exited = once(child!, "exit");
          child!.kill("SIGTERM");
          await exited;
          const spy = vi.spyOn(process, "kill");
          restoreKill = () => spy.mockRestore();
          await expect(pool.close()).rejects.toThrow("无法确认子进程关闭");
          expect(spy).not.toHaveBeenCalled();
          expect(existsSync(directory)).toBe(true);
          restoreKill();
          restoreKill = undefined;
        } else if (mode === "shutdown timeout") {
          const realKill = process.kill.bind(process);
          const spy = vi
            .spyOn(process, "kill")
            .mockImplementation((pid, signal) =>
              pid === -child!.pid! ? true : realKill(pid, signal),
            );
          restoreKill = () => spy.mockRestore();
          await expect(pool.close()).rejects.toThrow("无法确认 Codex 分析服务进程树已关闭");
          expect(spy).toHaveBeenCalledWith(-child!.pid!, "SIGTERM");
          expect(spy).toHaveBeenCalledWith(-child!.pid!, "SIGKILL");
          expect(existsSync(directory)).toBe(true);
          restoreKill();
          restoreKill = undefined;
        } else await pool.close();
        if (!["leader exited before child", "shutdown timeout"].includes(mode)) {
          expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
          if (mode === "ignore SIGTERM") expect(child?.signalCode).toBe("SIGKILL");
          await vi.waitFor(() => expect(() => process.kill(grandchild, 0)).toThrow());
          expect(existsSync(directory)).toBe(false);
        }
      } finally {
        restoreKill?.();
        const closed =
          child && !fixtureClosed
            ? Promise.race([
                once(child, "close"),
                new Promise((resolve) => setTimeout(resolve, 2000)),
              ])
            : Promise.resolve();
        if (child?.pid && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        if (grandchild) {
          try {
            process.kill(grandchild, "SIGKILL");
          } catch {}
        }
        await closed;
        if (directory && fixtureClosed) await rm(directory, { recursive: true, force: true });
      }
    },
    15_000,
  );

  // Failure cases: a string-ID server request is ignored, a numeric-ID request is approved,
  // a notification receives a response, or a regular RPC response is mistaken for a request.
  it("stdio 协议拒绝字符串和数字 ID 的意外授权请求", async () => {
    class MockChild extends EventEmitter {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      kill() {
        this.stdin.end();
        this.stdout.end();
        this.stderr.end();
        this.emit("exit", 0);
        this.emit("close", 0);
        return true;
      }
    }
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    const replies: Record<string, unknown>[] = [];
    let buffer = "";
    const send = (message: unknown) => child.stdout.write(JSON.stringify(message) + "\n");
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)) as Record<string, unknown>;
        buffer = buffer.slice(end + 1);
        if (message.method === "initialize") send({ id: message.id, result: {} });
        else if (message.method === "initialized") {
          send({
            id: "approval-string",
            method: "item/commandExecution/requestApproval",
            params: {},
          });
          send({ id: 42, method: "item/commandExecution/requestApproval", params: {} });
          send({ method: "thread/started", params: {} });
        } else if (message.method === "thread/start")
          send({ id: message.id, result: { thread: { id: "thread-1", ephemeral: true } } });
        else if (message.method === "turn/start") {
          send({ id: message.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
          send({
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              item: { type: "agentMessage", text: "answer" },
            },
          });
          send({
            method: "turn/completed",
            params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } },
          });
        } else if (message.method === "thread/unsubscribe")
          send({ id: message.id, result: { status: "unsubscribed" } });
        else if (message.error) replies.push(message);
      }
    });
    const pool = new CodexPool(1, "gpt-6-luna");
    pools.push(pool);
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    expect((await lease.run("role", {}, signal)).text).toBe("answer");
    await vi.waitFor(() => expect(replies).toHaveLength(2));
    expect(replies).toEqual([
      { id: "approval-string", error: { code: -32600, message: "Not supported" } },
      { id: 42, error: { code: -32600, message: "Not supported" } },
    ]);
    await lease.release(true);
  });

  it.each(["timeout", "close"])("已发送请求%s时停止池，不发送队列中的会话请求", async (mode) => {
    class MockChild extends EventEmitter {
      readonly stdin = new PassThrough();
      readonly stdout = new PassThrough();
      readonly stderr = new PassThrough();
      kill() {
        this.stdin.end();
        this.stdout.end();
        this.stderr.end();
        this.emit("exit", 0);
        this.emit("close", 0);
        return true;
      }
    }
    const child = new MockChild();
    spawnMock.mockReturnValue(child);
    const requests: string[] = [];
    let buffer = "";
    child.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)) as { id?: number; method: string };
        buffer = buffer.slice(end + 1);
        if (message.method === "initialize")
          child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\n");
        else if (message.method === "thread/start") requests.push(message.method);
      }
    });
    const pool = new CodexPool(2, "gpt-6-luna");
    pools.push(pool);
    const signal = new AbortController().signal;
    const leases = await Promise.all([pool.acquire(signal), pool.acquire(signal)]);
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const outcomes = Promise.allSettled(
      leases.map((lease, index) => lease.run(`role-${index}`, {}, signal)),
    );
    await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0));
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(20_001);
    else await pool.close();
    const results = await outcomes;
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    if (mode === "timeout")
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason.message).toContain("thread/start 响应超时");
    expect(requests).toEqual(["thread/start"]);
    await expect(pool.acquire(signal)).rejects.toThrow();
  });
});
