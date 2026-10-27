import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
// Failure cases: default state contamination, persisted ID lost across restarts,
// unexpected temporary threads, unavailable resume, or hidden network/model calls.
const testHome = realpathSync(mkdtempSync(path.join(tmpdir(), "cbg-persistent-offline-")));
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
    [cli, "app-server", "--listen", "stdio://", "-c", 'cli_auth_credentials_store="file"'],
    { env: childEnv, cwd: testHome, stdio: ["pipe", "pipe", "pipe"] },
  );
  let seq = 0;
  const waiting = new Map();
  let stderr = "";
  createInterface({ input: proc.stdout }).on("line", (line) => {
    try {
      const msg = JSON.parse(line);
      if (msg.id != null && waiting.has(msg.id)) {
        waiting.get(msg.id)(msg);
        waiting.delete(msg.id);
      }
    } catch {}
  });
  proc.stderr.on("data", (c) => {
    stderr += c.toString();
  });
  async function request(method, params = {}) {
    const id = ++seq;
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(method + " timeout")), 12000);
      waiting.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(method + ": " + msg.error.message));
        else resolve(msg.result);
      });
      proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
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
    proc.stdin.end();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error("shutdown timeout"));
      }, 12000);
      proc.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  return { init, request, close };
}
const report = {
  test: "offline persistent thread restart",
  simulatedHistory: true,
  modelRequests: 0,
  isolatedHome: testHome,
  repeat: "node scripts/codex-persistent-offline-regression.mjs",
  limits:
    "No actual turn, turn/revert or model request was performed; same-ID resume and empty turn list only.",
};
try {
  const one = createTransport();
  await one.init();
  const created = await one.request("thread/start", {
    cwd: testHome,
    model: "gpt-6-luna",
    sandbox: "read-only",
    approvalPolicy: "never",
    ephemeral: false,
  });
  const threadId = created.thread.id;
  assert.ok(threadId);
  assert.equal(created.thread.ephemeral, false);
  assert.ok(created.thread.path.startsWith(testHome + path.sep));
  await one.request("thread/name/set", { threadId, name: "offline synthetic" });
  await one.request("thread/inject_items", {
    threadId,
    items: [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "offline synthetic history" }],
      },
    ],
  });
  await one.close();
  const two = createTransport();
  await two.init();
  const resumed = await two.request("thread/resume", { threadId, excludeTurns: true });
  assert.equal(resumed.thread.id, threadId);
  assert.equal(resumed.thread.ephemeral, false);
  assert.ok(resumed.thread.path.startsWith(testHome + path.sep));
  const turns = await two.request("thread/turns/list", { threadId, limit: 1 });
  assert.ok(Array.isArray(turns.data));
  report.sameIdAfterRestart = true;
  report.persistentThread = true;
  report.threadPathInIsolatedHome = true;
  report.turnCount = turns.data.length;
  await two.close();
  writeFileSync(path.join(testHome, "evidence.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (err) {
  console.error(String(err));
  process.exitCode = 1;
}
