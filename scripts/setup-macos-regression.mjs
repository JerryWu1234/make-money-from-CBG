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
  writeFileSync(
    path.join(project, "scripts", "serve-local.mjs"),
    `import { appendFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid }));
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ command: "service-start", args: [] }) + "\\n");
setInterval(() => {}, 1000);
`,
  );
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
    // Keep the missing executable path free of spaces so the pre-fix version
    // fails because lockf is absent, rather than because its command was unquoted.
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
  if (state.listener === "existing" || state.listener === "foreign") {
    existing = spawn(realNode, ["-e", "setInterval(() => {}, 1000)"], {
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
appendFileSync(state.callsPath, JSON.stringify({ command, args, bundled: process.env.CBG_TEST_PACKAGED_NODE === "1" }) + "\\n");
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
    let pid = state.listenerPid;
    if (!pid && existsSync(state.startedPath)) pid = JSON.parse(readFileSync(state.startedPath, "utf8")).pid;
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
      `#!/bin/bash\nexec "$CBG_TEST_REAL_NODE" "$CBG_TEST_DRIVER" ${command} "$@"\n`,
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
        `#!/bin/bash\nexport CBG_TEST_PACKAGED_NODE=1\nexport CBG_TEST_NODE_EXECUTABLE="$0"\nexec "$CBG_TEST_REAL_NODE" "$CBG_TEST_DRIVER" ${command} "$@"\n`,
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
  const start = (detached = false) => {
    const child = spawn("/bin/bash", [installerPath], { ...runOptions, detached });
    let stdout = "";
    let stderr = "";
    let error;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (value) => {
      error = value;
    });
    const completed = new Promise((resolve) =>
      child.once("close", (status, signal) => resolve({ status, signal, stdout, stderr, error })),
    );
    let terminated = false;
    const processGroup = {
      completed,
      terminate: () => {
        if (terminated || !child.pid) return;
        assert.ok(detached, "只能终止测试自身创建的独立进程组");
        terminated = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (value) {
          if (value.code !== "ESRCH") throw value;
        }
      },
    };
    if (detached) processGroups.push(processGroup);
    return processGroup;
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
    run: () => spawnSync("/bin/bash", [installerPath], runOptions),
    start: () => start().completed,
    startProcessGroup: () => start(true),
  };
}

function successful(result) {
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stdout + result.stderr);
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

test("重复运行复用本项目服务，不安装依赖或启动第二个进程（路径含空格）", async (t) => {
  const f = await fixture(t, { listener: "existing" });
  successful(f.run());
  successful(f.run());
  noInstallationOrStart(f);
  assert.doesNotThrow(() => process.kill(f.existing.pid, 0));
});

test("5173 被其他项目占用时停止，不改动依赖或关闭对方进程", async (t) => {
  const f = await fixture(t, { listener: "foreign" });
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /5173.*其他项目/);
  noInstallationOrStart(f);
  assert.doesNotThrow(() => process.kill(f.existing.pid, 0));
});

test("依赖安装失败时保留日志且不启动后台", async (t) => {
  const f = await fixture(t, { installExitCode: 42 });
  const result = f.run();
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
  successful(f.run());
  assert.equal(existsSync(f.startedPath), true, "失败后应释放安装锁，重新运行可以启动");
});

test("缺少 Git 且系统安装入口失败时，只请求一次安装并停止", async (t) => {
  const f = await fixture(t, { gitAvailable: false });
  const result = f.run();
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
  const result = f.run();
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
      ? "已有 Node 但缺 npm 时，安装完整配套工具并保留原服务"
      : "缺少 Node/npm 时，校验并安装私有工具，不改动原服务",
    async (t) => {
      const f = await fixture(t, {
        nodeAvailable,
        npmAvailable: false,
        validArchive: true,
        listener: "existing",
      });
      successful(f.run());
      assert.equal(existsSync(path.join(f.setupHome, "node-current", "bin", "node")), true);
      assert.equal(existsSync(path.join(f.setupHome, "node-current", "bin", "npm")), true);
      assert.ok(f.calls().some(({ command, bundled }) => command === "npm" && bundled));
      noInstallationOrStart(f);
      assert.doesNotThrow(() => process.kill(f.existing.pid, 0));
    },
  );
}

test("缺少 pnpm 时按项目版本安装，再安装开发依赖并启动独立后台", async (t) => {
  const f = await fixture(t, { pnpmAvailable: false });
  const result = f.run();
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
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal(
    f.calls().some(({ command }) => command === "open"),
    false,
  );
});

test("首次下载项目失败不留下半成品，重新运行可下载并启动", async (t) => {
  const f = await fixture(t, { cloneProject: true, cloneExitCode: 128 });
  const failed = f.run();
  assert.equal(failed.error, undefined);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.equal(existsSync(f.project), false);
  noInstallationOrStart(f);
  f.update({ cloneExitCode: 0 });
  const result = f.run();
  successful(result);
  assert.equal(existsSync(f.startedPath), true, result.stdout + result.stderr);
  const clones = f.calls().filter(({ command, args }) => command === "git" && args[0] === "clone");
  assert.equal(clones.length, 2);
  assert.ok(clones.every(({ args }) => args.includes("--branch") && args.includes("main")));
});

