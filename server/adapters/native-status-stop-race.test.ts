import { randomUUID } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ExtensionNativeRuntime } from "./extension-native";

const fixtures: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
});

async function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-status-"));
  const db = new DatabaseSync(":memory:");
  const runtime = new ExtensionNativeRuntime({
    db,
    socketPath: path.join(directory, "bridge.sock"),
    stopEpoch: () => 0,
    onRisk: () => {},
    runAction: async (_plan, dispatch) => dispatch(),
  });
  try {
    await runtime.start();
  } catch (error) {
    db.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  // This is an actual Unix transport peer, not a replacement of Runtime's socket/receive.
  // It only returns protocol records; no helper or OS input runs in these tests.
  const peer = net.connect(path.join(directory, "bridge.sock"));
  const writes: Record<string, any>[] = [];
  const events = new EventEmitter();
  const operations: Promise<unknown>[] = [];
  let buffer = "";
  peer.setEncoding("utf8");
  peer.on("data", (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      writes.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
      events.emit("write");
    }
  });
  await once(peer, "connect");
  const track = <T>(operation: Promise<T>) => {
    operations.push(operation);
    void operation.catch(() => {});
    return operation;
  };
  const next = async (actionId: string) => {
    for (;;) {
      const write = writes.find((message) => message.actionId === actionId);
      if (write) return write;
      await once(events, "write");
    }
  };
  const send = (message: Record<string, unknown>) => peer.write(JSON.stringify(message) + "\n");
  const request = (message: Record<string, unknown>, timeoutMs?: number) =>
    track(
      (
        runtime as unknown as {
          request(
            value: Record<string, unknown>,
            timeout?: number,
          ): Promise<Record<string, unknown>>;
        }
      ).request(message, timeoutMs),
    );
  const f = {
    runtime,
    peer,
    writes,
    next,
    send,
    request,
    status: () => track(runtime.nativeStatus()),
    close: async () => {
      await runtime.close();
      peer.destroy();
      await Promise.allSettled(operations);
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
  fixtures.push(f);
  return f;
}

it("keeps only a post-cancellation status pending for its actual same-action reply", async () => {
  const f = await fixture();
  const original = f.status();
  await vi.waitFor(() => expect(f.writes).toHaveLength(1));
  await f.runtime.stop("cancelled workflow");
  await expect(original).rejects.toThrow("cancelled workflow");
  const status = f.status();
  let settled = false;
  void status.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await vi.waitFor(() =>
    expect(f.writes.filter((message) => message.command === "status")).toHaveLength(2),
  );
  const actionId = f.writes.filter((message) => message.command === "status").at(-1)!.actionId;
  f.send({ kind: "host-status", stopped: true, reason: "server-stop" });
  f.send({ kind: "input-result", actionId: "unrelated-status", ok: true });
  await vi.waitFor(() => expect(f.runtime.status().reason).toBe("server-stop"));
  expect(settled).toBe(false);
  const actual = {
    kind: "input-result",
    actionId,
    ok: true,
    activity: { active: false, expired: false, lease: {} },
    permissions: { accessibility: true },
  };
  f.send(actual);
  expect(await status).toEqual(actual);
  expect(f.runtime.status().stopped).toBe(true);
  expect(f.writes.filter((message) => message.command === "status")).toHaveLength(2);
  expect(
    f.writes.some((message) => message.command === "execute" || message.kind === "activity"),
  ).toBe(false);
});

it.each([
  { kind: "activity", command: "begin" },
  { kind: "activity", command: "renew" },
  { kind: "activity", command: "end" },
  { kind: "resume" },
  { kind: "command", command: "execute" },
  { kind: "command", command: "locate" },
  { kind: "activity", command: "status" },
])("still rejects pending $kind/$command on server-stop", async (message) => {
  const f = await fixture();
  const actionId = randomUUID();
  const operation = f.request({ ...message, actionId });
  await f.next(actionId);
  f.send({ kind: "host-status", stopped: true, reason: "server-stop" });
  await expect(operation).rejects.toThrow("server-stop");
});

it.each(["input-stopped-or-user-preempted", "activity-expired", "native-host-disconnected"])(
  "still rejects a read-only status on %s",
  async (reason) => {
    const f = await fixture();
    const actionId = randomUUID();
    const operation = f.request({ kind: "command", command: "status", actionId });
    await f.next(actionId);
    f.send({ kind: "host-status", stopped: true, reason });
    await expect(operation).rejects.toThrow(reason);
  },
);

it("retains the status timeout after a server-stop notification", async () => {
  const f = await fixture();
  const actionId = randomUUID();
  const operation = f.request({ kind: "command", command: "status", actionId }, 100);
  await f.next(actionId);
  f.send({ kind: "host-status", stopped: true, reason: "server-stop" });
  await expect(operation).rejects.toThrow("原生输入回执未知，禁止自动重放");
});

it("still rejects the preserved status when its actual socket disconnects", async () => {
  const f = await fixture();
  const actionId = randomUUID();
  const operation = f.request({ kind: "command", command: "status", actionId });
  await f.next(actionId);
  f.send({ kind: "host-status", stopped: true, reason: "server-stop" });
  await vi.waitFor(() => expect(f.runtime.status().reason).toBe("server-stop"));
  f.peer.destroy();
  await expect(operation).rejects.toThrow("宿主连接中断");
});

it("a later explicit stop still rejects the preserved read-only status", async () => {
  const f = await fixture();
  const actionId = randomUUID();
  const operation = f.request({ kind: "command", command: "status", actionId });
  await f.next(actionId);
  f.send({ kind: "host-status", stopped: true, reason: "server-stop" });
  await vi.waitFor(() => expect(f.runtime.status().reason).toBe("server-stop"));
  await f.runtime.stop("second explicit stop");
  await expect(operation).rejects.toThrow("second explicit stop");
});
