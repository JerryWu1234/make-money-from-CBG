import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { showBrowserWorkPages } from "./config";
import { diagnostics } from "./diagnostics";

export async function openDedicatedBrowser(
  directory = path.resolve("data/browser-profile"),
): Promise<BrowserContext> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    return await chromium.launchPersistentContext(directory, {
      channel: "chrome",
      headless: !showBrowserWorkPages(),
      viewport: { width: 1280, height: 900 },
    });
  } catch (cause) {
    diagnostics.record("browser.launch_error", { mode: "dedicated", error: cause });
    throw new Error(
      "项目专用浏览器启动失败。请确认已安装 Chrome，且没有另一个项目服务占用专用浏览器目录；详情见运行日志。",
      { cause },
    );
  }
}
