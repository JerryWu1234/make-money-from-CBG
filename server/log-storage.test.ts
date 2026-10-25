import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
  appendFile,
  readdir,
} from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { DiagnosticLog } from "./diagnostics";
import { LogStorage, LogStorageTokenError } from "./log-storage";

const CURRENT = "00000000-0000-0000-0000-000000000001";
const OLD = "00000000-0000-0000-0000-000000000002";
const OTHER = "00000000-0000-0000-0000-000000000003";
const NEW = "00000000-0000-0000-0000-000000000004";
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function setup(inspect?: (directory: string) => Promise<string[]>) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "cbg-log-storage-")));
  directories.push(directory);
  const storage = new LogStorage({
    context: () => ({ directory, runId: CURRENT }),
    openFiles: inspect ?? (async () => []),
  });
  return { directory, storage };
}
function logName(id: string) {
  return `run-2026-10-24T00-00-00-000Z-${id}.jsonl`;
}
async function log(directory: string, id = OLD, text = "log") {
  const file = path.join(directory, logName(id));
  await writeFile(file, text);
  return file;
}
async function evidence(directory: string, id = OLD) {
  const folder = path.join(directory, "browser-steps", id);
  await mkdir(path.join(folder, "nested"), { recursive: true });
  await writeFile(path.join(folder, "step.png"), "image");
  await writeFile(path.join(folder, "nested", "step.json"), "{}");
  return folder;
}
async function writer(directory: string, id: string, pid: number) {
  const folder = path.join(directory, ".writers");
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, id + ".json"), JSON.stringify({ runId: id, pid }));
}

it("预览只计入历史运行日志和完整截图目录，不删除文件或触碰业务数据", async () => {
  const { directory, storage } = await setup();
  const old = await log(directory);
  await evidence(directory);
  await log(directory, CURRENT);
  await evidence(directory, CURRENT);
  await writeFile(path.join(directory, "cbg.sqlite"), "business");
  await writeFile(path.join(directory, "run-unknown.jsonl"), "unknown");
  await mkdir(path.join(directory, "backups"));
  const preview = await storage.preview();
  expect(preview).toMatchObject({ runs: 1, files: 3, bytes: 10, protectedRuns: [CURRENT] });
  expect(preview.token).toBeTruthy();
  expect(await readFile(old, "utf8")).toBe("log");
  expect(await readFile(path.join(directory, "cbg.sqlite"), "utf8")).toBe("business");
});

it("确认只清预览集合，保留后来出现的运行和所有非日志文件，token不能重用", async () => {
  const { directory, storage } = await setup();
  await log(directory);
  await evidence(directory);
  await writer(directory, OLD, 2147483647); // A dead writer leaves a historical marker.
  const preview = await storage.preview();
  const added = await log(directory, NEW);
  await evidence(directory, NEW);
  await writeFile(path.join(directory, "business.json"), "keep");
  expect(await storage.clear(preview.token)).toEqual({
    removedRuns: 1,
    removedFiles: 3,
    freedBytes: 10,
    skippedRuns: [],
    errors: [],
  });
  expect(await readdir(directory)).toContain("business.json");
  expect(await readFile(added, "utf8")).toBe("log");
  expect(await readdir(path.join(directory, "browser-steps"))).toEqual([NEW]);
  expect(await readFile(path.join(directory, ".writers", OLD + ".json"), "utf8")).toContain(OLD);
  await expect(storage.clear(preview.token)).rejects.toBeInstanceOf(LogStorageTokenError);
});

it("保护当前服务、其他存活PID和仍有开放文件的运行", async () => {
  const { directory, storage } = await setup(async (root) => [
    path.join(root, "browser-steps", NEW, "step.png"),
  ]);
  for (const id of [CURRENT, OLD, OTHER, NEW]) {
    await log(directory, id);
    await evidence(directory, id);
  }
  await writer(directory, OTHER, process.pid);
  const preview = await storage.preview();
  expect(preview).toMatchObject({ runs: 1, files: 3, protectedRuns: [CURRENT, OTHER, NEW] });
  expect(await storage.clear(preview.token)).toMatchObject({ removedRuns: 1, removedFiles: 3 });
  for (const id of [CURRENT, OTHER, NEW])
    expect(await readFile(path.join(directory, logName(id)), "utf8")).toBe("log");
});

it("预览后被继续写入或新增截图的历史运行整组跳过", async () => {
  const { directory, storage } = await setup();
  const file = await log(directory);
  const folder = await evidence(directory);
  await log(directory, OTHER);
  const preview = await storage.preview();
  await appendFile(file, "more");
  await writeFile(path.join(folder, "new.png"), "new");
  expect(await storage.clear(preview.token)).toEqual({
    removedRuns: 1,
    removedFiles: 1,
    freedBytes: 3,
    skippedRuns: [OLD],
    errors: [],
  });
  expect(await readFile(file, "utf8")).toBe("logmore");
  expect(await readFile(path.join(folder, "step.png"), "utf8")).toBe("image");
});

