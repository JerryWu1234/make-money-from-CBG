import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EventEmitter } from "node:events";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { DatabaseSync } from "node:sqlite";
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

// Failure cases: sessions are recreated per role, one session runs two roles at once,
// events cross between turns, retryable errors stop a turn, results are reset before
// persistence, old role history reaches a new role, cancellation releases early,
// a failed reset or an exited server leaves a slot reusable, or waiters never settle.
class FakeTransport implements CodexPoolTransport {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  readonly histories = new Map<string, string[]>();
  readonly turns = new Map<string, { threadId: string; prompt: string }>();
  listeners = new Set<(event: CodexPoolEvent) => void>();
  failRevert = false;
  retainHistory = false;
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
      const id = `thread-${++this.nextThread}`;
      this.histories.set(id, []);
      return { thread: { id } };
    }
    if (method === "thread/resume") {
      const id = String(params.threadId);
      if (!this.histories.has(id)) throw new Error("unknown persisted thread");
      return { thread: { id } };
    }
    if (method === "turn/start") {
      const id = `turn-${++this.nextTurn}`;
      const threadId = String(params.threadId);
      const input = params.input as { text: string }[];
      this.turns.set(id, { threadId, prompt: input[0]!.text });
      this.histories.get(threadId)!.push(id);
      // Real app-server notifications can precede the JSON-RPC response.
      this.emit("turn/started", { threadId, turn: { id, status: "inProgress" } });
      return { turn: { id, status: "inProgress" } };
    }
    if (method === "thread/revert") {
      if (this.failRevert) throw new Error("revert failed");
      const threadId = String(params.threadId);
      const history = this.histories.get(threadId)!;
      const index = history.indexOf(String(params.beforeTurnId));
      if (index < 0) throw new Error("unknown turn");
      if (!this.retainHistory) history.splice(index);
      return { thread: { id: threadId } };
    }
    if (method === "thread/turns/list")
      return { data: this.histories.get(String(params.threadId))!.map((id) => ({ id })) };
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
  async close() {}
}

