import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const repository = fileURLToPath(new URL("../", import.meta.url));
const installer = path.join(repository, "setup-macos.command");
const realNode = process.execPath;
const ptyDriver = String.raw`
import codecs, json, os, pty, select, signal, sys

def emit(value):
    print(json.dumps(value), flush=True)

pid, master = pty.fork()
if pid == 0:
    os.execve("/bin/bash", ["/bin/bash", sys.argv[1]], os.environ)
emit({"type": "pid", "pid": pid})
decoder = codecs.getincrementaldecoder("utf-8")("replace")
while True:
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited:
        code = os.waitstatus_to_exitcode(status)
        emit({"type": "exit", "status": code if code >= 0 else None,
              "signal": None if code >= 0 else signal.Signals(-code).name})
        break
    inputs = [sys.stdin] + ([] if master is None else [master])
    readable, _, _ = select.select(inputs, [], [], 0.05)
    if master is not None and master in readable:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if data:
            emit({"type": "output", "text": decoder.decode(data)})
        else:
            os.close(master)
            master = None
    if sys.stdin in readable:
        command = sys.stdin.readline().strip()
        if command == "CLOSE" and master is not None:
            os.close(master)
            master = None
        elif command == "CTRL_C" and master is not None:
            os.write(master, b"\x03")
        elif command in ["SIGTERM", "SIGINT", "SIGHUP"]:
            os.kill(pid, getattr(signal, command))
if master is not None:
    os.close(master)
`;

function installCodexFixture(project, includeCli = true) {
  const sdk = path.join(project, "node_modules", "@openai", "codex-sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(
    path.join(sdk, "package.json"),
    JSON.stringify({
      name: "@openai/codex-sdk",
      version: "0.159.3",
      type: "module",
      exports: { ".": { import: "./index.js" } },
      dependencies: { "@openai/codex": "0.159.3" },
    }),
  );
  writeFileSync(path.join(sdk, "index.js"), "export {};\n");
  if (!includeCli) return;
  const cli = path.join(project, "node_modules", "@openai", "codex");
  mkdirSync(path.join(cli, "bin"), { recursive: true });
  writeFileSync(
    path.join(cli, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: "0.159.3",
      type: "module",
      bin: { codex: "./bin/codex.js" },
    }),
  );
  writeFileSync(
    path.join(cli, "bin", "codex.js"),
    `import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
const state = JSON.parse(readFileSync(process.env.CBG_TEST_STATE, "utf8"));
const codexHome = process.env.CODEX_HOME;
const sqliteHome = process.env.CODEX_SQLITE_HOME;
appendFileSync(state.callsPath, JSON.stringify({
  command: "project-codex", args: process.argv.slice(2), codexHome, sqliteHome,
  homeExists: !!codexHome && existsSync(codexHome) && statSync(codexHome).isDirectory(),
}) + "\\n");
if (process.argv.length !== 3 || process.argv[2] !== "--version") process.exit(99);
if (!codexHome || !sqliteHome) process.exit(98);
writeFileSync(path.join(codexHome, "mock-version-probe"), "only a version probe");
if (state.codexExitCode) {
  process.stderr.write("fixture Codex native binary cannot run\\n");
  process.exit(state.codexExitCode);
}
if (!state.codexEmptyOutput) console.log("codex-cli 0.159.3");
`,
  );
}

