import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { expect, it } from "vite-plus/test";
function fixture() {
  let now = 100000;
  const serverWrites: any[] = [],
    nativeWrites: any[] = [],
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
      stdout: {
        write: (frame: Buffer) => nativeWrites.push(JSON.parse(frame.subarray(4).toString("utf8"))),
      },
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
      active: command.command !== "activity-end",
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
    nativeWrites,
    serverWrites,
    kills,
    socket,
    advance: (ms: number) => {
      now += ms;
    },
    tick: () => timers.forEach((callback) => callback()),
  };
}
it.each(["observe", "focus"])(
  "host %s is a validated read-only route while stopped; a forged proof never reaches the helper",
  (command) => {
    const f = fixture();
    f.send({ kind: "command", command: "stop", actionId: "stop" });
    const writes = f.helperWrites.length,
      generation = f.host.authority.generation;
    const context = {
      pageId: "page",
      pageGeneration: 1,
      tabId: 1,
      windowId: 2,
      bindingEpoch: "binding",
      connectionEpoch: "connection",
      url: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=role",
    };
    f.send({ kind: "command", command, actionId: command, context });
    expect(f.nativeWrites.at(-1)).toEqual({ kind: "command", command, actionId: command, context });
    f.chrome({ kind: "command-proof", actionId: command, proof: { actionId: command } });
    expect(f.helperWrites).toHaveLength(writes);
    expect(f.host.authority.stopped).toBe(true);
    expect(f.host.authority.generation).toBe(generation);
    expect(f.host.activities.current).toBeNull();
    f.chrome({ kind: "command-result", actionId: command, ok: true, posted: false });
    expect(f.serverWrites.at(-1)).toMatchObject({
      kind: "input-result",
      actionId: command,
      ok: true,
      posted: false,
    });
    f.send({ kind: "command", command, actionId: "bad action id" });
    expect(f.serverWrites.at(-1).error).toBe("invalid-observation-request");
    expect(f.helperWrites).toHaveLength(writes);
  },
);
it.each([true, undefined])(
  "focus result cannot claim input or omit its read-only receipt: posted=%s",
  (posted) => {
    const f = fixture(),
      before = f.helperWrites.length,
      generation = f.host.authority.generation;
    f.send({ kind: "command", command: "focus", actionId: "focus" });
    f.chrome({
      kind: "command-result",
      actionId: "focus",
      ok: true,
      ...(posted === undefined ? {} : { posted }),
    });
    expect(f.serverWrites.at(-1)).toMatchObject({
      kind: "input-result",
      actionId: "focus",
      ok: false,
      posted: false,
      error: "read-only-command-cannot-post",
    });
    expect(f.helperWrites).toHaveLength(before);
    expect(f.host.authority.generation).toBe(generation);
    expect(f.host.activities.current).toBeNull();
  },
);
it("host waits for a successful helper activity grant before forwarding any native input", () => {
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
it("a helper activity grant failure stops the host without dispatching input", () => {
  const f = fixture(),
    lease = f.lease();
  f.control("begin", lease);
  f.result({
    actionId: f.helperWrites.at(-1).actionId,
    activityId: lease.activityId,
    ok: false,
    active: false,
    error: "activity-grant-failed",
  });
  expect(f.host.activities.current).toBeNull();
  expect(f.host.authority.stopped).toBe(true);
  expect(f.helperWrites.some((command) => command.command === "execute")).toBe(false);
  expect(f.serverWrites.some((message) => message.error === "activity-grant-failed")).toBe(true);
});
it("a legacy awake-only helper ACK cannot authorize input", () => {
  const f = fixture(),
    lease = f.lease();
  f.control("begin", lease);
  f.result({
    actionId: f.helperWrites.at(-1).actionId,
    activityId: lease.activityId,
    ok: true,
    awake: true,
  });
  expect(f.host.activities.current).toBeNull();
  expect(f.host.authority.stopped).toBe(true);
  expect(f.serverWrites.some((message) => message.error === "native-activity-grant-failed")).toBe(
    true,
  );
  expect(f.helperWrites.some((message) => message.command === "execute")).toBe(false);
});
it("wait renewal keeps the lease live, and normal end revokes helper input authorization", () => {
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
