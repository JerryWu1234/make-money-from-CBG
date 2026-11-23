import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { BrowserSettingsStore } from "./browser-settings";
import { showBrowserWorkPages } from "./config";

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-browser-settings-"));
  directories.push(directory);
  return path.join(directory, "browser-settings.json");
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("显示操作过程选择持久保存，切换浏览器方式不会覆盖它", () => {
  const file = temporary();
  const store = new BrowserSettingsStore(file);
  store.save("dedicated", true);
  expect(new BrowserSettingsStore(file).get()).toEqual({
    mode: "dedicated",
    modes: ["dedicated"],
    showWorkPages: true,
  });
  store.save("daily");
  expect(new BrowserSettingsStore(file).get()).toEqual({
    mode: "daily",
    modes: ["daily"],
    showWorkPages: true,
  });
  store.save("daily", false);
  expect(new BrowserSettingsStore(file).get().showWorkPages).toBe(false);
});

it.each([null, "true", "false", 0, 1, {}, []])("拒绝无效显示开关 %j，保留原设置", (value) => {
  const file = temporary();
  const store = new BrowserSettingsStore(file);
  store.save("dedicated", true);
  expect(() => store.save("daily", value)).toThrow("必须为布尔值");
  expect(new BrowserSettingsStore(file).get()).toEqual({
    mode: "dedicated",
    modes: ["dedicated"],
    showWorkPages: true,
  });
});

it("保存的显示选择优先于环境变量；未保存时保留环境变量兼容", () => {
  const read = vi.spyOn(BrowserSettingsStore.prototype, "get");
  read.mockReturnValue({ mode: "dedicated" });
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "0");
  expect(showBrowserWorkPages()).toBe(false);
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "1");
  expect(showBrowserWorkPages()).toBe(true);
  read.mockReturnValue({ mode: "dedicated", showWorkPages: false });
  expect(showBrowserWorkPages()).toBe(false);
  vi.stubEnv("CBG_SHOW_WORK_PAGES", "0");
  read.mockReturnValue({ mode: "dedicated", showWorkPages: true });
  expect(showBrowserWorkPages()).toBe(true);
});

it("默认只启用保存登录的专用浏览器，读取不创建配置且不影响截图配置", () => {
  const file = temporary();
  const screenshots = path.join(path.dirname(file), "runtime-settings.json");
  writeFileSync(screenshots, '{"saveScreenshots":false}');
  expect(new BrowserSettingsStore(file).get()).toEqual({
    mode: "dedicated",
    modes: ["dedicated"],
  });
  expect(readdirSync(path.dirname(file))).toEqual(["runtime-settings.json"]);
  const store = new BrowserSettingsStore(file);
  store.save("daily");
  expect(new BrowserSettingsStore(file).get()).toEqual({ mode: "daily", modes: ["daily"] });
  store.save("dedicated");
  expect(new BrowserSettingsStore(file).get()).toEqual({ mode: "dedicated", modes: ["dedicated"] });
  expect(readFileSync(screenshots, "utf8")).toBe('{"saveScreenshots":false}');
  expect(readdirSync(path.dirname(file)).sort()).toEqual([
    "browser-settings.json",
    "runtime-settings.json",
  ]);
});

it.each([undefined, null, "", "chrome", true, {}, []])(
  "拒绝无效浏览器方式 %j，保留已保存值",
  (value) => {
    const file = temporary();
    const store = new BrowserSettingsStore(file);
    store.save("daily");
    expect(() => store.save(value)).toThrow("浏览器运行方式无效");
    expect(new BrowserSettingsStore(file).get()).toEqual({ mode: "daily", modes: ["daily"] });
  },
);

it("默认单主会话，拒绝双选和重复值，保留日常 Chrome 的明确选择", () => {
  const file = temporary();
  const store = new BrowserSettingsStore(file);
  expect(store.get()).toEqual({ mode: "dedicated", modes: ["dedicated"] });
  store.save(["daily"]);
  expect(new BrowserSettingsStore(file).get()).toEqual({ mode: "daily", modes: ["daily"] });
  for (const value of [[], ["dedicated", "daily"], ["daily", "daily"]])
    expect(() => store.save(value)).toThrow("浏览器运行方式无效");
  expect(new BrowserSettingsStore(file).get()).toEqual({ mode: "daily", modes: ["daily"] });
});

it.each([
  [{ mode: "daily" }, "daily"],
  [{ mode: "dedicated" }, "dedicated"],
  [{ mode: "daily", modes: ["daily"] }, "daily"],
  [{ mode: "daily", modes: ["daily", "dedicated"] }, "dedicated"],
  [{ mode: "dedicated", modes: ["dedicated", "daily"] }, "dedicated"],
])("兼容旧配置 %j，双开收敛为专用浏览器且只读不改配置", (stored, expected) => {
  const file = temporary();
  const original = JSON.stringify(stored);
  writeFileSync(file, original);
  const store = new BrowserSettingsStore(file);
  expect(store.get()).toEqual({ mode: expected, modes: [expected] });
  expect(readFileSync(file, "utf8")).toBe(original);
});
