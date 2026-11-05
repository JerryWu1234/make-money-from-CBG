import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const runtimeKey = Symbol.for("cbg.codex-runtime.v1");
const generatedDirectories = new Set([
  ".tmp",
  "tmp",
  "cache",
  "plugins",
  "sessions",
  "archived_sessions",
  "shell_snapshots",
  "thread-writer-locks",
  "cbg-pool-workspaces",
]);
const generatedFiles = new Set(["models_cache.json", "history.jsonl", "session_index.jsonl"]);
const generatedDatabase =
  /^(?:(?:state|logs|thread_history|goals|memories|queue)_\d+|cbg-analysis-pool)\.sqlite(?:-(?:wal|shm|journal))?$/;

/** Pure path calculation shared with the server's Codex environment. */
export function codexHomeDirectory(projectRoot = process.cwd(), userHome = homedir()) {
  const identity = createHash("sha256")
    .update(realpathSync(projectRoot))
    .digest("hex")
    .slice(0, 32);
  return join(
    realpathSync(userHome),
    ".local",
    "share",
    "make-money-from-cbg",
    identity,
    "codex-home",
  );
}

async function privateDirectory(directory, projectRoot) {
  const inside = relative(realpathSync(projectRoot), directory);
  if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
    throw new Error("Codex 登录目录不能位于项目网页目录内");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory)
    throw new Error("Codex 运行目录不能通过符号链接重定向");
}

async function acquireLock(path) {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error("Codex 服务锁不能是符号链接");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  // flock is held by the helper until this process closes its pipe. An abrupt
  // parent exit also closes the pipe, so no stale PID lock needs to be deleted.
  const helper = spawn(
    "perl",
    [
      "-e",
      'use Fcntl qw(:flock); $|=1; open my $lock, ">>", $ARGV[0] or die "Cannot open service lock: $!\\n"; flock($lock, LOCK_EX | LOCK_NB) or exit 75; print "LOCKED\\n"; while (sysread(STDIN, my $buffer, 4096)) {}',
      path,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let exited = false;
  let stderr = "";
  helper.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
  const closed = new Promise((resolve) => helper.once("close", resolve));
  helper.once("exit", () => (exited = true));
  helper.stdin.on("error", () => {});
  let timer;
  try {
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("取得 Codex 服务锁超时，已停止启动")), 5000);
      const ready = (chunk) => {
        if (String(chunk).includes("LOCKED")) {
          helper.stdout.off("data", ready);
          resolve();
        }
      };
      helper.stdout.on("data", ready);
      helper.once("error", (error) =>
        reject(new Error("无法取得 Codex 服务锁，请检查本机 Perl", { cause: error })),
      );
      helper.once("close", (code) =>
        reject(
          new Error(
            code === 75
              ? "此项目已有服务持有 Codex 运行目录，请使用已有服务或先关闭它"
              : `无法取得 Codex 服务锁：${stderr.trim() || `退出码 ${code}`}`,
          ),
        ),
      );
    });
  } catch (error) {
    helper.stdin.destroy();
    helper.kill();
    await closed;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return {
    assertHeld() {
      if (exited) throw new Error("Codex 服务锁已失效，已停止清理");
    },
    async release() {
      helper.stdin.end();
      await closed;
    },
  };
}

async function assertNoWriters(directory, { timeoutMs = 10_000 } = {}) {
  let output;
  try {
    const result = await run("lsof", ["-nP", "-Fpn", "+D", directory], {
      maxBuffer: 4 * 1024 * 1024,
      timeout: timeoutMs,
    });
    output = result.stdout;
  } catch (error) {
    // macOS lsof may return 1 even while listing matching open files.
    if (error.stdout?.trim()) output = error.stdout;
    else {
      if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim()) return;
      throw new Error("无法检查 Codex 运行目录写入者，已停止清理", { cause: error });
    }
  }
  const pids = [...output.matchAll(/^p(\d+)$/gm)].map((match) => match[1]);
  if (pids.length)
    throw new Error(
      `Codex 运行目录仍被进程占用（PID ${[...new Set(pids)].join("、")}），请先关闭旧服务和残留 Codex`,
    );
  throw new Error("无法确认 Codex 运行目录没有写入者，已停止清理");
}

