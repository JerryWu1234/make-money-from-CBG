import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { diagnostics } from "./diagnostics";
import { showBrowserWorkPages } from "./config";
import { ScheduleConfigError } from "./crawler/schedule-time";
import { validateSampleSelection } from "./analysis/sample-selection";
import { analysisConcurrency } from "./analysis/types";
import type { SavedListingScope } from "./crawler/types";
import { HeadRefreshSettingsError } from "./crawler/head-refresh";
import { AccessGateError } from "./access";
import {
  browserControl,
  browserBusyError,
  isBrowserMode,
  isAccessAdapter,
  isBrowserModes,
} from "./browser-settings";

const getRoutes = new Set([
  "/api/access/status",
  "/api/browser/status",
  "/api/browser/settings",
  "/api/crawl/status",
  "/api/crawl/settings",
  "/api/crawl/role-training-filter",
  "/api/crawl/head-refresh",
  "/api/crawl/detail",
  "/api/crawl/records",
  "/api/scan/status",
  "/api/logs/export",
  "/api/logs/storage",
  "/api/runtime/settings",
  "/api/ai/status",
  "/api/ai/models",
  "/api/ai/login/status",
  "/api/analysis/status",
  "/api/analysis/progress",
  "/api/analysis/detail",
  "/api/analysis/input",
  "/api/analysis/settings",
]);
const postRoutes = new Set([
  "/api/access/policy",
  "/api/access/recover",
  "/api/access/resume",
  "/api/access/open",
  "/api/access/stop",
  "/api/browser/open",
  "/api/browser/settings/save",
  "/api/crawl/start",
  "/api/crawl/settings/save",
  "/api/crawl/role-training-filter/save",
  "/api/crawl/head-refresh/save",
  "/api/crawl/backfill",
  "/api/crawl/stop",
  "/api/crawl/clear",
  "/api/logs/clear",
  "/api/runtime/settings/save",
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
  "/api/analysis/conditions/compile",
  "/api/analysis/school-formula/confirm",
  "/api/analysis/recommendation/view",
]);

