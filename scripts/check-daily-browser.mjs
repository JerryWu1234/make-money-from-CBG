import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { chromium } from "playwright-core";
const [port, route] = (
  await readFile(
    path.join(os.homedir(), "Library/Application Support/Google/Chrome/DevToolsActivePort"),
    "utf8",
  )
)
  .trim()
  .split(/\r?\n/);
const endpoint = `ws://127.0.0.1:${port}${route}`;
let browser;
try {
  browser = await chromium.connectOverCDP(endpoint, { timeout: 12000, noDefaults: true });
  const source = ts.transpileModule(await readFile("server/page-state.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const { readPageSnapshot, buildPageState } = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
  );
  const pages = browser
    .contexts()
    .flatMap((context) => context.pages())
    .filter((page) => page.url().startsWith("https://xyq.cbg.163.com/"));
  console.log(JSON.stringify({ connected: true, cbgPages: pages.length }));
  for (const page of pages) {
    const snapshot = await page.evaluate(readPageSnapshot);
    const result = buildPageState(snapshot);
    console.log(
      JSON.stringify({
        path: new URL(snapshot.url).pathname,
        hasLogin: snapshot.hasLogin,
        hasLogout: snapshot.hasLogout,
        hasQr: snapshot.hasQr,
        hasRoles: snapshot.hasRoles,
        isLoggedIn: result.isLoggedIn,
        loginStatus: result.loginStatus,
        identityShown: Boolean(result.accountUrs || result.nickname),
      }),
    );
  }
} catch (error) {
  console.error(error.message.replaceAll(endpoint, "[daily Chrome endpoint]"));
  process.exitCode = 1;
} finally {
  // 对 connectOverCDP 建立的远程连接，此调用仅断开测试客户端。
  await browser?.close();
}