const pools: CodexPool[] = [];
function create(size = 1) {
  const transport = new FakeTransport();
  const pool = new CodexPool(size, "gpt-6-luna", async () => transport);
  pools.push(pool);
  return { pool, transport };
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

describe("Codex 固定会话池", () => {
  // Failure cases: restarted pool starts new threads instead of resuming clean ones;
  // unsaved results or interrupted threads are reused; changed account/model/scope
  // gets another context; a resumed thread with history leaks it into the next role.
  it("跨池只恢复已保存并清空的持久线程，失败线程不复用", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbg-pool-restart-test-"));
    const transport = new FakeTransport();
    const options = { statePath: join(directory, "pool.sqlite"), accountId: "fixture-account" };
    const signal = new AbortController().signal;
    const pool = () => {
      const instance = new CodexPool(1, "gpt-6-luna", async () => transport, options);
      pools.push(instance);
      return instance;
    };
    try {
      const first = pool();
      const lease = await first.acquire(signal);
      const pending = lease.run("role-a", {}, signal, { bareRoleReview: true });
      const [id, turn] = (await turns(transport, 1))[0]!;
      transport.finish(id, "result-a");
      expect((await pending).text).toBe("result-a");
      await lease.release(true);
      const unused = await first.acquire(signal);
      await unused.release(true);
      await first.close();

      const second = pool();
      const again = await second.acquire(signal);
      const pendingAgain = again.run("role-b", {}, signal, { bareRoleReview: true });
      const [id2, turn2] = (await turns(transport, 2))[1]!;
      expect(turn2.threadId).toBe(turn.threadId);
      expect(transport.calls.filter((call) => call.method === "thread/resume")).toHaveLength(1);
      transport.finish(id2, "result-b");
      await pendingAgain;
      await expect(again.release(false)).rejects.toThrow("分析结果未保存");
      await second.close();

      const third = pool();
      const replacement = await third.acquire(signal);
      const pendingThird = replacement.run("role-c", {}, signal, { bareRoleReview: true });
      const [id3, turn3] = (await turns(transport, 3))[2]!;
      expect(turn3.threadId).not.toBe(turn.threadId);
      transport.finish(id3, "result-c");
      await pendingThird;
      await replacement.release(true);
      await third.close();
    } finally {
      await Promise.allSettled(pools.splice(0).map((entry) => entry.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("持久线程按账号、模型和分析范围隔离", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbg-pool-config-test-"));
    const statePath = join(directory, "pool.sqlite");
    const transport = new FakeTransport();
    const signal = new AbortController().signal;
    const used: string[] = [];
    async function role(accountId: string, model: string, bareRoleReview: boolean) {
      const pool = new CodexPool(1, model, async () => transport, { statePath, accountId });
      pools.push(pool);
      const lease = await pool.acquire(signal);
      const count = transport.turns.size + 1;
      const pending = lease.run("fixture-role", {}, signal, { bareRoleReview });
      const [id, turn] = (await turns(transport, count))[count - 1]!;
      transport.finish(id, "fixture-result");
      await pending;
      used.push(turn.threadId);
      await lease.release(true);
      await pool.close();
    }
    try {
      await role("account-a", "model-a", true);
      await role("account-b", "model-a", true);
      await role("account-a", "model-b", true);
      await role("account-a", "model-a", false);
      await role("account-a", "model-a", true);
      expect(new Set(used.slice(0, 4)).size).toBe(4);
      expect(used[4]).toBe(used[0]);
    } finally {
      await Promise.allSettled(pools.splice(0).map((entry) => entry.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("恢复线程出现旧历史时暂停且隔离该线程", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbg-pool-dirty-test-"));
    const transport = new FakeTransport();
    const options = { statePath: join(directory, "pool.sqlite"), accountId: "fixture-account" };
    const signal = new AbortController().signal;
    const createPool = () => {
      const pool = new CodexPool(1, "model-a", async () => transport, options);
      pools.push(pool);
      return pool;
    };
    try {
      const first = createPool();
      const lease = await first.acquire(signal);
      const pending = lease.run("role-a", {}, signal);
      const [id, turn] = (await turns(transport, 1))[0]!;
      transport.finish(id, "result-a");
      await pending;
      await lease.release(true);
      await first.close();
      transport.histories.set(turn.threadId, ["unexpected-old-turn"]);

      const second = createPool();
      const resumed = await second.acquire(signal);
      await expect(resumed.run("role-b", {}, signal)).rejects.toThrow("历史未清空");
      expect(transport.turns.size).toBe(1);
      await second.close();

      const third = createPool();
      const replacement = await third.acquire(signal);
      const later = replacement.run("role-c", {}, signal);
      const [id2, turn2] = (await turns(transport, 2))[1]!;
      expect(turn2.threadId).not.toBe(turn.threadId);
      transport.finish(id2, "result-c");
      await later;
      await replacement.release(true);
      await third.close();
    } finally {
      await Promise.allSettled(pools.splice(0).map((entry) => entry.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("结果返回但未落库时，重启池不复用可能含旧资料的线程", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbg-pool-abandoned-test-"));
    const transport = new FakeTransport();
    const options = { statePath: join(directory, "pool.sqlite"), accountId: "fixture-account" };
    const signal = new AbortController().signal;
    const createPool = () => {
      const pool = new CodexPool(1, "model-a", async () => transport, options);
      pools.push(pool);
      return pool;
    };
    try {
      const first = createPool();
      const lease = await first.acquire(signal);
      const pending = lease.run("role-a", {}, signal);
      const [id, turn] = (await turns(transport, 1))[0]!;
      transport.finish(id, "not-yet-persisted");
      await pending;
      await first.close();

      const second = createPool();
      const next = await second.acquire(signal);
      const later = next.run("role-b", {}, signal);
      const [id2, turn2] = (await turns(transport, 2))[1]!;
      expect(turn2.threadId).not.toBe(turn.threadId);
      transport.finish(id2, "result-b");
      await later;
      await next.release(true);
      await second.close();
    } finally {
      await Promise.allSettled(pools.splice(0).map((entry) => entry.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("两个槽交错领取时不会同时绑定同一持久线程", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbg-pool-claim-test-"));
    const transport = new FakeTransport();
    const pool = new CodexPool(2, "model-a", async () => transport, {
      statePath: join(directory, "pool.sqlite"),
      accountId: "fixture-account",
    });
    pools.push(pool);
    const signal = new AbortController().signal;
    try {
      const first = await pool.acquire(signal);
      const waitingSlot = await pool.acquire(signal);
      const pending = first.run("role-a", {}, signal);
      const [id, turn] = (await turns(transport, 1))[0]!;
      transport.finish(id, "result-a");
      await pending;
      await first.release(true);

      const second = waitingSlot.run("role-b", {}, signal);
      const [id2, turn2] = (await turns(transport, 2))[1]!;
      expect(turn2.threadId).toBe(turn.threadId);
      const otherSlot = await pool.acquire(signal);
      const third = otherSlot.run("role-c", {}, signal);
      const [id3, turn3] = (await turns(transport, 3))[2]!;
      expect(turn3.threadId).not.toBe(turn2.threadId);
      transport.finish(id2, "result-b");
      transport.finish(id3, "result-c");
      await Promise.all([second, third]);
      await Promise.all([waitingSlot.release(true), otherSlot.release(true)]);
      await pool.close();
    } finally {
      await Promise.allSettled(pools.splice(0).map((entry) => entry.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("两个池同时运行时使用不同持久线程", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbg-pool-multiple-test-"));
    const transport = new FakeTransport();
    const options = { statePath: join(directory, "pool.sqlite"), accountId: "fixture-account" };
    const signal = new AbortController().signal;
    const createPool = () => {
      const pool = new CodexPool(1, "model-a", async () => transport, options);
      pools.push(pool);
      return pool;
    };
    try {
      const seed = createPool();
      const seedLease = await seed.acquire(signal);
      const seedRun = seedLease.run("seed", {}, signal);
      const [seedId, seedTurn] = (await turns(transport, 1))[0]!;
      transport.finish(seedId, "seed-result");
      await seedRun;
      await seedLease.release(true);
      await seed.close();

      const first = createPool();
      const second = createPool();
      const leaseA = await first.acquire(signal);
      const leaseB = await second.acquire(signal);
      const pendingA = leaseA.run("role-a", {}, signal);
      const pendingB = leaseB.run("role-b", {}, signal);
      const started = (await turns(transport, 3)).slice(1);
      expect(new Set(started.map(([, turn]) => turn.threadId)).size).toBe(2);
      expect(started.some(([, turn]) => turn.threadId === seedTurn.threadId)).toBe(true);
      const startCwds = transport.calls
        .filter((call) => call.method === "thread/start")
        .map((call) => String(call.params.cwd));
      expect(new Set(startCwds).size).toBe(2);
      expect(transport.calls.filter((call) => call.method === "thread/resume")[0]!.params.cwd).toBe(
        startCwds[0],
      );
      for (const [id, turn] of started) transport.finish(id, `result:${turn.prompt}`);
      await Promise.all([pendingA, pendingB]);
      await Promise.all([leaseA.release(true), leaseB.release(true)]);
      await Promise.all([first.close(), second.close()]);
    } finally {
      await Promise.allSettled(pools.splice(0).map((entry) => entry.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Failure cases: concurrent roles share an ID, a restart creates new sessions,
  // stale role turns remain, or results are routed to a different role.
  it("10 个持久线程跨池并发恢复，保持 ID 并隔离角色", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbg-pool-ten-restart-"));
    const transport = new FakeTransport();
    const options = { statePath: join(directory, "pool.sqlite"), accountId: "fixture-account" };
    const signal = new AbortController().signal;
    const createPool = () => {
      const pool = new CodexPool(10, "model-a", async () => transport, options);
      pools.push(pool);
      return pool;
    };
    try {
      const first = createPool();
      const leases = await Promise.all(Array.from({ length: 10 }, () => first.acquire(signal)));
      const pending = leases.map((lease, index) =>
        lease.run(`role-a-${index}`, {}, signal, { bareRoleReview: true }),
      );
      const started = await turns(transport, 10);
      const firstIds = new Set(started.map(([, turn]) => turn.threadId));
      expect(firstIds.size).toBe(10);
      for (const [id, turn] of [...started].reverse()) {
        expect(transport.histories.get(turn.threadId)).toEqual([id]);
        transport.finish(id, `result:${turn.prompt}`);
      }
      expect((await Promise.all(pending)).map((item) => item.text).sort()).toEqual(
        Array.from({ length: 10 }, (_, index) => `result:role-a-${index}`).sort(),
      );
      await Promise.all(leases.map((lease) => lease.release(true)));
      for (const id of firstIds) expect(transport.histories.get(id)).toEqual([]);
      await first.close();

      const second = createPool();
      const next = await Promise.all(Array.from({ length: 10 }, () => second.acquire(signal)));
      const pendingNext = next.map((lease, index) =>
        lease.run(`role-b-${index}`, {}, signal, { bareRoleReview: true }),
      );
      const resumed = (await turns(transport, 20)).slice(10);
      expect(new Set(resumed.map(([, turn]) => turn.threadId))).toEqual(firstIds);
      expect(transport.calls.filter((call) => call.method === "thread/start")).toHaveLength(10);
      expect(transport.calls.filter((call) => call.method === "thread/resume")).toHaveLength(10);
      for (const [id, turn] of [...resumed].reverse()) {
        expect(transport.histories.get(turn.threadId)).toEqual([id]);
        transport.finish(id, `result:${turn.prompt}`);
      }
      expect((await Promise.all(pendingNext)).map((item) => item.text).sort()).toEqual(
        Array.from({ length: 10 }, (_, index) => `result:role-b-${index}`).sort(),
      );
      await Promise.all(next.map((lease) => lease.release(true)));
      for (const id of firstIds) expect(transport.histories.get(id)).toEqual([]);
      await second.close();
    } finally {
      await Promise.allSettled(pools.splice(0).map((entry) => entry.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  // Failure cases: the reusable thread points to a deleted or different cwd,
  // previous role files remain, two threads share a cwd, or missing cwd cannot recover.
  it("持久线程跨角色及跨池保持相同目录，并清除上次角色文件", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbg-pool-workspace-test-"));
    const transport = new FakeTransport();
    const options = { statePath: join(directory, "pool.sqlite"), accountId: "fixture-account" };
    const signal = new AbortController().signal;
    const createPool = () => {
      const pool = new CodexPool(1, "model-a", async () => transport, options);
      pools.push(pool);
      return pool;
    };
    try {
      const first = createPool();
      const a = await first.acquire(signal);
      const aRun = a.run("role-a", {}, signal);
      const [aId] = (await turns(transport, 1))[0]!;
      const cwd = String(
        transport.calls.find((call) => call.method === "thread/start")!.params.cwd,
      );
      await writeFile(join(cwd, "previous-role.txt"), "fixture");
      transport.finish(aId, "result-a");
      await aRun;
      await a.release(true);
      expect(existsSync(cwd)).toBe(true);
      expect(existsSync(join(cwd, "previous-role.txt"))).toBe(false);

      const b = await first.acquire(signal);
      const bRun = b.run("role-b", {}, signal);
      const [bId] = (await turns(transport, 2))[1]!;
      expect(transport.calls.filter((call) => call.method === "thread/resume")[0]!.params.cwd).toBe(
        cwd,
      );
      transport.finish(bId, "result-b");
      await bRun;
      await b.release(true);
      await first.close();

      await rm(cwd, { recursive: true });
      const second = createPool();
      const c = await second.acquire(signal);
      const cRun = c.run("role-c", {}, signal);
      const [cId] = (await turns(transport, 3))[2]!;
      expect(transport.calls.filter((call) => call.method === "thread/resume")[1]!.params.cwd).toBe(
        cwd,
      );
      expect(existsSync(cwd)).toBe(true);
      transport.finish(cId, "result-c");
      await cRun;
      await c.release(true);
      await second.close();
    } finally {
      await Promise.allSettled(pools.splice(0).map((entry) => entry.close()));
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("持久目录元数据异常时不访问目录，也不发送角色资料", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbg-pool-invalid-workspace-"));
    const statePath = join(directory, "pool.sqlite");
    const transport = new FakeTransport();
    const signal = new AbortController().signal;
    const options = { statePath, accountId: "fixture-account" };
    const createPool = () => {
      const pool = new CodexPool(1, "model-a", async () => transport, options);
      pools.push(pool);
      return pool;
    };
    try {
      const first = createPool();
      const lease = await first.acquire(signal);
      const pending = lease.run("role-a", {}, signal);
      const [id] = (await turns(transport, 1))[0]!;
      transport.finish(id, "result-a");
      await pending;
      await lease.release(true);
      await first.close();
      const db = new DatabaseSync(statePath);
      db.prepare("UPDATE reusable_threads SET workspace=?").run("../outside");
      db.close();
      const second = createPool();
      const next = await second.acquire(signal);
      await expect(next.run("role-b", {}, signal)).rejects.toThrow("会话目录无效");
      expect(transport.turns.size).toBe(1);
      await second.close();
    } finally {
      await Promise.allSettled(pools.splice(0).map((entry) => entry.close()));
      await rm(directory, { recursive: true, force: true });
    }
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
          if(m.method==='thread/start') send({id:m.id,result:{thread:{id:'thread-1'}}});
          if(m.method==='turn/start') {send({id:m.id,result:{turn:{id:'turn-1'}}});send({method:'item/completed',params:{threadId:'thread-1',turnId:'turn-1',item:{type:'agentMessage',text:'ok'}}});send({method:'turn/completed',params:{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}}});}
          if(m.method==='thread/revert') send({id:m.id,result:{}});
          if(m.method==='thread/turns/list') send({id:m.id,result:{data:[]}});
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
          send({ id: message.id, result: { thread: { id: "thread-1" } } });
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
        } else if (message.method === "thread/revert") send({ id: message.id, result: {} });
        else if (message.method === "thread/turns/list")
          send({ id: message.id, result: { data: [] } });
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

  it("10 个 session 独立并发，保存后回退并复用原 session，不串角色或中间重连", async () => {
    const { pool, transport } = create(10);
    const signal = new AbortController().signal;
    const leases = await Promise.all(Array.from({ length: 10 }, () => pool.acquire(signal)));
    const pending = leases.map((lease, i) =>
      lease.run(`role-${i}`, { type: "object" }, signal, { bareRoleReview: true }),
    );
    const started = await turns(transport, 10);
    expect(new Set(started.map(([, turn]) => turn.threadId)).size).toBe(10);
    const [firstId, first] = started[0]!;
    transport.emit("error", {
      threadId: first.threadId,
      turnId: firstId,
      error: { message: "reconnecting" },
      willRetry: true,
    });
    transport.emit("item/completed", {
      threadId: first.threadId,
      turnId: "different-turn",
      item: { type: "agentMessage", text: "wrong" },
    });
    for (const [id, turn] of [...started].reverse()) transport.finish(id, `answer:${turn.prompt}`);
    const results = await Promise.all(pending);
    expect(results.map((result) => result.text).sort()).toEqual(
      started.map(([, turn]) => `answer:${turn.prompt}`).sort(),
    );
    expect(results[0]!.usage).toMatchObject({
      input_tokens: 11,
      output_tokens: 4,
      input_scope: "body",
    });
    expect(transport.calls.filter((call) => call.method === "thread/revert")).toHaveLength(0);
    await Promise.all(leases.map((lease) => lease.release(true)));
    expect(transport.calls.filter((call) => call.method === "thread/revert")).toHaveLength(10);
    const again = await Promise.all(Array.from({ length: 10 }, () => pool.acquire(signal)));
    const second = again.map((lease, i) =>
      lease.run(`next-${i}`, { type: "object" }, signal, { bareRoleReview: true }),
    );
    const startedAgain = (await turns(transport, 20)).slice(10);
    expect(new Set(startedAgain.map(([, turn]) => turn.threadId))).toEqual(
      new Set(started.map(([, turn]) => turn.threadId)),
    );
    expect(transport.calls.filter((call) => call.method === "thread/start")).toHaveLength(10);
    for (const [id, turn] of startedAgain) transport.finish(id, `answer:${turn.prompt}`);
    expect((await Promise.all(second)).map((value) => value.text).sort()).toEqual(
      startedAgain.map(([, turn]) => `answer:${turn.prompt}`).sort(),
    );
    await Promise.all(again.map((lease) => lease.release(true)));
  });

  it("取消后等待该 turn 确认结束并落库，再回退且允许重新领取", async () => {
    const { pool, transport } = create();
    const controller = new AbortController();
    const lease = await pool.acquire(controller.signal);
    const run = lease.run("role-a", {}, controller.signal).catch((error: unknown) => error);
    const [[id]] = await turns(transport, 1);
    controller.abort(new Error("paused"));
    await vi.waitFor(() =>
      expect(transport.calls.some((call) => call.method === "turn/interrupt")).toBe(true),
    );
    const release = lease.release(true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(transport.calls.some((call) => call.method === "thread/revert")).toBe(false);
    transport.finish(id!, "", "interrupted");
    expect(await run).toMatchObject({ message: "paused" });
    await release;
    expect(transport.calls.some((call) => call.method === "thread/revert")).toBe(true);
    await (await pool.acquire(new AbortController().signal)).release(true);
  });

  it("结果未持久化时保留会话历史，停止派发", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const run = lease.run("role-a", {}, signal);
    const [[id]] = await turns(transport, 1);
    transport.finish(id!, "answer-a");
    expect((await run).text).toBe("answer-a");
    await expect(lease.release(false)).rejects.toThrow();
    expect(transport.calls.some((call) => call.method === "thread/revert")).toBe(false);
    await expect(pool.acquire(signal)).rejects.toThrow();
  });

  it("同角色发生429后在同一租约重试，持久化后从首个 turn 一次回退", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const first = lease.run("role-a", {}, signal);
    const [[firstId]] = await turns(transport, 1);
    const failed = expect(first).rejects.toThrow("failed");
    transport.finish(firstId!, "", "failed");
    await failed;
    const second = lease.run("role-a", {}, signal);
    const [[, firstInfo], [secondId, secondInfo]] = await turns(transport, 2);
    expect(firstInfo!.threadId).toBe(secondInfo!.threadId);
    transport.finish(secondId!, "answer-a");
    expect((await second).text).toBe("answer-a");
    expect(transport.calls.filter((call) => call.method === "thread/revert")).toHaveLength(0);
    await lease.release(true);
    expect(
      transport.calls.find((call) => call.method === "thread/revert")?.params.beforeTurnId,
    ).toBe(firstId);
    expect(transport.histories.get(firstInfo!.threadId)).toEqual([]);
  });

  it("首轮失败后第二次在 turn/start 前取消，落库后仍回退首轮", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const first = lease.run("role-a", {}, signal);
    const [[firstId, firstInfo]] = await turns(transport, 1);
    const failed = expect(first).rejects.toThrow("failed");
    transport.finish(firstId!, "", "failed");
    await failed;
    const controller = new AbortController();
    const retry = lease.run("role-a", {}, controller.signal);
    controller.abort(new Error("paused before start"));
    await expect(retry).rejects.toThrow("paused before start");
    expect(transport.turns.size).toBe(1);
    await lease.release(true);
    expect(
      transport.calls.find((call) => call.method === "thread/revert")?.params.beforeTurnId,
    ).toBe(firstId);
    expect(transport.histories.get(firstInfo!.threadId)).toEqual([]);
    const next = await pool.acquire(signal);
    const run = next.run("role-b", {}, signal);
    const allTurns = await turns(transport, 2);
    transport.finish(allTurns[1]![0], "answer-b");
    expect((await run).text).toBe("answer-b");
    await next.release(true);
  });

  it("释放后的旧租约和已取消的排队任务不能占用新角色的 session", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const old = await pool.acquire(signal);
    const waiting = new AbortController();
    const queued = pool.acquire(waiting.signal);
    const rejected = expect(queued).rejects.toThrow("waiting canceled");
    waiting.abort(new Error("waiting canceled"));
    await rejected;
    await old.release(true);
    const current = await pool.acquire(signal);
    await expect(old.run("old-role", {}, signal)).rejects.toThrow();
    const run = current.run("new-role", {}, signal);
    const [[id]] = await turns(transport, 1);
    expect(transport.turns.get(id!)?.prompt).toBe("new-role");
    transport.finish(id!, "new-answer");
    expect((await run).text).toBe("new-answer");
    await current.release(true);
  });

  it.each(["failed", "history remains"])("回退不可靠时隔离池：%s", async (reason) => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const run = lease.run("role-a", {}, signal);
    const [[id]] = await turns(transport, 1);
    transport.finish(id!, "saved-answer");
    expect((await run).text).toBe("saved-answer");
    transport.failRevert = reason === "failed";
    transport.retainHistory = reason === "history remains";
    await expect(lease.release(true)).rejects.toThrow();
    await expect(pool.acquire(signal)).rejects.toThrow();
  });

  it("服务退出后，正在执行的角色和等待的角色均失败，不能误复用", async () => {
    const { pool, transport } = create();
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const run = lease.run("role-a", {}, signal);
    const queued = pool.acquire(signal);
    await turns(transport, 1);
    const failedRun = expect(run).rejects.toThrow();
    const failedQueue = expect(queued).rejects.toThrow();
    for (const listener of transport.listeners)
      listener({ method: "$closed", error: new Error("server exited") });
    await Promise.all([failedRun, failedQueue]);
    await expect(lease.release(true)).rejects.toThrow();
  });

  it("取消后长时间没有完成事件时停止池，不回退或复用可能仍在执行的会话", async () => {
    const { pool, transport } = create();
    const controller = new AbortController();
    const lease = await pool.acquire(controller.signal);
    const run = lease.run("role-a", {}, controller.signal);
    await turns(transport, 1);
    vi.useFakeTimers();
    const failedRun = expect(run).rejects.toThrow("取消超时");
    controller.abort(new Error("paused"));
    const release = lease.release(true);
    const failedRelease = expect(release).rejects.toThrow("取消超时");
    await vi.advanceTimersByTimeAsync(10_001);
    await Promise.all([failedRun, failedRelease]);
    expect(transport.calls.some((call) => call.method === "thread/revert")).toBe(false);
    await expect(pool.acquire(new AbortController().signal)).rejects.toThrow("取消超时");
  });

  it("turn/start 响应到达前的完成事件仍能按 turn ID 正确收集", async () => {
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

  it("session 创建失败后停止池，不重复启动可能已创建的 session", async () => {
    const { pool, transport } = create();
    const original = transport.request.bind(transport);
    transport.request = async (method, params) => {
      if (method === "thread/start") throw new Error("start failed");
      return original(method, params);
    };
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    await expect(lease.run("role-a", {}, signal)).rejects.toThrow("start failed");
    await expect(lease.release(true)).rejects.toThrow("start failed");
    await expect(pool.acquire(signal)).rejects.toThrow("start failed");
  });

  it("服务返回重复 session ID 时停止池，防止两个角色串台", async () => {
    const { pool, transport } = create(2);
    const original = transport.request.bind(transport);
    let started = 0;
    transport.request = async (method, params) => {
      if (method === "thread/start" && ++started === 2) return { thread: { id: "thread-1" } };
      return original(method, params);
    };
    const signal = new AbortController().signal;
    const first = await pool.acquire(signal);
    const one = first.run("role-a", {}, signal);
    const [[turnId]] = await turns(transport, 1);
    const second = await pool.acquire(signal);
    await expect(second.run("role-b", {}, signal)).rejects.toThrow("重复 ID");
    transport.finish(turnId!, "answer-a");
    expect((await one).text).toBe("answer-a");
    await expect(first.release(true)).rejects.toThrow("重复 ID");
    await expect(second.release(true)).rejects.toThrow("重复 ID");
  });

  it("turn/start 明确收到429拒绝时允许同租约退避后重试", async () => {
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
    const retry = lease.run("role-a", {}, signal);
    const [[id]] = await turns(transport, 1);
    transport.finish(id!, "answer-a");
    expect((await retry).text).toBe("answer-a");
    await lease.release(true);
    expect(transport.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
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
      expect(transport.calls.some((call) => call.method === "thread/revert")).toBe(false);
    },
  );

  it("极大的合法并发配置仅为实际使用的任务创建槽位", async () => {
    const { pool, transport } = create(Number.MAX_SAFE_INTEGER);
    const signal = new AbortController().signal;
    const lease = await pool.acquire(signal);
    const run = lease.run("only-role", {}, signal);
    const [[id]] = await turns(transport, 1);
    transport.finish(id!, "answer");
    expect((await run).text).toBe("answer");
    await lease.release(true);
    expect(transport.calls.filter((call) => call.method === "thread/start")).toHaveLength(1);
  });
});
