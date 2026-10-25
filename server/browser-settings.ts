import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type BrowserMode = "dedicated" | "daily";
export const isBrowserMode = (value: unknown): value is BrowserMode =>
  value === "dedicated" || value === "daily";

export const BROWSER_MODES: BrowserMode[] = ["dedicated", "daily"];
export const isBrowserModes = (value: unknown): value is BrowserMode[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every(isBrowserMode) &&
  new Set(value).size === value.length;
export type BrowserSelection = { mode: BrowserMode; modes?: BrowserMode[] };
const selection = (modes: BrowserMode[]): BrowserSelection => ({ mode: modes[0], modes });

export class BrowserSettingsStore {
  constructor(private readonly file: string) {}

  get(): BrowserSelection {
    try {
      const stored: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (stored && typeof stored === "object") {
        if ("modes" in stored && isBrowserModes(stored.modes))
          return selection(
            BROWSER_MODES.filter((mode) => (stored.modes as BrowserMode[]).includes(mode)),
          );
        if ("mode" in stored && isBrowserMode(stored.mode)) return selection([stored.mode]);
      }
    } catch {
      // Reading settings never starts either browser.
    }
    return selection([...BROWSER_MODES]);
  }

  save(value: unknown): BrowserSelection {
    const modes = isBrowserMode(value) ? [value] : value;
    if (!isBrowserModes(modes)) throw new Error("浏览器运行方式无效，请至少选择一种方式");
    const next = selection(BROWSER_MODES.filter((mode) => modes.includes(mode)));
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
    return next;
  }
}

const store = new BrowserSettingsStore(path.resolve("data/browser-settings.json"));
export const browserSettings = () => store.get();
export const saveBrowserSettings = (value: unknown) => store.save(value);
export const enabledBrowserModes = (): BrowserMode[] => {
  const settings = browserSettings();
  return settings.modes || [settings.mode];
};

// Count requests until their business promises settle, including after HTTP disconnects.
const controlKey = Symbol.for("cbg.browser-control.v1");
const runtime = globalThis as typeof globalThis & {
  [controlKey]?: { changing: boolean; pending: number };
};
export const browserControl = (runtime[controlKey] ??= { changing: false, pending: 0 });

export function browserBusyError(message = "浏览器正在切换，请稍后重试") {
  return Object.assign(new Error(message), { name: "BrowserSessionBusyError" });
}
