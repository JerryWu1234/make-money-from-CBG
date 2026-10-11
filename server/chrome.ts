import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnection } from "node:net";

export const CONNECTION_HELP =
  "请在日常 Chrome 的 chrome://inspect/#remote-debugging 开启远程调试，再点击开始查询；如 Chrome 弹出连接提示，请确认允许。";

export async function verifyCdpEndpoint(endpoint: string): Promise<void> {
  const port = Number(new URL(endpoint).port);
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("error", (cause: NodeJS.ErrnoException) =>
      finish(
        new Error(
          cause.code === "ECONNREFUSED"
            ? `Chrome 调试端口 ${port} 未启动，保存的调试地址已失效。请在 chrome://inspect/#remote-debugging 关闭再开启远程调试；如仍失败，请完全退出 Chrome，去掉 --remote-debugging-port/--remote-debugging-pipe 启动参数后正常打开，再开启远程调试。默认用户目录下，旧启动参数会阻止界面开关生效。`
            : `无法访问 Chrome 调试端口 ${port}（${cause.code || "连接失败"}）。请检查 Chrome 是否仍在运行及本地连接权限。`,
          { cause },
        ),
      ),
    );
    socket.setTimeout(2000, () =>
      finish(new Error(`Chrome 调试端口 ${port} 无响应，请检查 Chrome 是否仍在运行。`)),
    );
  });
}

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