// Every external installation, network request and browser opening is replaced.
// The fixture services are plain Node processes with no network or Chrome access.
async function fixture(t, changes = {}) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "cbg setup regression ")));
  const project = path.join(root, "project with spaces");
  const bin = path.join(root, "mock bin");
  const setupHome = path.join(root, "private tools");
  const statePath = path.join(root, "state.json");
  const callsPath = path.join(root, "calls.jsonl");
  const startedPath = path.join(root, "service-started.json");
  const driver = path.join(root, "mock-command.mjs");
  const originalCodexHome = path.join(root, "existing codex settings");
  const originalSqliteHome = path.join(root, "existing codex sqlite");
  const processGroups = [];
  const state = {
    project,
    callsPath,
    startedPath,
    nodeBinary: path.join(bin, "node"),
    gitAvailable: true,
    nodeAvailable: true,
    npmAvailable: true,
    pnpmAvailable: true,
    pnpmVersion: "11.25.0",
    installExitCode: 0,
    codexMissing: false,
    codexExitCode: 0,
    listener: "none",
    ...changes,
  };
  mkdirSync(path.join(project, "scripts"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const directory of [originalCodexHome, originalSqliteHome]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "keep.txt"), "original fixture settings");
  }
  writeFileSync(callsPath, "");
  writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "make-money-from-cbg",
      type: "module",
      scripts: { "dev:stable": "node scripts/serve-local.mjs" },
      dependencies: { "@openai/codex-sdk": "0.159.3" },
      devEngines: { packageManager: { name: "pnpm", version: "11.25.0" } },
    }),
  );
  writeFileSync(path.join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(project, "pnpm-workspace.yaml"), "packages: []\n");
  const serviceSource = (
    owned,
  ) => `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, "utf8"));
const record = (command, extra = {}) => appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ command, args: [], pid: process.pid, ...extra }) + "\\n");
${owned ? `writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid }));` : ""}
record(${JSON.stringify(owned ? "service-start" : "existing-service-start")});
if (state.serviceStartupExitCode) { console.error("fixture service failed to start"); process.exit(state.serviceStartupExitCode); }
let closing = false;
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {
  record("service-signal", { signal });
  if (closing) return;
  closing = true;
  setTimeout(() => { record("service-stop", { reason: signal }); process.exit(0); }, 40);
});
if (state.serviceNaturalExitMs) setTimeout(() => { record("service-stop", { reason: "natural" }); process.exit(0); }, state.serviceNaturalExitMs);
setInterval(() => {}, 1000);
`;
  writeFileSync(path.join(project, "scripts", "serve-local.mjs"), serviceSource(true));
  if (state.listener === "existing" || state.listener === "foreign") {
    installCodexFixture(project, !state.codexMissing);
  }
  const installerPath = state.installerInProject
    ? path.join(project, path.basename(installer))
    : state.withoutLockf
      ? path.join(root, "launcher with spaces", path.basename(installer))
      : installer;
  if (state.withoutLockf) {
    const source = readFileSync(installer, "utf8");
    assert.ok(source.includes("/usr/bin/lockf"), "fixture 应准确替换系统 lockf 路径");
    assert.ok(source.includes("/usr/bin/perl"), "旧 Mac 路径应使用系统 Perl 文件锁");
    // Exercise the real Perl fallback without a production-only test switch.
    const missingLockf = path.join(tmpdir(), `cbg-missing-lockf-${process.pid}`);
    assert.equal(existsSync(missingLockf), false);
    mkdirSync(path.dirname(installerPath), { recursive: true });
    writeFileSync(installerPath, source.replaceAll("/usr/bin/lockf", missingLockf));
  } else if (state.installerInProject) copyFileSync(installer, installerPath);
  if (state.cloneProject) {
    state.cloneTemplate = path.join(root, "download source fixture");
    renameSync(project, state.cloneTemplate);
  }

  let existing;
  writeFileSync(statePath, JSON.stringify(state));
  if (state.listener === "existing" || state.listener === "foreign") {
    const existingService = path.join(root, "existing-service.mjs");
    writeFileSync(existingService, serviceSource(false));
    existing = spawn(realNode, [existingService], {
      cwd: project,
      stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      existing.once("spawn", resolve);
      existing.once("error", reject);
    });
    state.listenerPid = existing.pid;
  }
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(
    driver,
    `import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
const statePath = process.env.CBG_TEST_STATE;
const state = JSON.parse(readFileSync(statePath, "utf8"));
const command = process.argv[2];
const args = process.argv.slice(3);
appendFileSync(state.callsPath, JSON.stringify({ command, args, pid: process.pid, bundled: process.env.CBG_TEST_PACKAGED_NODE === "1" }) + "\\n");
const output = (text) => process.stdout.write(String(text) + "\\n");
const fail = (code = 1) => process.exit(code);
const save = () => writeFileSync(statePath, JSON.stringify(state));
${installCodexFixture.toString()}
switch (command) {
  case "uname": output(args.includes("-s") || !args.length ? "Darwin" : "arm64"); break;
  case "git":
    if (!state.gitAvailable) fail(127);
    if (args.includes("--version")) output("git version 2.50.0");
    else if (args[0] === "clone") {
      if (!state.cloneTemplate) fail(93);
      const destination = args.at(-1);
      if (state.cloneExitCode) {
        mkdirSync(destination, { recursive: true });
        writeFileSync(path.join(destination, "partial-download"), "incomplete");
        fail(state.cloneExitCode);
      }
      cpSync(state.cloneTemplate, destination, { recursive: true });
    }
    break;
  case "xcode-select":
    if (args.includes("--install")) { output("fixture: CLT installation unavailable"); fail(1); }
    fail(2);
    break;
  case "node": {
    if (!state.nodeAvailable && process.env.CBG_TEST_PACKAGED_NODE !== "1") fail(127);
    if (args.includes("-p") && args.includes("process.execPath")) { output(process.env.CBG_TEST_NODE_EXECUTABLE || state.nodeBinary); break; }
    const child = spawnSync(process.env.CBG_TEST_REAL_NODE, args, { stdio: "inherit", env: process.env });
    process.exit(child.status ?? 1);
  }
  case "npm":
    if (!state.npmAvailable && process.env.CBG_TEST_PACKAGED_NODE !== "1") fail(127);
    if (args.includes("--version") || args.includes("-v")) output("10.9.0");
    else {
      const version = args.find((arg) => /^pnpm@/.test(arg))?.slice(5);
      const prefix = args[args.indexOf("--prefix") + 1];
      if (!version || args.indexOf("--prefix") < 0) fail(94);
      const target = path.join(prefix, "bin");
      mkdirSync(target, { recursive: true });
      writeFileSync(path.join(target, "pnpm"), ${JSON.stringify('#!/bin/bash\nexec "$CBG_TEST_REAL_NODE" "$CBG_TEST_DRIVER" pnpm "$@"\n')}, { mode: 0o755 });
      state.pnpmAvailable = true;
      state.pnpmVersion = version;
      save();
    }
    break;
  case "pnpm":
    if (!state.pnpmAvailable) fail(127);
    if (args.includes("--version") || args.includes("-v")) output(state.pnpmVersion);
    else if (args.includes("install")) {
      if (state.installDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.installDelayMs);
      if (state.installExitCode) { process.stderr.write("fixture dependency install failed\\n"); fail(state.installExitCode); }
      installCodexFixture(state.project, !state.codexMissing);
    } else fail(95);
    break;
  case "codex": fail(127); break;
  case "lsof": {
    if (state.serviceStartupExitCode && !state.listenerPid) fail(1);
    const candidates = [state.listenerPid, existsSync(state.startedPath) ? JSON.parse(readFileSync(state.startedPath, "utf8")).pid : null];
    const pid = candidates.find((value) => { if (!value) return false; try { process.kill(value, 0); return true; } catch { return false; } });
    if (!pid) fail(1);
    if (args.some((arg) => arg.includes("cwd"))) {
      output("p" + pid);
      output("n" + (state.listener === "foreign" ? path.join(state.project, "other project") : state.project));
    } else output(pid);
    break;
  }
  case "curl": {
    const url = args.find((arg) => /^https?:/.test(arg));
    const index = args.findIndex((arg) => arg === "-o" || arg === "--output");
    const target = index < 0 ? null : args[index + 1];
    let body;
    if (url?.startsWith("http://127.0.0.1:5173/")) {
      if (state.healthDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, state.healthDelayMs);
      if (state.unhealthy) fail(22);
      body = JSON.stringify({ mode: "dedicated", modes: ["dedicated"], busy: false, connected: false });
    } else if (url?.endsWith("SHASUMS256.txt")) {
      body = (state.archiveSha || "0".repeat(64)) + "  node-v24.22.2-darwin-arm64.tar.gz\\n";
    } else if (url?.endsWith(".tar.gz")) body = state.archivePath ? readFileSync(state.archivePath) : "invalid archive: checksum must fail before extraction";
    else fail(96);
    if (target) writeFileSync(target, body);
    else process.stdout.write(body);
    break;
  }
  case "open": fail(97); break;
  default: process.stderr.write("Unexpected mock command " + command); fail(98);
}
`,
  );
  for (const command of [
    "uname",
    "git",
    "xcode-select",
    "node",
    "npm",
    "pnpm",
    "codex",
    "lsof",
    "curl",
    "open",
  ]) {
    writeFileSync(
      path.join(bin, command),
      `#!/bin/bash\n${command === "node" ? 'if [ "${1:-}" = scripts/serve-local.mjs ]; then exec "$CBG_TEST_REAL_NODE" "$@"; fi\n' : ""}exec "$CBG_TEST_REAL_NODE" "$CBG_TEST_DRIVER" ${command} "$@"\n`,
      { mode: 0o755 },
    );
  }
  if (state.validArchive) {
    const directory = "node-v24.22.2-darwin-arm64";
    const archiveRoot = path.join(root, "archive payload");
    const archiveBin = path.join(archiveRoot, directory, "bin");
    mkdirSync(archiveBin, { recursive: true });
    for (const command of ["node", "npm"]) {
      writeFileSync(
        path.join(archiveBin, command),
        `#!/bin/bash\nexport CBG_TEST_PACKAGED_NODE=1\nexport CBG_TEST_NODE_EXECUTABLE="$0"\n${command === "node" ? 'if [ "${1:-}" = scripts/serve-local.mjs ]; then exec "$CBG_TEST_REAL_NODE" "$@"; fi\n' : ""}exec "$CBG_TEST_REAL_NODE" "$CBG_TEST_DRIVER" ${command} "$@"\n`,
        { mode: 0o755 },
      );
    }
    state.archivePath = path.join(root, "node-fixture.tar.gz");
    const archive = spawnSync(
      "/usr/bin/tar",
      ["-czf", state.archivePath, "-C", archiveRoot, directory],
      { encoding: "utf8" },
    );
    assert.equal(archive.status, 0, archive.stderr);
    state.archiveSha = createHash("sha256").update(readFileSync(state.archivePath)).digest("hex");
    writeFileSync(statePath, JSON.stringify(state));
  }
  t.after(async () => {
    for (const group of processGroups) {
      group.terminate();
      await group.completed;
    }
    const pids = [existing?.pid];
    if (existsSync(startedPath)) pids.push(JSON.parse(readFileSync(startedPath, "utf8")).pid);
    for (const pid of pids.filter(Boolean)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (existing && existing.exitCode == null && existing.signalCode == null) {
      await new Promise((resolve) => existing.once("exit", resolve));
    }
    rmSync(root, { recursive: true, force: true });
  });
  const runOptions = {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
      CBG_SETUP_HOME: setupHome,
      CBG_PROJECT_DIR: project,
      CBG_NO_OPEN: "1",
      CBG_TEST_STATE: statePath,
      CBG_TEST_DRIVER: driver,
      CBG_TEST_REAL_NODE: realNode,
      CODEX_HOME: originalCodexHome,
      CODEX_SQLITE_HOME: originalSqliteHome,
    },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1_000_000,
  };
  if (state.omitProjectDir) delete runOptions.env.CBG_PROJECT_DIR;
  const start = ({ autoStop = false, pty: usePty = false } = {}) => {
    let python;
    if (usePty) {
      const found = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
      });
      assert.equal(found.status, 0, found.stderr);
      python = found.stdout.trim();
    }
    const child = spawn(
      usePty ? python : "/bin/bash",
      usePty ? ["-u", "-c", ptyDriver, installerPath] : [installerPath],
      {
        ...runOptions,
        timeout: undefined,
        detached: true,
      },
    );
    let stdout = "";
    let stderr = "";
    let error;
    let ready = false;
    let ptyChildPid;
    let ptyExit;
    let wireBuffer = "";
    let resolveReady;
    const whenReady = new Promise((resolve) => {
      resolveReady = resolve;
    });
    const signal = (value = "SIGTERM") => {
      if (usePty) child.stdin.write(value + "\n");
      else child.kill(value);
    };
    const onOutput = (text) => {
      stdout += text;
      if (!ready && stdout.includes("已就绪：http://127.0.0.1:5173/analysis-preview")) {
        ready = true;
        resolveReady(true);
        if (autoStop) signal();
      }
    };
    child.stdout.on("data", (chunk) => {
      if (!usePty) return onOutput(chunk.toString());
      wireBuffer += chunk;
      let newline;
      while ((newline = wireBuffer.indexOf("\n")) !== -1) {
        const event = JSON.parse(wireBuffer.slice(0, newline));
        wireBuffer = wireBuffer.slice(newline + 1);
        if (event.type === "output") onOutput(event.text);
        else if (event.type === "pid") ptyChildPid = event.pid;
        else if (event.type === "exit") ptyExit = event;
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (value) => {
      error = value;
    });
    const completed = new Promise((resolve) =>
      child.once("close", async (status, exitSignal) => {
        clearTimeout(deadline);
        resolveReady(false);
        const managedPid = existsSync(startedPath)
          ? JSON.parse(readFileSync(startedPath, "utf8")).pid
          : existing?.pid;
        if (ready && managedPid) {
          for (let attempt = 0; attempt < 80 && processAlive(managedPid); attempt++)
            await delay(25);
        }
        const calls = readFileSync(callsPath, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(JSON.parse);
        resolve({
          status: usePty ? ptyExit?.status : status,
          signal: usePty ? ptyExit?.signal : exitSignal,
          stdout,
          stderr,
          error,
          ready,
          managedPid,
          serviceAlive: managedPid ? processAlive(managedPid) : false,
          cleanShutdown: calls.some(
            (call) => call.command === "service-stop" && call.pid === managedPid,
          ),
        });
      }),
    );
    let terminated = false;
    const session = {
      completed,
      ready: whenReady,
      signal,
      signalGroup: (value) => process.kill(-(ptyChildPid || child.pid), value),
      closePty: () => {
        assert.ok(usePty);
        child.stdin.write("CLOSE\n");
      },
      interruptPty: () => {
        assert.ok(usePty);
        child.stdin.write("CTRL_C\n");
      },
      output: () => stdout + stderr,
      terminate: () => {
        if (terminated || !child.pid) return;
        terminated = true;
        for (const pid of [ptyChildPid, child.pid].filter(Boolean)) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch (value) {
            if (value.code !== "ESRCH") throw value;
          }
        }
      },
    };
    const deadline = setTimeout(() => {
      error = new Error("安装窗口未在测试期限内就绪或退出");
      session.terminate();
    }, 20_000);
    deadline.unref();
    processGroups.push(session);
    return session;
  };
  return {
    root,
    project,
    setupHome,
    startedPath,
    existing,
    originalCodexHome,
    originalSqliteHome,
    update: (changes) =>
      writeFileSync(
        statePath,
        JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), ...changes }),
      ),
    calls: () => readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
    run: (options = {}) => start({ autoStop: true, ...options }).completed,
    start: () => start(),
    startPty: () => start({ pty: true }),
    startProcessGroup: () => start(),
  };
}

