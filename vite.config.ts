import { defineConfig } from "vite-plus";
import type { Plugin } from "vite-plus";
import react from "@vitejs/plugin-react";
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { apiMiddleware } from "./server/api";
import { codexHomeDirectory } from "./server/ai/codex-home";
import { initializeScanSchedule } from "./server/crawler/schedule";
import { createLocalServiceShutdown } from "./server/shutdown";
import { resetServiceLifecycle } from "./server/service-lifecycle";
import { resetBrowserSessionLifecycle } from "./server/session";

let closeService: (() => Promise<void>) | undefined;

/** Vite's glob deny checks the requested path, so resolve symlink targets first. */
export function codexHomeGuard(home = codexHomeDirectory): Plugin {
  return {
    name: "cbg-codex-home-guard",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let pathnames: string[];
        try {
          const rawPathname = new URL(req.url || "/", "http://localhost").pathname;
          // Vite's static middleware uses decodeURI, which preserves encoded
          // separators that decodeURIComponent would turn into other paths.
          pathnames = [
            ...new Set([rawPathname, decodeURI(rawPathname), decodeURIComponent(rawPathname)]),
          ];
        } catch {
          res.statusCode = 400;
          res.end();
          return;
        }
        let protectedHome: string;
        try {
          protectedHome = realpathSync(home());
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return next();
          res.statusCode = 403;
          res.end();
          return;
        }
        const candidates = pathnames.flatMap((pathname) => {
          const fsPath = pathname.startsWith("/@fs/") ? pathname.slice(5) : null;
          return fsPath
            ? [isAbsolute(fsPath) ? fsPath : resolve(sep, fsPath)]
            : [
                resolve(server.config.root, `.${pathname}`),
                ...(server.config.publicDir
                  ? [resolve(server.config.publicDir, `.${pathname}`)]
                  : []),
              ];
        });
        for (const candidate of candidates) {
          try {
            const target = realpathSync(candidate);
            const path = relative(protectedHome, target);
            if (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) {
              res.statusCode = 403;
              res.end();
              return;
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
              res.statusCode = 403;
              res.end();
              return;
            }
          }
        }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    codexHomeGuard(),
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
    fs: {
      // Preserve Vite's defaults and block the separate Codex home even when a
      // parent workspace includes it in Vite's default allow list.
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem,key,p12,pfx,cer,der}",
        ".npmrc",
        ".yarnrc.yml",
        "**/.git/**",
        "**/make-money-from-cbg/*/codex-home/**",
      ],
    },
    watch: { ignored: ["**/.chrome-cbg-profile/**", "**/.git/**", "**/data/**"] },
  },
  // Preserve the user's prompt bytes and their recorded SHA-256.
  fmt: { ignorePatterns: ["prompts/role-valuation.md"] },
  lint: { options: { typeAware: true, typeCheck: true } },
});