test("重复同时运行只允许一个安装流程，完成后可再次取得锁", async (t) => {
  const f = await fixture(t, { installDelayMs: 1500 });
  const first = f.start();
  let installing = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    installing = f
      .calls()
      .some(({ command, args }) => command === "pnpm" && args.includes("install"));
    if (installing) break;
    await delay(25);
  }
  assert.ok(installing, "首个安装流程应到达模拟依赖安装步骤");
  const duplicate = f.run();
  assert.equal(duplicate.error, undefined);
  assert.equal(duplicate.status, 75, duplicate.stdout + duplicate.stderr);
  assert.match(duplicate.stdout + duplicate.stderr, /另一个.*正在运行/);
  successful(await first);
  successful(f.run());
  assert.equal(
    f.calls().filter(({ command, args }) => command === "pnpm" && args.includes("install")).length,
    1,
  );
});

test("已有空锁文件不会阻止下一次启动", async (t) => {
  const f = await fixture(t, { listener: "existing" });
  mkdirSync(f.setupHome, { recursive: true });
  writeFileSync(path.join(f.setupHome, "install.lock"), "");
  successful(f.run());
  noInstallationOrStart(f);
});

test("下载 ZIP 后在无 .git 的仓库中运行，自行识别同目录项目并启动", async (t) => {
  const f = await fixture(t, { installerInProject: true, omitProjectDir: true });
  assert.equal(existsSync(path.join(f.project, ".git")), false);
  const result = f.run();
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

test("缺少 lockf 时用系统 Perl 锁复用服务，并允许重复运行", async (t) => {
  const f = await fixture(t, { withoutLockf: true, listener: "existing" });
  successful(f.run());
  successful(f.run());
  noInstallationOrStart(f);
  assert.doesNotThrow(() => process.kill(f.existing.pid, 0));
});

test("缺少 lockf 时安装失败会释放 Perl 锁，重试可启动", async (t) => {
  const f = await fixture(t, { withoutLockf: true, installExitCode: 42 });
  const failed = f.run();
  assert.equal(failed.error, undefined);
  assert.notEqual(failed.status, 0, failed.stdout + failed.stderr);
  assert.match(failed.stdout + failed.stderr, /fixture dependency install failed/);
  assert.equal(existsSync(f.startedPath), false);
  f.update({ installExitCode: 0 });
  successful(f.run());
  assert.equal(existsSync(f.startedPath), true);
});

test("缺少 lockf 时 Perl 锁仍只允许一个并发安装流程", async (t) => {
  const f = await fixture(t, { withoutLockf: true, installDelayMs: 1500 });
  const first = f.start();
  await waitForDependencyInstall(f);
  const duplicate = f.run();
  assert.equal(duplicate.error, undefined);
  assert.equal(duplicate.status, 75, duplicate.stdout + duplicate.stderr);
  assert.match(duplicate.stdout + duplicate.stderr, /另一个.*正在运行/);
  const nativeLock = () =>
    spawnSync(
      "/usr/bin/lockf",
      ["-k", "-t", "0", path.join(f.setupHome, "install.lock"), "/bin/sh", "-c", ":"],
      { encoding: "utf8", timeout: 5000 },
    );
  if (existsSync("/usr/bin/lockf")) {
    const conflict = nativeLock();
    assert.equal(conflict.status, 75, conflict.stdout + conflict.stderr);
  }
  successful(await first);
  if (existsSync("/usr/bin/lockf")) successful(nativeLock());
  assert.equal(
    f.calls().filter(({ command, args }) => command === "pnpm" && args.includes("install")).length,
    1,
  );
});

test("缺少 lockf 时后台服务不会长期继承 Perl 安装锁", async (t) => {
  const f = await fixture(t, { withoutLockf: true });
  successful(f.run());
  const pid = JSON.parse(readFileSync(f.startedPath, "utf8")).pid;
  assert.doesNotThrow(() => process.kill(pid, 0));
  successful(f.run());
  assert.equal(JSON.parse(readFileSync(f.startedPath, "utf8")).pid, pid);
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal(
    f.calls().filter(({ command, args }) => command === "pnpm" && args.includes("install")).length,
    1,
  );
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
  successful(f.run());
  assert.equal(existsSync(f.startedPath), true);
});

test("项目依赖安装 Codex CLI，无可用全局命令也能校验后启动", async (t) => {
  const f = await fixture(t);
  const cliPackage = path.join(f.project, "node_modules", "@openai", "codex", "package.json");
  assert.equal(existsSync(cliPackage), false, "CLI 应随 pnpm 安装，而非夹具预装");
  const result = f.run();
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
  const result = f.run();
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
  const result = f.run();
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
      const result = f.run();
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
  const result = f.run();
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /Codex CLI 未返回版本信息/);
  assert.equal(existsSync(f.startedPath), false);
  codexProbesAreIsolated(f);
});
