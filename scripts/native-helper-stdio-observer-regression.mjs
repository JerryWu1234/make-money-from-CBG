import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertHelperExpiryInput, helperMessages } from "./native-helper-stdio-evidence.mjs";

const observer = fileURLToPath(new URL("./native-helper-stdio-observer.mjs", import.meta.url));
assert(
  Number(process.versions.node.split(".")[0]) >= 22,
  "Use the project Node runtime (vp exec node), not an older global node:test",
);

const grant = {
  command: "activity-renew",
  actionId: "grant",
  activity: { activityId: "lease", value: "价格" },
};
const status = { command: "status", actionId: "during" };
const line = (message) => Buffer.from(JSON.stringify(message) + "\n");
function evidence(beforeAck, afterAck = [], events = []) {
  const scope = { observerPid: 1, hostPid: 2, helperPid: 3 };
  const data = (bytes, direction) => ({
    ...scope,
    event: "data",
    direction,
    bytes: bytes.toString("base64"),
    receivedAt: 10,
  });
  const rows = beforeAck.map((bytes) => data(bytes, "host-to-helper"));
  rows.push(...events.map((event) => ({ ...scope, event, receivedAt: 11 })));
  rows.push(
    data(
      line({
        kind: "input-result",
        actionId: "grant",
        ok: true,
        active: true,
        activityId: "lease",
      }),
      "helper-to-host",
    ),
  );
  rows.push(...afterAck.map((bytes) => data(bytes, "host-to-helper")));
  const pauseRowCount = rows.length;
  rows.push(
    data(
      line({
        kind: "activity-invalidated",
        activityId: "lease",
        reason: "native-workflow-activity-expired",
      }),
      "helper-to-host",
    ),
  );
  const messages = helperMessages(rows);
  return {
    rows,
    args: {
      request: messages.find(
        (row) => row.direction === "host-to-helper" && row.message.actionId === "grant",
      ),
      ack: messages.find(
        (row) => row.direction === "helper-to-host" && row.message.actionId === "grant",
      ),
      expired: messages.at(-1),
      pausedAt: 1000,
      pauseRowCount,
      statusActionId: "during",
    },
  };
}

await test("whole-stream validator accepts fragmented UTF-8 grant and only the known read-only status", () => {
  const bytes = Buffer.concat([line(grant), line(status)]);
  const cut = bytes.indexOf(Buffer.from("价格")) + 1;
  const f = evidence([bytes.subarray(0, cut), bytes.subarray(cut)]);
  assert.deepEqual(assertHelperExpiryInput(f.rows, f.args), [status]);
  assert.equal(f.args.request.message.activity.value, "价格");
});
await test("whole-stream validator excludes a signal between fragments of the grant itself", () => {
  const bytes = line(grant),
    f = evidence([bytes.subarray(0, 8), bytes.subarray(8)]);
  f.rows.splice(1, 0, {
    observerPid: 1,
    hostPid: 2,
    helperPid: 3,
    event: "signal",
    receivedAt: 10,
  });
  const messages = helperMessages(f.rows);
  f.args.request = messages.find((row) => row.direction === "host-to-helper");
  f.args.ack = messages.find((row) => row.direction === "helper-to-host");
  f.args.expired = messages.at(-1);
  f.args.pauseRowCount++;
  assert(f.args.request.startRowIndex < f.args.request.rowIndex);
  assert.throws(() => assertHelperExpiryInput(f.rows, f.args), /Signal, EOF/);
});
for (const [name, make] of [
  [
    "grant and stop merged in one chunk",
    () => evidence([Buffer.concat([line(grant), line({ command: "stop" })])]),
  ],
  [
    "renew split across the grant chunk and the ACK",
    () => {
      const next = line({ command: "activity-renew", actionId: "later" });
      return evidence([Buffer.concat([line(grant), next.subarray(0, 8)])], [next.subarray(8)]);
    },
  ],
  [
    "stop arriving before the observer reads the ACK",
    () => evidence([line(grant), line({ command: "stop" })]),
  ],
  ["unparsed partial input", () => evidence([line(grant)], [Buffer.from('{"command":"stop"')])],
  ["signal before the ACK", () => evidence([line(grant)], [], ["signal"])],
  [
    "unknown read-only status",
    () => evidence([line(grant)], [line({ command: "status", actionId: "other" })]),
  ],
])
  await test(`whole-stream validator rejects ${String(name)}`, () => {
    const f = make();
    assert.throws(() => assertHelperExpiryInput(f.rows, f.args));
  });
