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
const installer = path.join(repository, "安装并启动.command");
const realNode = process.execPath;

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
    listener: "none",
    ...changes,
  };
  mkdirSync(path.join(project, "scripts"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(callsPath, "");
  writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify({
      name: "make-money-from-cbg",
      type: "module",
      scripts: { "dev:stable": "node scripts/serve-local.mjs" },
      devEngines: { packageManager: { name: "pnpm", version: "11.25.0" } },
    }),
  );
  writeFileSync(path.join(project, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(path.join(project, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(
    path.join(project, "scripts", "serve-local.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(startedPath)}, JSON.stringify({ pid: process.pid }));
setInterval(() => {}, 1000);
`,
  );
  const installerPath = state.installerInProject
    ? path.join(project, path.basename(installer))
    : installer;
  if (state.installerInProject) copyFileSync(installer, installerPath);
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
    } else fail(95);
    break;
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
    },
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 1_000_000,
  };
  if (state.omitProjectDir) delete runOptions.env.CBG_PROJECT_DIR;
  return {
    root,
    project,
    setupHome,
    startedPath,
    existing,
    update: (changes) =>
      writeFileSync(
        statePath,
        JSON.stringify({ ...JSON.parse(readFileSync(statePath, "utf8")), ...changes }),
      ),
    calls: () => readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse),
    run: () => spawnSync("/bin/bash", [installerPath], runOptions),
    start: () => {
      const child = spawn("/bin/bash", [installerPath], runOptions);
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
      return new Promise((resolve) =>
        child.once("close", (status) => resolve({ status, stdout, stderr, error })),
      );
    },
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
