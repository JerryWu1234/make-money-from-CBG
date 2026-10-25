import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite-plus";

const repository = fileURLToPath(new URL("../", import.meta.url));
process.chdir(repository);
const directory = path.join(repository, "data/service-runtime");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const events = path.join(directory, "lifecycle.jsonl");
const errorDetails = (error) => ({
  message: String(error),
  ...(error instanceof AggregateError ? { errors: error.errors.map(errorDetails) } : {}),
});
const record = (event, details = {}) => {
  appendFileSync(
    events,
    JSON.stringify({
      at: new Date().toISOString(),
      event,
      pid: process.pid,
      ...details,
    }) + "\n",
    { mode: 0o600 },
  );
};
process.on("uncaughtExceptionMonitor", (error, origin) => {
  record("uncaught_exception", {
    origin,
    name: error.name,
    message: error.message,
    stack: error.stack,
  });
});
process.once("exit", (code) => record("exit", { code }));
record("starting", { cwd: process.cwd(), parentPid: process.ppid, node: process.version });
const server = await createServer({
  root: repository,
  configFile: path.join(repository, "vite.config.ts"),
  plugins: [
    {
      name: "cbg-stable-runtime",
      configResolved(config) {
        // Vite's mergeConfig skips null overrides from the inline config.
        config.server.watch = null;
      },
    },
  ],
  server: { host: "127.0.0.1", port: 5173, strictPort: true, open: false, watch: null },
});
server.httpServer?.once("close", () => record("http_server_closed"));
await server.listen();
const ready = {
  pid: process.pid,
  startedAt: new Date().toISOString(),
  cwd: process.cwd(),
  url: "http://127.0.0.1:5173/",
  sourceWatching: server.config.server.watch !== null,
};
writeFileSync(path.join(directory, "current.json"), JSON.stringify(ready, null, 2) + "\n", {
  mode: 0o600,
});
record("ready", ready);
console.log("CBG_STABLE_LOCAL_SERVER", ready.url, "source watching disabled");
setInterval(() => {
  record("heartbeat", { uptime: process.uptime(), memory: process.memoryUsage() });
}, 60_000).unref();
let closing = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  // 先触发 server.close() 移除 Vite 自带的退出回调，保留业务清理错误的退出码。
  process.prependListener(signal, async () => {
    if (closing) return;
    closing = true;
    record("shutdown_signal", { signal });
    const deadline = setTimeout(() => process.exit(1), 15_000);
    deadline.unref();
    try {
      const closeService = server[Symbol.for("cbg.close-local-service")];
      const results = await Promise.allSettled([
        typeof closeService === "function"
          ? closeService()
          : Promise.reject(new Error("本地服务关停钩子未注册")),
        server.close(),
      ]);
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "本地服务关停失败",
        );
      process.exit(0);
    } catch (error) {
      record("shutdown_error", errorDetails(error));
      process.exit(1);
    }
  });
}
