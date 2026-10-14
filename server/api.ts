import type { IncomingMessage, ServerResponse } from "node:http";
import { diagnostics } from "./diagnostics";
import { ScheduleConfigError } from "./crawler/schedule-time";
import { validateSampleSelection } from "./analysis/sample-selection";

const getRoutes = new Set([
  "/api/browser/status",
  "/api/crawl/status",
  "/api/crawl/detail",
  "/api/crawl/records",
  "/api/scan/status",
  "/api/logs/export",
  "/api/ai/status",
  "/api/ai/models",
  "/api/ai/login/status",
  "/api/analysis/status",
  "/api/analysis/detail",
  "/api/analysis/input",
  "/api/analysis/settings",
]);
const postRoutes = new Set([
  "/api/browser/open",
  "/api/crawl/start",
  "/api/crawl/backfill",
  "/api/crawl/stop",
  "/api/crawl/clear",
  "/api/scan/configure",
  "/api/scan/enable",
  "/api/scan/disable",
  "/api/ai/verify",
  "/api/ai/login/start",
  "/api/ai/login/cancel",
  "/api/analysis/start",
  "/api/analysis/pause",
  "/api/analysis/resume",
  "/api/analysis/retry",
  "/api/analysis/equipment/check",
  "/api/analysis/pet/check",
  "/api/analysis/pet-gear/check",
  "/api/analysis/settings/save",
]);

