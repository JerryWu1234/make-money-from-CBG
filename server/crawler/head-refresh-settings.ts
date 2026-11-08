import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_HEAD_REFRESH,
  validateHeadRefreshSettings,
  type HeadRefreshSettings,
} from "./head-refresh";

export class HeadRefreshSettingsStore {
  private settings?: HeadRefreshSettings;

  constructor(private readonly file: string) {}

  get(): HeadRefreshSettings {
    if (!this.settings) {
      this.settings = { ...DEFAULT_HEAD_REFRESH };
      try {
        this.settings = validateHeadRefreshSettings(JSON.parse(readFileSync(this.file, "utf8")));
      } catch {
        // 未配置或旧配置损坏时沿用默认值，不影响已有采集。
      }
    }
    return { ...this.settings };
  }

  save(value: unknown): HeadRefreshSettings {
    const next = validateHeadRefreshSettings(value);
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temporary, this.file);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* 保留原始写入错误。 */
      }
      throw error;
    }
    this.settings = next;
    return { ...next };
  }
}

const store = new HeadRefreshSettingsStore(path.resolve("data/head-refresh-settings.json"));
export const headRefreshSettings = () => store.get();
export const saveHeadRefreshSettings = (value: unknown) => store.save(value);
