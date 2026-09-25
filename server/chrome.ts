import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const CONNECTION_HELP =
  "请在日常 Chrome 的 chrome://inspect/#remote-debugging 开启远程调试，再点击开始查询；如 Chrome 弹出连接提示，请确认允许。";

export function parseDevToolsEndpoint(contents: string): string {
  const [rawPort, route] = contents.trim().split(/\r?\n/);
  const port = Number(rawPort);
  if (
    !/^\d+$/.test(rawPort) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(route || "")
  ) {
    throw new Error("Chrome 的远程调试地址无效，请重新开启远程调试。");
  }
  return `ws://127.0.0.1:${port}${route}`;
}

// 只读取日常 Chrome 发布的连接地址，不扫描其他浏览器或复制用户配置。
export async function resolveCdpEndpoint(): Promise<string> {
  const directory =
    process.env.CBG_CHROME_USER_DATA_DIR ||
    path.join(os.homedir(), "Library/Application Support/Google/Chrome");
  try {
    return parseDevToolsEndpoint(
      await readFile(path.join(directory, "DevToolsActivePort"), "utf8"),
    );
  } catch {
    throw new Error(CONNECTION_HELP);
  }
}