async function fixture(
  t,
  flood = false,
  awaitReady = true,
  stubbornEOF = false,
  finiteExitZero = false,
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cbg-observer-test-"));
  const binary = path.join(directory, "fixture-helper.mjs"),
    log = path.join(directory, "raw.jsonl");
  // A protocol/stdio fixture, not native code, permissions, or OS input evidence.
  await writeFile(
    binary,
    `#!${process.execPath}\nimport{spawn}from'node:child_process';process.on('SIGUSR1',()=>process.stdout.write('USR1\\n'));
${finiteExitZero ? "process.stdin.once('data',()=>{spawn(process.execPath,['-e','process.stdout.write(Buffer.alloc(8*1024*1024,120))'],{stdio:['ignore',1,2]});process.exit(0);});" : flood ? "process.on('SIGTERM',()=>{});process.stdin.once('data',()=>setInterval(()=>process.stdout.write(Buffer.alloc(65536,120)),1));" : "process.stdin.on('data',bytes=>process.stdout.write(bytes));"}
${stubbornEOF ? "process.on('SIGTERM',()=>{});process.stdin.on('end',()=>setInterval(()=>{},100));" : "process.stdin.on('end',()=>{process.exitCode=0;});"}
process.stdout.write('READY\\n');\n`,
    { mode: 0o700 },
  );
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT; // Fixture stdout is bytes, not node:test's child IPC stream.
  const processChild = spawn(process.execPath, [observer, "--binary", binary, "--log", log], {
    stdio: ["pipe", "pipe", "pipe"],
    env: environment,
  });
  const output = [],
    stderr = [];
  processChild.stdout.on("data", (bytes) => output.push(bytes));
  processChild.stderr.on("data", (bytes) => stderr.push(bytes));
  const closed = once(processChild, "close");
  const rows = async () => {
    try {
      const text = await readFile(log, "utf8");
      return text
        .slice(0, text.lastIndexOf("\n") + 1)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  const until = async (condition) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const value = await condition();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Fixture evidence timeout");
  };
  t.after(async () => {
    processChild.stdout.resume();
    if (processChild.exitCode === null) processChild.kill("SIGTERM");
    await closed;
    assert.equal(Buffer.concat(stderr).toString(), "");
    await rm(directory, { recursive: true, force: true });
  });
  if (awaitReady) await until(() => Buffer.concat(output).includes(Buffer.from("READY\n")));
  return { processChild, output, closed, rows, until, log };
}
const raw = (rows, direction) =>
  Buffer.concat(
    rows
      .filter((row) => row.event === "data" && row.direction === direction)
      .map((row) => Buffer.from(row.bytes, "base64")),
  );

await test(
  "an already-exited zero-code child cannot overwrite a later stream overflow failure",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, false, true, false, true);
    f.processChild.stdout.pause();
    f.processChild.stdin.write("finite burst");
    await f.until(async () => (await f.rows()).some((row) => row.event === "helper-close"));
    const rows = await f.rows();
    assert.equal(rows.at(-1).code, 0);
    assert(rows.some((row) => row.event === "output-buffer-overflow"));
    f.processChild.stdout.resume();
    assert.deepEqual(await f.closed, [1, null]);
  },
);

await test(
  "EOF has a bounded cleanup fallback when a child refuses to exit",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, false, true, true);
    const began = Date.now();
    f.processChild.stdin.end();
    assert.deepEqual(await f.closed, [1, null]);
    assert(Date.now() - began < 4000);
    const rows = await f.rows();
    assert(rows.some((row) => row.event === "host-stdin-eof"));
    assert.equal(rows.filter((row) => row.event === "cleanup-kill").length, 1);
    assert.equal(rows.at(-1).signal, "SIGKILL");
  },
);

await test(
  "early host EOF still records and reaps the real child before any identity/status setup",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, false, false);
    f.processChild.stdin.end();
    assert.deepEqual(await f.closed, [0, null]);
    const rows = await f.rows(),
      start = rows.find((row) => row.event === "observer-start");
    assert(start.helperPid > 0);
    assert(rows.some((row) => row.event === "host-stdin-eof"));
    assert.equal(rows.at(-1).event, "helper-close");
    assert.throws(() => process.kill(start.helperPid, 0), { code: "ESRCH" });
  },
);

