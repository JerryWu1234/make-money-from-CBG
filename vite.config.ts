import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import type { IncomingMessage } from "node:http";
import { diagnostics } from "./server/diagnostics";

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 4096) throw new Error("请求体过大");
  }
  const parsed: unknown = body ? JSON.parse(body) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("请求格式错误");
  return parsed as Record<string, unknown>;
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "cbg-browser-middleware",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          const routes = [
            "/api/browser/open",
            "/api/browser/status",
            "/api/crawl/start",
            "/api/crawl/stop",
            "/api/crawl/status",
            "/api/crawl/detail",
            "/api/crawl/records",
            "/api/crawl/clear",
            "/api/logs/export",
          ];
          const pathname = req.url?.split("?")[0];
          if (!pathname || !routes.includes(pathname)) return next();
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Cache-Control", "no-store");
          const expectedMethod =
            pathname.endsWith("/status") ||
            pathname.endsWith("/detail") ||
            pathname.endsWith("/records") ||
            pathname.endsWith("/export")
              ? "GET"
              : "POST";
          if (req.method !== expectedMethod) {
            res.statusCode = 405;
            res.end(JSON.stringify({ error: "不支持的请求方法" }));
            return;
          }
          const expectedOrigin = `http://${req.headers.host}`;
          try {
            if (
              (req.headers.origin && req.headers.origin !== expectedOrigin) ||
              (req.headers.referer && new URL(req.headers.referer).origin !== expectedOrigin)
            ) {
              res.statusCode = 403;
              res.end(JSON.stringify({ error: "禁止跨域请求" }));
              return;
            }
            if (pathname === "/api/logs/export") {
              res.setHeader("Content-Disposition", 'attachment; filename="cbg-run-log.json"');
              res.end(JSON.stringify(diagnostics.export(), null, 2));
              return;
            }
            const crawler = await import("./server/crawler/controller");
            if (pathname.startsWith("/api/crawl/")) {
              if (pathname.endsWith("/records")) {
                const params = new URL(req.url!, expectedOrigin).searchParams;
                res.end(
                  JSON.stringify(
                    crawler.savedRecords(
                      Number(params.get("page") || 1),
                      Number(params.get("pageSize") || 20),
                    ),
                  ),
                );
                return;
              }
              if (req.method === "POST") await readBody(req);
              const result = pathname.endsWith("/start")
                ? await crawler.startCrawl()
                : pathname.endsWith("/stop")
                  ? crawler.stopCrawl()
                  : pathname.endsWith("/clear")
                    ? crawler.clearCrawl()
                    : pathname.endsWith("/detail")
                      ? crawler.savedDetail(
                          new URL(req.url!, expectedOrigin).searchParams.get("key") || "",
                        )
                      : crawler.crawlStatus();
              res.end(JSON.stringify(result));
              return;
            }
            if (pathname.endsWith("/open") && crawler.isCrawling()) {
              res.statusCode = 409;
              res.end(JSON.stringify({ error: "请先暂停采集，再重新打开角色查询" }));
              return;
            }
            const api = await import("./server/browser");
            if (req.method === "POST") await readBody(req);
            const result = pathname.endsWith("/status")
              ? await api.checkCbgStatus()
              : api.openCbg();
            res.end(JSON.stringify(result));
          } catch (error) {
            diagnostics.record("api.error", { route: pathname, error });
            res.statusCode = 500;
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : "请求失败" }));
          }
        });
      },
    },
  ],
  server: {
    host: "127.0.0.1",
    port: 5173,
    watch: { ignored: ["**/.chrome-cbg-profile/**", "**/.git/**", "**/data/**"] },
  },
  fmt: {},
  lint: { options: { typeAware: true, typeCheck: true } },
});