function successful(result) {
  assert.equal(result.error, undefined, result.error?.message);
  if ("ready" in result) {
    assert.equal(result.ready, true, result.stdout + result.stderr);
    assert.equal(result.status, 143, result.stdout + result.stderr);
    assert.equal(typeof result.managedPid, "number");
    assert.equal(result.serviceAlive, false, "关闭安装窗口后服务进程应已退出");
    assert.equal(result.cleanShutdown, true, "服务应完成关停清理而非被强制杀死");
  } else assert.equal(result.status, 0, result.stdout + result.stderr);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processStopped(pid) {
  for (let attempt = 0; attempt < 80 && processAlive(pid); attempt++) await delay(25);
  assert.equal(processAlive(pid), false, `测试进程 ${pid} 应已退出`);
}

async function cleanlyStopped(f, pid) {
  await processStopped(pid);
  assert.ok(
    f.calls().some((call) => call.command === "service-stop" && call.pid === pid),
    "服务应完成关停清理",
  );
}

async function readySession(session) {
  assert.equal(await session.ready, true, session.output());
}

function noInstallationOrStart(f) {
  assert.equal(
    f
      .calls()
      .some(({ command, args }) => ["npm", "pnpm"].includes(command) && args.includes("install")),
    false,
  );
  assert.equal(existsSync(f.startedPath), false);
}

function codexProbesAreIsolated(f, count = 1) {
  const probes = f.calls().filter(({ command }) => command === "project-codex");
  assert.equal(probes.length, count);
  for (const probe of probes) {
    assert.deepEqual(probe.args, ["--version"]);
    assert.equal(probe.homeExists, true);
    assert.equal(probe.codexHome, probe.sqliteHome);
    assert.notEqual(probe.codexHome, f.originalCodexHome);
    assert.notEqual(probe.sqliteHome, f.originalSqliteHome);
    assert.equal(existsSync(probe.codexHome), false, "版本检测目录应在成功或失败后清理");
  }
  for (const directory of [f.originalCodexHome, f.originalSqliteHome]) {
    assert.equal(
      readFileSync(path.join(directory, "keep.txt"), "utf8"),
      "original fixture settings",
    );
    assert.equal(existsSync(path.join(directory, "mock-version-probe")), false);
  }
  assert.equal(
    f.calls().some(({ command }) => command === "codex"),
    false,
  );
}

test("已有服务由当前窗口接管，关闭窗口时停止且不重装依赖", async (t) => {
  const f = await fixture(t, { listener: "existing" });
  const session = f.start();
  await readySession(session);
  assert.doesNotThrow(() => process.kill(f.existing.pid, 0));
  const duplicate = await f.run();
  assert.equal(duplicate.status, 75, duplicate.stdout + duplicate.stderr);
  noInstallationOrStart(f);
  session.signal("SIGTERM");
  successful(await session.completed);
  await cleanlyStopped(f, f.existing.pid);
});

test("5173 被其他项目占用时停止，不改动依赖或关闭对方进程", async (t) => {
  const f = await fixture(t, { listener: "foreign" });
  const result = await f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /5173.*其他项目/);
  noInstallationOrStart(f);
  assert.doesNotThrow(() => process.kill(f.existing.pid, 0));
});

