import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright-core";
import { showBrowserWorkPages } from "./config";
import { diagnostics } from "./diagnostics";

export class DedicatedBrowserLaunchError extends Error {
  constructor(
    readonly kind: "timeout" | "not_installed" | "profile_in_use" | "launch_failed",
    cause: unknown,
  ) {
    super(
      {
        timeout:
          "项目专用 Chrome 初始化超时，未能在60秒内建立连接；已停止本次启动。请查看运行日志中的启动进程及错误详情。",
        not_installed: "未找到可启动的 Google Chrome，请安装 Chrome 后重新查询。",
        profile_in_use:
          "项目专用浏览器配置目录正被其他 Chrome 进程占用；请先结束占用该目录的会话，保留登录资料。",
        launch_failed:
          "项目专用 Chrome 启动异常；请查看运行日志中的实际错误，已保留专用配置和登录资料。",
      }[kind],
      { cause },
    );
    this.name = "DedicatedBrowserLaunchError";
  }
}

export async function openDedicatedBrowser(
  directory = path.resolve("data/browser-profile"),
): Promise<BrowserContext> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const started = Date.now();
  diagnostics.record("browser.launch_attempt", { mode: "dedicated", directory, timeoutMs: 60_000 });
  try {
    return await chromium.launchPersistentContext(directory, {
      channel: "chrome",
      headless: !showBrowserWorkPages(),
      viewport: { width: 1280, height: 900 },
      timeout: 60_000,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const kind =
      cause instanceof Error && cause.name === "TimeoutError"
        ? "timeout"
        : /Executable doesn't exist|Chromium distribution.*not found|ENOENT/.test(message)
          ? "not_installed"
          : /ProcessSingleton|SingletonLock|profile.*(?:in use|locked)|user data directory is already in use/i.test(
                message,
              )
            ? "profile_in_use"
            : "launch_failed";
    diagnostics.record("browser.launch_error", {
      mode: "dedicated",
      kind,
      directory,
      durationMs: Date.now() - started,
      timeoutMs: 60_000,
      childPid: Number(message.match(/\bpid=(\d+)/)?.[1]) || undefined,
      error: cause,
    });
    throw new DedicatedBrowserLaunchError(kind, cause);
  }
}
