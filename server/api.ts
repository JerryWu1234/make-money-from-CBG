import type { IncomingMessage, ServerResponse } from "node:http";
import { diagnostics } from "./diagnostics";
import { ScheduleConfigError } from "./crawler/schedule-time";

const getRoutes = new Set([
  "/api/browser/status",
  "/api/crawl/status",
  "/api/crawl/detail",
  "/api/crawl/records",
  "/api/scan/status",
  "/api/logs/export",
]);
const postRoutes = new Set([
  "/api/browser/open",
  "/api/crawl/start",
  "/api/crawl/stop",
  "/api/crawl/clear",
  "/api/scan/configure",
  "/api/scan/enable",
  "/api/scan/disable",
]);

async function verifyRequestBody(request: IncomingMessage) {
  let body = "";
  for await (const chunk of request) {
    body += String(chunk);
    if (body.length > 4096) throw new Error("请求体过大");
  }
  const parsed: unknown = body ? JSON.parse(body) : {};
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("请求格式错误");
  return parsed;
}

export async function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const pathname = req.url?.split("?")[0];
  if (!pathname || (!getRoutes.has(pathname) && !postRoutes.has(pathname))) return next();
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== (getRoutes.has(pathname) ? "GET" : "POST")) {
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

    const body = req.method === "POST" ? await verifyRequestBody(req) : {};
    if (pathname.startsWith("/api/scan/")) {
      const scan = await import("./crawler/schedule");
      const result =
        pathname === "/api/scan/configure"
          ? scan.configureScanSchedule(body)
          : pathname === "/api/scan/enable"
            ? scan.enableScanSchedule()
            : pathname === "/api/scan/disable"
              ? scan.disableScanSchedule()
              : scan.scanScheduleStatus();
      res.end(JSON.stringify(result));
      return;
    }

    const crawler = await import("./crawler/controller");
    if (pathname.startsWith("/api/crawl/")) {
      const params = new URL(req.url!, expectedOrigin).searchParams;
      let result: unknown;
      switch (pathname) {
        case "/api/crawl/start":
          {
            const attempt = await crawler.startCrawl();
            if (attempt.started) (await import("./crawler/schedule")).disableScanSchedule();
            result = attempt.status;
          }
          break;
        case "/api/crawl/stop":
          (await import("./crawler/schedule")).disableScanSchedule();
          result = crawler.stopCrawl();
          break;
        case "/api/crawl/clear":
          {
            const scan = await import("./crawler/schedule");
            if (crawler.isCrawling()) {
              res.statusCode = 409;
              res.end(JSON.stringify({ error: "请先暂停采集，再清空数据" }));
              return;
            }
            scan.disableScanSchedule();
          }
          result = crawler.clearCrawl();
          break;
        case "/api/crawl/records":
          result = crawler.savedRecords(
            Number(params.get("page") || 1),
            Number(params.get("pageSize") || 20),
          );
          break;
        case "/api/crawl/detail":
          result = crawler.savedDetail(params.get("key") || "");
          break;
        default:
          result = crawler.crawlStatus();
      }
      res.end(JSON.stringify(result));
      return;
    }

    if (pathname === "/api/browser/open" && crawler.isCrawling()) {
      res.statusCode = 409;
      res.end(JSON.stringify({ error: "请先暂停采集，再重新打开角色查询" }));
      return;
    }
    const browser = await import("./browser");
    const result =
      pathname === "/api/browser/status" ? await browser.checkCbgStatus() : browser.openCbg();
    res.end(JSON.stringify(result));
  } catch (error) {
    diagnostics.record("api.error", { route: pathname, error });
    res.statusCode = error instanceof ScheduleConfigError ? 400 : 500;
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "请求失败" }));
  }
}