test("依赖安装失败时保留日志且不启动后台", async (t) => {
  const f = await fixture(t, { installExitCode: 42 });
  const result = await f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /fixture dependency install failed/);
  const install = f
    .calls()
    .find(({ command, args }) => command === "pnpm" && args.includes("install"));
  assert.ok(install, result.stdout + result.stderr);
  assert.ok(install.args.includes("--frozen-lockfile"));
  assert.ok(install.args.includes("--prod=false"));
  assert.equal(existsSync(f.startedPath), false);
  f.update({ installExitCode: 0 });
  successful(await f.run());
  assert.equal(existsSync(f.startedPath), true, "失败后应释放安装锁，重新运行可以启动");
});

test("缺少 Git 且系统安装入口失败时，只请求一次安装并停止", async (t) => {
  const f = await fixture(t, { gitAvailable: false });
  const result = await f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    f
      .calls()
      .filter(({ command, args }) => command === "xcode-select" && args.includes("--install"))
      .length,
    1,
  );
  noInstallationOrStart(f);
});

test("Node 下载校验失败时不安装损坏档案，也不继续项目安装", async (t) => {
  const f = await fixture(t, { nodeAvailable: false });
  const result = await f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /校验失败/);
  assert.ok(
    f
      .calls()
      .some(
        ({ command, args }) => command === "curl" && args.some((arg) => arg.endsWith(".tar.gz")),
      ),
    result.stdout + result.stderr,
  );
  assert.equal(existsSync(path.join(f.setupHome, "node-current", "bin", "node")), false);
  noInstallationOrStart(f);
});

