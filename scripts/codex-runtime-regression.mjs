import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { closeSync, openSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { acquireCodexRuntime, attachCodexRuntime, codexHomeDirectory } from "./codex-runtime.mjs";

const run = promisify(execFile);

async function fixture(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cbg-codex-runtime-test-")));
  const projectRoot = join(root, "project");
  const userHome = join(root, "user");
  await mkdir(projectRoot);
  await mkdir(userHome);
  const options = { projectRoot, userHome, checkWriters: async () => {} };
  const directory = codexHomeDirectory(projectRoot, userHome);
  await mkdir(directory, { recursive: true });
  try {
    await run({ root, projectRoot, userHome, options, directory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void test("cleans generated files and complete SQLite groups while retaining login, config and business data", async () => {
  await fixture(async ({ projectRoot, userHome, options, directory }) => {
    for (const name of [
      "sessions",
      "cache",
      ".tmp",
      "tmp",
      "plugins",
      "skills/.system",
      "shell_snapshots",
      "cbg-pool-workspaces",
      "thread-writer-locks",
    ]) {
      await mkdir(join(directory, name), { recursive: true });
      await writeFile(join(directory, name, "fixture"), "generated");
    }
    await mkdir(join(directory, "skills/custom-skill"));
    await writeFile(join(directory, "skills/custom-skill/SKILL.md"), "user skill");
    const generated = [
      "models_cache.json",
      "state_5.sqlite",
      "state_5.sqlite-wal",
      "state_5.sqlite-shm",
      "logs_2.sqlite",
      "logs_2.sqlite-wal",
      "thread_history_1.sqlite",
      "cbg-analysis-pool.sqlite",
      "cbg-analysis-pool.sqlite-journal",
    ];
    const kept = [
      "auth.json",
      "config.toml",
      "installation_id",
      ".sandbox_migration",
      ".sqlite-maintenance.lock",
      "custom.sqlite",
      "user-settings.json",
    ];
    for (const name of [...generated, ...kept]) await writeFile(join(directory, name), name);
    for (const name of ["data/cbg.sqlite", ".chrome-cbg-profile/Preferences"]) {
      await mkdir(dirname(join(projectRoot, name)), { recursive: true });
      await writeFile(join(projectRoot, name), "business");
    }
    await mkdir(join(userHome, ".codex"));
    await writeFile(join(userHome, ".codex", "auth.json"), "desktop fixture");
    const lease = await acquireCodexRuntime(options);
    try {
      assert.ok((await readdir(directory)).includes("sessions"), "acquiring a lock must not clean");
      const deleted = await lease.clean();
      assert.ok(deleted.includes("state_5.sqlite-wal"));
      assert.deepEqual((await readdir(directory)).sort(), [...kept, "skills"].sort());
      assert.equal(
        await readFile(join(directory, "skills/custom-skill/SKILL.md"), "utf8"),
        "user skill",
      );
      assert.deepEqual(await readdir(join(directory, "skills")), ["custom-skill"]);
      for (const name of kept) assert.equal(await readFile(join(directory, name), "utf8"), name);
      assert.equal(await readFile(join(projectRoot, "data/cbg.sqlite"), "utf8"), "business");
      assert.equal(
        await readFile(join(projectRoot, ".chrome-cbg-profile/Preferences"), "utf8"),
        "business",
      );
      assert.equal(await readFile(join(userHome, ".codex/auth.json"), "utf8"), "desktop fixture");
      await writeFile(join(directory, "models_cache.json"), "new runtime");
      await lease.clean();
      assert.equal(
        await readFile(join(directory, "models_cache.json"), "utf8"),
        "new runtime",
        "the same service cleans once",
      );
    } finally {
      await lease.release();
    }
  });
});

void test("rejects redirected home and generated symlinks before deleting any entries", async () => {
  await fixture(async ({ root, userHome, options, directory }) => {
    const target = join(root, "protected");
    await mkdir(target);
    await writeFile(join(target, "keep"), "safe");
    await symlink(target, join(directory, "sessions"));
    await writeFile(join(directory, "models_cache.json"), "preserve on failure");
    const lease = await acquireCodexRuntime(options);
    try {
      await assert.rejects(lease.clean(), /符号链接/);
      assert.equal(
        await readFile(join(directory, "models_cache.json"), "utf8"),
        "preserve on failure",
      );
      assert.equal(await readFile(join(target, "keep"), "utf8"), "safe");
    } finally {
      await lease.release();
    }
    await rm(join(userHome, ".local"), { recursive: true });
    await symlink(target, join(userHome, ".local"));
    await assert.rejects(acquireCodexRuntime(options), /符号链接/);
    assert.equal(await readFile(join(target, "keep"), "utf8"), "safe");
  });
});

void test("another process cannot acquire the lock, and exiting releases it", async () => {
  await fixture(async ({ options }) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { acquireCodexRuntime } from ${JSON.stringify(import.meta.resolve("./codex-runtime.mjs"))};
      const lease = await acquireCodexRuntime(${JSON.stringify(options)});
      process.stdout.write("ready\\n");
      process.stdin.resume();
      process.stdin.once("end", async () => { await lease.release(); });
    `,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const childClosed = new Promise((resolve) => child.once("close", resolve));
    let errors = "";
    child.stderr.on("data", (chunk) => (errors += chunk));
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("close", (code) => reject(new Error(`fixture child failed: ${code}: ${errors}`)));
    });
    try {
      await assert.rejects(acquireCodexRuntime(options), /已有服务/);
    } finally {
      child.stdin.end();
      await childClosed;
    }
    const next = await acquireCodexRuntime(options);
    await next.release();
  });
});

void test("abrupt owner exit closes the helper pipe and releases the lock", async () => {
  await fixture(async ({ options }) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import { acquireCodexRuntime } from ${JSON.stringify(import.meta.resolve("./codex-runtime.mjs"))};
      await acquireCodexRuntime(${JSON.stringify(options)});
      process.stdout.write("ready\\n");
      setInterval(() => {}, 1000);
    `,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const childClosed = new Promise((resolve) => child.once("close", resolve));
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`fixture child exited: ${code}`)));
    });
    child.kill("SIGKILL");
    await childClosed;
    const lease = await acquireCodexRuntime(options);
    await lease.release();
  });
});

