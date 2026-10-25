import { createBackgroundPage, getBrowser, getCbgPage } from "./session";
import { buildPageState, disconnectedState } from "./page-state";
import { isNavigationTransition, readStableSnapshot, runFixedWorkflow } from "./workflow";
import type { OpenCbgResult } from "./types";
import { diagnostics, watchWorkPage, workflowDiagnostic } from "./diagnostics";
import { browserSettings } from "./browser-settings";
import { assertServiceOpen } from "./service-lifecycle";

type WorkflowCache = {
  state: OpenCbgResult;
  task: Promise<void> | null;
  lastDiagnostic: string;
  generation?: number;
};
const workflowKey = Symbol.for("cbg.workflow-state.v1");
const runtime = globalThis as typeof globalThis & { [workflowKey]?: WorkflowCache };
const cache = (runtime[workflowKey] ??= {
  state: {
    ...disconnectedState("点击开始，在本页扫码并进入角色列表。"),
    running: false,
    workflowStep: "idle",
  },
  task: null,
  lastDiagnostic: "",
});
function recordState() {
  const data = workflowDiagnostic(cache.state);
  const signature = JSON.stringify(data);
  if (signature !== cache.lastDiagnostic) diagnostics.record("workflow.state", data);
  cache.lastDiagnostic = signature;
}

export function openCbg(): OpenCbgResult {
  assertServiceOpen();
  if (cache.task) return cache.state;
  cache.generation = (cache.generation || 0) + 1;
  diagnostics.record("workflow.start");
  const started = Date.now();
  cache.state = {
    ...disconnectedState(
      browserSettings().mode === "daily"
        ? "正在连接日常 Chrome；重新连接时可能需要允许浏览器授权…"
        : "正在启动项目专用浏览器，将复用已保存的登录状态…",
    ),
    running: true,
    workflowStep: "connecting",
  };
  recordState();
  cache.task = (async () => {
    diagnostics.record("browser.connect_start");
    const browser = await getBrowser(true);
    diagnostics.record("browser.connected", { durationMs: Date.now() - started });
    diagnostics.record("page.create_start", { kind: "list" });
    const page = await createBackgroundPage(browser);
    watchWorkPage(page, "list");
    diagnostics.record("page.ready", { kind: "list" });
    cache.state = { ...cache.state, connected: true };
    cache.state = await runFixedWorkflow(page, (update) => {
      cache.state = { ...cache.state, ...update };
      recordState();
    });
    recordState();
    diagnostics.record("workflow.completed", { durationMs: Date.now() - started });
  })()
    .catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : "流程执行失败";
      const code = `CBG_${(cache.state.workflowStep || "unknown").toUpperCase()}`;
      diagnostics.record("workflow.error", { code, error, durationMs: Date.now() - started });
      const message = /Timeout/i.test(detail)
        ? "网站响应超时，请重试当前流程。"
        : detail.split("\n")[0];
      // 错误按步骤保留，不会被下一次状态轮询的“未连接”覆盖。
      cache.state = {
        ...cache.state,
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
      cache.task = null;
    });
  return cache.state;
}

export const isBrowserWorkflowRunning = () => cache.task !== null;

export function resetBrowserWorkflow() {
  if (cache.task) throw new Error("角色查询仍在运行，请等待结束后切换");
  cache.generation = (cache.generation || 0) + 1;
  cache.state = {
    ...disconnectedState("浏览器运行方式已切换，请开始查询角色列表。"),
    running: false,
    workflowStep: "idle",
  };
  recordState();
}

export async function finishBrowserWorkflow() {
  await cache.task;
}

export async function checkCbgStatus(): Promise<OpenCbgResult> {
  // 长时间等待扫码或导航时直接返回进度，不把 HTTP 请求挂在登录操作之后。
  if (cache.task || cache.state.workflowStep !== "completed") return cache.state;
  const page = getCbgPage();
  const generation = cache.generation;
  if (!page) {
    cache.state = {
      ...disconnectedState("后台工作页已关闭，请重新开始。"),
      workflowStep: "idle",
      running: false,
    };
    recordState();
    return cache.state;
  }
  try {
    const auth = buildPageState(await readStableSnapshot(page, 1500));
    if (generation !== cache.generation || page !== getCbgPage()) return cache.state;
    if (!auth.isLoggedIn)
      cache.state = {
        ...auth,
        running: false,
        workflowStep: "idle",
        message: "登录已失效，请重新开始。",
      };
    else
      cache.state = {
        ...cache.state,
        ...auth,
        message: cache.state.message,
        nickname: auth.nickname,
        accountUrs: auth.accountUrs,
        selectedRoleId: auth.selectedRoleId,
      };
  } catch (error) {
    if (generation !== cache.generation || page !== getCbgPage()) return cache.state;
    if (!isNavigationTransition(error)) {
      diagnostics.record("workflow.status_error", { error });
      cache.state = {
        ...disconnectedState("无法读取后台工作页，请重新开始。"),
        running: false,
        workflowStep: "idle",
      };
    }
  }
  recordState();
  return cache.state;
}
