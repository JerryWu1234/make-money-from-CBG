import { afterAll, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const directory = fileURLToPath(new URL("../../native/cbg-access/", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "cbg-native-startup-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

// Execute the checked-in host in a real process with its actual Native stdin pipe.
// Only the socket/helper/configuration are substituted; host lifecycle logic is unchanged.
const hostHarness = path.join(temporary, "host-process.cjs");
writeFileSync(
  hostHarness,
  String.raw`
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const directory = process.argv[2], scenario = process.argv[3];
const writes = [], kills = [], reports = [], messages = [];
let now = 1000;
const socket = Object.assign(new EventEmitter(), { write(raw) { messages.push(JSON.parse(raw)); }, destroy() {} });
const helper = Object.assign(new EventEmitter(), {
  stdin:{ write(raw) { writes.push(JSON.parse(raw)); } },
  stdout:new EventEmitter(), stderr:new EventEmitter(), kill(signal) { kills.push(signal); }
});
const authority = fs.readFileSync(path.join(directory,'command-authority.mjs'),'utf8').replaceAll('export class ','class ');
const activity = fs.readFileSync(path.join(directory,'activity-authority.mjs'),'utf8').replaceAll('export class ','class ').replaceAll('export const ','const ');
const host = fs.readFileSync(path.join(directory,'host.mjs'),'utf8').replace(/^#!.*\n/,'').replace(/^import .*?;\n/gm,'').replaceAll('import.meta.url',JSON.stringify(pathToFileURL(path.join(directory,'host.mjs')).href));
const bridgeProcess = Object.create(process);
bridgeProcess.argv = [process.execPath, path.join(directory,'host.mjs'), 'chrome-extension://'+'a'.repeat(32)+'/'];
vm.runInNewContext(authority+'\n'+activity+'\n'+host, {
  Buffer, fs:{ statSync:()=>({mode:0o600,uid:process.getuid()}), readFileSync:()=>JSON.stringify({extensionId:'a'.repeat(32),socketPath:'/private/tmp/unused-startup.sock'}) },
  net:{connect:()=>socket}, path, os:{homedir:()=>temporary}, spawn:()=>helper,
  fileURLToPath, randomUUID, process:bridgeProcess, setInterval, clearInterval,
  Date:class extends Date { static now() { return scenario==='timeout' ? now : Date.now(); } }
});
function send(message) { socket.emit('data',Buffer.from(JSON.stringify(message)+'\n')); }
function result(value) { helper.stdout.emit('data',Buffer.from(JSON.stringify(value)+'\n')); }
function record(stage) { reports.push({stage,writes:structuredClone(writes),kills:[...kills]}); }
function finish() {
  socket.emit('close'); socket.emit('close');
  process.stderr.write('REPORT '+JSON.stringify({reports,writes,kills,messages,stdinDestroyed:process.stdin.destroyed})+'\n');
}
setTimeout(() => {
  if (scenario==='exit') return finish();
  send({kind:'resume',actionId:'old-resume',context:{stopEpoch:0,browserSessionEpoch:'session'}});
  if (scenario==='cancel') {
    send({kind:'command',command:'stop',actionId:'stop-before-ready'});
    send({kind:'resume',actionId:'new-resume',context:{stopEpoch:1,browserSessionEpoch:'new-session'}});
  }
  record('before-ready');
  if (scenario==='unavailable') {
    result({kind:'input-unavailable',version:1,error:'input-monitor-startup-failed'});
    return finish();
  }
  if (scenario==='timeout') {
    now=8000;
    setTimeout(finish,150);
    return;
  }
  result({kind:'input-ready',version:1});
  record('after-ready');
  if (scenario==='diagnostic') {
    const activity = {activityId:'diagnostic-activity',authorizationEpoch:1,stopEpoch:0,browserSessionEpoch:'session',expiresAt:Date.now()+14000,progressExpiresAt:Date.now()+170000,progressSequence:0};
    send({kind:'activity',command:'begin',actionId:'grant',activity});
    const grant = writes.at(-1);
    result({actionId:'grant',ok:true,activityId:activity.activityId,active:true});
    const invalidated = {kind:'activity-invalidated',...activity,hostGeneration:grant.hostGeneration,hostInstanceEpoch:grant.hostInstanceEpoch,reason:'input-stopped-or-user-preempted',inputPreemption:{diagnosticSchema:2,eventType:5,eventTimestampNs:'99',grantTimestampNs:'100',sourcePid:0,userData:0,sourceStateID:0,ownsInput:true,tapDisabled:false,grantPointerAvailable:true,grantPointer:{x:100.5,y:-12.25},mouse:{deltaX:0,deltaY:0,locationAvailable:true,location:{x:100.5,y:-12.25}}}};
    result({...invalidated,hostGeneration:grant.hostGeneration-1,inputPreemption:{stale:true}});
    record('after-stale-invalidated');
    result(invalidated);
    return finish();
  }
  send({kind:'command',command:'stop',actionId:'stop-after-ready'});
  finish();
},10);
`.replace("os:{homedir:()=>temporary}", `os:{homedir:()=>${JSON.stringify(temporary)}}`),
);

async function runHost(scenario: string) {
  const child = spawn(process.execPath, [hostHarness, directory, scenario], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let errors = "";
  child.stdout.resume();
  child.stderr.on("data", (value) => (errors += value));
  const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const lines = errors.trim().split("\n");
    expect(lines.filter((line) => !line.startsWith("REPORT "))).toEqual([]);
    expect(code).toBe(0);
    return JSON.parse(lines.at(-1)!.slice("REPORT ".length)) as {
      reports: Array<{ stage: string; writes: any[]; kills: string[] }>;
      writes: any[];
      kills: string[];
      messages: any[];
      stdinDestroyed: boolean;
    };
  } finally {
    clearTimeout(timer);
    child.stdin.destroy();
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

it("host closes its real Native stdin and terminates once when the service socket closes", async () => {
  const result = await runHost("exit");
  expect(result.stdinDestroyed).toBe(true);
  expect(result.kills).toEqual(["SIGTERM"]);
});

it.each(["startup", "cancel"])(
  "host fences %s commands until the helper is actually ready",
  async (scenario) => {
    const result = await runHost(scenario);
    expect(result.reports[0]).toMatchObject({ stage: "before-ready", writes: [], kills: [] });
    expect(result.reports[1].writes).toHaveLength(1);
    expect(result.reports[1].writes[0]).toMatchObject({
      command: "resume",
      actionId: scenario === "cancel" ? "new-resume" : "old-resume",
    });
    expect(result.reports[1].kills).toEqual([]);
    expect(result.kills).toEqual(["SIGUSR1", "SIGTERM"]);
  },
);

it.each(["unavailable", "timeout"])(
  "host releases stdin without dispatch when helper startup is %s",
  async (scenario) => {
    const result = await runHost(scenario);
    expect(result.stdinDestroyed).toBe(true);
    expect(result.writes).toEqual([]);
    expect(result.kills).toEqual(["SIGTERM"]);
  },
);

it("host preserves the first-event diagnostic and reason only for the current activity invalidation", async () => {
  const result = await runHost("diagnostic");
  expect(result.reports.at(-1)).toMatchObject({ stage: "after-stale-invalidated", kills: [] });
  expect(result.messages.filter((message) => message.kind === "host-status")).toEqual([
    {
      kind: "host-status",
      stopped: true,
      reason: "input-stopped-or-user-preempted",
      inputPreemption: {
        diagnosticSchema: 2,
        eventType: 5,
        eventTimestampNs: "99",
        grantTimestampNs: "100",
        sourcePid: 0,
        userData: 0,
        sourceStateID: 0,
        ownsInput: true,
        tapDisabled: false,
        grantPointerAvailable: true,
        grantPointer: { x: 100.5, y: -12.25 },
        mouse: { deltaX: 0, deltaY: 0, locationAvailable: true, location: { x: 100.5, y: -12.25 } },
      },
    },
  ]);
  expect(result.kills).toEqual(["SIGUSR1", "SIGTERM"]);
});

function buildHelper(name: string, definitions: string[], isolatedMonitor = true) {
  const executable = path.join(temporary, name);
  const compiled = spawnSync(
    "clang",
    [
      "-fobjc-arc",
      "-fblocks",
      ...(isolatedMonitor ? ["-DCBG_INPUT_TEST_MONITOR=1"] : []),
      ...definitions,
      path.join(directory, "Input.m"),
      "-o",
      executable,
      "-framework",
      "Cocoa",
      "-framework",
      "ApplicationServices",
    ],
    { encoding: "utf8" },
  );
  expect(compiled.stderr).toBe("");
  expect(compiled.status).toBe(0);
  return executable;
}

async function runHelper(executable: string, statusOnly = false) {
  const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "",
    errors = "";
  const started = performance.now();
  let firstRecordAt = 0;
  child.stdout.on("data", (value) => {
    if (!output) firstRecordAt = performance.now() - started;
    output += value;
  });
  child.stderr.on("data", (value) => (errors += value));
  child.stdin.on("error", () => {});
  // These commands are already available while the exact production startup barrier waits.
  child.stdin.end(
    statusOnly
      ? JSON.stringify({ command: "status", actionId: "permission-types" }) + "\n"
      : JSON.stringify({
          command: "resume",
          actionId: "buffered-resume",
          hostInstanceEpoch: "test-host",
          hostGeneration: 1,
          stopEpoch: 0,
          browserSessionEpoch: "test-session",
        }) +
          "\n" +
          JSON.stringify({ command: "execute", actionId: "no-input" }) +
          "\n",
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 2500);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    expect(errors).toBe("");
    return {
      code,
      firstRecordAt,
      records: output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    };
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
}

it.skipIf(process.platform !== "darwin")(
  "normal compiled callback guard is lock-free and fences owner transfer while preserving takeover and disabled-tap stops",
  () => {
    const executable = buildHelper("preemption-guard", [], false);
    const completed = spawnSync(executable, ["--preemption-self-test"], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(completed.status).toBe(0);
    expect(completed.stderr).toBe("");
    expect(JSON.parse(completed.stdout)).toEqual({
      kind: "input-preemption-self-test",
      ok: true,
      checks: 14,
      osInputPosted: false,
    });
    const geometry = spawnSync(executable, ["--self-test"], { encoding: "utf8", timeout: 5000 });
    expect(geometry.status).toBe(0);
    expect(geometry.stderr).toBe("");
    expect(geometry.stdout).toContain("55 assertions, no input posted");
  },
  10000,
);

it.skipIf(process.platform !== "darwin")(
  "helper waits for a delayed monitor before ready or buffered resume, with OS input disabled",
  async () => {
    const helper = buildHelper("delayed-monitor", [
      "-DCBG_INPUT_TEST_MONITOR_DELAY_MS=120",
      "-DCBG_INPUT_STARTUP_TIMEOUT_MS=1000",
    ]);
    const result = await runHelper(helper);
    expect(result.code).toBe(0);
    expect(result.firstRecordAt).toBeGreaterThanOrEqual(100);
    expect(result.records).toEqual([
      { kind: "input-ready", version: 1 },
      { actionId: "buffered-resume", ok: true },
      {
        actionId: "no-input",
        ok: false,
        error: "startup-test-input-disabled",
        inputPreemption: {},
        posted: false,
      },
    ]);
  },
  10000,
);

it.skipIf(process.platform !== "darwin")(
  "real permission reads serialize booleans for the runtime activation contract",
  async () => {
    // Only monitor startup/input posting use the isolated backend. AX/TCC status reads remain real.
    const result = await runHelper(buildHelper("permission-types", []), true);
    expect(result.code).toBe(0);
    const status = result.records.find((value) => value.actionId === "permission-types");
    expect(status?.ok).toBe(true);
    for (const name of [
      "accessibility",
      "inputMonitoring",
      "inputMonitorActive",
      "locked",
      "displayAvailable",
      "frontmostChrome",
      "screenRecording",
    ])
      expect(typeof status.permissions[name], name).toBe("boolean");
    expect(status.activity.active).toBe(false);
    expect(status.activity.expired).toBe(false);
    expect(status.activity).not.toHaveProperty("awake");
    expect(status.activity).not.toHaveProperty("assertionId");
  },
  10000,
);

it.skipIf(process.platform !== "darwin").each([
  {
    name: "failed-monitor",
    definitions: ["-DCBG_INPUT_TEST_MONITOR_READY=0"],
    error: "input-monitor-startup-failed",
  },
  {
    name: "timed-out-monitor",
    definitions: ["-DCBG_INPUT_TEST_MONITOR_DELAY_MS=300", "-DCBG_INPUT_STARTUP_TIMEOUT_MS=30"],
    error: "input-monitor-startup-timeout",
  },
])(
  "helper stops before reading buffered commands after $name",
  async ({ name, definitions, error }) => {
    const result = await runHelper(buildHelper(name, definitions));
    expect(result.code).toBe(1);
    expect(result.records).toEqual([{ kind: "input-unavailable", version: 1, error }]);
  },
  10000,
);
