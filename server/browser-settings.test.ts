import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { BrowserSettingsStore } from "./browser-settings";

const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-browser-settings-"));
  directories.push(directory);
  return path.join(directory, "browser-settings.json");
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("默认启用两种浏览器，读取不创建配置且不影响截图配置", () => {
  const file = temporary();
  const screenshots = path.join(path.dirname(file), "runtime-settings.json");
  writeFileSync(screenshots, '{"saveScreenshots":false}');
  expect(new BrowserSettingsStore(file).get()).toEqual({
    mode: "dedicated",
    modes: ["dedicated", "daily"],
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

it("新安装默认同时启用两种浏览器，并保存独立勾选结果", () => {
  const file = temporary();
  const store = new BrowserSettingsStore(file);
  expect(store.get()).toMatchObject({ modes: ["dedicated", "daily"] });
  store.save(["dedicated", "daily"]);
  expect(new BrowserSettingsStore(file).get()).toMatchObject({ modes: ["dedicated", "daily"] });
  store.save(["daily"]);
  expect(new BrowserSettingsStore(file).get()).toMatchObject({ modes: ["daily"] });
  expect(() => store.save([])).toThrow();
  expect(() => store.save(["daily", "daily"])).toThrow();
  expect(new BrowserSettingsStore(file).get()).toMatchObject({ modes: ["daily"] });
});

it("旧版单选配置保留用户选择，下次保存写成多选配置", () => {
  const file = temporary();
  writeFileSync(file, '{"mode":"daily"}');
  const store = new BrowserSettingsStore(file);
  expect(store.get()).toEqual({ mode: "daily", modes: ["daily"] });
  store.save(["daily", "dedicated"]);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
    mode: "dedicated",
    modes: ["dedicated", "daily"],
  });
});
