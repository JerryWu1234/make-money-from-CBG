#!/usr/bin/env node
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CommandAuthority, ResumeAcknowledgement } from "./command-authority.mjs";
import { ActivityAuthority } from "./activity-authority.mjs";

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
const activities = new ActivityAuthority();
let lastCompletedActionId = null;
let helperReady = false,
  exiting = false;
const helperQueue = [],
  helperStartupExpiresAt = Date.now() + 6000;
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
const writeHelper = (message) => {
  if (exiting) return;
  if (!helperReady) {
    if (helperQueue.length >= 128) throw new Error("native-helper-startup-buffer-full");
    helperQueue.push(message);
    return;
  }
  helper.stdin.write(`${JSON.stringify(message)}\n`);
};
helper.stderr.on("data", (data) => process.stderr.write(data));
helper.on("error", () => {
  if (exiting) return;
  stopped = true;
  server({ kind: "host-status", stopped: true, reason: "native-helper-unavailable" });
  exit();
});
helper.on("exit", () => {
  if (exiting) return;
  stopped = true;
  server({ kind: "host-status", stopped: true, reason: "native-helper-exited" });
  exit();
});
const resumeAck = (actionId, record, source, result) => {
  const merged = record.barrier.accept(source, result, authority.generation);
  if (!merged) return;
  pending.delete(actionId);
  server({ kind: "input-result", actionId, posted: false, ...merged });
  if (!merged.ok) stop("native-resume-denied");
};
helper.stdout.on("data", (data) => {
  if (exiting) return;
  helperBuffer += data;
  let at;
  while ((at = helperBuffer.indexOf("\n")) >= 0) {
    const line = helperBuffer.slice(0, at);
    helperBuffer = helperBuffer.slice(at + 1);
    try {
      const result = JSON.parse(line);
      if (result.kind === "input-ready") {
        if (helperReady) continue;
        helperReady = true;
        for (const message of helperQueue.splice(0)) writeHelper(message);
        continue;
      }
      if (result.kind === "input-unavailable") {
        server({
          kind: "host-status",
          stopped: true,
          reason: result.error || "native-helper-unavailable",
        });
        exit();
        continue;
      }
      if (result.kind === "activity-invalidated") {
        if (
          result.hostInstanceEpoch === authority.instanceEpoch &&
          result.hostGeneration === authority.generation &&
          activities.same(result, authority)
        )
          stop(result.reason || "native-activity-invalidated", result.inputPreemption);
        continue;
      }
      const command = pending.get(result.actionId);
      if (
        command &&
        (command.generation === undefined || command.generation === authority.generation)
      ) {
        if (command.kind === "activity") {
          pending.delete(result.actionId);
          const ending = command.command === "end";
          if (
            !result.ok ||
            result.activityId !== command.activity.activityId ||
            result.active !== !ending
          ) {
            server({
              kind: "input-result",
              actionId: result.actionId,
              ok: false,
              posted: false,
              error: result.error || "native-activity-grant-failed",
            });
            stop("native-activity-denied");
          } else {
            if (!ending) activities.granted(command.activity, authority);
            server({ kind: "input-result", ...result });
          }
          continue;
        }
        if (command.kind === "resume") {
          resumeAck(result.actionId, command, "helper", result);
          continue;
        }
        pending.delete(result.actionId);
        authority.complete(result.actionId);
        if (
          result.ok &&
          result.posted &&
          command.plan?.activity?.activityId === activities.current?.lease.activityId
        )
          lastCompletedActionId = result.actionId;
        server({ kind: "input-result", ...result });
      }
    } catch {
      stop("invalid-native-helper-message");
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
const stop = (reason, inputPreemption) => {
  if (exiting) return;
  stopped = true;
  activities.stop();
  authority.stop();
  helperQueue.length = 0;
  invalidatePending("host-stop-invalidated");
  if (helperReady) helper.kill("SIGUSR1");
  writeHelper({
    command: "stop",
    hostGeneration: authority.generation,
    hostInstanceEpoch: authority.instanceEpoch,
  });
  native({ kind: "command", command: "stop", actionId: "local-stop" });
  server({
    kind: "host-status",
    stopped: true,
    reason,
    ...(inputPreemption ? { inputPreemption } : {}),
  });
};
socket.on("connect", () => server({ kind: "host-hello", version: 1 }));
socket.on("data", (data) => {
  if (exiting) return;
  serverBuffer += data;
  if (serverBuffer.length > 1024 * 1024) return stop("server-size");
  let at;
  while ((at = serverBuffer.indexOf("\n")) >= 0) {
    const line = serverBuffer.slice(0, at);
    serverBuffer = serverBuffer.slice(at + 1);
    try {
      const message = JSON.parse(line);
      if (message.kind === "ack") native(message);
      else if (message.kind === "activity") {
        try {
          if (!/^[a-zA-Z0-9_-]{1,100}$/.test(message.actionId || ""))
            throw new Error("activity-action-id");
          if (message.command === "begin") {
            activities.begin(message.activity, authority);
            lastCompletedActionId = null;
          } else if (message.command === "renew")
            activities.renew(message.activity, authority, lastCompletedActionId);
          else if (message.command === "end") activities.end(message.activity, authority);
          else throw new Error("unsupported-activity-command");
          pending.set(message.actionId, { ...message, generation: authority.generation });
          writeHelper({
            command: `activity-${message.command}`,
            actionId: message.actionId,
            activity: message.activity,
            hostGeneration: authority.generation,
            hostInstanceEpoch: authority.instanceEpoch,
          });
        } catch (error) {
          server({
            kind: "input-result",
            actionId: message.actionId,
            ok: false,
            posted: false,
            error: error.message || "invalid-native-activity",
          });
        }
      } else if (message.kind === "command") {
        if (message.command === "stop") {
          stop("server-stop");
          continue;
        }
        if (message.command === "status") {
          pending.set(message.actionId, message);
          writeHelper({ command: "status", actionId: message.actionId });
          continue;
        }
        if (["observe", "focus"].includes(message.command)) {
          if (
            !/^[a-zA-Z0-9_-]{1,100}$/.test(message.actionId) ||
            pending.has(message.actionId) ||
            pending.size >= 128
          )
            server({
              kind: "input-result",
              actionId: message.actionId,
              ok: false,
              posted: false,
              error: "invalid-observation-request",
            });
          else {
            pending.set(message.actionId, { kind: "observe" });
            native(message);
          }
          continue; // Read-only extension observation never reaches the input helper or authority.
        }
        if (
          !message.plan ||
          !authority.accepts(message.plan) ||
          !/^[a-zA-Z0-9_-]{1,100}$/.test(message.plan.actionId) ||
          [...pending.values()].some((command) => command.kind !== "activity") ||
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
        if (
          message.command === "execute" &&
          !activities.accepts(message.plan.activity, authority)
        ) {
          server({
            kind: "input-result",
            actionId: message.plan.actionId,
            ok: false,
            posted: false,
            error: "native-workflow-activity-required",
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
        helperQueue.length = 0;
        activities.stop();
        authority.resume(message.context);
        stopped = false;
        if (message.actionId) {
          pending.set(message.actionId, {
            ...message,
            generation: authority.generation,
            barrier: new ResumeAcknowledgement(authority.generation),
          });
          writeHelper(authority.helperResume(message.context, message.actionId));
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
  if (exiting) return;
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
        else if (pending.delete(message.actionId))
          server(
            record?.kind === "observe" && message.posted !== false
              ? {
                  kind: "input-result",
                  actionId: message.actionId,
                  ok: false,
                  posted: false,
                  error: "read-only-command-cannot-post",
                }
              : { ...message, kind: "input-result" },
          );
      } else if (message.kind === "command-proof") {
        const command = pending.get(message.actionId);
        if (
          !command ||
          command.kind === "observe" ||
          stopped ||
          command.generation !== authority.generation
        )
          continue;
        if (!activities.accepts(command.plan.activity, authority)) {
          stop("native-activity-expired-before-dispatch");
          continue;
        }
        const dispatched = authority.dispatch(message.actionId, message.proof);
        if (!dispatched) continue;
        writeHelper(dispatched);
      }
    } catch {
      stop("invalid-native-message");
    }
  }
});
const exit = () => {
  if (exiting) return;
  exiting = true;
  stopped = true;
  helperReady = false;
  helperQueue.length = 0;
  pending.clear();
  activities.stop();
  authority.stop();
  clearInterval(activityWatchdog);
  process.stdin.pause?.();
  process.stdin.destroy?.();
  helper.kill("SIGTERM");
  socket.destroy();
};
const activityWatchdog = setInterval(() => {
  try {
    if (!helperReady && Date.now() >= helperStartupExpiresAt) {
      stop("native-helper-startup-timeout");
      exit();
      return;
    }
    if (activities.current && activities.expired()) stop("native-workflow-activity-expired");
  } catch {
    stop("native-activity-clock-anomaly");
  }
}, 100);
activityWatchdog.unref();
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
