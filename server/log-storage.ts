import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { diagnostics } from "./diagnostics";

const execute = promisify(execFile);
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const runName = new RegExp(`^run-.+-(${uuid})\\.jsonl$`, "i");
const runDirectory = new RegExp(`^${uuid}$`, "i");
const writerName = new RegExp(`^(${uuid})\\.json$`, "i");
const previewLifetime = 10 * 60 * 1000;

interface Entry {
  name: string;
  directory: boolean;
  device: number;
  inode: number;
  bytes: number;
  modified: number;
  changed: number;
}
interface Run {
  id: string;
  entries: Entry[];
}
interface Context {
  directory: string;
  runId: string;
}
interface Options {
  context?: () => Context;
  openFiles?: (directory: string) => Promise<string[]>;
}
export interface LogStoragePreview {
  token: string;
  runs: number;
  files: number;
  bytes: number;
  protectedRuns: string[];
}
export interface LogStorageClearResult {
  removedRuns: number;
  removedFiles: number;
  freedBytes: number;
  skippedRuns: string[];
  errors: { runId: string; message: string }[];
}
export class LogStorageTokenError extends Error {
  constructor() {
    super("清理预览已失效，请重新预览");
    this.name = "LogStorageTokenError";
  }
}
function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
async function stat(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
}