for (const nodeAvailable of [false, true]) {
  test(
    nodeAvailable
      ? "已有 Node 但缺 npm 时，补齐工具并接管原服务"
      : "缺少 Node/npm 时，安装私有工具后由窗口托管原服务",
    async (t) => {
      const f = await fixture(t, {
        nodeAvailable,
        npmAvailable: false,
        validArchive: true,
        listener: "existing",
      });
      successful(await f.run());
      assert.equal(existsSync(path.join(f.setupHome, "node-current", "bin", "node")), true);
      assert.equal(existsSync(path.join(f.setupHome, "node-current", "bin", "npm")), true);
      assert.ok(f.calls().some(({ command, bundled }) => command === "npm" && bundled));
      noInstallationOrStart(f);
      await cleanlyStopped(f, f.existing.pid);
    },
  );
}

test("缺少 pnpm 时按项目版本安装，再安装开发依赖并启动窗口托管服务", async (t) => {
  const f = await fixture(t, { pnpmAvailable: false });
  const result = await f.run();
  successful(result);
  const installs = f
    .calls()
    .filter(({ command, args }) => ["npm", "pnpm"].includes(command) && args.includes("install"));
  assert.equal(installs[0]?.command, "npm");
  assert.ok(installs[0].args.includes("pnpm@11.25.0"));
  assert.equal(installs[1]?.command, "pnpm");
  assert.ok(installs[1].args.includes("--frozen-lockfile"));
  assert.ok(installs[1].args.includes("--prod=false"));
  assert.equal(
    existsSync(f.startedPath),
    true,
    result.stdout + result.stderr + JSON.stringify(f.calls()),
  );
  const pid = JSON.parse(readFileSync(f.startedPath, "utf8")).pid;
  await cleanlyStopped(f, pid);
  assert.equal(
    f.calls().some(({ command }) => command === "open"),
    false,
  );
});

