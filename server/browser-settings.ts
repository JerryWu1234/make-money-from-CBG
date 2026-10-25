import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type BrowserMode = "dedicated" | "daily";
export const isBrowserMode = (value: unknown): value is BrowserMode =>
  value === "dedicated" || value === "daily";

export class BrowserSettingsStore {
  constructor(private readonly file: string) {}

  get(): { mode: BrowserMode } {
    try {
      const stored: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (stored && typeof stored === "object" && "mode" in stored && isBrowserMode(stored.mode))
        return { mode: stored.mode };
    } catch {
      // A new installation uses its own persistent profile, never the daily profile.
    }
    return { mode: "dedicated" };
  }

  save(mode: unknown): { mode: BrowserMode } {
    if (!isBrowserMode(mode)) throw new Error("浏览器运行方式无效");
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify({ mode }, null, 2)}\n`, {
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
    return { mode };
  }
}

const store = new BrowserSettingsStore(path.resolve("data/browser-settings.json"));
export const browserSettings = () => store.get();
export const saveBrowserSettings = (mode: unknown) => store.save(mode);

// Count requests until their business promises settle, including after HTTP disconnects.
const controlKey = Symbol.for("cbg.browser-control.v1");
const runtime = globalThis as typeof globalThis & {
  [controlKey]?: { changing: boolean; pending: number };
};
export const browserControl = (runtime[controlKey] ??= { changing: false, pending: 0 });

export function browserBusyError(message = "浏览器正在切换，请稍后重试") {
  return Object.assign(new Error(message), { name: "BrowserSessionBusyError" });
}
