import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const NATIVE_CBG_HOME_URL = "https://xyq.cbg.163.com/";

const execFileAsync = promisify(execFile);

export async function openNativeCbgPage() {
  if (process.platform !== "darwin")
    throw new Error("扩展读取与 macOS 输入只能在 macOS 上打开藏宝阁页面");
  await execFileAsync("/usr/bin/open", ["-a", "Google Chrome", NATIVE_CBG_HOME_URL], {
    timeout: 10_000,
  });
}