test("首次下载项目失败不留下半成品，重新运行可下载并启动", async (t) => {
  const f = await fixture(t, { cloneProject: true, cloneExitCode: 128 });
  const failed = await f.run();
  assert.equal(failed.error, undefined);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.equal(existsSync(f.project), false);
  noInstallationOrStart(f);
  f.update({ cloneExitCode: 0 });
  const result = await f.run();
  successful(result);
  assert.equal(existsSync(f.startedPath), true, result.stdout + result.stderr);
  const clones = f.calls().filter(({ command, args }) => command === "git" && args[0] === "clone");
  assert.equal(clones.length, 2);
  assert.ok(clones.every(({ args }) => args.includes("--branch") && args.includes("main")));
});

test("安装和运行期间只允许一个窗口，关闭后可以再次运行", async (t) => {
  const f = await fixture(t, { installDelayMs: 1500 });
  const first = f.start();
  await waitForDependencyInstall(f);
  assert.equal((await f.run()).status, 75);
  await readySession(first);
  assert.equal((await f.run()).status, 75, "就绪后窗口仍应持锁");
  first.signal("SIGTERM");
  successful(await first.completed);
  const firstPid = JSON.parse(readFileSync(f.startedPath, "utf8")).pid;
  await cleanlyStopped(f, firstPid);
  successful(await f.run());
  const nextPid = JSON.parse(readFileSync(f.startedPath, "utf8")).pid;
  assert.notEqual(nextPid, firstPid);
  await cleanlyStopped(f, nextPid);
});

test("已有空锁文件不会阻止下一次启动", async (t) => {
  const f = await fixture(t, { listener: "existing" });
  mkdirSync(f.setupHome, { recursive: true });
  writeFileSync(path.join(f.setupHome, "install.lock"), "");
  successful(await f.run());
  noInstallationOrStart(f);
});

test("下载 ZIP 后在无 .git 的仓库中运行，自行识别同目录项目并启动", async (t) => {
  const f = await fixture(t, { installerInProject: true, omitProjectDir: true });
  assert.equal(existsSync(path.join(f.project, ".git")), false);
  const result = await f.run();
  successful(result);
  assert.ok(result.stdout.includes(`项目：${f.project}`), result.stdout + result.stderr);
  assert.equal(
    f.calls().some(({ command, args }) => command === "git" && args[0] === "clone"),
    false,
    "完整的仓库 ZIP 不需要再次克隆项目",
  );
  assert.equal(
    f.calls().filter(({ command, args }) => command === "pnpm" && args.includes("install")).length,
    1,
  );
  assert.equal(existsSync(f.startedPath), true);
  assert.equal(existsSync(path.join(f.project, ".git")), false);
});

async function waitForDependencyInstall(f) {
  for (let attempt = 0; attempt < 400; attempt++) {
    if (f.calls().some(({ command, args }) => command === "pnpm" && args.includes("install")))
      return;
    await delay(25);
  }
  assert.fail("安装流程应到达模拟依赖安装步骤");
}

test("缺少 lockf 时用 Perl 锁托管原服务，关闭窗口完成关停", async (t) => {
  const f = await fixture(t, { withoutLockf: true, listener: "existing" });
  successful(await f.run());
  noInstallationOrStart(f);
  await cleanlyStopped(f, f.existing.pid);
});

test("缺少 lockf 时安装失败会释放 Perl 锁，重试可启动", async (t) => {
  const f = await fixture(t, { withoutLockf: true, installExitCode: 42 });
  const failed = await f.run();
  assert.equal(failed.error, undefined);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /fixture dependency install failed/);
  assert.equal(existsSync(f.startedPath), false);
  f.update({ installExitCode: 0 });
  successful(await f.run());
  assert.equal(existsSync(f.startedPath), true);
});

