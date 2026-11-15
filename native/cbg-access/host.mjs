#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CommandAuthority, ResumeAcknowledgement } from "./command-authority.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(os.homedir(), "Library/Application Support/CBGAccess/host.json");
const stat = fs.statSync(configPath);
if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())
  throw new Error("Native host configuration must be owned by the current user, mode 0600");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
if (process.argv[2] !== `chrome-extension://${config.extensionId}/`)
  throw new Error("Unapproved extension");
const socket = net.connect(config.socketPath);
const authority = new CommandAuthority(randomUUID());
let helperReady = false;
let nativeBuffer = Buffer.alloc(0),
  serverBuffer = "",
  stopped = false,
  helperBuffer = "",
  pending = new Map();
const native = (value) => {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > 512 * 1024) return;
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
};
const server = (value) => socket.write(`${JSON.stringify(value)}\n`);
const helper = spawn(path.join(directory, "cbg-input"), [], { stdio: ["pipe", "pipe", "pipe"] });
helper.stderr.on("data", (data) => process.stderr.write(data));
helper.on("error", () => {
  stopped = true;
  server({ kind: "host-status", stopped: true, reason: "native-helper-unavailable" });
});
helper.on("exit", () => {
  stopped = true;
  server({ kind: "host-status", stopped: true, reason: "native-helper-exited" });
});
const resumeAck = (actionId, record, source, result) => {
  const merged = record.barrier.accept(source, result, authority.generation);
  if (!merged) return;
  pending.delete(actionId);
  server({ kind: "input-result", actionId, posted: false, ...merged });
  if (!merged.ok) stop("native-resume-denied");
};
helper.stdout.on("data", (data) => {
  helperBuffer += data;
  let at;
  while ((at = helperBuffer.indexOf("\n")) >= 0) {
    const line = helperBuffer.slice(0, at);
    helperBuffer = helperBuffer.slice(at + 1);
    try {
      const result = JSON.parse(line);
      if (result.kind === "input-ready") {
        helperReady = true;
        continue;
      }
      const command = pending.get(result.actionId);
      if (
        command &&
        (command.generation === undefined || command.generation === authority.generation)
      ) {
        if (command.kind === "resume") {
          resumeAck(result.actionId, command, "helper", result);
          continue;
        }
        pending.delete(result.actionId);
        authority.complete(result.actionId);
        server({ kind: "input-result", ...result });
      }
    } catch {
      stopped = true;
    }
  }
});
const invalidatePending = (reason) => {
  for (const [id, command] of pending)
    server({
      kind: "input-result",
      actionId: id,
      ok: false,
      posted: command.dispatched === true,
      error: reason,
    });
  pending.clear();
};
const stop = (reason) => {
  stopped = true;
  authority.stop();
  invalidatePending("host-stop-invalidated");
  if (helperReady) helper.kill("SIGUSR1");
  helper.stdin.write(
    `${JSON.stringify({ command: "stop", hostGeneration: authority.generation, hostInstanceEpoch: authority.instanceEpoch })}\n`,
  );
  native({ kind: "command", command: "stop", actionId: "local-stop" });
  server({ kind: "host-status", stopped: true, reason });
};
socket.on("connect", () => server({ kind: "host-hello", version: 1 }));
socket.on("data", (data) => {
  serverBuffer += data;
  if (serverBuffer.length > 1024 * 1024) return stop("server-size");
  let at;
  while ((at = serverBuffer.indexOf("\n")) >= 0) {
    const line = serverBuffer.slice(0, at);
    serverBuffer = serverBuffer.slice(at + 1);
    try {
      const message = JSON.parse(line);
      if (message.kind === "ack") native(message);
      else if (message.kind === "command") {
        if (message.command === "stop") {
          stop("server-stop");
          continue;
        }
        if (message.command === "status") {
          helper.stdin.write(
            `${JSON.stringify({ command: "status", actionId: message.actionId })}\n`,
          );
          pending.set(message.actionId, message);
          continue;
        }
        if (
          !message.plan ||
          !authority.accepts(message.plan) ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(message.plan.actionId) ||
          pending.size ||
          stopped
        ) {
          server({
            kind: "input-result",
            actionId: message.plan?.actionId,
            ok: false,
            posted: false,
            error: "host-stopped-or-busy",
          });
          continue;
        }
        const record =
          message.command === "execute"
            ? authority.reserve(message.plan)
            : { ...message, generation: authority.generation, dispatched: false };
        pending.set(message.plan.actionId, record);
        native(message);
      } else if (message.kind === "resume") {
        if (!message.context) continue;
        invalidatePending("host-resume-invalidated");
        authority.resume(message.context);
        stopped = false;
        if (message.actionId) {
          pending.set(message.actionId, {
            ...message,
            generation: authority.generation,
            barrier: new ResumeAcknowledgement(authority.generation),
          });
          helper.stdin.write(
            `${JSON.stringify(authority.helperResume(message.context, message.actionId))}\n`,
          );
          native({
            kind: "command",
            command: "resume",
            actionId: message.actionId,
            context: message.context,
          });
        }
      }
    } catch {
      stop("invalid-server-message");
    }
  }
});
process.stdin.on("data", (data) => {
  nativeBuffer = Buffer.concat([nativeBuffer, data]);
  while (nativeBuffer.length >= 4) {
    const length = nativeBuffer.readUInt32LE(0);
    if (length > 512 * 1024) {
      stop("native-size");
      process.exitCode = 1;
      return process.stdin.destroy();
    }
    if (nativeBuffer.length < length + 4) break;
    const raw = nativeBuffer.subarray(4, length + 4);
    nativeBuffer = nativeBuffer.subarray(length + 4);
    try {
      const message = JSON.parse(raw.toString("utf8"));
      if (message.version === 1 && ["snapshot", "status"].includes(message.kind)) server(message);
      else if (message.kind === "command-result") {
        const record = pending.get(message.actionId);
        if (record?.kind === "resume") resumeAck(message.actionId, record, "extension", message);
        else if (pending.delete(message.actionId)) server({ ...message, kind: "input-result" });
      } else if (message.kind === "command-proof") {
        const command = pending.get(message.actionId);
        if (!command || stopped || command.generation !== authority.generation) continue;
        const dispatched = authority.dispatch(message.actionId, message.proof);
        if (!dispatched) continue;
        helper.stdin.write(`${JSON.stringify(dispatched)}\n`);
      }
    } catch {
      stop("invalid-native-message");
    }
  }
});
const exit = () => {
  stopped = true;
  helper.kill("SIGTERM");
  socket.destroy();
};
socket.on("error", () => {
  native({ kind: "command", command: "stop", actionId: "disconnect" });
  exit();
});
socket.on("close", exit);
process.stdin.on("end", exit);
process.on("SIGTERM", () => {
  exit();
  process.exit(0);
});
