import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

// Test transport only. Never construct protocol replies or inject helper commands.
const options = process.argv.slice(2);
assert.equal(options.length, 4, "Usage: --binary PATH --log PATH");
assert.equal(options[0], "--binary");
assert.equal(options[2], "--log");
const binary = options[1],
  logPath = options[3],
  hostPid = process.ppid;
let sequence = 0;
const record = (event, details = {}) =>
  appendFileSync(
    logPath,
    JSON.stringify({
      event,
      sequence: ++sequence,
      receivedAt: Date.now(),
      monotonicNs: process.hrtime.bigint().toString(),
      observerPid: process.pid,
      hostPid,
      ...details,
    }) + "\n",
    { mode: 0o600 },
  );
const helper = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
record("observer-start", {
  helperPid: helper.pid,
  helperParentPid: process.pid,
  binary,
  binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
});
let killTimer,
  overflowed = false;
const boundExit = () => {
  if (killTimer) return;
  killTimer = setTimeout(() => {
    record("cleanup-kill", { helperPid: helper.pid });
    helper.kill("SIGKILL");
  }, 2000);
  killTimer.unref();
};
const terminate = (signal) => {
  if (overflowed) return;
  record("signal", { signal, helperPid: helper.pid });
  if (!helper.kill(signal)) record("signal-not-delivered", { signal });
  if (signal !== "SIGUSR1") boundExit();
};
for (const signal of ["SIGUSR1", "SIGTERM", "SIGINT", "SIGHUP"])
  process.on(signal, () => terminate(signal));
process.stdin.on("data", (bytes) =>
  record("data", {
    direction: "host-to-helper",
    helperPid: helper.pid,
    bytes: bytes.toString("base64"),
  }),
);
helper.stdout.on("data", (bytes) => {
  if (overflowed) return;
  if (process.stdout.writableLength + bytes.length > 4 * 1024 * 1024) {
    overflowed = true;
    record("output-buffer-overflow", {
      helperPid: helper.pid,
      queuedBytes: process.stdout.writableLength,
      droppedBytes: bytes.length,
      queueLimitBytes: 4 * 1024 * 1024,
    });
    clearTimeout(killTimer);
    process.stdin.unpipe(helper.stdin);
    process.stdin.pause();
    process.stdin.destroy();
    helper.kill("SIGKILL");
    process.exitCode = 1;
    return;
  }
  const receivedAt = Date.now(),
    monotonicNs = process.hrtime.bigint().toString();
  // A separate process remains runnable while the real host is SIGSTOP'ed.
  const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(hostPid)], { encoding: "utf8" });
  record("data", {
    direction: "helper-to-host",
    helperPid: helper.pid,
    receivedAt,
    monotonicNs,
    bytes: bytes.toString("base64"),
    hostState: state.stdout?.trim() || "",
    hostStateSampledAt: Date.now(),
    hostStateStatus: state.status,
  });
  // Do not pipe/pause this input when the stopped host exerts backpressure:
  // the independent expiry observation must remain runnable. Bound the queue.
  process.stdout.write(bytes);
});
// pipe forwards the original Buffers and preserves backpressure and EOF.
process.stdin.pipe(helper.stdin);
helper.stderr.pipe(process.stderr);
process.stdin.on("end", () => {
  record("host-stdin-eof", { helperPid: helper.pid });
  boundExit();
});
helper.stdout.on("end", () => record("helper-stdout-eof", { helperPid: helper.pid }));
helper.stdin.on("error", (error) => {
  record("helper-stdin-error", { code: error.code });
  terminate("SIGTERM");
});
process.stdout.on("error", (error) => {
  record("host-stdout-error", { code: error.code });
  terminate("SIGTERM");
});
helper.on("error", (error) => {
  record("helper-spawn-error", { code: error.code });
  process.stdin.destroy();
  process.exitCode = 1;
});
helper.on("close", (code, signal) => {
  clearTimeout(killTimer);
  record("helper-close", { helperPid: helper.pid, code, signal });
  process.stdin.unpipe(helper.stdin);
  process.stdin.pause();
  process.stdin.destroy();
  process.exitCode = overflowed ? 1 : (code ?? 1);
});