// Validate every ancestor, including browser-steps and the logs root itself.
async function safeDirectory(directory: string) {
  const parent = path.dirname(directory);
  if (parent !== directory && !(await safeDirectory(parent))) return false;
  const info = await stat(directory);
  if (!info) return false;
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("运行日志路径包含符号链接或非目录，已拒绝清理");
  return true;
}
function filePath(directory: string, name: string) {
  const file = path.resolve(directory, name);
  if (!file.startsWith(directory + path.sep)) throw new Error("运行日志路径越界，已拒绝清理");
  return file;
}
async function openFiles(directory: string): Promise<string[]> {
  const names = (output: string) =>
    output
      .split("\n")
      .filter((line) => line.startsWith("n"))
      .map((line) => line.slice(1));
  try {
    const result = await execute("lsof", ["-nP", "-F", "n", "+D", directory], {
      timeout: 15000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (result.stderr.trim()) throw new Error("无法完整核对日志文件的活动写入进程");
    return names(result.stdout);
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string };
    // macOS lsof can exit 1 both for no matches and with selected descriptors.
    // Preserve every reported descriptor; warnings/errors still block cleanup.
    if (failure.code === 1 && !failure.stderr?.trim()) return names(failure.stdout ?? "");
    throw new Error("无法核对日志文件的活动写入进程，已拒绝清理", { cause: error });
  }
}
function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export class LogStorage {
  private previewed?: { token: string; expires: number; directory: string; runs: Run[] };
  private clearing = false;

  constructor(private readonly options: Options = {}) {}

  private context() {
    // Do not touch diagnostics at module initialization; API tests replace its logger.
    const context = this.options.context?.() ?? diagnostics.storageContext();
    return { directory: path.resolve(context.directory), runId: context.runId.toLowerCase() };
  }

  private async protectedRuns(context: Context, inspectDescriptors = true) {
    const protectedRuns = new Set([context.runId]);
    const writers = filePath(context.directory, ".writers");
    if (await safeDirectory(writers)) {
      for (const name of await readdir(writers)) {
        const match = writerName.exec(name);
        if (!match) continue;
        const id = match[1].toLowerCase();
        const file = filePath(writers, name);
        const info = await stat(file);
        if (!info) continue;
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) {
          protectedRuns.add(id);
          continue;
        }
        try {
          const writer = JSON.parse(await readFile(file, "utf8"));
          if (
            writer.runId?.toLowerCase() !== id ||
            !Number.isSafeInteger(writer.pid) ||
            writer.pid < 1 ||
            processAlive(writer.pid)
          )
            protectedRuns.add(id);
        } catch {
          protectedRuns.add(id);
        }
      }
    }
    const browser = filePath(context.directory, "browser-steps");
    const descriptors = inspectDescriptors
      ? await (this.options.openFiles ?? openFiles)(context.directory)
      : [];
    for (const file of descriptors) {
      if (path.dirname(file) === context.directory) {
        const match = runName.exec(path.basename(file));
        if (match) protectedRuns.add(match[1].toLowerCase());
      } else if (file.startsWith(browser + path.sep)) {
        const id = file.slice(browser.length + 1).split(path.sep)[0];
        if (runDirectory.test(id)) protectedRuns.add(id.toLowerCase());
      }
    }
    return protectedRuns;
  }

  private async collect(directory: string, name: string, entries: Entry[]) {
    const file = filePath(directory, name);
    const info = await stat(file);
    if (!info || info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new Error("日志文件消失、含符号链接或特殊文件，已跳过本次运行");
    entries.push({
      name,
      directory: info.isDirectory(),
      device: info.dev,
      inode: info.ino,
      bytes: info.isFile() ? info.size : 0,
      modified: info.mtimeMs,
      changed: info.ctimeMs,
    });
    if (info.isDirectory())
      for (const child of (await readdir(file)).sort())
        await this.collect(directory, path.join(name, child), entries);
  }

  private async scan(context: Context) {
    if (!(await safeDirectory(context.directory)))
      return { runs: [] as Run[], protectedRuns: new Set([context.runId]) };
    const protectedRuns = await this.protectedRuns(context);
    const names = new Map<string, string[]>();
    const add = (id: string, name: string) => {
      id = id.toLowerCase();
      names.set(id, [...(names.get(id) ?? []), name]);
    };
    for (const name of (await readdir(context.directory)).sort()) {
      const match = runName.exec(name);
      if (match) add(match[1], name);
    }
    const browser = filePath(context.directory, "browser-steps");
    if (await safeDirectory(browser))
      for (const name of (await readdir(browser)).sort())
        if (runDirectory.test(name)) add(name, path.join("browser-steps", name));
    const runs: Run[] = [];
    for (const [id, roots] of names) {
      if (protectedRuns.has(id)) continue;
      try {
        const entries: Entry[] = [];
        for (const root of roots) {
          const info = await stat(filePath(context.directory, root));
          if (!info || (root.endsWith(".jsonl") ? !info.isFile() : !info.isDirectory()))
            throw new Error("运行日志类型不符合约定");
          await this.collect(context.directory, root, entries);
        }
        runs.push({ id, entries });
      } catch {
        protectedRuns.add(id);
      }
    }
    return { runs, protectedRuns };
  }

  async preview(): Promise<LogStoragePreview> {
    const context = this.context();
    const snapshot = await this.scan(context);
    const token = randomUUID();
    this.previewed = {
      token,
      expires: Date.now() + previewLifetime,
      directory: context.directory,
      runs: snapshot.runs,
    };
    const files = snapshot.runs.flatMap((run) => run.entries.filter((entry) => !entry.directory));
    return {
      token,
      runs: snapshot.runs.length,
      files: files.length,
      bytes: files.reduce((total, file) => total + file.bytes, 0),
      protectedRuns: [...snapshot.protectedRuns].sort(),
    };
  }

  async clear(token: unknown): Promise<LogStorageClearResult> {
    const preview = this.previewed;
    if (
      typeof token !== "string" ||
      !preview ||
      token !== preview.token ||
      Date.now() > preview.expires ||
      this.clearing
    )
      throw new LogStorageTokenError();
    this.previewed = undefined;
    this.clearing = true;
    const result: LogStorageClearResult = {
      removedRuns: 0,
      removedFiles: 0,
      freedBytes: 0,
      skippedRuns: [],
      errors: [],
    };
    try {
      const context = this.context();
      if (context.directory !== preview.directory) throw new LogStorageTokenError();
      const snapshot = await this.scan(context);
      const current = new Map(snapshot.runs.map((run) => [run.id, run]));
      for (const run of preview.runs) {
        const checked = current.get(run.id);
        if (!checked || JSON.stringify(run.entries) !== JSON.stringify(checked.entries)) {
          result.skippedRuns.push(run.id);
          continue;
        }
        try {
          // Recheck writer ownership directly before removing this run. New runs are never admitted.
          if ((await this.protectedRuns(context, false)).has(run.id)) {
            result.skippedRuns.push(run.id);
            continue;
          }
          await safeDirectory(context.directory);
          for (const entry of [...run.entries].reverse()) {
            const file = filePath(context.directory, entry.name);
            if (!(await safeDirectory(path.dirname(file)))) throw new Error("日志目录已改变");
            const info = await stat(file);
            if (
              !info ||
              info.isSymbolicLink() ||
              info.dev !== entry.device ||
              info.ino !== entry.inode ||
              info.isDirectory() !== entry.directory
            )
              throw new Error("日志文件已改变，已停止清理本次运行");
            if (entry.directory) await rmdir(file);
            else {
              if (
                !info.isFile() ||
                info.size !== entry.bytes ||
                info.mtimeMs !== entry.modified ||
                info.ctimeMs !== entry.changed
              )
                throw new Error("日志内容已改变，已停止清理本次运行");
              await unlink(file);
              result.removedFiles++;
              result.freedBytes += entry.bytes;
            }
          }
          result.removedRuns++;
        } catch (error) {
          result.skippedRuns.push(run.id);
          result.errors.push({
            runId: run.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return result;
    } finally {
      this.clearing = false;
    }
  }
}

export const logStorage = new LogStorage();
