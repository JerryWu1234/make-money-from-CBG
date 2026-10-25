import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import { apiMiddleware } from "./server/api";
import { initializeScanSchedule } from "./server/crawler/schedule";
import { createLocalServiceShutdown } from "./server/shutdown";
import { resetServiceLifecycle } from "./server/service-lifecycle";
import { resetBrowserSessionLifecycle } from "./server/session";

let closeService: (() => Promise<void>) | undefined;

export default defineConfig({
  plugins: [
    react(),
    {
      name: "cbg-browser-middleware",
      configureServer(server) {
        if (server.httpServer) {
          let listened = server.httpServer.listening;
          const ready = () => {
            // Vite creates the replacement server before closing the old server.
            // Reset global lifecycle flags only after that close has finished.
            resetServiceLifecycle();
            resetBrowserSessionLifecycle();
            initializeScanSchedule();
            listened = true;
          };
          if (listened) ready();
          else server.httpServer.once("listening", ready);
          const requestsClosed = new Promise<void>((resolve) =>
            server.httpServer!.once("close", resolve),
          );
          const pendingRequests = new Set<Promise<void>>();
          const shutdown = createLocalServiceShutdown(async () => {
            if (listened) await requestsClosed;
            // HTTP 连接断开不会取消仍在 await 的业务处理，必须另等其退出。
            await Promise.allSettled(pendingRequests);
          });
          closeService = () => shutdown.close();
          // 稳定入口必须显式观察业务关停错误；Vite 的 close() 会吞掉插件关闭错误。
          Object.defineProperty(server, Symbol.for("cbg.close-local-service"), {
            value: closeService,
          });
          server.middlewares.use((req, res, next) => {
            if (!shutdown.started) {
              const request = apiMiddleware(req, res, next);
              pendingRequests.add(request);
              void request.finally(() => pendingRequests.delete(request)).catch(next);
              return;
            }
            res.statusCode = 503;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            res.end(JSON.stringify({ error: "本地服务正在关闭，请稍后重试" }));
          });
        } else {
          resetServiceLifecycle();
          server.middlewares.use(apiMiddleware);
        }
      },
      async closeBundle() {
        // Vite 等待此异步钩子，稳定入口才可以在 server.close() 后退出。
        await closeService?.();
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    watch: { ignored: ["**/.chrome-cbg-profile/**", "**/.git/**", "**/data/**"] },
  },
  // Preserve the user's prompt bytes and their recorded SHA-256.
  fmt: { ignorePatterns: ["prompts/role-valuation.md"] },
  lint: { options: { typeAware: true, typeCheck: true } },
});
