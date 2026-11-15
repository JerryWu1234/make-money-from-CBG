import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export type AccessAdapter = "playwright" | "extension-native";
export const isAccessAdapter = (value: unknown): value is AccessAdapter =>
  value === "playwright" || value === "extension-native";
export type BrowserMode = "dedicated" | "daily";
export const isBrowserMode = (value: unknown): value is BrowserMode =>
  value === "dedicated" || value === "daily";

export const BROWSER_MODES: BrowserMode[] = ["dedicated", "daily"];
export const isBrowserModes = (value: unknown): value is BrowserMode[] =>
  Array.isArray(value) &&
  value.length === 1 &&
  value.every(isBrowserMode) &&
  new Set(value).size === value.length;
export type BrowserSelection = {
  mode: BrowserMode;
  modes?: BrowserMode[];
  showWorkPages?: boolean;
  accessAdapter?: AccessAdapter;
};
const selection = (modes: BrowserMode[]): BrowserSelection => ({ mode: modes[0], modes });

export class BrowserSettingsStore {
  constructor(private readonly file: string) {}

  get(): BrowserSelection {
    let stored: unknown;
    try {
      stored = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      // Missing and malformed legacy settings never start either browser.
      return selection(["dedicated"]);
    }
    if (stored && typeof stored === "object") {
      if ("accessAdapter" in stored && !isAccessAdapter(stored.accessAdapter))
        throw new Error("保存的官网交互通路无法识别，请明确重新选择；已停止浏览器操作");
      const result = (modes: BrowserMode[]): BrowserSelection => ({
        ...selection(modes),
        ...("accessAdapter" in stored && isAccessAdapter(stored.accessAdapter)
          ? { accessAdapter: stored.accessAdapter }
          : {}),
        ...("showWorkPages" in stored && typeof stored.showWorkPages === "boolean"
          ? { showWorkPages: stored.showWorkPages }
          : {}),
      });
      if ("modes" in stored && Array.isArray(stored.modes)) {
        const modes = stored.modes;
        if (isBrowserModes(modes)) return result(modes);
        // 旧版双开拥有两套独立登录；收敛到保存登录的专用会话，不改写或清除配置。
        if (modes.length === 2 && BROWSER_MODES.every((mode) => modes.includes(mode)))
          return result(["dedicated"]);
      }
      if ("mode" in stored && isBrowserMode(stored.mode)) return result([stored.mode]);
    }
    return selection(["dedicated"]);
  }

  save(
    value: unknown,
    showWorkPages: unknown = this.get().showWorkPages,
    accessAdapter: unknown = this.get().accessAdapter,
  ): BrowserSelection {
    const modes = isBrowserMode(value) ? [value] : value;
    if (!isBrowserModes(modes)) throw new Error("浏览器运行方式无效，请只选择一种方式");
    if (showWorkPages !== undefined && typeof showWorkPages !== "boolean")
      throw new Error("显示操作过程选项必须为布尔值");
    if (accessAdapter !== undefined && !isAccessAdapter(accessAdapter))
      throw new Error("官网交互通路无效");
    const next = {
      ...selection(BROWSER_MODES.filter((mode) => modes.includes(mode))),
      ...(showWorkPages === undefined ? {} : { showWorkPages }),
      ...(accessAdapter === undefined ? {} : { accessAdapter }),
    };
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
export const saveBrowserSettings = (
  value: unknown,
  showWorkPages?: boolean,
  accessAdapter?: AccessAdapter,
) => store.save(value, showWorkPages, accessAdapter);

// Count requests until their business promises settle, including after HTTP disconnects.
const controlKey = Symbol.for("cbg.browser-control.v1");
const runtime = globalThis as typeof globalThis & {
  [controlKey]?: { changing: boolean; pending: number };
};
export const browserControl = (runtime[controlKey] ??= { changing: false, pending: 0 });

export function browserBusyError(message = "浏览器正在切换，请稍后重试") {
  return Object.assign(new Error(message), { name: "BrowserSessionBusyError" });
}