async function waitForWriters(directory, checkWriters, timeoutMs, keepLock = false) {
  const deadline = performance.now() + timeoutMs;
  let lastError;
  while (performance.now() < deadline) {
    const remaining = Math.max(1, Math.ceil(deadline - performance.now()));
    let timer;
    try {
      await Promise.race([
        checkWriters(directory, { timeoutMs: remaining }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Codex 写入者检查超时")), remaining);
        }),
      ]);
      return;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
    const pause = Math.min(100, Math.max(0, deadline - performance.now()));
    if (pause) await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new Error(
    keepLock
      ? `等待 Codex 进程退出超时（${timeoutMs} 毫秒），未清理运行文件，服务锁仍持有`
      : `等待 Codex 进程退出超时（${timeoutMs} 毫秒），服务锁将释放；下次启动仍会检查残留写入者`,
    { cause: lastError },
  );
}

/** Acquire ownership without deleting anything. clean() is called only after a successful bind. */
export async function acquireCodexRuntime({
  projectRoot = process.cwd(),
  userHome = homedir(),
  checkWriters = assertNoWriters,
  releaseTimeoutMs = 5000,
} = {}) {
  const directory = codexHomeDirectory(projectRoot, userHome);
  await privateDirectory(directory, projectRoot);
  const lock = await acquireLock(join(dirname(directory), "codex-runtime.lock"));
  let cleaning;
  let sweeping;
  let cleaned = false;
  let closing = false;
  let released = false;
  let releasing;
  const removeGenerated = async (assertActive, waitForExit) => {
    lock.assertHeld();
    if (waitForExit) await waitForWriters(directory, checkWriters, releaseTimeoutMs, true);
    else await checkWriters(directory);
    lock.assertHeld();
    assertActive();
    if (released) throw new Error("Codex 服务已关闭，已停止清理");
    await privateDirectory(directory, projectRoot);
    const names = (await readdir(directory)).filter(
      (name) =>
        generatedDirectories.has(name) || generatedFiles.has(name) || generatedDatabase.test(name),
    );
    try {
      if ((await lstat(join(directory, "skills"))).isSymbolicLink())
        throw new Error("Codex 系统技能目录不能通过符号链接重定向");
      await lstat(join(directory, "skills", ".system"));
      names.push("skills/.system");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Validate the complete deletion set before removing the first entry.
    // rm does not follow nested symlinks, and top-level redirections are rejected.
    for (const name of names)
      if ((await lstat(join(directory, name))).isSymbolicLink())
        throw new Error(`Codex 生成文件不能是符号链接：${name}`);
    lock.assertHeld();
    assertActive();
    if (released) throw new Error("Codex 服务已关闭，已停止清理");
    for (const name of names) await rm(join(directory, name), { recursive: true, force: true });
    return names;
  };
  return {
    directory,
    clean(assertActive = () => {}) {
      if (closing && !cleaning) return Promise.reject(new Error("Codex 服务正在关闭，已停止清理"));
      cleaning ||= (async () => {
        const names = await removeGenerated(assertActive, false);
        cleaned = true;
        return names;
      })();
      return cleaning;
    },
    sweep(assertActive = () => {}) {
      if (closing) return Promise.reject(new Error("Codex 服务正在关闭，已停止清理"));
      if (!cleaning) return Promise.reject(new Error("Codex 启动清理尚未开始，拒绝清理运行文件"));
      if (!sweeping) {
        const pending = (async () => {
          await cleaning;
          return await removeGenerated(assertActive, true);
        })();
        sweeping = pending;
        const finished = () => {
          if (sweeping === pending) sweeping = undefined;
        };
        void pending.then(finished, finished);
      }
      return sweeping;
    },
    release() {
      releasing ||= (async () => {
        closing = true;
        if (cleaning) await cleaning.catch(() => {});
        let sweepFailure;
        if (sweeping) {
          try {
            await sweeping;
          } catch (error) {
            sweepFailure = error;
          }
        }
        try {
          // SDK completion can precede its CLI process closing SQLite handles.
          // Keep ownership until those short-lived writers finish shutting down.
          if (cleaned) await waitForWriters(directory, checkWriters, releaseTimeoutMs);
          if (sweepFailure) throw sweepFailure;
        } finally {
          released = true;
          await lock.release();
        }
      })();
      return releasing;
    },
  };
}

/** Called only after the lifecycle manager drains requests and closes Codex writers. */
export async function cleanActiveCodexRuntime(reason = "分析结束") {
  const projectRoot = realpathSync(process.cwd());
  const states = globalThis[runtimeKey];
  const matches = states
    ? [...states.values()].filter((state) => state.projectRoot === projectRoot && state.users.size)
    : [];
  if (matches.length !== 1)
    throw new Error("当前项目没有唯一的活动 Codex 服务租约，拒绝清理运行文件");
  const state = matches[0];
  await state.startupReady;
  const assertActive = () => {
    if (states.get(state.directory) !== state || !state.users.size)
      throw new Error("Codex 服务租约已关闭，拒绝清理运行文件");
  };
  assertActive();
  const lease = await state.lease;
  const names = await lease.sweep(assertActive);
  const logger = [...state.users][0]?.config.logger;
  logger?.info(`已清理项目 Codex 运行文件（${reason}，${names.length} 项），保留登录与配置`);
  return names;
}

/** Bind first, then clean before publishing listening or accepting business requests. */
export async function attachCodexRuntime(server, options = {}) {
  if (!server.httpServer) return async () => {};
  const directory = codexHomeDirectory(options.projectRoot || server.config.root, options.userHome);
  const states = (globalThis[runtimeKey] ||= new Map());
  let state = states.get(directory);
  if (!state) {
    let resolveStartup;
    let rejectStartup;
    const startupReady = new Promise((resolve, reject) => {
      resolveStartup = resolve;
      rejectStartup = reject;
    });
    void startupReady.catch(() => {});
    state = {
      directory,
      projectRoot: realpathSync(options.projectRoot || server.config.root),
      lease: acquireCodexRuntime({ projectRoot: server.config.root, ...options }),
      users: new Set(),
      ready: null,
      startupReady,
      resolveStartup,
      rejectStartup,
    };
    states.set(directory, state);
    state.lease.catch(() => {
      if (states.get(directory) === state) states.delete(directory);
    });
  }
  const lease = await state.lease;
  state.users.add(server);
  const http = server.httpServer;
  const emit = http.emit;
  let active = true;
  let releaseCalled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {});
  http.emit = function (event, ...args) {
    if (event !== "listening") return emit.call(this, event, ...args);
    http.emit = emit;
    state.ready ||= lease.clean(() => {
      if (!active || !http.listening) throw new Error("本地服务尚未就绪，已停止清理 Codex");
    });
    state.ready.then(
      (names) => {
        if (!active) return;
        state.resolveStartup();
        resolveReady();
        if (names.length && !state.logged) {
          state.logged = true;
          server.config.logger.info(
            `已清理项目 Codex 运行文件（${names.length} 项），保留登录与配置`,
          );
        }
        emit.call(http, "listening", ...args);
      },
      (error) => {
        state.rejectStartup(error);
        rejectReady(error);
        emit.call(http, "error", error);
        http.close();
      },
    );
    return true;
  };
  server.middlewares.use((_req, _res, next) => {
    void ready.then(() => next(), next);
  });
  return async () => {
    if (releaseCalled) return;
    releaseCalled = true;
    active = false;
    http.emit = emit;
    rejectReady(new Error("本地服务已关闭"));
    state.users.delete(server);
    if (!state.users.size) {
      state.rejectStartup(new Error("Codex 服务已关闭，启动清理未完成"));
      if (states.get(directory) === state) states.delete(directory);
      await lease.release();
    }
  };
}