test("Perl 锁在窗口运行期间继续持有，关闭后原生锁也能获取", async (t) => {
  const f = await fixture(t, { withoutLockf: true, installDelayMs: 1500 });
  const session = f.start();
  await waitForDependencyInstall(f);
  assert.equal((await f.run()).status, 75);
  await readySession(session);
  const nativeLock = () =>
    spawnSync(
      "/usr/bin/lockf",
      ["-k", "-t", "0", path.join(f.setupHome, "install.lock"), "/bin/sh", "-c", ":"],
      { encoding: "utf8", timeout: 5000 },
    );
  if (existsSync("/usr/bin/lockf")) assert.equal(nativeLock().status, 75);
  assert.equal((await f.run()).status, 75);
  session.signal("SIGTERM");
  successful(await session.completed);
  if (existsSync("/usr/bin/lockf")) successful(nativeLock());
  await cleanlyStopped(f, JSON.parse(readFileSync(f.startedPath, "utf8")).pid);
});

test("Perl 托管窗口关闭后服务和锁均释放，可再次启动", async (t) => {
  const f = await fixture(t, { withoutLockf: true });
  successful(await f.run());
  const firstPid = JSON.parse(readFileSync(f.startedPath, "utf8")).pid;
  await cleanlyStopped(f, firstPid);
  successful(await f.run());
  const nextPid = JSON.parse(readFileSync(f.startedPath, "utf8")).pid;
  assert.notEqual(nextPid, firstPid);
  await cleanlyStopped(f, nextPid);
});

test("缺少 lockf 时强制结束安装进程组后，遗留锁文件仍可重新使用", async (t) => {
  const f = await fixture(t, { withoutLockf: true, installDelayMs: 15_000 });
  const interrupted = f.startProcessGroup();
  await waitForDependencyInstall(f);
  interrupted.terminate();
  const result = await interrupted.completed;
  assert.equal(result.signal, "SIGKILL", result.stdout + result.stderr);
  assert.equal(existsSync(f.startedPath), false);
  assert.equal(existsSync(path.join(f.setupHome, "install.lock")), true);
  f.update({ installDelayMs: 0 });
  successful(await f.run());
  assert.equal(existsSync(f.startedPath), true);
});

test("项目依赖安装 Codex CLI，无可用全局命令也能校验后启动", async (t) => {
  const f = await fixture(t);
  const cliPackage = path.join(f.project, "node_modules", "@openai", "codex", "package.json");
  assert.equal(existsSync(cliPackage), false, "CLI 应随 pnpm 安装，而非夹具预装");
  const result = await f.run();
  successful(result);
  assert.match(result.stdout, /项目内 Codex CLI.*codex-cli 0\.159\.3/);
  assert.equal(existsSync(cliPackage), true);
  const calls = f.calls();
  const installAt = calls.findIndex(
    ({ command, args }) => command === "pnpm" && args.includes("install"),
  );
  const probeAt = calls.findIndex(({ command }) => command === "project-codex");
  const startedAt = calls.findIndex(({ command }) => command === "service-start");
  assert.ok(installAt >= 0 && probeAt > installAt && startedAt > probeAt);
  codexProbesAreIsolated(f);
});

test("Codex SDK 安装后缺少配套 CLI 包时报告失败，不启动后台", async (t) => {
  const f = await fixture(t, { codexMissing: true });
  const result = await f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Codex CLI 检查失败/);
  assert.equal(
    existsSync(path.join(f.project, "node_modules", "@openai", "codex-sdk", "index.js")),
    true,
  );
  assert.equal(
    existsSync(path.join(f.project, "node_modules", "@openai", "codex", "package.json")),
    false,
  );
  assert.equal(existsSync(f.startedPath), false);
  codexProbesAreIsolated(f, 0);
});

test("Codex 原生组件无法运行时停止启动，并清理版本检查的临时目录", async (t) => {
  const f = await fixture(t, { codexExitCode: 86 });
  const result = await f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /fixture Codex native binary cannot run/);
  assert.equal(existsSync(f.startedPath), false);
  codexProbesAreIsolated(f);
});

for (const codexMissing of [true, false]) {
  test(
    codexMissing
      ? "已有服务缺少项目 Codex CLI 时不重装依赖或重启"
      : "已有服务的 Codex CLI 损坏时保留服务和依赖",
    async (t) => {
      const f = await fixture(t, { listener: "existing", codexMissing, codexExitCode: 86 });
      const result = await f.run();
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /正在运行的项目缺少可用的 Codex CLI/);
      noInstallationOrStart(f);
      assert.doesNotThrow(() => process.kill(f.existing.pid, 0));
      codexProbesAreIsolated(f, codexMissing ? 0 : 1);
    },
  );
}

test("Codex CLI 退出成功但没有版本输出时仍阻止启动", async (t) => {
  const f = await fixture(t, { codexEmptyOutput: true });
  const result = await f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Codex CLI 未返回版本信息/);
  assert.equal(existsSync(f.startedPath), false);
  codexProbesAreIsolated(f);
});