async function verifyRequestBody(request: IncomingMessage, limit = 4096) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += value.byteLength;
    if (size > limit) throw new Error("请求体过大");
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  let parsed: unknown;
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    throw new Error("请求格式错误");
  }
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

    const body =
      req.method === "POST"
        ? await verifyRequestBody(
            req,
            pathname === "/api/analysis/settings/save" ? 128 * 1024 : 4096,
          )
        : {};
    if (pathname.startsWith("/api/analysis/")) {
      switch (pathname) {
        case "/api/analysis/equipment/check":
        case "/api/analysis/pet/check":
        case "/api/analysis/pet-gear/check": {
          if (res.destroyed) return;
          const controller = new AbortController();
          const cancel = () => controller.abort(new Error("查价请求已断开"));
          res.once("close", cancel);
          try {
            const check =
              pathname === "/api/analysis/pet-gear/check"
                ? (await import("./analysis/pet-gear-check")).checkPetGear
                : pathname === "/api/analysis/pet/check"
                  ? (await import("./analysis/pet-check")).checkPet
                  : (await import("./analysis/equipment-check")).checkEquipment;
            const result = await check(body as Record<string, unknown>, controller.signal);
            if (!res.destroyed) res.end(JSON.stringify(result));
          } finally {
            res.removeListener("close", cancel);
          }
          return;
        }
      }
      const analysis = await import("./analysis/controller");
      const params = new URL(req.url!, expectedOrigin).searchParams;
      const input = body as Record<string, unknown>;
      const runId = typeof input.runId === "string" ? input.runId : "";
      let result: unknown;
      switch (pathname) {
        case "/api/analysis/settings":
          result = await analysis.analysisSettings();
          break;
        case "/api/analysis/settings/save":
          result = analysis.saveAnalysisSettings(input);
          break;
        case "/api/analysis/status": {
          const provider = params.get("provider");
          result = analysis.analysisOverview({
            provider: provider ? (await import("./ai-connection")).aiProvider(provider) : undefined,
            runId: params.get("runId") || undefined,
            page: Number(params.get("page") || 1),
            resultsPage: Number(params.get("resultsPage") || 1),
            search: params.get("search") || undefined,
            filter: params.get("filter") || undefined,
          });
          break;
        }
        case "/api/analysis/detail":
          result = analysis.analysisDetail(params.get("taskId") || "");
          break;
        case "/api/analysis/input": {
          const detail = analysis.analysisDetail(params.get("taskId") || "");
          const prompt = params.get("kind") === "prompt";
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.setHeader(
            "Content-Disposition",
            `attachment; filename="${prompt ? detail.promptHash : detail.inputHash}.txt"`,
          );
          res.end(prompt ? detail.promptText : detail.inputText);
          return;
        }
        case "/api/analysis/start": {
          if (
            input.sampleSize !== undefined &&
            (input.sample !== true ||
              typeof input.sampleSize !== "number" ||
              !Number.isInteger(input.sampleSize) ||
              input.sampleSize < 1 ||
              input.sampleSize > 3)
          )
            throw new Error("试分析数量请选择 1 到 3 件");
          if (
            input.model !== undefined &&
            (typeof input.model !== "string" || input.model.length > 200)
          )
            throw new Error("请选择有效的分析模型");
          const productKeys = validateSampleSelection(
            input.sample === true,
            (input.sampleSize as number | undefined) ?? 1,
            input.productKeys,
          );
          result = await analysis.startAnalysis(
            (await import("./ai-connection")).aiProvider(input.provider),
            input.force === true,
            input.sample === true,
            (input.model as string | undefined) || undefined,
            (input.sampleSize as number | undefined) ?? 1,
            productKeys,
          );
          break;
        }
        case "/api/analysis/pause":
          result = await analysis.pauseAnalysis(runId || undefined);
          break;
        case "/api/analysis/resume":
          result = await analysis.resumeAnalysis(runId);
          break;
        default:
          result = await analysis.resumeAnalysis(runId, true);
      }
      if (!res.destroyed) res.end(JSON.stringify(result));
      return;
    }
    if (pathname.startsWith("/api/ai/")) {
      const ai = await import("./ai-connection");
      const params = new URL(req.url!, expectedOrigin).searchParams;
      const input = body as Record<string, unknown>;
      let result: unknown;
      switch (pathname) {
        case "/api/ai/status":
          result = await ai.aiStatus();
          break;
        case "/api/ai/models":
          result = await ai.aiModels(ai.aiProvider(params.get("provider")));
          break;
        case "/api/ai/verify":
          {
            const controller = new AbortController();
            const cancel = () => controller.abort();
            res.once("close", cancel);
            try {
              result = await ai.verifyAi(ai.aiProvider(input.provider), input, controller.signal);
            } finally {
              res.removeListener("close", cancel);
            }
          }
          break;
        case "/api/ai/login/start":
          if (ai.aiProvider(input.provider) !== "codex")
            throw new Error("DeepSeek 请使用 API Key 连接");
          result = await ai.startCodexLogin();
          break;
        case "/api/ai/login/status":
          result = ai.codexLoginStatus(params.get("loginId") || "");
          break;
        default:
          result = await ai.cancelCodexLogin(
            typeof input.loginId === "string" ? input.loginId : "",
          );
      }
      if (res.destroyed) return;
      res.end(JSON.stringify(result));
      return;
    }
    if (pathname.startsWith("/api/scan/")) {
      const scan = await import("./crawler/schedule");
      if (pathname === "/api/scan/enable" && scan.scanScheduleStatus().mode === "disabled") {
        const crawler = await import("./crawler/controller");
        if (crawler.isCrawling()) {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: "请先暂停采集，再启用计划" }));
          return;
        }
        const browser = await (await import("./browser")).checkCbgStatus();
        if (browser.running || !browser.isLoggedIn || browser.workflowStep !== "completed") {
          res.statusCode = 409;
          res.end(JSON.stringify({ error: "请先完成登录并进入角色列表，再启用计划" }));
          return;
        }
      }
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
        case "/api/crawl/backfill":
          {
            const keys = (body as Record<string, unknown>).keys;
            const refresh = (body as Record<string, unknown>).refresh;
            if (
              keys !== undefined &&
              (!Array.isArray(keys) ||
                keys.length > 100 ||
                keys.some((key) => typeof key !== "string" || key.length > 100))
            )
              throw new Error("补采商品列表无效");
            if (refresh !== undefined && typeof refresh !== "boolean")
              throw new Error("刷新采集参数无效");
            if (
              refresh === true &&
              (pathname !== "/api/crawl/backfill" ||
                !Array.isArray(keys) ||
                keys.length !== 1 ||
                typeof keys[0] !== "string" ||
                !keys[0].trim() ||
                keys[0] !== keys[0].trim())
            )
              throw new Error("刷新采集仅支持明确指定一个已保存商品");
            const attempt = await crawler.startCrawl("manual", undefined, {
              backfillOnly: pathname === "/api/crawl/backfill",
              keys: keys as string[] | undefined,
              ...(refresh === true ? { refresh: true } : {}),
            });
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
            if ((await import("./analysis/controller")).isAnalyzing()) {
              res.statusCode = 409;
              res.end(JSON.stringify({ error: "请先暂停分析，再清空数据" }));
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
    if (res.destroyed) return;
    res.statusCode = error instanceof ScheduleConfigError ? 400 : 500;
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : "请求失败" }));
  }
}