await test(
  "preserves fragmented binary bytes both ways and propagates stdin EOF",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const parts = [
      Buffer.from([0, 255, 10, 195]),
      Buffer.from([169, 1, 0]),
      Buffer.from("原始\n数据"),
    ];
    for (const part of parts) f.processChild.stdin.write(part);
    f.processChild.stdin.end();
    assert.deepEqual(await f.closed, [0, null]);
    const rows = await f.rows(),
      input = Buffer.concat(parts),
      output = Buffer.concat(f.output);
    assert.deepEqual(raw(rows, "host-to-helper"), input);
    assert.deepEqual(raw(rows, "helper-to-host"), output);
    assert.deepEqual(output, Buffer.concat([Buffer.from("READY\n"), input]));
    assert(rows.some((row) => row.event === "host-stdin-eof"));
    const start = rows.find((row) => row.event === "observer-start");
    assert.equal(start.observerPid, f.processChild.pid);
    assert.equal(start.helperParentPid, start.observerPid);
    assert.notEqual(start.helperPid, start.observerPid);
    assert.match(start.binarySha256, /^[a-f0-9]{64}$/);
    assert.equal(rows.at(-1).event, "helper-close");
  },
);

await test(
  "overflow latches, bounds buffering/logging and kills a SIGTERM-ignoring writer",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, true);
    f.processChild.stdout.pause();
    f.processChild.stdin.write("start flood");
    await f.until(async () =>
      (await f.rows()).some((row) => row.event === "output-buffer-overflow"),
    );
    const beforeDrain = await f.rows();
    const overflow = beforeDrain.find((row) => row.event === "output-buffer-overflow");
    assert(overflow.queuedBytes <= 4 * 1024 * 1024);
    await f.until(async () => (await f.rows()).some((row) => row.event === "helper-close"));
    const fixedSize = (await stat(f.log)).size;
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await stat(f.log)).size, fixedSize);
    assert(fixedSize < 8 * 1024 * 1024);
    f.processChild.stdout.resume();
    assert.deepEqual(await f.closed, [1, null]);
    const rows = await f.rows();
    assert.equal(rows.filter((row) => row.event === "output-buffer-overflow").length, 1);
    assert.equal(rows.at(-1).signal, "SIGKILL");
    const index = rows.findIndex((row) => row.event === "output-buffer-overflow");
    assert(!rows.slice(index + 1).some((row) => row.event === "data"));
    assert.throws(() => process.kill(overflow.helperPid, 0), { code: "ESRCH" });
  },
);

await test(
  "forwards SIGUSR1 to the actual child and SIGTERM terminates both",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    f.processChild.kill("SIGUSR1");
    await f.until(() => Buffer.concat(f.output).includes(Buffer.from("USR1\n")));
    f.processChild.kill("SIGTERM");
    assert.deepEqual(await f.closed, [1, null]);
    const rows = await f.rows();
    assert.deepEqual(
      rows.filter((row) => row.event === "signal").map((row) => row.signal),
      ["SIGUSR1", "SIGTERM"],
    );
    assert.equal(rows.at(-1).signal, "SIGTERM");
    const child = rows.find((row) => row.event === "observer-start").helperPid;
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  },
);

await test(
  "keeps independently recording helper output while its host reader is paused",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    f.processChild.stdout.pause();
    const payload = Buffer.concat([
      Buffer.alloc(1024 * 1024, 120),
      Buffer.from("INDEPENDENT-TAIL\n"),
    ]);
    f.processChild.stdin.write(payload);
    await f.until(async () =>
      raw(await f.rows(), "helper-to-host").includes(Buffer.from("INDEPENDENT-TAIL\n")),
    );
    f.processChild.stdout.resume();
    f.processChild.stdin.end();
    assert.deepEqual(await f.closed, [0, null]);
    assert.deepEqual(Buffer.concat(f.output), Buffer.concat([Buffer.from("READY\n"), payload]));
    assert(!(await f.rows()).some((row) => row.event === "output-buffer-overflow"));
  },
);
