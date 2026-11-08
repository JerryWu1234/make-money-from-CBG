import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  headRefreshDelayMs,
  MAX_HEAD_REFRESH_SECONDS,
  validateHeadRefreshSettings,
} from "./head-refresh";
import { HeadRefreshSettingsStore } from "./head-refresh-settings";

const directories: string[] = [];
const temporaryFile = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "cbg-head-refresh-"));
  directories.push(dir);
  return path.join(dir, "settings.json");
};
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it("固定10分钟不会抽取随机数；随机模式覆盖1秒到配置上限且每轮重新抽取", () => {
  const random = vi
    .fn()
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0.5)
    .mockReturnValueOnce(0.999999);
  expect(headRefreshDelayMs({ intervalSeconds: 600, random: false }, random)).toBe(600_000);
  expect(random).not.toHaveBeenCalled();
  const settings = { intervalSeconds: 3600, random: true };
  expect([
    headRefreshDelayMs(settings, random),
    headRefreshDelayMs(settings, random),
    headRefreshDelayMs(settings, random),
  ]).toEqual([1000, 1_801_000, 3_600_000]);
  expect(headRefreshDelayMs({ intervalSeconds: 1, random: true }, () => 0.99999)).toBe(1000);
});

it.each([0, -1, 1.5, NaN, Infinity, "60", MAX_HEAD_REFRESH_SECONDS + 1])(
  "拒绝无效时长 %s",
  (intervalSeconds) => {
    expect(() => validateHeadRefreshSettings({ intervalSeconds, random: false })).toThrow(
      "刷新间隔",
    );
  },
);
it.each([null, {}, [], { intervalSeconds: 60, random: "true" }])(
  "拒绝不完整或非布尔配置 %j",
  (settings) => {
    expect(() => validateHeadRefreshSettings(settings)).toThrow();
  },
);

it("默认60秒固定间隔，不主动写文件；保存后重新创建存储仍能恢复，返回值不共享", () => {
  const file = temporaryFile(),
    store = new HeadRefreshSettingsStore(file);
  expect(store.get()).toEqual({ intervalSeconds: 60, random: false });
  expect(readdirSync(path.dirname(file))).toEqual([]);
  const saved = store.save({ intervalSeconds: 600, random: true });
  saved.intervalSeconds = 1;
  expect(new HeadRefreshSettingsStore(file).get()).toEqual({ intervalSeconds: 600, random: true });
  expect(store.get()).toEqual({ intervalSeconds: 600, random: true });
  expect(() => store.save({ intervalSeconds: 0, random: true })).toThrow();
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ intervalSeconds: 600, random: true });
});

it("配置损坏时用默认值且保留原文件；保存失败不更改内存值并清理临时文件", () => {
  const file = temporaryFile();
  writeFileSync(file, "invalid");
  const store = new HeadRefreshSettingsStore(file);
  expect(store.get()).toEqual({ intervalSeconds: 60, random: false });
  expect(readFileSync(file, "utf8")).toBe("invalid");
  store.save({ intervalSeconds: 300, random: false });
  rmSync(file);
  mkdirSync(file);
  expect(() => store.save({ intervalSeconds: 600, random: true })).toThrow();
  expect(store.get()).toEqual({ intervalSeconds: 300, random: false });
  expect(readdirSync(path.dirname(file))).toEqual(["settings.json"]);
});
