import { randomUUID } from "node:crypto";
import path from "node:path";
import { ExtensionNativeRuntime } from "./adapters/extension-native";
import type { ActionPlan } from "./adapters/contracts";
import { officialGovernor } from "./official-access";
import type { AccessContext, OwnerFence } from "./access";
import type { DatabaseSync } from "node:sqlite";
import type { OpenCbgResult } from "./types";
import { nativeWorkflowScope } from "./adapters/native-workflow";
import { openNativeCbgPage } from "./native-cbg-page";

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
  // Selecting the native adapter and polling its status must be sufficient to
  // open the local listener. An explicit open request also opens the official
  // home page, but never starts a search, collection, or input workflow.
  const adapter = start || !cache.adapter ? await nativeAccess() : cache.adapter;
  if (start) await openNativeCbgPage();
  const status = adapter?.status();
  let snapshot;
  try {
    snapshot = await adapter?.snapshot();
  } catch {
    /* Missing or stale observation is explicit. */
  }
  const loggedIn =
    status?.connected === true &&
    snapshot?.access === "normal" &&
    snapshot?.authenticated === true &&
    !snapshot?.loading;
  const ready = loggedIn && !!snapshot?.listing && snapshot?.listingCommitted === true;
  return {
    connected: status?.connected === true,
    title: snapshot?.title ?? "扩展与 macOS 输入",
    url: snapshot?.url ?? "",
    serverName: "",
    isLoggedIn: loggedIn,
    loginStatus: loggedIn ? "logged_in" : snapshot?.access === "login" ? "logged_out" : "unknown",
    needLogin: snapshot?.access === "login",
    running: false,
    workflowStep: ready ? "completed" : "idle",
    message: ready
      ? status?.stopped
        ? "已自动识别角色列表，开始采集时将核验当前访问状态"
        : "扩展已自动连接角色列表，可开始采集"
      : loggedIn
        ? snapshot?.listing && !snapshot.listingCommitted
          ? "已读到角色列表，正在核验列表加载结果；核验完成后采集按钮会变为可用"
          : "藏宝阁已登录。请在官网手动完成全服搜索；角色列表加载并核验后，采集按钮会变为可用"
        : status?.stopped && status.reason === "unexpected-navigation-rebind-required"
          ? "藏宝阁页面刚发生跳转，扩展正在等待重新绑定；请将藏宝阁标签切到前台并保持打开"
          : snapshot?.access === "login"
            ? "藏宝阁需要登录，请在官网完成登录；登录状态会显示在此页面"
            : snapshot?.loading
              ? "扩展已连接，正在读取官网页面和角色列表…"
              : snapshot && snapshot.authenticated !== true
                ? "扩展已连接藏宝阁页面，但当前页面没有可确认的登录信号；登录状态尚未回显"
                : snapshot && !snapshot.listing
                  ? "扩展已连接藏宝阁页面，但还没有识别到角色列表；请在官网手动完成全服搜索"
                  : status?.connected
                    ? "宿主已连接，正在等待官网页面自动绑定；请保持藏宝阁页面打开"
                    : "正在等待 CBG 扩展自动连接；请启用扩展并打开藏宝阁官网",
  };
}
