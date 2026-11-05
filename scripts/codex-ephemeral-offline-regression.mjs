import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

// Failure cases: temporary calls persist transcripts, a later request sees another
// thread, or restarting app-server can restore a discarded thread. No model turn is sent.
const testHome = realpathSync(mkdtempSync(path.join(tmpdir(), "cbg-ephemeral-offline-")));
const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
const cli = path.join(
  path.dirname(sdkRequire.resolve("@openai/codex/package.json")),
  "bin",
  "codex.js",
);
const childEnv = { ...process.env, CODEX_HOME: testHome, CODEX_SQLITE_HOME: testHome };
for (const key of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN", "OPENAI_BASE_URL"])
  delete childEnv[key];

function createTransport() {
  const proc = spawn(
    process.execPath,
    [
      cli,
      "app-server",
      "--listen",
      "stdio://",
      "-c",
      'cli_auth_credentials_store="file"',
      "-c",
      "features.plugins=false",
      "-c",
      "features.apps=false",
      "-c",
      "features.skip_host_skill_discovery=true",
      "-c",
      "features.shell_snapshot=false",
      "-c",
      "thread_unload_delay_secs=0",
    ],
    { env: childEnv, cwd: testHome, stdio: ["pipe", "pipe", "pipe"] },
  );
  let seq = 0;
  let closed = false;
  const waiting = new Map();
  const output = createInterface({ input: proc.stdout });
  output.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id != null && waiting.has(msg.id)) {
      const task = waiting.get(msg.id);
      waiting.delete(msg.id);
      clearTimeout(task.timer);
      if (msg.error) task.reject(new Error(task.method + ": " + msg.error.message));
      else task.resolve(msg.result);
    }
  });
  proc.stderr.resume();
  const completion = new Promise((resolve) => {
    proc.once("close", () => {
      closed = true;
      for (const task of waiting.values()) {
        clearTimeout(task.timer);
        task.reject(new Error("app-server closed before " + task.method));
      }
      waiting.clear();
      resolve();
    });
  });
  proc.on("error", () => {});
  async function request(method, params = {}) {
    if (closed) throw new Error("app-server is closed");
    const id = ++seq;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(method + " timeout"));
      }, 12000);
      waiting.set(id, { method, timer, resolve, reject });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n", (error) => {
        if (!error || !waiting.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  async function init() {
    const data = await request("initialize", {
      clientInfo: { name: "cbg-offline-check", version: "1.0" },
      capabilities: { experimentalApi: true },
    });
    assert.equal(data.codexHome, testHome);
    proc.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  }
  async function close() {
    if (closed) return;
    const deadline = setTimeout(() => proc.kill("SIGKILL"), 12000);
    proc.stdin.end();
    await completion;
    clearTimeout(deadline);
    output.close();
  }
  return { init, request, close };
}

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}

const report = {
  test: "offline ephemeral thread disposal and restart",
  simulatedHistory: true,
  modelRequests: 0,
  isolatedHome: testHome,
  repeat: "node scripts/codex-ephemeral-offline-regression.mjs",
  limits:
    "Synthetic injected messages only; no model request, real account, or analysis result is used. CLI runtime metadata may still be generated.",
};
const transports = [];
try {
  const one = createTransport();
  transports.push(one);
  await one.init();
  const input = {
    cwd: testHome,
    model: "gpt-6-luna",
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: true,
  };
  const first = (await one.request("thread/start", input)).thread;
  const second = (await one.request("thread/start", input)).thread;
  assert.ok(first.id);
  assert.notEqual(first.id, second.id);
  for (const thread of [first, second]) {
    assert.equal(thread.ephemeral, true);
    assert.equal(thread.path, null);
  }
  await one.request("thread/inject_items", {
    threadId: first.id,
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "offline synthetic request, no model invocation" }],
      },
    ],
  });
  const before = await one.request("thread/list", { limit: 100 });
  assert.ok(before.data.every((thread) => ![first.id, second.id].includes(thread.id)));
  for (const thread of [first, second]) {
    const released = await one.request("thread/unsubscribe", { threadId: thread.id });
    assert.ok(["unsubscribed", "notLoaded", "notSubscribed"].includes(released.status));
  }
  await one.close();

  const two = createTransport();
  transports.push(two);
  await two.init();
  const after = await two.request("thread/list", { limit: 100 });
  assert.ok(after.data.every((thread) => ![first.id, second.id].includes(thread.id)));
  await assert.rejects(two.request("thread/resume", { threadId: first.id, excludeTurns: true }));
  const third = (await two.request("thread/start", input)).thread;
  assert.ok(![first.id, second.id].includes(third.id));
  assert.equal(third.ephemeral, true);
  assert.equal(third.path, null);
  await two.request("thread/unsubscribe", { threadId: third.id });
  await two.close();
  assert.deepEqual(filesUnder(path.join(testHome, "sessions")), []);
  assert.deepEqual(filesUnder(path.join(testHome, "archived_sessions")), []);
  Object.assign(report, {
    distinctThreadIds: [first.id, second.id, third.id],
    persistentThreadsListed: after.data.length,
    discardedThreadCannotResume: true,
    noSessionFiles: true,
  });
  writeFileSync(path.join(testHome, "evidence.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
} finally {
  await Promise.allSettled(transports.map((transport) => transport.close()));
}