void test("a failed lock helper and an unexpectedly lost lock fail closed", async () => {
  await fixture(async ({ options, directory }) => {
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = "/nonexistent-codex-runtime-test-bin";
      await assert.rejects(acquireCodexRuntime(options), /无法取得 Codex 服务锁/);
    } finally {
      process.env.PATH = originalPath;
    }
    const lease = await acquireCodexRuntime(options);
    await writeFile(join(directory, "models_cache.json"), "keep after lock loss");
    try {
      const processes = await run("ps", ["-axo", "pid=,ppid=,comm="]);
      const helper = processes.stdout
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .find(
          ([, parent, command]) => parent === String(process.pid) && /(?:^|\/)perl$/.test(command),
        );
      assert.ok(helper, "the fixture lease must have a lock helper");
      process.kill(Number(helper[0]), "SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 50));
      await assert.rejects(lease.clean(), /服务锁已失效/);
      assert.equal(
        await readFile(join(directory, "models_cache.json"), "utf8"),
        "keep after lock loss",
      );
    } finally {
      await lease.release();
    }
  });
});

void test("an existing open file blocks cleanup without changing auth or runtime files", async () => {
  await fixture(async ({ options, directory }) => {
    const path = join(directory, "state_5.sqlite");
    await writeFile(path, "active database fixture");
    const descriptor = openSync(path, "r");
    const lease = await acquireCodexRuntime({ ...options, checkWriters: undefined });
    try {
      await assert.rejects(lease.clean(), /进程占用/);
      assert.equal(await readFile(path, "utf8"), "active database fixture");
    } finally {
      closeSync(descriptor);
      await lease.release();
    }
  });
});

void test("release holds ownership while a completed request's writer finishes exiting", async () => {
  await fixture(async ({ options }) => {
    let writerActive = false;
    let checkStarted;
    const checked = new Promise((resolve) => (checkStarted = resolve));
    const lease = await acquireCodexRuntime({
      ...options,
      checkWriters: async () => {
        if (!writerActive) return;
        checkStarted();
        throw new Error("fixture writer is still exiting");
      },
    });
    await lease.clean();
    writerActive = true;
    let releaseFinished = false;
    const release = lease.release().then(() => (releaseFinished = true));
    await checked;
    assert.equal(releaseFinished, false);
    await assert.rejects(acquireCodexRuntime(options), /已有服务/);
    writerActive = false;
    await release;
    assert.equal(releaseFinished, true);
    const next = await acquireCodexRuntime(options);
    await next.release();
  });
});

