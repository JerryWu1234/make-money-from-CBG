import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AccessGovernor } from "./access";

const mocks = vi.hoisted(() => ({
  gate: null as AccessGovernor | null,
  isCrawling: vi.fn(),
  isAnalyzing: vi.fn(),
  isBrowserWorkflowRunning: vi.fn(),
  startCrawl: vi.fn(),
  openCbg: vi.fn(),
  openRecovery: vi.fn(),
  recover: vi.fn(),
  disableScanSchedule: vi.fn(),
  adapter: "playwright" as "playwright" | "extension-native",
  prepareNative: vi.fn(),
  completeNative: vi.fn(),
  abortNative: vi.fn(),
  nativeStatus: vi.fn(),
  nativeBrowserState: vi.fn(),
}));
vi.mock("./official-access", () => ({
  officialGovernor: () => mocks.gate!,
  openOfficialRecovery: mocks.openRecovery,
  recoverOfficialAccess: mocks.recover,
}));
vi.mock("./crawler/controller", () => ({
  crawlDatabase: () => mocks.gate!.db,
  isCrawling: mocks.isCrawling,
  startCrawl: mocks.startCrawl,
}));
vi.mock("./analysis/controller", () => ({ isAnalyzing: mocks.isAnalyzing }));
vi.mock("./cbg", () => ({ isBrowserWorkflowRunning: mocks.isBrowserWorkflowRunning }));
vi.mock("./browser", () => ({ openCbg: mocks.openCbg }));
vi.mock("./crawler/schedule", () => ({ disableScanSchedule: mocks.disableScanSchedule }));
vi.mock("./diagnostics", () => ({ diagnostics: { record: vi.fn() } }));
vi.mock("./browser-settings", async (original) => ({
  ...(await original<typeof import("./browser-settings")>()),
  browserSettings: () => ({ accessAdapter: mocks.adapter }),
}));
vi.mock("./native-access", () => ({
  nativeAccessStatus: mocks.nativeStatus,
  nativeBrowserState: mocks.nativeBrowserState,
  nativeAccess: async () => ({
    prepareManualRecovery: mocks.prepareNative,
    completeManualRecovery: mocks.completeNative,
    abortManualRecovery: mocks.abortNative,
  }),
}));
let db: DatabaseSync;
beforeEach(async () => {
  vi.clearAllMocks();
  db = new DatabaseSync(":memory:");
  mocks.gate = new AccessGovernor(db);
  mocks.adapter = "playwright";
  mocks.nativeStatus.mockReturnValue(undefined);
  mocks.nativeBrowserState.mockResolvedValue({
    running: false,
    workflowStep: "completed",
    isLoggedIn: true,
  });
  mocks.abortNative.mockResolvedValue(undefined);
  mocks.prepareNative.mockImplementation(async () => ({ stopEpoch: mocks.gate!.read().stopEpoch }));
  mocks.completeNative.mockImplementation((ticket) => {
    expect(mocks.gate!.read()).toMatchObject({ state: "ready", stopEpoch: ticket.stopEpoch });
  });
  mocks.isCrawling.mockReturnValue(false);
  mocks.isAnalyzing.mockReturnValue(false);
  mocks.isBrowserWorkflowRunning.mockReturnValue(false);
  mocks.openCbg.mockReturnValue({ running: true, workflowStep: "connecting" });
  mocks.startCrawl.mockResolvedValue({ started: true, status: { running: true } });
  const { browserControl } = await import("./browser-settings");
  browserControl.pending = 0;
  browserControl.changing = false;
});
afterEach(() => db.close());
async function call(
  path: string,
  body: Record<string, unknown> = {},
  method = "POST",
  origin = "http://127.0.0.1:5173",
) {
  const request = Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    url: path,
    headers: { host: "127.0.0.1:5173", origin },
  }) as IncomingMessage;
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    destroyed: false,
    setHeader: vi.fn(),
    end: vi.fn(),
  });
  await (
    await import("./api")
  ).apiMiddleware(request, response as unknown as ServerResponse, vi.fn());
  return { status: response.statusCode, body: JSON.parse(response.end.mock.calls[0][0]) };
}
it("显式resume需要当前revision并只清soft，不打开页面或重放任务", async () => {
  const paused = mocks.gate!.reportRisk({ reason: "login" });
  expect((await call("/api/access/resume", { revision: paused.revision })).body).toMatchObject({
    state: "ready",
    stopEpoch: paused.stopEpoch + 1,
  });
  expect(mocks.openCbg).not.toHaveBeenCalled();
  expect(mocks.startCrawl).not.toHaveBeenCalled();
  expect((await call("/api/access/resume", { revision: paused.revision })).body.code).toBe(
    "stale_revision",
  );
});
it.each([{}, { revision: -1 }, { revision: "1" }])("缺少或非法revision%j不能继续", async (body) => {
  mocks.gate!.reportRisk({ reason: "manual_stop" });
  expect((await call("/api/access/resume", body)).status).toBe(409);
  expect(mocks.gate!.read().state).toBe("needs_action");
});
it.each(["/api/browser/open", "/api/crawl/start", "/api/crawl/backfill"])(
  "用户%s先恢复soft再启动原功能",
  async (route) => {
    mocks.gate!.reportRisk({ reason: "unknown_inflight" });
    mocks.gate!.reportRisk({ reason: "manual_stop" });
    mocks.gate!.reportRisk({ reason: "login" });
    expect((await call(route)).status).toBe(200);
    expect(mocks.gate!.read().state).toBe("ready");
    if (route === "/api/browser/open") expect(mocks.openCbg).toHaveBeenCalledOnce();
    else expect(mocks.startCrawl).toHaveBeenCalledWith("manual", undefined, expect.any(Object));
  },
);
it.each(["isCrawling", "isAnalyzing", "isBrowserWorkflowRunning"] as const)(
  "%s运行中不清soft",
  async (key) => {
    const paused = mocks.gate!.reportRisk({ reason: "login" });
    mocks[key].mockReturnValue(true);
    expect((await call("/api/access/resume", { revision: paused.revision })).body.code).toBe(
      "inflight_action",
    );
    expect(mocks.gate!.read().revision).toBe(paused.revision);
  },
);
it("验证码重试只打开固定恢复页，普通登录任务不启动，也不清保护", async () => {
  const paused = mocks.gate!.reportRisk({ reason: "verification" });
  mocks.openRecovery.mockResolvedValue(paused);
  const result = await call("/api/browser/open");
  expect(result.status).toBe(409);
  expect(result.body.error).toContain("已打开官网固定页面");
  expect(mocks.openRecovery).toHaveBeenCalledWith(paused.revision);
  expect(mocks.openCbg).not.toHaveBeenCalled();
  expect(mocks.gate!.read().reasons).toEqual(paused.reasons);
});
it("手动采集的硬原因必须交给现有真实页面核验，失败不启动", async () => {
  const paused = mocks.gate!.reportRisk({ reason: "http_403" });
  mocks.recover.mockRejectedValue(new Error("当前页面仍要求验证"));
  const result = await call("/api/crawl/start");
  expect(result.body.error).toContain("仍要求验证");
  expect(mocks.recover).toHaveBeenCalledWith(paused.revision, ["http_403"]);
  expect(mocks.startCrawl).not.toHaveBeenCalled();
  expect(mocks.gate!.read().state).toBe("needs_action");
});
it("时钟等非页面原因不能凭登录重试或当前网页自动清除", async () => {
  mocks.gate!.reportRisk({ reason: "clock_anomaly" });
  for (const route of ["/api/browser/open", "/api/crawl/start"]) {
    const result = await call(route);
    expect(result.status).toBe(409);
    expect(result.body.error).toContain("clock_anomaly");
  }
  expect(mocks.openRecovery).not.toHaveBeenCalled();
  expect(mocks.recover).not.toHaveBeenCalled();
});
it("GET和跨站POST不能清状态", async () => {
  const paused = mocks.gate!.reportRisk({ reason: "login" });
  expect((await call("/api/access/resume", {}, "GET")).status).toBe(405);
  expect(
    (
      await call(
        "/api/access/resume",
        { revision: paused.revision },
        "POST",
        "https://foreign.test",
      )
    ).status,
  ).toBe(403);
  expect(mocks.gate!.read().revision).toBe(paused.revision);
});
it("Native用户重试在新epoch仍暂停时真实prepare，再CAS ready并完成同epoch票据", async () => {
  mocks.adapter = "extension-native";
  const paused = mocks.gate!.reportRisk({ reason: "unknown_inflight" });
  mocks.prepareNative.mockImplementation(async () => {
    const state = mocks.gate!.read();
    expect(state.state).toBe("needs_action");
    expect(state.stopEpoch).toBe(paused.stopEpoch + 1);
    return { stopEpoch: state.stopEpoch };
  });
  expect((await call("/api/access/resume", { revision: paused.revision })).status).toBe(200);
  expect(mocks.prepareNative).toHaveBeenCalledOnce();
  expect(mocks.completeNative).toHaveBeenCalledOnce();
  expect(mocks.abortNative).not.toHaveBeenCalled();
});
it("Native准备失败保持暂停，票据完成失败重新风险并abort", async () => {
  mocks.adapter = "extension-native";
  const paused = mocks.gate!.reportRisk({ reason: "login" });
  mocks.prepareNative.mockRejectedValueOnce(new Error("权限不满足"));
  expect((await call("/api/access/resume", { revision: paused.revision })).status).toBe(500);
  expect(mocks.gate!.read()).toMatchObject({
    state: "needs_action",
    stopEpoch: paused.stopEpoch + 1,
  });
  expect(mocks.completeNative).not.toHaveBeenCalled();
  expect(mocks.abortNative).toHaveBeenCalledOnce();
  mocks.completeNative.mockImplementationOnce(() => {
    throw new Error("票据已变化");
  });
  const current = mocks.gate!.read();
  expect((await call("/api/access/resume", { revision: current.revision })).status).toBe(500);
  expect(mocks.gate!.read().reasons.map((r) => r.code)).toContain(
    "native_recovery_activation_failed",
  );
  expect(mocks.abortNative).toHaveBeenCalledTimes(2);
});
it("Native准备中出现新风险不能被finish CAS清除", async () => {
  mocks.adapter = "extension-native";
  const paused = mocks.gate!.reportRisk({ reason: "login" });
  mocks.prepareNative.mockImplementationOnce(async () => {
    const epoch = mocks.gate!.read().stopEpoch;
    mocks.gate!.reportRisk({ reason: "verification" });
    return { stopEpoch: epoch };
  });
  expect((await call("/api/access/resume", { revision: paused.revision })).body.code).toBe(
    "stale_revision",
  );
  expect(mocks.completeNative).not.toHaveBeenCalled();
  expect(mocks.gate!.read().reasons.map((r) => r.code)).toContain("verification");
  expect(mocks.abortNative).toHaveBeenCalledOnce();
});
it("物理暂停仅Native普通重新尝试交已有恢复核验，不列soft清理或仅启动host", async () => {
  const paused = mocks.gate!.reportRisk({ reason: "native-activity-stopped" });
  expect((await call("/api/browser/open")).status).toBe(409);
  expect(mocks.recover).not.toHaveBeenCalled();
  mocks.adapter = "extension-native";
  mocks.recover.mockResolvedValueOnce({ state: "ready" });
  expect((await call("/api/browser/open")).status).toBe(200);
  expect(mocks.recover).toHaveBeenCalledWith(paused.revision, ["native-activity-stopped"]);
  expect(mocks.openRecovery).not.toHaveBeenCalled();
  expect(mocks.nativeBrowserState).toHaveBeenCalledWith(true);
  expect(mocks.prepareNative).not.toHaveBeenCalled(); // The soft-resume path did not accept this reason.
  expect(mocks.gate!.read()).toMatchObject({ state: "needs_action", revision: paused.revision }); // Recovery is mocked; the API never cleared the risk itself.
});
