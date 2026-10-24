import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type RuntimeSettings = { saveScreenshots: boolean };

export class RuntimeSettingsStore {
  private settings?: RuntimeSettings;

  constructor(private readonly file: string) {}

  get(): RuntimeSettings {
    if (!this.settings) {
      this.settings = { saveScreenshots: true };
      try {
        const stored: unknown = JSON.parse(readFileSync(this.file, "utf8"));
        if (
          stored &&
          typeof stored === "object" &&
          "saveScreenshots" in stored &&
          typeof stored.saveScreenshots === "boolean"
        )
          this.settings = { saveScreenshots: stored.saveScreenshots };
      } catch {
        // A missing or unreadable setting must not interrupt browser work.
      }
    }
    return { ...this.settings };
  }

  save(value: unknown): RuntimeSettings {
    if (typeof value !== "boolean") throw new Error("保存截图选项必须为布尔值");
    const next = { saveScreenshots: value };
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // Preserve the original persistence error.
      }
      throw error;
    }
    this.settings = next;
    return { ...next };
  }
}

const store = new RuntimeSettingsStore(path.resolve("data/runtime-settings.json"));

export const runtimeSettings = () => store.get();
export const saveRuntimeSettings = (value: unknown) => store.save(value);
export const screenshotsEnabled = () => runtimeSettings().saveScreenshots;
