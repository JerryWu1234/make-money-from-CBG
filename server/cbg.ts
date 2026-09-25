import { createBackgroundPage, getBrowser, getCbgPage } from "./session";
import { buildPageState, disconnectedState } from "./page-state";
import { isNavigationTransition, readStableSnapshot, runFixedWorkflow } from "./workflow";
import type { OpenCbgResult } from "./types";
import { diagnostics, watchWorkPage, workflowDiagnostic } from "./diagnostics";

let state: OpenCbgResult = {
  ...disconnectedState("点击开始，在本页扫码并进入角色列表。"),
  running: false,
  workflowStep: "idle",
};
let task: Promise<void> | null = null;
let lastDiagnostic = "";
function recordState() {
  const data = workflowDiagnostic(state);
  const signature = JSON.stringify(data);
  if (signature !== lastDiagnostic) diagnostics.record("workflow.state", data);
  lastDiagnostic = signature;
}

export function openCbg(): OpenCbgResult {
  if (task) return state;
  diagnostics.record("workflow.start");
  const started = Date.now();
  state = {
    ...disconnectedState("正在连接日常 Chrome，请留意首次连接的浏览器授权提示…"),
    running: true,
    workflowStep: "connecting",
  };
  recordState();
  task = (async () => {
    diagnostics.record("browser.connect_start");
    const browser = await getBrowser(true);
    diagnostics.record("browser.connected", { durationMs: Date.now() - started });
    diagnostics.record("page.create_start", { kind: "list" });
    const page = await createBackgroundPage(browser);
    watchWorkPage(page, "list");
    diagnostics.record("page.ready", { kind: "list" });
    state = { ...state, connected: true };
    state = await runFixedWorkflow(page, (update) => {
      state = { ...state, ...update };
      recordState();
    });
    recordState();
    diagnostics.record("workflow.completed", { durationMs: Date.now() - started });
  })()
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "流程执行失败";
      const code = `CBG_${(state.workflowStep || "unknown").toUpperCase()}`;
      diagnostics.record("workflow.error", { code, error, durationMs: Date.now() - started });
      const message = /Timeout/i.test(detail)
        ? "网站响应超时，请重试当前流程。"
        : detail.split("\n")[0];
      // 错误按步骤保留，不会被下一次状态轮询的“未连接”覆盖。
      state = {
        ...state,
        running: false,
        workflowStep: "error",
        message,
        error: { code, message },
        qrCodeUrl: undefined,
        accountUrs: undefined,
        nickname: undefined,
        selectedRoleId: undefined,
        isLoggedIn: false,
        loginStatus: "unknown",
        roleList: undefined,
      };
      recordState();
      console.error(`[${code}] ${detail}`);
    })
    .finally(() => {
      task = null;
    });
  return state;
}

export async function checkCbgStatus(): Promise<OpenCbgResult> {
  // 长时间等待扫码或导航时直接返回进度，不把 HTTP 请求挂在登录操作之后。
  if (task || state.workflowStep !== "completed") return state;
  const page = getCbgPage();
  if (!page) {
    state = {
      ...disconnectedState("后台工作页已关闭，请重新开始。"),
      workflowStep: "idle",
      running: false,
    };
    recordState();
    return state;
  }
  try {
    const auth = buildPageState(await readStableSnapshot(page, 1500));
    if (!auth.isLoggedIn)
      state = {
        ...auth,
        running: false,
        workflowStep: "idle",
        message: "登录已失效，请重新开始。",
      };
    else
      state = {
        ...state,
        ...auth,
        message: state.message,
        nickname: auth.nickname,
        accountUrs: auth.accountUrs,
        selectedRoleId: auth.selectedRoleId,
      };
  } catch (error) {
    if (!isNavigationTransition(error)) {
      diagnostics.record("workflow.status_error", { error });
      state = {
        ...disconnectedState("无法读取后台工作页，请重新开始。"),
        running: false,
        workflowStep: "idle",
      };
    }
  }
  recordState();
  return state;
}