const controlRoutes = new Set([
  "/api/browser/open",
  "/api/crawl/start",
  "/api/crawl/backfill",
  "/api/analysis/start",
  "/api/analysis/resume",
  "/api/analysis/retry",
]);
const browserUseRoutes = new Set([
  ...controlRoutes,
  "/api/access/open",
  "/api/access/recover",
  "/api/access/resume",
  "/api/analysis/equipment/check",
  "/api/analysis/pet/check",
  "/api/analysis/pet-gear/check",
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

async function resumeAccessForUser(mode: "resume" | "open" | "capture", revision?: unknown) {
  const crawler = await import("./crawler/controller");
  const access = await import("./official-access");
  const governor = access.officialGovernor(crawler.crawlDatabase());
  const state = governor.read();
  if (revision !== undefined && (!Number.isSafeInteger(revision) || Number(revision) < 0))
    throw new AccessGateError("stale_revision", "访问状态版本无效，请重新尝试", state);
  if (revision !== undefined && revision !== state.revision)
    throw new AccessGateError("stale_revision", "访问状态已变化，请重新尝试", state);
  const { browserSettings } = await import("./browser-settings");
  const nativeMode = browserSettings().accessAdapter === "extension-native";
  const native = nativeMode ? await import("./native-access") : undefined;
  const nativeStatus = native?.nativeAccessStatus();
  if (nativeMode && (!nativeStatus?.connected || !nativeStatus.pageId)) {
    if (mode === "open") {
      await native!.nativeAccess();
      return governor.read();
    }
    if (mode === "capture")
      throw new AccessGateError(
        "native_binding_pending",
        "正在等待官网角色列表自动连接，请在藏宝阁完成角色搜索后重试",
        state,
      );
  }
  const nativeNeedsResume =
    nativeStatus?.connected && nativeStatus.pageId && nativeStatus.stopped && !nativeStatus.idle;
  if (!nativeMode && state.state === "ready" && mode !== "resume" && !nativeNeedsResume)
    return state;
  const analysis = await import("./analysis/controller");
  const browser = await import("./cbg");
  if (
    crawler.isCrawling() ||
    analysis.isAnalyzing() ||
    browser.isBrowserWorkflowRunning() ||
    browserControl.pending > 1
  )
    throw new AccessGateError(
      "inflight_action",
      "仍有正在运行的任务，请先暂停或等待结束后重试",
      state,
    );
  let focusReceipt: { id: string } | undefined;
  if (nativeMode) {
    const adapter = await native!.nativeAccess();
    focusReceipt = await adapter.focusBoundPage();
    const latest = governor.read();
    adapter.assertFocusedPage(focusReceipt);
    if (latest.revision !== state.revision || latest.stopEpoch !== state.stopEpoch)
      throw new AccessGateError("stale_revision", "切回官网期间访问状态已变化，请重新尝试", latest);
  }
  if (state.state === "ready" && mode !== "resume" && !nativeNeedsResume) return state;
  try {
    if (nativeMode) {
      const prepared = governor.prepareUserResume(
        revision === undefined ? state.revision : Number(revision),
      );
      const adapter = await native!.nativeAccess();
      let activated = false;
      try {
        const ticket = await adapter.prepareManualRecovery(focusReceipt);
        const result = governor.resumeForUser(prepared.revision, prepared.stopEpoch);
        activated = true;
        adapter.completeManualRecovery(ticket);
        return result;
      } catch (error) {
        try {
          if (activated)
            governor.reportRisk({
              reason: "native_recovery_activation_failed",
              evidence: { message: error instanceof Error ? error.message : "activation_failed" },
            });
        } finally {
          await adapter.abortManualRecovery("用户继续未完成，保持原生停止状态").catch(() => {});
        }
        throw error;
      }
    }
    return governor.resumeForUser(revision === undefined ? state.revision : Number(revision));
  } catch (error) {
    if (
      !(error instanceof AccessGateError) ||
      error.code !== "user_recovery_required" ||
      mode === "resume"
    )
      throw error;
    const pageReasons = new Set([
      "unknown_inflight",
      "manual_stop",
      "login",
      "verification",
      "http_403",
      "http_429",
      "frequency",
      "busy",
      ...(nativeMode ? ["native_recovery_activation_failed", "native-activity-stopped"] : []),
    ]);
    if (state.reasons.some((reason) => !pageReasons.has(reason.code)))
      throw new AccessGateError(
        "user_recovery_required",
        `当前暂停原因不能仅凭登录页面解除：${state.reasons.map((reason) => reason.code).join("、")}`,
        state,
      );
    if (
      mode === "capture" ||
      (nativeMode && state.reasons.some((reason) => reason.code === "native-activity-stopped"))
    )
      return access.recoverOfficialAccess(
        state.revision,
        state.reasons.map((reason) => reason.code),
        ...(nativeMode ? [focusReceipt] : []),
      );
    await access.openOfficialRecovery(state.revision);
    throw new AccessGateError(
      "user_recovery_required",
      nativeMode
        ? "请在已绑定的官网页面完成登录或验证后重新尝试；原生输入仍保持停止"
        : "已打开官网固定页面，请完成登录或验证后重新尝试；访问限制尚未解除",
      governor.read(),
    );
  }
}

export async function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const control = browserUseRoutes.has(req.url?.split("?")[0] || "");
  if (control) browserControl.pending++;
  try {
    await handleApi(req, res, next);
  } finally {
    if (control) browserControl.pending--;
  }
}

async function handleApi(req: IncomingMessage, res: ServerResponse, next: () => void) {
  const pathname = req.url?.split("?")[0];
  if (!pathname || (!getRoutes.has(pathname) && !postRoutes.has(pathname))) return next();
  if (controlRoutes.has(pathname)) {
    const requestId = randomUUID();
    const started = Date.now();
    const finish = () => complete("api.control_finished");
    const close = () => complete("api.control_closed");
    const complete = (event: string) => {
      res.removeListener("finish", finish);
      res.removeListener("close", close);
      diagnostics.record(event, {
        requestId,
        route: pathname,
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    };
    diagnostics.record("api.control_received", { requestId, route: pathname, method: req.method });
    res.once("finish", finish);
    res.once("close", close);
  }
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== (getRoutes.has(pathname) ? "GET" : "POST")) {
    res.statusCode = 405;
    res.end(JSON.stringify({ error: "不支持的请求方法" }));
    return;
  }

  const expectedOrigin = `http://${req.headers.host}`;
  try {
    const scope = new URL(req.url!, expectedOrigin).searchParams.get("scope") || "all";
    if (
      (pathname === "/api/crawl/records" ||
        pathname === "/api/analysis/status" ||
        pathname === "/api/analysis/progress") &&
      !["all", "complete", "tasks"].includes(scope)
    ) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "记录范围无效" }));
      return;
    }
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
            pathname === "/api/analysis/settings/save" ||
              pathname === "/api/analysis/conditions/compile"
              ? 256 * 1024
              : 4096,
          )
        : {};
    if (browserUseRoutes.has(pathname) && browserControl.changing) throw browserBusyError();
    if (pathname.startsWith("/api/access/")) {
      const { crawlDatabase } = await import("./crawler/controller");
      const access = await import("./official-access");
      const governor = access.officialGovernor(crawlDatabase());
      const input = body as Record<string, unknown>;
      let result;
      if (pathname === "/api/access/policy") {
        const { parseAccessPolicy } = await import("./access");
        if (!Number.isSafeInteger(input.revision)) throw new Error("访问状态版本无效");
        result = governor.updatePolicy(parseAccessPolicy(input.policy), Number(input.revision));
      } else if (pathname === "/api/access/open") {
        if (!Number.isSafeInteger(input.revision)) throw new Error("访问状态版本无效");
        result = await access.openOfficialRecovery(Number(input.revision));
      } else if (pathname === "/api/access/recover") {
        if (
          !Number.isSafeInteger(input.revision) ||
          !Array.isArray(input.acknowledgedReasons) ||
          input.acknowledgedReasons.some((reason) => typeof reason !== "string")
        )
          throw new Error("请核对当前版本的全部暂停原因");
        result = await access.recoverOfficialAccess(
          Number(input.revision),
          input.acknowledgedReasons as string[],
        );
      } else if (pathname === "/api/access/resume") {
        if (!Number.isSafeInteger(input.revision) || Number(input.revision) < 0)
          throw new AccessGateError(
            "stale_revision",
            "访问状态版本无效，请重新尝试",
            governor.read(),
          );
        result = await resumeAccessForUser("resume", input.revision);
      } else if (pathname === "/api/access/stop") {
        result = governor.reportRisk({ reason: "manual_stop", state: "needs_action" });
      } else result = governor.read();
      res.end(JSON.stringify(result));
      return;
    }
    if (pathname === "/api/browser/settings" || pathname === "/api/browser/settings/save") {
      const { mode, modes, showWorkPages, accessAdapter } = body as Record<string, unknown>;
      if (accessAdapter !== undefined && !isAccessAdapter(accessAdapter))
        throw new Error("官网交互通路无效");
      if (
        pathname.endsWith("/save") &&
        showWorkPages !== undefined &&
        typeof showWorkPages !== "boolean"
      ) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "显示操作过程选项必须为布尔值" }));
        return;
      }
      if (
        pathname.endsWith("/save") &&
        !(modes === undefined
          ? isBrowserMode(mode) ||
            (mode === undefined &&
              (typeof showWorkPages === "boolean" || isAccessAdapter(accessAdapter)))
          : isBrowserModes(modes))
      ) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "浏览器运行方式无效" }));
        return;
      }
      const [session, workflow, capture, analysis] = await Promise.all([
        import("./session"),
        import("./cbg"),
        import("./crawler/controller"),
        import("./analysis/controller"),
      ]);
      const busy = () =>
        browserControl.pending > 0 ||
        workflow.isBrowserWorkflowRunning() ||
        capture.isCrawling() ||
        analysis.isAnalyzing();
      if (
        pathname.endsWith("/save") &&
        (typeof showWorkPages === "boolean" || accessAdapter !== undefined)
      )
        await session.changeBrowserModes(
          (modes ?? [mode ?? session.getActiveBrowserMode()]) as ("daily" | "dedicated")[],
          busy,
          workflow.resetBrowserWorkflow,
          showWorkPages as boolean | undefined,
          accessAdapter as "playwright" | "extension-native" | undefined,
        );
      else if (pathname.endsWith("/save") && modes !== undefined)
        await session.changeBrowserModes(
          modes as ("daily" | "dedicated")[],
          busy,
          workflow.resetBrowserWorkflow,
        );
      else if (pathname.endsWith("/save"))
        await session.changeBrowserMode(
          mode as "daily" | "dedicated",
          busy,
          workflow.resetBrowserWorkflow,
        );
      res.end(
        JSON.stringify({
          ...session.browserSessionSettings(),
          busy: busy() || session.browserSessionSettings().busy,
        }),
      );
      return;
    }
    if (
      pathname === "/api/crawl/role-training-filter" ||
      pathname === "/api/crawl/role-training-filter/save"
    ) {
      const settings = await import("./crawler/role-training-settings");
      try {
        const result = pathname.endsWith("/save")
          ? settings.saveRoleTrainingSettings((body as Record<string, unknown>).minTotal)
          : settings.roleTrainingSettings();
        res.end(JSON.stringify(result));
      } catch (error) {
        if (!(error instanceof settings.RoleTrainingSettingsError)) throw error;
        res.statusCode = 400;
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    if (pathname === "/api/runtime/settings" || pathname === "/api/runtime/settings/save") {
      const input = body as Record<string, unknown>;
      if (pathname === "/api/runtime/settings/save" && typeof input.saveScreenshots !== "boolean") {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "保存截图选项必须为布尔值" }));
        return;
      }
      const settings = await import("./runtime-settings");
      const result =
        pathname === "/api/runtime/settings"
          ? settings.runtimeSettings()
          : settings.saveRuntimeSettings(input.saveScreenshots);
      res.end(JSON.stringify(result));
      return;
    }
    if (pathname === "/api/logs/storage" || pathname === "/api/logs/clear") {
      const { logStorage } = await import("./log-storage");
      const result =
        pathname === "/api/logs/storage"
          ? await logStorage.preview()
          : await logStorage.clear((body as Record<string, unknown>).token);
      if (!res.destroyed) res.end(JSON.stringify(result));
      return;
    }
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
        case "/api/analysis/progress": {
          const provider = params.get("provider");
          result = analysis.analysisProgress({
            provider: provider ? (await import("./ai-connection")).aiProvider(provider) : undefined,
            runId: params.get("runId") || undefined,
            ...(scope === "all" ? {} : { scope: scope as SavedListingScope }),
          });
          break;
        }
        case "/api/analysis/settings":
          result = await analysis.analysisSettings();
          break;
        case "/api/analysis/conditions/compile": {
          const controller = new AbortController();
          const cancel = () => controller.abort(new Error("条件解析请求已取消"));
          const deadline = setTimeout(
            () => controller.abort(new Error("条件解析超时，请重试")),
            120_000,
          );
          res.once("close", cancel);
          try {
            result = await analysis.compileAnalysisConditions(input, controller.signal);
          } finally {
            clearTimeout(deadline);
            res.removeListener("close", cancel);
          }
          break;
        }
        case "/api/analysis/settings/save":
          result = analysis.saveAnalysisSettings(input);
          break;
        case "/api/analysis/school-formula/confirm":
          result = analysis.confirmSchoolFormula(input.productKeys, input.confirmed);
          break;
        case "/api/analysis/status": {
          const provider = params.get("provider");
          const controller = new AbortController();
          const cancel = () => controller.abort(new Error("商品记录请求已断开"));
          const deadline = setTimeout(
            () => controller.abort(new Error("读取商品记录超时")),
            12_000,
          );
          res.once("close", cancel);
          try {
            result = await analysis.analysisOverviewAsync(
              {
                provider: provider
                  ? (await import("./ai-connection")).aiProvider(provider)
                  : undefined,
                runId: params.get("runId") || undefined,
                page: Number(params.get("page") || 1),
                resultsPage: Number(params.get("resultsPage") || 1),
                rankingPage: Number(params.get("rankingPage") || 1),
                summary: true,
                search: params.get("search") || undefined,
                filter: params.get("filter") || undefined,
                showViewed: params.get("showViewed") === "true",
                ...(params.get("includeRanking") === "false" ? { includeRanking: false } : {}),
                ...(params.get("includeRecords") === "false" ? { includeRecords: false } : {}),
                ...(params.get("includeResults") === "false" ? { includeResults: false } : {}),
                ...(scope === "all" ? {} : { scope: scope as SavedListingScope }),
              },
              controller.signal,
            );
          } finally {
            clearTimeout(deadline);
            res.removeListener("close", cancel);
          }
          break;
        }
        case "/api/analysis/recommendation/view":
          result = analysis.markRecommendationViewed(input.key);
          break;
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
          if (input.equipmentOnly !== undefined && typeof input.equipmentOnly !== "boolean")
            throw new Error("只查装备选项必须为布尔值");
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
            input.equipmentOnly === true,
            analysisConcurrency(input.concurrency),
          );
          break;
        }
        case "/api/analysis/pause":
          result = await analysis.pauseAnalysis(runId || undefined);
          break;
        case "/api/analysis/resume":
          result = await analysis.resumeAnalysis(
            runId,
            false,
            input.concurrency === undefined ? undefined : analysisConcurrency(input.concurrency),
          );
          break;
        default:
          result = await analysis.resumeAnalysis(
            runId,
            true,
            input.concurrency === undefined ? undefined : analysisConcurrency(input.concurrency),
          );
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

    if (pathname === "/api/crawl/head-refresh" || pathname === "/api/crawl/head-refresh/save") {
      const settings = await import("./crawler/head-refresh-settings");
      try {
        const result = pathname.endsWith("/save")
          ? settings.saveHeadRefreshSettings(body)
          : settings.headRefreshSettings();
        res.end(JSON.stringify(result));
      } catch (error) {
        if (!(error instanceof HeadRefreshSettingsError)) throw error;
        res.statusCode = 400;
        res.end(JSON.stringify({ error: error.message }));
      }
      return;
    }
    const crawler = await import("./crawler/controller");
    if (pathname.startsWith("/api/crawl/")) {
      const params = new URL(req.url!, expectedOrigin).searchParams;
      let result: unknown;
      switch (pathname) {
        case "/api/crawl/settings":
          result = crawler.equipmentAnalysisSettings();
          break;
        case "/api/crawl/settings/save":
          result = crawler.setEquipmentAnalysis((body as Record<string, unknown>).analyzeEquipment);
          break;
        case "/api/crawl/start":
        case "/api/crawl/backfill":
          {
            const keys = (body as Record<string, unknown>).keys;
            const refresh = (body as Record<string, unknown>).refresh;
            const concurrency = (body as Record<string, unknown>).concurrency;
            if (
              concurrency !== undefined &&
              (typeof concurrency !== "number" ||
                !Number.isSafeInteger(concurrency) ||
                concurrency < 1 ||
                concurrency > 32)
            )
              throw new Error("并发数必须是1至32之间的整数");
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
            if (!crawler.isCrawling()) await resumeAccessForUser("capture");
            const attempt = await crawler.startCrawl("manual", undefined, {
              backfillOnly: pathname === "/api/crawl/backfill",
              keys: keys as string[] | undefined,
              ...(concurrency !== undefined ? { concurrency: concurrency as number } : {}),
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
            result = crawler.clearCrawl();
            scan.disableScanSchedule();
          }
          break;
        case "/api/crawl/records":
          result = crawler.savedRecords(
            Number(params.get("page") || 1),
            Number(params.get("pageSize") || 20),
            scope as SavedListingScope,
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
    if (pathname === "/api/browser/open") await resumeAccessForUser("open");
    const { browserSettings } = await import("./browser-settings");
    if (browserSettings().accessAdapter === "extension-native") {
      const { nativeBrowserState } = await import("./native-access");
      res.end(JSON.stringify(await nativeBrowserState(pathname === "/api/browser/open")));
      return;
    }
    const browser = await import("./browser");
    const result =
      pathname === "/api/browser/status" ? await browser.checkCbgStatus() : browser.openCbg();
    res.end(JSON.stringify({ ...result, workPagesVisible: showBrowserWorkPages() }));
  } catch (error) {
    diagnostics.record("api.error", { route: pathname, error });
    if (res.destroyed) return;
    res.statusCode =
      error instanceof AccessGateError
        ? 409
        : error instanceof ScheduleConfigError
          ? 400
          : error instanceof Error && error.name === "SchoolFormulaConfirmationError"
            ? 400
            : error instanceof Error &&
                ["LogStorageTokenError", "BrowserSessionBusyError"].includes(error.name)
              ? 409
              : 500;
    const retryNotBefore = error instanceof AccessGateError ? error.state?.retryNotBefore : null;
    const remaining = retryNotBefore
      ? Math.max(0, Math.ceil((retryNotBefore - Date.now()) / 1000))
      : 0;
    res.end(
      JSON.stringify({
        error: `${error instanceof Error ? error.message : "请求失败"}${remaining ? `（冷却剩余约 ${remaining} 秒）` : ""}`,
        ...(error instanceof AccessGateError ? { code: error.code, access: error.state } : {}),
      }),
    );
  }
}
