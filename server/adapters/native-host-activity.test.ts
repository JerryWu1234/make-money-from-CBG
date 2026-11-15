import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, it } from "vite-plus/test";
function fixture() {
  let now = 100000;
  const serverWrites: any[] = [],
    helperWrites: any[] = [],
    kills: string[] = [],
    timers: Array<() => void> = [];
  const socket = Object.assign(new EventEmitter(), {
    write: (line: string) => serverWrites.push(JSON.parse(line)),
    destroy: () => {},
  });
  const helper = Object.assign(new EventEmitter(), {
    stdin: { write: (line: string) => helperWrites.push(JSON.parse(line)) },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: (signal: string) => kills.push(signal),
  });
  const stdin = new EventEmitter();
  const world: Record<string, any> = {
    Buffer,
    fs: {
      statSync: () => ({ mode: 0o600, uid: 501 }),
      readFileSync: () =>
        JSON.stringify({ extensionId: "a".repeat(32), socketPath: "/private/tmp/fixture.sock" }),
    },
    net: { connect: () => socket },
    path,
    os: { homedir: () => "/private/tmp/host-fixture" },
    fileURLToPath,
    spawn: () => helper,
    randomUUID: () => "host-instance",
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    process: {
      argv: ["node", "host", `chrome-extension://${"a".repeat(32)}/`],
      getuid: () => 501,
      stdin,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      on: () => {},
      exit: () => {},
    },
    setInterval: (callback: () => void) => {
      timers.push(callback);
      return { unref() {} };
    },
    clearInterval: () => {},
  };
  const directory = new URL("../../native/cbg-access/", import.meta.url);
  const authority = readFileSync(new URL("command-authority.mjs", directory), "utf8").replaceAll(
    "export class ",
    "class ",
  );
  const activity = readFileSync(new URL("activity-authority.mjs", directory), "utf8")
    .replaceAll("export class ", "class ")
    .replaceAll("export const ", "const ");
  const host = readFileSync(new URL("host.mjs", directory), "utf8")
    .replace(/^#!.*\n/, "")
    .replace(/^import .*?;\n/gm, "")
    .replaceAll("import.meta.url", JSON.stringify(new URL("host.mjs", directory).href));
  runInNewContext(
    authority + "\n" + activity + "\n" + host + "\nglobalThis.host={authority,activities};",
    world,
  );
  const send = (message: unknown) =>
    socket.emit("data", Buffer.from(JSON.stringify(message) + "\n"));
  const result = (message: unknown) =>
    helper.stdout.emit("data", Buffer.from(JSON.stringify(message) + "\n"));
  const chrome = (message: unknown) => {
    const body = Buffer.from(JSON.stringify(message)),
      header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    stdin.emit("data", Buffer.concat([header, body]));
  };
  result({ kind: "input-ready" });
  send({
    kind: "resume",
    actionId: "resume",
    context: { stopEpoch: 0, browserSessionEpoch: "session" },
  });
  result({ actionId: "resume", ok: true });
  chrome({ kind: "command-result", actionId: "resume", ok: true });
  const lease = (epoch = 1) => ({
    activityId: `workflow-${epoch}`,
    authorizationEpoch: epoch,
    stopEpoch: 0,
    browserSessionEpoch: "session",
    expiresAt: now + 15000,
    progressExpiresAt: now + 60000,
    progressSequence: 0,
  });
  const control = (command: string, activity: unknown) =>
    send({ kind: "activity", command, actionId: `activity-${helperWrites.length}`, activity });
  const grant = (activity: any) => {
    const command = helperWrites.at(-1);
    result({
      actionId: command.actionId,
      activityId: activity.activityId,
      ok: true,
      awake: command.command !== "activity-end",
    });
  };
  return {
    host: world.host,
    send,
    result,
    chrome,
    lease,
    control,
    grant,
    helperWrites,
    serverWrites,
    kills,
    socket,
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => timers.forEach((callback) => callback()),
  };
}
it("host observe is a validated read-only route while stopped; a forged observation proof never reaches the helper", () => {
  const f = fixture();
  f.send({ kind: "command", command: "stop", actionId: "stop" });
  const writes = f.helperWrites.length,
    generation = f.host.authority.generation;
  f.send({ kind: "command", command: "observe", actionId: "observe" });
  f.chrome({ kind: "command-proof", actionId: "observe", proof: { actionId: "observe" } });
  expect(f.helperWrites).toHaveLength(writes);
  expect(f.host.authority.stopped).toBe(true);
  expect(f.host.authority.generation).toBe(generation);
  expect(f.host.activities.current).toBeNull();
  f.chrome({ kind: "command-result", actionId: "observe", ok: true, posted: false });
  expect(f.serverWrites.at(-1)).toMatchObject({
    kind: "input-result",
    actionId: "observe",
    ok: true,
    posted: false,
  });
  f.send({ kind: "command", command: "observe", actionId: "bad action id" });
  expect(f.serverWrites.at(-1).error).toBe("invalid-observation-request");
  expect(f.helperWrites).toHaveLength(writes);
});
it("host waits for a successful helper assertion before forwarding any native input", () => {
  const f = fixture(),
    lease = f.lease();
  f.control("begin", lease);
  const plan = {
    actionId: "input",
    pageId: "page",
    pageGeneration: 1,
    stopEpoch: 0,
    browserSessionEpoch: "session",
    target: { kind: "query" },
    activity: lease,
  };
  f.send({ kind: "command", command: "execute", plan });
  expect(f.serverWrites.at(-1)).toMatchObject({
    ok: false,
    error: "native-workflow-activity-required",
  });
  f.grant(lease);
  f.send({ kind: "command", command: "execute", plan });
  f.chrome({
    kind: "command-proof",
    actionId: "input",
    proof: { actionId: "input", pageId: "page", pageGeneration: 1, semantic: plan.target },
  });
  expect(f.helperWrites.at(-1)).toMatchObject({ command: "execute", plan: { activity: lease } });
});
it("a helper assertion failure stops the host without dispatching input", () => {
  const f = fixture(),
    lease = f.lease();
  f.control("begin", lease);
  f.result({
    actionId: f.helperWrites.at(-1).actionId,
    activityId: lease.activityId,
    ok: false,
    awake: false,
    error: "IOPM-failed",
  });
  expect(f.host.activities.current).toBeNull();
  expect(f.host.authority.stopped).toBe(true);
  expect(f.helperWrites.some((command) => command.command === "execute")).toBe(false);
  expect(f.serverWrites.some((message) => message.error === "IOPM-failed")).toBe(true);
});
it("wait renewal keeps the lease live, and normal end releases the helper assertion", () => {
  const f = fixture(),
    lease = f.lease();
  f.control("begin", lease);
  f.grant(lease);
  f.advance(10000);
  f.control("renew", { ...lease, expiresAt: 125000 });
  f.grant(lease);
  f.advance(6000);
  f.tick();
  expect(f.host.authority.stopped).toBe(false);
  f.control("end", lease);
  f.grant(lease);
  expect(f.helperWrites.at(-1).command).toBe("activity-end");
  expect(f.host.activities.current).toBeNull();
});
it.each(["expiry", "disconnect", "stop"])(
  "host releases on %s independently of service progress",
  (scenario) => {
    const f = fixture(),
      lease = f.lease();
    f.control("begin", lease);
    f.grant(lease);
    if (scenario === "expiry") {
      f.advance(15000);
      f.tick();
    }
    if (scenario === "disconnect") f.socket.emit("close");
    if (scenario === "stop") f.send({ kind: "command", command: "stop" });
    expect(f.host.activities.current).toBeNull();
    expect(f.kills).toContain(scenario === "disconnect" ? "SIGTERM" : "SIGUSR1");
  },
);
it("a stale activity end cannot release the next workflow", () => {
  const f = fixture(),
    old = f.lease();
  f.control("begin", old);
  f.grant(old);
  f.control("end", old);
  f.grant(old);
  const next = f.lease(2);
  f.control("begin", next);
  f.grant(next);
  const count = f.helperWrites.length;
  f.control("end", old);
  expect(f.helperWrites).toHaveLength(count);
  expect(f.host.activities.accepts(next, f.host.authority)).toBe(true);
});
it("a delayed invalidation from an old activity cannot stop the next workflow", () => {
  const f = fixture(),
    old = f.lease();
  f.control("begin", old);
  f.grant(old);
  f.control("end", old);
  f.grant(old);
  const next = f.lease(2);
  f.control("begin", next);
  f.grant(next);
  f.result({
    kind: "activity-invalidated",
    ...old,
    hostInstanceEpoch: "host-instance",
    hostGeneration: 1,
    reason: "old-watchdog",
  });
  expect(f.host.activities.accepts(next, f.host.authority)).toBe(true);
  f.result({
    kind: "activity-invalidated",
    ...next,
    hostInstanceEpoch: "host-instance",
    hostGeneration: 1,
    reason: "current-watchdog",
  });
  expect(f.host.activities.current).toBeNull();
  expect(f.host.authority.stopped).toBe(true);
});