for (const listener of ["existing", "none"]) {
  test(
    listener === "existing"
      ? "真实 PTY 挂断会停止当前窗口接管的旧服务"
      : "真实 PTY 挂断会停止当前窗口新启动的子服务",
    async (t) => {
      const f = await fixture(t, { listener });
      const session = f.startPty();
      await readySession(session);
      const pid = f.existing?.pid || JSON.parse(readFileSync(f.startedPath, "utf8")).pid;
      assert.doesNotThrow(() => process.kill(pid, 0));
      session.closePty();
      const result = await session.completed;
      assert.equal(result.error, undefined, result.stdout + result.stderr);
      assert.equal(result.status, 129, result.stdout + result.stderr);
      assert.equal(result.serviceAlive, false);
      assert.equal(result.cleanShutdown, true);
      if (listener === "existing") noInstallationOrStart(f);
      await cleanlyStopped(f, pid);
    },
  );
}

test("真实 PTY 输入 Ctrl+C 会清理新服务并以 130 退出", async (t) => {
  const f = await fixture(t);
  const session = f.startPty();
  await readySession(session);
  session.interruptPty();
  const result = await session.completed;
  assert.equal(result.error, undefined, result.stdout + result.stderr);
  assert.equal(result.status, 130, result.stdout + result.stderr);
  assert.equal(result.serviceAlive, false);
  assert.equal(result.cleanShutdown, true);
});

test("仅向父 Bash 发送 TERM 也会等待新服务清理完成", async (t) => {
  const f = await fixture(t);
  const session = f.start();
  await readySession(session);
  const pid = JSON.parse(readFileSync(f.startedPath, "utf8")).pid;
  session.signal("SIGTERM");
  const result = await session.completed;
  successful(result);
  assert.ok(
    f
      .calls()
      .some(
        (call) =>
          call.command === "service-signal" && call.pid === pid && call.signal === "SIGTERM",
      ),
  );
  await cleanlyStopped(f, pid);
});

test("新服务尚未就绪时关闭父 Bash 也会完成清理并允许重试", async (t) => {
  const f = await fixture(t, { healthDelayMs: 750 });
  const session = f.start();
  let probing = false;
  for (let attempt = 0; attempt < 400; attempt++) {
    probing = f
      .calls()
      .some(
        ({ command, args }) =>
          command === "curl" && args.some((arg) => arg.startsWith("http://127.0.0.1:5173/")),
      );
    if (probing) break;
    await delay(25);
  }
  assert.equal(probing, true, session.output());
  const pid = JSON.parse(readFileSync(f.startedPath, "utf8")).pid;
  session.signal("SIGTERM");
  const result = await session.completed;
  assert.equal(result.error, undefined, result.stdout + result.stderr);
  assert.equal(result.ready, false);
  assert.equal(result.status, 143, result.stdout + result.stderr);
  await cleanlyStopped(f, pid);
  f.update({ healthDelayMs: 0 });
  successful(await f.run());
});

test("服务自然退出后启动窗口也正常结束并释放锁", async (t) => {
  const f = await fixture(t, { serviceNaturalExitMs: 2200 });
  const result = await f.run({ autoStop: false });
  assert.equal(result.error, undefined, result.stdout + result.stderr);
  assert.equal(result.ready, true, result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.serviceAlive, false);
  assert.equal(result.cleanShutdown, true);
  assert.ok(f.calls().some((call) => call.command === "service-stop" && call.reason === "natural"));
  f.update({ serviceNaturalExitMs: 0 });
  successful(await f.run());
});

test("服务启动失败时报告错误，不遗留进程且能重试", async (t) => {
  const f = await fixture(t, { serviceStartupExitCode: 23 });
  const failed = await f.run();
  assert.equal(failed.error, undefined, failed.stdout + failed.stderr);
  assert.equal(failed.ready, false);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /fixture service failed to start/);
  await processStopped(JSON.parse(readFileSync(f.startedPath, "utf8")).pid);
  f.update({ serviceStartupExitCode: 0 });
  successful(await f.run());
});

test("安装阶段 Ctrl+C 不会启动服务或遗留安装子进程，可重新运行", async (t) => {
  const f = await fixture(t, { installDelayMs: 15_000 });
  const session = f.start();
  await waitForDependencyInstall(f);
  const install = f
    .calls()
    .find(({ command, args }) => command === "pnpm" && args.includes("install"));
  session.signalGroup("SIGINT");
  const result = await session.completed;
  assert.equal(result.error, undefined, result.stdout + result.stderr);
  assert.equal(result.status, 130, result.stdout + result.stderr);
  assert.equal(existsSync(f.startedPath), false);
  await processStopped(install.pid);
  f.update({ installDelayMs: 0 });
  successful(await f.run());
});

test("旧服务健康检查失败时不接管或停止该服务", async (t) => {
  const f = await fixture(t, { listener: "existing", unhealthy: true });
  const result = await f.run();
  assert.equal(result.error, undefined, result.stdout + result.stderr);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.ready, false);
  assert.doesNotThrow(() => process.kill(f.existing.pid, 0));
  noInstallationOrStart(f);
  assert.equal(
    f.calls().some((call) => call.command === "service-signal"),
    false,
  );
});