void test("release times out clearly, still releases ownership, and skips waiting after a failed or absent clean", async () => {
  await fixture(async ({ options }) => {
    let writerActive = false;
    const checkWriters = async () => {
      if (writerActive) throw new Error("fixture writer remains alive");
    };
    const lease = await acquireCodexRuntime({ ...options, checkWriters, releaseTimeoutMs: 120 });
    await lease.clean();
    writerActive = true;
    const release = lease.release();
    assert.equal(
      lease.release(),
      release,
      "concurrent release calls must wait for the same shutdown",
    );
    await assert.rejects(release, /等待 Codex 进程退出超时.*下次启动仍会检查/);
    const next = await acquireCodexRuntime({ ...options, checkWriters });
    await assert.rejects(next.clean(), /fixture writer remains alive/);
    await next.release();
    const unstarted = await acquireCodexRuntime({ ...options, checkWriters });
    await unstarted.release();
  });
});

function fakeServer(projectRoot) {
  const httpServer = new EventEmitter();
  httpServer.listening = false;
  httpServer.close = () => {
    httpServer.listening = false;
    httpServer.emit("close");
  };
  const middleware = [];
  return {
    config: { root: projectRoot, logger: { info() {} } },
    httpServer,
    middlewares: {
      use(fn) {
        middleware.push(fn);
      },
    },
    request() {
      return new Promise((resolve, reject) =>
        middleware[0]({}, {}, (error) => (error ? reject(error) : resolve())),
      );
    },
    bind() {
      httpServer.listening = true;
      httpServer.emit("listening");
    },
  };
}

void test("a port conflict never cleans, successful binding gates ready and requests, reload does not clean twice", async () => {
  await fixture(async ({ projectRoot, options, directory }) => {
    let checks = 0;
    const runtimeOptions = {
      ...options,
      checkWriters: async () => {
        checks++;
      },
    };
    await writeFile(join(directory, "models_cache.json"), "old");
    const conflict = fakeServer(projectRoot);
    const closeConflict = await attachCodexRuntime(conflict, runtimeOptions);
    conflict.httpServer.on("error", () => {});
    conflict.httpServer.emit(
      "error",
      Object.assign(new Error("port occupied"), { code: "EADDRINUSE" }),
    );
    await closeConflict();
    assert.equal(checks, 0);
    assert.equal(await readFile(join(directory, "models_cache.json"), "utf8"), "old");

    const first = fakeServer(projectRoot);
    const closeFirst = await attachCodexRuntime(first, runtimeOptions);
    const listening = new Promise((resolve) => first.httpServer.once("listening", resolve));
    let requestFinished = false;
    const request = first.request().then(() => (requestFinished = true));
    await Promise.resolve();
    assert.equal(requestFinished, false);
    first.bind();
    await listening;
    await request;
    assert.equal(checks, 1);
    assert.deepEqual(await readdir(directory), []);
    await writeFile(join(directory, "models_cache.json"), "current service");

    const replacement = fakeServer(projectRoot);
    const closeReplacement = await attachCodexRuntime(replacement, runtimeOptions);
    await closeFirst();
    const replacementListening = new Promise((resolve) =>
      replacement.httpServer.once("listening", resolve),
    );
    replacement.bind();
    await replacementListening;
    assert.equal(checks, 1);
    assert.equal(await readFile(join(directory, "models_cache.json"), "utf8"), "current service");
    await assert.rejects(acquireCodexRuntime(options), /已有服务/);
    await closeReplacement();
    const next = await acquireCodexRuntime(options);
    await next.release();
  });
});

void test("real HTTP port conflicts do not clean and a successful HTTP bind cleans before listening", async () => {
  await fixture(async ({ options, projectRoot, directory }) => {
    const occupied = createServer();
    await new Promise((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const port = occupied.address().port;
    const conflict = fakeServer(projectRoot);
    conflict.httpServer = createServer();
    const closeConflict = await attachCodexRuntime(conflict, options);
    await writeFile(join(directory, "models_cache.json"), "preserve on port conflict");
    try {
      const error = await new Promise((resolve) => {
        conflict.httpServer.once("error", resolve);
        conflict.httpServer.listen(port, "127.0.0.1");
      });
      assert.equal(error.code, "EADDRINUSE");
      assert.equal(
        await readFile(join(directory, "models_cache.json"), "utf8"),
        "preserve on port conflict",
      );
    } finally {
      await closeConflict();
      await new Promise((resolve) => occupied.close(resolve));
    }
    const successful = fakeServer(projectRoot);
    successful.httpServer = createServer();
    const release = await attachCodexRuntime(successful, options);
    try {
      await new Promise((resolve, reject) => {
        successful.httpServer.once("error", reject);
        successful.httpServer.listen(0, "127.0.0.1", resolve);
      });
      assert.deepEqual(await readdir(directory), []);
    } finally {
      await new Promise((resolve) => successful.httpServer.close(resolve));
      await release();
    }
  });
});
