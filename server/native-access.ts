import { randomUUID } from "node:crypto";
import path from "node:path";
import { ExtensionNativeRuntime } from "./adapters/extension-native";
import type { ActionPlan } from "./adapters/contracts";
import { officialGovernor } from "./official-access";
import type { AccessContext, OwnerFence } from "./access";
import type { DatabaseSync } from "node:sqlite";
import type { OpenCbgResult } from "./types";
import { nativeWorkflowScope } from "./adapters/native-workflow";

const key = Symbol.for("cbg.native-access.v1");
type Runtime = {
  adapter?: ExtensionNativeRuntime;
  owner: string;
  heartbeat?: ReturnType<typeof setInterval>;
  governor?: ReturnType<typeof officialGovernor>;
  fence?: OwnerFence;
};
const global = globalThis as typeof globalThis & { [key]?: Runtime };
const cache = (global[key] ??= { owner: randomUUID() });
export function nativeAccessStatus() {
  return cache.adapter?.status();
}
export async function nativeAccess(db?: DatabaseSync) {
  if (!cache.adapter) {
    if (!db) db = (await import("./crawler/controller")).crawlDatabase();
    const governor = officialGovernor(db);
    cache.governor = governor;
    const owner = governor.acquireOwner(cache.owner);
    cache.fence = owner;
    cache.adapter = new ExtensionNativeRuntime({
      db,
      socketPath: path.resolve("data/cbg-access.sock"),
      stopEpoch: () => governor.read().stopEpoch,
      detailReadBudgetMs: () => governor.read().policy.detailReadBudgetMs,
      accessReady: () => governor.read().state === "ready",
      onRisk: (reason, evidence) => {
        const event =
          evidence && typeof evidence === "object" ? (evidence as Record<string, unknown>) : {};
        governor.reportRisk({
          reason: reason === "busy" ? "frequency" : reason,
          evidence,
          retryAfter: typeof event.retryAfter === "string" ? event.retryAfter : undefined,
          idempotencyKey:
            typeof event.bridgeEventId === "string" ? `native:${event.bridgeEventId}` : undefined,
        });
      },
      runAction: async <T>(plan: ActionPlan, dispatch: () => Promise<T>, signal?: AbortSignal) => {
        const scope = nativeWorkflowScope();
        const queryContext = scope?.context(plan);
        const matches =
          queryContext &&
          queryContext.pageId === plan.pageId &&
          queryContext.pageGeneration === plan.pageGeneration &&
          queryContext.browserSessionEpoch === plan.browserSessionEpoch &&
          queryContext.stopEpoch === plan.stopEpoch;
        if (!matches && governor.read().state !== "ready")
          throw new Error("暂停中的跨页面原生动作不在诊断计划内");
        const context: AccessContext = {
          ...(matches ? queryContext : {}),
          ...plan,
          ...owner,
          sourceKind: matches ? queryContext.sourceKind : "extension-native",
          ...(scope?.crawlLease ? { crawlLease: scope.crawlLease } : {}),
        };
        governor.renewOwner(owner);
        governor.registerPage(context);
        return governor.runAction(context, dispatch, signal);
      },
    });
    cache.heartbeat = setInterval(() => {
      try {
        governor.renewOwner(owner);
        // The active workflow owns its diagnostic scope. A service heartbeat must
        // not replace that scope or read a resolver from an unrelated queued job.
        const state = governor.read();
        const status = cache.adapter?.status();
        const recovering = status?.recoveringStopEpoch === state.stopEpoch;
        // A stopped runtime already rejects input. Repeating stop here would
        // invalidate the extension's read-only initial binding handshake.
        if (
          ["cooldown", "needs_action"].includes(state.state) &&
          !recovering &&
          (!status?.stopped || status.recoveringStopEpoch !== undefined)
        )
          void cache.adapter?.stop("官网访问状态已暂停");
      } catch (error) {
        void cache.adapter?.stop(error instanceof Error ? error.message : "访问状态不可用");
      }
    }, 1000);
    cache.heartbeat.unref();
  }
  await cache.adapter.start();
  return cache.adapter;
}
export function nativeAccessOwner(): OwnerFence {
  if (!cache.fence) throw new Error("原生宿主尚未启动");
  return cache.fence;
}
export async function closeNativeAccess() {
  clearInterval(cache.heartbeat);
  await cache.adapter?.close();
  cache.adapter = undefined;
}
export async function nativeBrowserState(start = false): Promise<OpenCbgResult> {
  const adapter = start ? await nativeAccess() : cache.adapter;
  const status = adapter?.status();
  let snapshot;
  try {
    snapshot = await adapter?.snapshot();
  } catch {
    /* Missing or stale observation is explicit. */
  }
  const ready =
    !!snapshot?.listing &&
    snapshot.access === "normal" &&
    snapshot.authenticated === true &&
    !snapshot.loading &&
    status?.stopped === false;
  return {
    connected: status?.connected === true,
    title: snapshot?.title ?? "扩展与 macOS 输入",
    url: snapshot?.url ?? "",
    serverName: "",
    isLoggedIn: ready,
    loginStatus: ready ? "logged_in" : snapshot?.access === "login" ? "logged_out" : "unknown",
    needLogin: snapshot?.access === "login",
    running: false,
    workflowStep: ready ? "completed" : "idle",
    message: ready
      ? "扩展已绑定角色列表，可开始采集"
      : (status?.reason ??
        "请安装原生宿主，并在官网完成登录、查询角色后点击扩展绑定；读取与输入均不连接 CDP。"),
  };
}