it("在清理最后核对前刚注册写入的其他服务也受到保护", async () => {
  let checks = 0;
  const { directory, storage } = await setup(async (root) => {
    if (++checks === 2) await writer(root, OLD, process.pid);
    return [];
  });
  const file = await log(directory);
  const preview = await storage.preview();
  expect(await storage.clear(preview.token)).toEqual({
    removedRuns: 0,
    removedFiles: 0,
    freedBytes: 0,
    skippedRuns: [OLD],
    errors: [],
  });
  expect(await readFile(file, "utf8")).toBe("log");
});

it("带符号链接的运行整组跳过，不跟随截图目录内的越界路径", async () => {
  const { directory, storage } = await setup();
  const outside = await setup();
  const target = await log(outside.directory);
  await log(directory);
  const folder = await evidence(directory);
  await symlink(outside.directory, path.join(folder, "outside"));
  await symlink(target, path.join(directory, logName(OTHER)));
  const preview = await storage.preview();
  expect(preview).toMatchObject({
    runs: 0,
    files: 0,
    bytes: 0,
    protectedRuns: [CURRENT, OLD, OTHER],
  });
  expect(await storage.clear(preview.token)).toMatchObject({ removedRuns: 0, removedFiles: 0 });
  expect(await readFile(target, "utf8")).toBe("log");
  expect(await readFile(path.join(folder, "step.png"), "utf8")).toBe("image");
});

it("拒绝logs或browser-steps祖先中的符号链接", async () => {
  const { directory } = await setup();
  const outside = await setup();
  await log(outside.directory);
  const alias = path.join(directory, "alias");
  await symlink(outside.directory, alias);
  const aliased = new LogStorage({
    context: () => ({ directory: path.join(alias, "nested"), runId: CURRENT }),
    openFiles: async () => [],
  });
  await expect(aliased.preview()).rejects.toThrow("符号链接");
  await symlink(outside.directory, path.join(directory, "browser-steps"));
  const storage = new LogStorage({
    context: () => ({ directory, runId: CURRENT }),
    openFiles: async () => [],
  });
  await expect(storage.preview()).rejects.toThrow("符号链接");
  expect(await readFile(path.join(outside.directory, logName(OLD)), "utf8")).toBe("log");
});

it("预览后根目录被换成符号链接时拒绝执行，不删除外部同名日志", async () => {
  const { directory, storage } = await setup();
  await log(directory);
  const preview = await storage.preview();
  const outside = await setup();
  const target = await log(outside.directory);
  const moved = directory + "-moved";
  await rename(directory, moved);
  directories.push(moved);
  await symlink(outside.directory, directory);
  await expect(storage.clear(preview.token)).rejects.toThrow("符号链接");
  expect(await readFile(target, "utf8")).toBe("log");
});

it("无效、被更新或过期的预览不能删除日志", async () => {
  const { directory, storage } = await setup();
  const file = await log(directory);
  const first = await storage.preview();
  await expect(storage.clear("../outside")).rejects.toBeInstanceOf(LogStorageTokenError);
  const second = await storage.preview();
  await expect(storage.clear(first.token)).rejects.toBeInstanceOf(LogStorageTokenError);
  const future = Date.now() + 11 * 60 * 1000;
  vi.spyOn(Date, "now").mockReturnValue(future);
  await expect(storage.clear(second.token)).rejects.toBeInstanceOf(LogStorageTokenError);
  expect(await readFile(file, "utf8")).toBe("log");
});

it("无法检查活动FD时拒绝清理，损坏writer marker按活动运行保护", async () => {
  const { directory, storage } = await setup();
  const file = await log(directory);
  await mkdir(path.join(directory, ".writers"));
  await writeFile(path.join(directory, ".writers", OLD + ".json"), "truncated");
  expect(await storage.preview()).toMatchObject({ runs: 0, protectedRuns: [CURRENT, OLD] });
  const blocked = new LogStorage({
    context: () => ({ directory, runId: CURRENT }),
    openFiles: async () => {
      throw new Error("FD inspection failed");
    },
  });
  await expect(blocked.preview()).rejects.toThrow("FD inspection failed");
  expect(await readFile(file, "utf8")).toBe("log");
});

it("diagnostics在写日志或截图前注册PID，其他当前服务能保护该运行", async () => {
  const { directory, storage } = await setup();
  const logger = new DiagnosticLog(directory);
  const context = logger.storageContext();
  logger.evidenceDirectory();
  expect(
    JSON.parse(await readFile(path.join(directory, ".writers", context.runId + ".json"), "utf8")),
  ).toEqual({ runId: context.runId, pid: process.pid });
  logger.record("service.fixture");
  const preview = await storage.preview();
  expect(preview.runs).toBe(0);
  expect(preview.protectedRuns).toContain(context.runId);
});

it("真实lsof将没有开放FD的exit1视为正常，并保护临时目录里仍打开的日志", async () => {
  const { directory } = await setup();
  const storage = new LogStorage({ context: () => ({ directory, runId: CURRENT }) });
  const file = await log(directory);
  expect(await storage.preview()).toMatchObject({ runs: 1 });
  const descriptor = openSync(file, "a");
  try {
    expect(await storage.preview()).toMatchObject({ runs: 0, protectedRuns: [CURRENT, OLD] });
  } finally {
    closeSync(descriptor);
  }
});
