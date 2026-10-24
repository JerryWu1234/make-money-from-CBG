import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { RuntimeSettingsStore } from "./runtime-settings";

const directories: string[] = [];
function temporaryFile() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-runtime-settings-"));
  directories.push(directory);
  return path.join(directory, "runtime-settings.json");
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("runtime screenshot settings", () => {
  it("defaults to enabled without creating a file and returns independent snapshots", () => {
    const file = temporaryFile();
    const store = new RuntimeSettingsStore(file);
    const settings = store.get();
    expect(settings).toEqual({ saveScreenshots: true });
    settings.saveScreenshots = false;
    expect(store.get()).toEqual({ saveScreenshots: true });
    expect(readdirSync(path.dirname(file))).toEqual([]);
  });

  it("persists false and true across store restarts and applies changes immediately", () => {
    const file = temporaryFile();
    const store = new RuntimeSettingsStore(file);
    expect(store.save(false)).toEqual({ saveScreenshots: false });
    expect(store.get()).toEqual({ saveScreenshots: false });
    expect(new RuntimeSettingsStore(file).get()).toEqual({ saveScreenshots: false });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ saveScreenshots: false });
    expect(store.save(true)).toEqual({ saveScreenshots: true });
    expect(new RuntimeSettingsStore(file).get()).toEqual({ saveScreenshots: true });
    expect(readdirSync(path.dirname(file))).toEqual(["runtime-settings.json"]);
  });

  it("uses the cached setting instead of reading the file during browser steps", () => {
    const file = temporaryFile();
    writeFileSync(file, JSON.stringify({ saveScreenshots: false }));
    const store = new RuntimeSettingsStore(file);
    expect(store.get()).toEqual({ saveScreenshots: false });
    writeFileSync(file, JSON.stringify({ saveScreenshots: true }));
    expect(store.get()).toEqual({ saveScreenshots: false });
    expect(new RuntimeSettingsStore(file).get()).toEqual({ saveScreenshots: true });
  });

  it.each([undefined, null, "false", 0, 1, {}, []])("rejects a nonboolean value %j", (value) => {
    const file = temporaryFile();
    const store = new RuntimeSettingsStore(file);
    store.save(false);
    const previous = readFileSync(file, "utf8");
    expect(() => store.save(value)).toThrow("保存截图选项必须为布尔值");
    expect(store.get()).toEqual({ saveScreenshots: false });
    expect(readFileSync(file, "utf8")).toBe(previous);
  });

  it.each(["{", "null", "[]", '{"saveScreenshots":"false"}'])(
    "keeps the default and preserves an invalid stored document %s",
    (stored) => {
      const file = temporaryFile();
      writeFileSync(file, stored);
      expect(new RuntimeSettingsStore(file).get()).toEqual({ saveScreenshots: true });
      expect(readFileSync(file, "utf8")).toBe(stored);
    },
  );

  it("keeps the old in-memory value and cleans staging files after a failed replace", () => {
    const file = temporaryFile();
    const store = new RuntimeSettingsStore(file);
    store.save(false);
    rmSync(file);
    mkdirSync(file);
    expect(() => store.save(true)).toThrow();
    expect(store.get()).toEqual({ saveScreenshots: false });
    expect(readdirSync(path.dirname(file))).toEqual(["runtime-settings.json"]);
  });
});
