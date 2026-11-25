import { randomUUID } from "node:crypto";
import {
  nativeWorkflowActivity,
  nativeWorkflowScope,
  withNativeActivity,
  withNativeWorkflow,
} from "./native-workflow";
import {
  NATIVE_ACTIVITY_TTL_MS,
  NATIVE_ACTIVITY_HEARTBEAT_MS,
  NATIVE_ACTIVITY_PROGRESS_MS,
  type NativeActivityDriver,
  type NativeActivityHandle,
  type NativeActivityLease,
} from "./native-activity";
import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import net, { type Socket, type Server } from "node:net";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { EventEmitter } from "node:events";
import { BridgeStore, validateBridgeEnvelope } from "./bridge-store";
import {
  type ActionPlan,
  type NativeNavigationReceipt,
  type NativeNavigationDocument,
  type PageObserver,
  type PageSnapshot,
  type SemanticTarget,
  type UiDriver,
  UnsupportedAdapterOperation,
} from "./contracts";
import { parseListing } from "../crawler/listing";
import type { CrawlSource, Listing, RoleDetail } from "../crawler/types";
import { CaptureDeadlineError } from "../crawler/capture-readiness";
import { classifyBusinessResponse } from "../access/response-classifier";
import { collectNativeDetail } from "./native-capture";
import { ROLE_SERVER_TYPES } from "../role-search";
import {
  ROLE_DIAGNOSTIC_FIELDS,
  validRoleDiagnosticValue,
  type RoleDiagnosticControl,
  type RoleDiagnosticField,
} from "../query-health/role-list-diagnostics";

const textValue = (value: unknown, fallback = "") =>
  typeof value === "string" ? value.slice(0, 2000) : fallback;

const roleQueryValue = (
  field: RoleDiagnosticField,
  value: unknown,
  control: RoleDiagnosticControl,
): string | undefined => {
  if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)))
    return undefined;
  const text = String(value);
  if (!validRoleDiagnosticValue(field, text, control)) return undefined;
  return text === "" ? "" : String(Number(text));
};

const ROLE_QUERY_DIMENSIONS = ["serverid", "server_type"] as const;
type RoleQueryDimension = (typeof ROLE_QUERY_DIMENSIONS)[number];
const roleQueryDimensionValue = (field: RoleQueryDimension, value: unknown) => {
  if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value)))
    return undefined;
  const text = String(value).trim();
  if (field === "serverid") return /^\d{0,8}$/.test(text) ? text : undefined;
  const types = text.split(",");
  return types.every((type) => ROLE_SERVER_TYPES.includes(type)) &&
    new Set(types).size === types.length
    ? types.sort().join(",")
    : undefined;
};

function submittedRoleQueryControls(snapshot: PageSnapshot) {
  const fields: Partial<Record<RoleDiagnosticField, string>> = {};
  for (const field of ROLE_DIAGNOSTIC_FIELDS) {
    const control = snapshot.roleQueryControls?.[field];
    if (control === undefined) continue; // Only controls independently observed in the form.
    const value =
      control && typeof control.value === "string"
        ? roleQueryValue(field, control.value, control)
        : undefined;
    if (value === undefined)
      throw new UnsupportedAdapterOperation(`角色查询字段 ${field} 的实际值未核验`);
    fields[field] = value;
  }
  const dimensions: Partial<Record<RoleQueryDimension, string>> = {};
  for (const field of ROLE_QUERY_DIMENSIONS) {
    const observed = snapshot.roleQueryDimensions?.[field];
    if (observed === undefined) continue;
    const value =
      typeof observed === "string" ? roleQueryDimensionValue(field, observed) : undefined;
    if (value === undefined)
      throw new UnsupportedAdapterOperation(`角色查询维度 ${field} 的实际值未核验`);
    dimensions[field] = value;
  }
  return { fields, dimensions };
}

function roleQuerySubmissionMatches(
  snapshot: PageSnapshot,
  submitted: ReturnType<typeof submittedRoleQueryControls>,
) {
  const fieldsMatch = ROLE_DIAGNOSTIC_FIELDS.every((field) => {
    if (!Object.hasOwn(submitted.fields, field)) return true;
    const control = snapshot.roleQueryControls?.[field];
    if (
      !control ||
      typeof control.value !== "string" ||
      !snapshot.queryArgs ||
      Array.isArray(snapshot.queryArgs)
    )
      return false;
    // A cleared form may omit an argument; an observed numeric zero remains distinct.
    const argument = Object.hasOwn(snapshot.queryArgs, field) ? snapshot.queryArgs[field] : "";
    return (
      roleQueryValue(field, control.value, control) === submitted.fields[field] &&
      roleQueryValue(field, argument, control) === submitted.fields[field]
    );
  });
  return (
    fieldsMatch &&
    ROLE_QUERY_DIMENSIONS.every((field) => {
      if (!Object.hasOwn(submitted.dimensions, field)) return true;
      const observed = snapshot.roleQueryDimensions?.[field];
      const argument =
        snapshot.queryArgs && Object.hasOwn(snapshot.queryArgs, field)
          ? snapshot.queryArgs[field]
          : "";
      return (
        typeof observed === "string" &&
        !!snapshot.queryArgs &&
        !Array.isArray(snapshot.queryArgs) &&
        roleQueryDimensionValue(field, observed) === submitted.dimensions[field] &&
        roleQueryDimensionValue(field, argument) === submitted.dimensions[field]
      );
    })
  );
}

export interface NativeRuntimeOptions {
  db: DatabaseSync;
  socketPath: string;
  runAction: <T>(plan: ActionPlan, dispatch: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
  onRisk: (reason: string, evidence?: unknown) => void | Promise<void>;
  stopEpoch: () => number;
  accessReady?: () => boolean;
  detailReadBudgetMs?: number | (() => number);
}
export interface NativeRecoveryTicket {
  ticketId: string;
  stopEpoch: number;
  pageId: string;
  pageGeneration: number;
  browserSessionEpoch: string;
  verifiedAt: number;
}
export interface NativeRuntimeStatus {
  adapter: "extension-native";
  listening: boolean;
  connected: boolean;
  stopped: boolean;
  idle: boolean;
  pageId: string | null;
  reason: string | null;
  unknownActions: number;
  recoveringStopEpoch?: number;
}

/** Native Messaging supplies all read/wait/evidence data. This module has no Playwright/CDP dependency. */
export class ExtensionNativeRuntime implements PageObserver, UiDriver {
  readonly mode = "extension-native" as const;
  readonly observer: PageObserver = this;
  readonly driver: UiDriver = this;
  private readonly store: BridgeStore;
  private readonly events = new EventEmitter();
  private readonly snapshots = new Map<string, PageSnapshot>();
  private readonly pageBindings = new Map<
    string,
    Pick<NativeNavigationDocument, "tabId" | "windowId" | "bindingEpoch" | "connectionEpoch">
  >();
  private currentBinding?: {
    pageId: string;
    pageGeneration: number;
    tabId: number;
    windowId: number;
    bindingEpoch: string;
    connectionEpoch: string;
  };
  private userFocus?: {
    id: string;
    binding: NonNullable<ExtensionNativeRuntime["currentBinding"]>;
    socket: Socket;
    url: string;
    verifiedAt: number;
    controller: AbortController;
  };
  private readonly pageContexts = new Map<
    string,
    {
      runId: string;
      queryId: string;
      stopEpoch: number;
      pageGeneration: number;
      browserSessionEpoch: string;
      boundAt: number;
      requiredBindingEpoch?: string;
    }
  >();
  private readonly pending = new Map<
    string,
    {
      requestKind: "status" | "other";
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
    }
  >();
  private socket?: Socket;
  private server?: Server;
  private stopped = true;
  private idle = false;
  private reason: string | null = "请安装宿主并点击扩展按钮绑定官网标签页";
  private pageId: string | null = null;
  private sessionEpoch = randomUUID();
  private runId: string = randomUUID();
  private queryId: string = randomUUID();
  private activePlan?: ActionPlan;
  private recovery?: {
    ticket: NativeRecoveryTicket;
    controller: AbortController;
    prepared: boolean;
    automatic: boolean;
    focusId?: string;
  };
  private returnTarget?: {
    url: string;
    page?: number;
    category?: string;
    openedByActionId?: string;
  };
  private detailRead?: {
    controller: AbortController;
    timer?: ReturnType<typeof setTimeout>;
    timeoutMs: number;
  };
  private starting?: Promise<void>;
  private activityEpoch = 0;
  private workflowActivity?: {
    lease: NativeActivityLease;
    control: AbortController;
    timer?: ReturnType<typeof setInterval>;
    pending?: Promise<void>;
    detach: () => void;
    closed: boolean;
    suspended?: boolean;
    recoveryId?: string;
  };
  readonly activity: NativeActivityDriver = { begin: (signal) => this.beginActivity(signal) };
  constructor(private readonly options: NativeRuntimeOptions) {
    this.store = new BridgeStore(options.db);
    if (this.store.recover().length) this.reason = "上次输入结果未知，须先核验官网页面再人工继续";
  }
  private async beginActivity(
    signal: AbortSignal,
    allowRecovery = false,
  ): Promise<NativeActivityHandle> {
    signal.throwIfAborted();
    if (this.workflowActivity) throw new Error("已有原生活动工作流，不能借用其授权");
    if (this.idle && !this.recovery) await this.resumeForRun();
    signal.throwIfAborted();
    if (
      (this.stopped && !(allowRecovery && this.recovery)) ||
      !this.socket ||
      this.socket.destroyed
    )
      throw new Error("原生工作流尚未获准启动");
    const now = Date.now();
    const state: NonNullable<ExtensionNativeRuntime["workflowActivity"]> = {
      lease: {
        activityId: randomUUID(),
        authorizationEpoch: ++this.activityEpoch,
        stopEpoch: this.options.stopEpoch(),
        browserSessionEpoch: this.sessionEpoch,
        expiresAt: now + NATIVE_ACTIVITY_TTL_MS,
        progressExpiresAt: now + NATIVE_ACTIVITY_PROGRESS_MS,
        progressSequence: 0,
      },
      control: new AbortController(),
      detach: () => {},
      closed: false,
      recoveryId: this.recovery?.ticket.ticketId,
    };
    this.workflowActivity = state;
    const abort = () => {
      void this.stop("活动工作流已取消");
    };
    signal.addEventListener("abort", abort, { once: true });
    state.detach = () => signal.removeEventListener("abort", abort);
    try {
      const result = await this.request({
        kind: "activity",
        command: "begin",
        actionId: randomUUID(),
        activity: state.lease,
      });
      if (
        !result.ok ||
        result.active !== true ||
        result.activityId !== state.lease.activityId ||
        this.workflowActivity !== state
      )
        throw new Error(textValue(result.error, "输入活动授权申请失败，禁止输入"));
      signal.throwIfAborted();
      state.timer = setInterval(() => {
        if (state.pending || state.closed || state.suspended) return;
        void this.queueActivityRenew(state).catch(() => {});
      }, NATIVE_ACTIVITY_HEARTBEAT_MS);
      state.timer.unref();
      return {
        get lease() {
          return state.lease;
        },
        signal: state.control.signal,
        close: async () => {
          if (state.closed) return;
          state.closed = true;
          clearInterval(state.timer);
          state.detach();
          await state.pending;
          if (this.workflowActivity !== state) return;
          this.workflowActivity = undefined;
          if (state.suspended) return; // Input authorization was already revoked at the pause boundary.
          try {
            const ended = await this.request({
              kind: "activity",
              command: "end",
              actionId: randomUUID(),
              activity: state.lease,
            });
            if (!ended.ok || ended.active !== false || ended.activityId !== state.lease.activityId)
              throw new Error(textValue(ended.error, "活动结束未确认"));
          } catch (error) {
            if (
              this.activityEpoch === state.lease.authorizationEpoch &&
              !this.workflowActivity &&
              this.recovery?.ticket.ticketId === state.recoveryId
            )
              await this.stop("活动结束未确认，输入已停止");
            throw error;
          }
        },
      };
    } catch (error) {
      if (this.workflowActivity === state)
        await this.stop(error instanceof Error ? error.message : "活动申请失败");
      throw error;
    }
  }
  private queueActivityRenew(
    state: NonNullable<ExtensionNativeRuntime["workflowActivity"]>,
    progressActionId?: string,
  ): Promise<void> {
    const operation = (state.pending || Promise.resolve())
      .then(() => this.renewActivity(state, progressActionId))
      .catch(async (error) => {
        await this.failActivity(
          error instanceof Error ? error.message : "活动续期失败",
          state.lease,
        );
        throw error;
      });
    state.pending = operation;
    const cleanup = () => {
      if (state.pending === operation) state.pending = undefined;
    };
    void operation.then(cleanup, cleanup);
    return operation;
  }
  private async renewActivity(
    state: NonNullable<ExtensionNativeRuntime["workflowActivity"]>,
    progressActionId?: string,
  ) {
    const now = Date.now();
    if (
      state.closed ||
      this.workflowActivity !== state ||
      state.lease.stopEpoch !== this.options.stopEpoch() ||
      now >= state.lease.expiresAt ||
      now >= state.lease.progressExpiresAt
    )
      throw new Error("原生活动已过期或授权代次变化，输入已停止");
    const lease = {
      ...state.lease,
      expiresAt: now + NATIVE_ACTIVITY_TTL_MS,
      ...(progressActionId
        ? {
            progressSequence: state.lease.progressSequence + 1,
            progressActionId,
            progressExpiresAt: now + NATIVE_ACTIVITY_PROGRESS_MS,
          }
        : {}),
    };
    const result = await this.request({
      kind: "activity",
      command: "renew",
      actionId: randomUUID(),
      activity: lease,
    });
    if (
      !result.ok ||
      result.active !== true ||
      result.activityId !== lease.activityId ||
      this.workflowActivity !== state
    )
      throw new Error(textValue(result.error, "活动续期未确认"));
    state.lease = lease;
  }
  private detachActivity(reason: string) {
    const activity = this.workflowActivity;
    this.workflowActivity = undefined;
    if (activity) {
      activity.closed = true;
      clearInterval(activity.timer);
      activity.detach();
      activity.control.abort(new Error(reason));
    }
    return activity;
  }
  private async failActivity(reason: string, lease: NativeActivityLease) {
    if (
      this.workflowActivity?.lease.activityId !== lease.activityId ||
      this.workflowActivity.lease.authorizationEpoch !== lease.authorizationEpoch
    )
      return;
    await this.stop(reason);
    try {
      await this.options.onRisk("native-activity-stopped", {
        activityId: lease.activityId,
        authorizationEpoch: lease.authorizationEpoch,
        reason,
      });
    } catch {
      this.reason = "活动停止状态保存失败，禁止继续输入";
    }
  }
  /** End the ordinary lease without aborting the enclosing diagnostic workflow. */
  async suspendDiagnosticActivity() {
    const state = this.workflowActivity;
    if (!state || state.closed || state.suspended) return;
    const workflow = nativeWorkflowActivity();
    if (
      workflow?.driver !== this.activity ||
      workflow.handle.signal.aborted ||
      workflow.handle.lease.activityId !== state.lease.activityId ||
      workflow.handle.lease.authorizationEpoch !== state.lease.authorizationEpoch
    )
      throw new Error("旧工作流不能释放当前原生活动");
    if (this.activePlan) throw new Error("输入尚未结束，不能切换诊断授权");
    state.suspended = true;
    clearInterval(state.timer);
    try {
      await state.pending;
      const ended = await this.request({
        kind: "activity",
        command: "end",
        actionId: randomUUID(),
        activity: state.lease,
      });
      if (!ended.ok || ended.active !== false || ended.activityId !== state.lease.activityId)
        throw new Error("诊断前释放原生活动未确认");
    } catch (error) {
      await this.failActivity("诊断前释放原生活动失败", state.lease);
      throw error;
    }
  }
  /** Called only inside the governor-authorized dispatch, never from page messages. */
  private async activateDiagnosticActivity(plan: ActionPlan, signal: AbortSignal) {
    const state = this.workflowActivity,
      context = nativeWorkflowScope()?.context(plan);
    if (
      !state?.suspended ||
      state.closed ||
      this.stopped ||
      this.activePlan ||
      this.store.unknownCommands().length ||
      context?.purpose !== "diagnostic" ||
      !context.diagnosticPlanId ||
      context.stopEpoch !== plan.stopEpoch ||
      plan.stopEpoch !== this.options.stopEpoch() ||
      context.pageId !== plan.pageId ||
      context.pageGeneration !== plan.pageGeneration ||
      context.browserSessionEpoch !== this.sessionEpoch
    )
      throw new Error("当前动作没有诊断授权，不能切换原生活动");
    const pageContext = this.pageContexts.get(plan.pageId);
    if (!pageContext || pageContext.pageGeneration !== plan.pageGeneration)
      throw new Error("诊断页面绑定已变化");
    signal.throwIfAborted();
    try {
      pageContext.stopEpoch = plan.stopEpoch;
      pageContext.runId = plan.runId;
      pageContext.queryId = plan.queryId;
      pageContext.boundAt = Date.now();
      pageContext.requiredBindingEpoch = randomUUID();
      const resumed = await this.request({
        kind: "resume",
        actionId: randomUUID(),
        context: {
          ...pageContext,
          pageId: plan.pageId,
          recoveryEpoch: pageContext.requiredBindingEpoch,
        },
      });
      if (!resumed.ok) throw new Error("诊断授权握手未确认");
      signal.throwIfAborted();
      if (
        this.workflowActivity !== state ||
        this.stopped ||
        this.options.stopEpoch() !== plan.stopEpoch
      )
        throw new Error("诊断授权已被新的停止撤销");
      const now = Date.now();
      state.lease = {
        activityId: randomUUID(),
        authorizationEpoch: ++this.activityEpoch,
        stopEpoch: plan.stopEpoch,
        browserSessionEpoch: this.sessionEpoch,
        expiresAt: now + NATIVE_ACTIVITY_TTL_MS,
        progressExpiresAt: now + NATIVE_ACTIVITY_PROGRESS_MS,
        progressSequence: 0,
      };
      const granted = await this.request({
        kind: "activity",
        command: "begin",
        actionId: randomUUID(),
        activity: state.lease,
      });
      if (
        !granted.ok ||
        granted.active !== true ||
        granted.activityId !== state.lease.activityId ||
        this.workflowActivity !== state ||
        this.stopped ||
        this.options.stopEpoch() !== plan.stopEpoch
      )
        throw new Error("诊断输入活动授权未获准，禁止输入");
      state.suspended = false;
      state.timer = setInterval(() => {
        if (state.pending || state.closed || state.suspended) return;
        void this.queueActivityRenew(state).catch(() => {});
      }, NATIVE_ACTIVITY_HEARTBEAT_MS);
      state.timer.unref();
      await this.waitFor(
        (value) =>
          value.context.stopEpoch === plan.stopEpoch &&
          value.context.pageGeneration === plan.pageGeneration &&
          value.authenticated === true &&
          value.access === "normal" &&
          !value.loading &&
          value.visible,
        { pageId: plan.pageId, after: "", timeoutMs: 5000, signal },
      );
      signal.throwIfAborted();
      if (
        this.workflowActivity !== state ||
        this.stopped ||
        this.options.stopEpoch() !== plan.stopEpoch
      )
        throw new Error("诊断页面等待期间授权已撤销");
    } catch (error) {
      await this.failActivity("诊断授权切换失败，已停止输入", state.lease);
      throw error;
    }
  }
  status(): NativeRuntimeStatus {
    return {
      adapter: this.mode,
      listening: !!this.server?.listening,
      connected: !!this.socket && !this.socket.destroyed,
      stopped: this.stopped,
      idle: this.idle,
      pageId: this.pageId,
      reason: this.reason,
      unknownActions: this.store.unknownCommands().length,
      ...(this.recovery ? { recoveringStopEpoch: this.recovery.ticket.stopEpoch } : {}),
    };
  }
  start(): Promise<void> {
    if (this.server?.listening) return Promise.resolve();
    return (this.starting ??= this.listen().finally(() => {
      this.starting = undefined;
    }));
  }
  private async listen() {
    const file = this.options.socketPath;
    if (!path.isAbsolute(file) || Buffer.byteLength(file) > 100)
      throw new Error("原生桥接 Unix socket 路径无效");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isSocket() || stat.uid !== process.getuid?.())
        throw new Error("原生桥接路径不属于当前用户的 socket");
      await new Promise<void>((resolve, reject) => {
        const probe = net.connect(file);
        probe.once("connect", () => {
          probe.destroy();
          reject(new Error("已有原生桥接实例运行，拒绝争抢会话"));
        });
        probe.once("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNREFUSED" || error.code === "ENOENT") resolve();
          else reject(error);
        });
      });
      unlinkSync(file);
    }
    const server = net.createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(file, () => {
        server.off("error", reject);
        resolve();
      });
    });
    chmodSync(file, 0o600);
    this.server = server;
  }
  private accept(socket: Socket) {
    if (this.socket && !this.socket.destroyed) {
      socket.destroy();
      return;
    }
    this.socket = socket;
    let buffer = "",
      processing: Promise<void> = Promise.resolve();
    socket.setEncoding("utf8");
    socket.on("data", (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 1024 * 1024) {
        void this.stop("bridge-message-size");
        socket.destroy();
        return;
      }
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        try {
          const value: unknown = JSON.parse(line);
          processing = processing
            .then(() => this.receive(value))
            .catch((error) =>
              this.stop(error instanceof Error ? error.message : "bridge-invalid-message"),
            );
        } catch (error) {
          void this.stop(error instanceof Error ? error.message : "bridge-invalid-message");
        }
      }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (this.workflowActivity)
        void this.failActivity("宿主连接中断，输入结果须人工核验", this.workflowActivity.lease);
      else void this.stop("宿主连接中断，输入结果须人工核验");
      this.stopped = true;
      this.reason = "宿主连接中断，输入结果须人工核验";
      for (const value of this.pending.values()) value.reject(new Error(this.reason));
      this.pending.clear();
      this.events.emit("change");
      if (this.activePlan) void this.options.onRisk(this.reason);
    });
  }
  private async receive(value: unknown) {
    if (!value || typeof value !== "object") throw new Error("bridge-schema");
    const message = value as Record<string, unknown>;
    if (message.kind === "host-hello") {
      if (message.version !== 1) throw new Error("native-protocol-version");
      return;
    }
    if (message.kind === "input-result") {
      const id = String(message.actionId);
      const pending = this.pending.get(id);
      if (pending) {
        this.pending.delete(id);
        pending.resolve(message);
      }
      return;
    }
    if (message.kind === "host-status") {
      this.cancelUserFocus();
      const activity = this.detachActivity(String(message.reason));
      if (message.reason !== "server-stop") this.idle = false;
      this.stopped = true;
      this.reason = String(message.reason);
      for (const [id, pending] of this.pending) {
        // An earlier stop notification may overtake a new read-only status request.
        // Keep waiting for its real, same-action reply; never preserve input authorization.
        if (message.reason === "server-stop" && pending.requestKind === "status") continue;
        this.pending.delete(id);
        pending.reject(new Error(this.reason));
      }
      this.events.emit("change");
      if (activity && message.reason !== "server-stop") {
        try {
          await this.options.onRisk("native-activity-stopped", {
            activityId: activity.lease.activityId,
            reason: message.reason,
          });
        } catch {
          this.reason = "宿主停止状态保存失败，禁止继续输入";
        }
      }
      return;
    }
    const envelope = validateBridgeEnvelope(value);
    // Parse before committing a receipt, so malformed messages are never ACKed as accepted data.
    const snapshot =
      envelope.kind === "snapshot" ? this.decodeSnapshot(envelope.payload) : undefined;
    if (snapshot && !["normal", "unknown"].includes(snapshot.access)) {
      await this.stop(`官网访问需要处理：${snapshot.access}`);
      // Persist the shared stop before receipt/ACK. Retry uses the governor's durable event key.
      await this.options.onRisk(snapshot.access, {
        ...snapshot.context,
        bridgeEventId: `bridge:${envelope.connectionEpoch}:${envelope.messageId}`,
      });
    }
    if (snapshot)
      for (const business of snapshot.business || []) {
        const decision = classifyBusinessResponse({
          url: "https://xyq.cbg.163.com" + business.endpoint,
          status: business.status,
          resourceType: business.kind === "jsonp" ? "script" : business.kind,
          mainFrame: true,
          body: business.denial ? JSON.stringify(business.denial) : undefined,
        });
        if (decision.kind === "blocked") {
          await this.stop(`官网业务响应要求处理：${decision.reason}`);
          await this.options.onRisk(decision.reason, {
            ...snapshot.context,
            bridgeEventId: `business:${snapshot.context.pageId}:${business.eventId || business.observedAt || envelope.messageId}`,
            endpoint: business.endpoint,
          });
        }
      }
    if (envelope.kind === "status") {
      const payload = envelope.payload as Record<string, unknown>,
        context = this.pageContexts.get(String(payload.pageId));
      if (
        ["http_403", "http_429"].includes(String(payload.risk)) &&
        context &&
        context.pageGeneration === payload.pageGeneration
      ) {
        await this.stop(String(payload.risk));
        await this.options.onRisk(String(payload.risk), {
          ...context,
          bridgeEventId: `bridge:${envelope.connectionEpoch}:${envelope.messageId}`,
          retryAfter: payload.retryAfter,
          endpoint: payload.endpoint,
        });
      }
    }
    const result = this.store.receive(envelope);
    if (snapshot) {
      // A durable duplicate may follow a lost ACK; restore current read-only state as well.
      const existing = this.snapshots.get(snapshot.context.pageId);
      if (
        !existing ||
        Date.parse(snapshot.context.observedAt) >= Date.parse(existing.context.observedAt)
      ) {
        if (snapshot) {
          this.snapshots.set(snapshot.context.pageId, snapshot);
          this.pageId = snapshot.context.pageId;
          if (this.snapshots.size > 8) this.snapshots.delete(this.snapshots.keys().next().value!);
        }
      }
      this.events.emit("change");
    }
    if (result === "new") {
      if (envelope.kind === "status") {
        const payload = envelope.payload as Record<string, unknown>;
        if (
          (payload.bound ||
            (payload.navigated && this.activePlan?.actionId === payload.actionId)) &&
          typeof payload.pageId === "string" &&
          Number.isSafeInteger(payload.tabId) &&
          Number.isSafeInteger(payload.windowId) &&
          typeof payload.bindingEpoch === "string"
        ) {
          this.pageBindings.set(payload.pageId, {
            tabId: Number(payload.tabId),
            windowId: Number(payload.windowId),
            bindingEpoch: payload.bindingEpoch,
            connectionEpoch: envelope.connectionEpoch,
          });
          this.currentBinding = {
            pageId: payload.pageId,
            pageGeneration: Number(payload.pageGeneration),
            ...this.pageBindings.get(payload.pageId)!,
          };
        }
        if (
          payload.navigated &&
          this.activePlan &&
          this.activePlan.actionId === payload.actionId &&
          typeof payload.pageId === "string"
        ) {
          const active = this.activePlan;
          this.pageContexts.set(payload.pageId, {
            runId: active.runId,
            queryId: active.queryId,
            stopEpoch: active.stopEpoch,
            pageGeneration: Number(payload.pageGeneration),
            browserSessionEpoch: active.browserSessionEpoch,
            boundAt: Date.now(),
          });
        }
        if (payload.stopped) {
          const binding = this.currentBinding;
          if (
            binding &&
            binding.connectionEpoch === envelope.connectionEpoch &&
            binding.pageId === payload.pageId &&
            binding.pageGeneration === payload.pageGeneration &&
            binding.tabId === payload.tabId &&
            binding.windowId === payload.windowId &&
            binding.bindingEpoch === payload.bindingEpoch
          )
            await this.stop(textValue(payload.reason, "扩展停止"));
        } else if (
          payload.bound &&
          typeof payload.pageId === "string" &&
          Number.isSafeInteger(payload.pageGeneration)
        ) {
          this.idle = false;
          this.sessionEpoch = randomUUID();
          this.snapshots.clear();
          this.pageContexts.clear();
          this.pageContexts.set(payload.pageId, {
            runId: this.runId,
            queryId: this.queryId,
            stopEpoch: this.options.stopEpoch(),
            pageGeneration: Number(payload.pageGeneration),
            browserSessionEpoch: this.sessionEpoch,
            boundAt: Date.now(),
          });
          this.stopped = true;
          this.reason = "正在绑定扩展与宿主授权代次";
          const boundContext = this.pageContexts.get(payload.pageId)!;
          void this.request({
            kind: "resume",
            actionId: randomUUID(),
            context: { ...boundContext, pageId: payload.pageId },
          })
            .then((result) => {
              if (!result.ok) throw new Error(textValue(result.error, "宿主绑定失败"));
              if (
                this.pageContexts.get(String(payload.pageId)) !== boundContext ||
                this.options.stopEpoch() !== boundContext.stopEpoch
              )
                return;
              if (
                !this.store.unknownCommands().length &&
                (!this.options.accessReady || this.options.accessReady())
              ) {
                this.stopped = false;
                this.reason = null;
                this.events.emit("change");
              } else this.reason = "访问暂停或存在未知动作，等待人工核验";
            })
            .catch((error) => this.stop(error instanceof Error ? error.message : "宿主绑定失败"));
        }
      }
      this.events.emit("change");
    }
    this.socket?.write(
      `${JSON.stringify({ kind: "ack", connectionEpoch: envelope.connectionEpoch, messageId: envelope.messageId, sequence: envelope.sequence })}\n`,
    );
  }
  private decodeSnapshot(value: unknown): PageSnapshot | undefined {
    if (!value || typeof value !== "object") throw new Error("snapshot-schema");
    const input = value as Record<string, unknown>;
    const url = new URL(String(input.url));
    if (
      url.origin !== "https://xyq.cbg.163.com" ||
      url.username ||
      url.password ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(String(input.pageId)) ||
      !Number.isSafeInteger(input.pageGeneration) ||
      Number(input.pageGeneration) < 1 ||
      !["normal", "login", "verification", "busy", "unknown"].includes(String(input.access)) ||
      !Number.isFinite(Date.parse(String(input.observedAt)))
    )
      throw new Error("snapshot-identity");
    const now = new Date().toISOString();
    if (Date.parse(String(input.observedAt)) > Date.now() + 2000) return undefined; // Untrusted future timestamps never refresh current state.
    const action = input.actionContext as Partial<ActionPlan> | undefined;
    const active = this.activePlan;
    if (
      active &&
      action?.actionId === active.actionId &&
      action.stopEpoch === active.stopEpoch &&
      action.queryId === active.queryId &&
      (active.pageId === input.pageId ||
        active.expected.kind === "detail" ||
        active.target.kind === "market-entry" ||
        active.target.kind === "return-to-list" ||
        active.target.kind === "refresh-list")
    )
      this.pageContexts.set(String(input.pageId), {
        runId: active.runId,
        queryId: active.queryId,
        stopEpoch: active.stopEpoch,
        pageGeneration: Number(input.pageGeneration),
        browserSessionEpoch: active.browserSessionEpoch,
        boundAt: this.pageContexts.get(String(input.pageId))?.boundAt ?? Date.now(),
      });
    const context = this.pageContexts.get(String(input.pageId));
    const binding = input.bindingContext as { recoveryEpoch?: string } | undefined;
    if (context?.requiredBindingEpoch && binding?.recoveryEpoch !== context.requiredBindingEpoch)
      return undefined;
    if (
      !context ||
      context.pageGeneration !== input.pageGeneration ||
      Date.parse(String(input.observedAt)) < context.boundAt - 100
    )
      return undefined; // Persist/ACK old evidence as archive, never current state.
    const snapshot: PageSnapshot = {
      context: {
        schemaVersion: 1,
        runId: context.runId,
        queryId: context.queryId,
        stopEpoch: context.stopEpoch,
        pageGeneration: context.pageGeneration,
        browserSessionEpoch: context.browserSessionEpoch,
        actionId: active && action?.actionId === active.actionId ? active.actionId : null,
        pageId: String(input.pageId),
        observedAt: String(input.observedAt),
        receivedAt: now,
        sourceKind: this.mode,
      },
      url: url.toString(),
      title: textValue(input.title).slice(0, 500),
      revision: String(input.revision),
      visible: input.visible === true,
      loading: input.loading === true,
      access: input.access as PageSnapshot["access"],
      empty: input.empty === true,
    };
    if (typeof input.authenticated === "boolean") snapshot.authenticated = input.authenticated;
    if (input.targetObservation && typeof input.targetObservation === "object")
      snapshot.targetObservation = input.targetObservation as PageSnapshot["targetObservation"];
    if (input.viewport && typeof input.viewport === "object")
      snapshot.viewport = input.viewport as PageSnapshot["viewport"];
    if (typeof input.listingCommitted === "boolean")
      snapshot.listingCommitted = input.listingCommitted;
    if (input.listingCommit && typeof input.listingCommit === "object")
      snapshot.listingCommit = input.listingCommit as PageSnapshot["listingCommit"];
    if (input.productIdentity && typeof input.productIdentity === "object")
      snapshot.productIdentity = input.productIdentity as PageSnapshot["productIdentity"];
    if (input.detail && typeof input.detail === "object")
      snapshot.detail = input.detail as RoleDetail;
    if (["selling", "unavailable", "unknown"].includes(String(input.productState)))
      snapshot.productState = input.productState as PageSnapshot["productState"];
    if (input.marketProduct && typeof input.marketProduct === "object")
      snapshot.marketProduct = input.marketProduct as PageSnapshot["marketProduct"];
    if (input.queryArgs && typeof input.queryArgs === "object")
      snapshot.queryArgs = input.queryArgs as Record<string, string | number>;
    if (input.market && typeof input.market === "object")
      snapshot.market = input.market as PageSnapshot["market"];
    if (input.petProof && typeof input.petProof === "object")
      snapshot.petProof = input.petProof as PageSnapshot["petProof"];
    if (input.productRevision && typeof input.productRevision === "string")
      snapshot.productRevision = input.productRevision;
    if (input.controls && typeof input.controls === "object")
      snapshot.controls = input.controls as PageSnapshot["controls"];
    if (input.wornEquipment && typeof input.wornEquipment === "object")
      snapshot.wornEquipment = input.wornEquipment as PageSnapshot["wornEquipment"];
    if (input.valuationSource && typeof input.valuationSource === "object")
      snapshot.valuationSource = input.valuationSource as Record<string, unknown>;
    if (input.formValues && typeof input.formValues === "object")
      snapshot.formValues = input.formValues as Record<string, string>;
    if (input.roleQueryControls && typeof input.roleQueryControls === "object")
      snapshot.roleQueryControls = input.roleQueryControls as PageSnapshot["roleQueryControls"];
    if (input.roleQueryDimensions && typeof input.roleQueryDimensions === "object")
      snapshot.roleQueryDimensions =
        input.roleQueryDimensions as PageSnapshot["roleQueryDimensions"];
    if (Array.isArray(input.business))
      snapshot.business = input.business.slice(-12) as PageSnapshot["business"];
    if (input.listing && typeof input.listing === "object") {
      const listing = input.listing as {
        page: number;
        totalPages: number;
        order: string;
        serverType: string;
        items: {
          href: string;
          attrs: Record<string, string>;
          summary: unknown;
          raw?: Record<string, unknown>;
        }[];
      };
      if (
        !Number.isSafeInteger(listing.page) ||
        listing.page < 1 ||
        !Number.isSafeInteger(listing.totalPages) ||
        !Array.isArray(listing.items) ||
        listing.items.length > 1000
      )
        throw new Error("listing-schema");
      if (
        listing.serverType.split(",").sort().join(",") !== [...ROLE_SERVER_TYPES].sort().join(",")
      )
        throw new Error("当前列表未确认全部三个服龄条件，请重新搜索后继续");
      snapshot.listing = {
        page: listing.page,
        totalPages: listing.totalPages,
        order: listing.order,
        items: listing.items.map((item) =>
          parseListing(item.href, item.attrs, item.summary, listing.order, item.raw),
        ),
      };
    }
    return snapshot;
  }
  async snapshot(pageId = this.pageId || ""): Promise<PageSnapshot> {
    const snapshot = this.snapshots.get(pageId);
    if (
      !snapshot ||
      Date.now() - Date.parse(snapshot.context.receivedAt) > 10_000 ||
      Date.now() - Date.parse(snapshot.context.observedAt) > 10_000 ||
      Date.parse(snapshot.context.observedAt) > Date.now() + 2000
    )
      throw new Error("官网观察快照缺失或过期，请重新绑定扩展标签页");
    return structuredClone(snapshot);
  }
  waitFor(
    predicate: (value: PageSnapshot) => boolean,
    options: { pageId: string; after: string; timeoutMs: number; signal?: AbortSignal },
  ): Promise<PageSnapshot> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.events.off("change", check);
        options.signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        reject(options.signal?.reason || new Error("观察已取消"));
      };
      const check = () => {
        if (options.signal?.aborted) return abort();
        for (const snapshot of this.snapshots.values()) {
          if (options.pageId && snapshot.context.pageId !== options.pageId) continue;
          if (snapshot.revision !== options.after && predicate(snapshot)) {
            cleanup();
            resolve(structuredClone(snapshot));
            return;
          }
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("官网动作结果未知，未自动重放输入"));
      }, options.timeoutMs);
      this.events.on("change", check);
      options.signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  }
  async evidence(pageId: string) {
    const snapshot = await this.snapshot(pageId);
    return { context: snapshot.context, revision: snapshot.revision, snapshot };
  }
  private request(
    message: Record<string, unknown>,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new Error("原生宿主未连接"));
    const id = textValue(message.actionId, (message.plan as ActionPlan)?.actionId || "");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("原生输入回执未知，禁止自动重放"));
      }, timeoutMs);
      this.pending.set(id, {
        requestKind:
          message.kind === "command" && message.command === "status" ? "status" : "other",
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.socket!.write(`${JSON.stringify(message)}\n`);
    });
  }
  private startDetailReadBudget() {
    const read = this.detailRead;
    if (!read || read.timer) return;
    const budget =
      typeof this.options.detailReadBudgetMs === "function"
        ? this.options.detailReadBudgetMs()
        : (this.options.detailReadBudgetMs ?? 900_000);
    if (!Number.isSafeInteger(budget) || budget < 1 || budget > 24 * 60 * 60 * 1000)
      throw new Error("原生详情读取预算无效");
    read.timeoutMs = budget;
    read.timer = setTimeout(
      () => read.controller.abort(new CaptureDeadlineError(budget, "原生详情读取")),
      budget,
    );
  }
  async nativeStatus() {
    return this.request({ kind: "command", command: "status", actionId: randomUUID() });
  }
  /** Explicit user task preparation only. This does not grant input authority. */
  async focusBoundPage(): Promise<{ id: string }> {
    const binding = this.currentBinding;
    const snapshot = binding && this.snapshots.get(binding.pageId);
    const socket = this.socket;
    if (!binding || !snapshot || !socket || socket.destroyed)
      throw new Error("官网尚未自动绑定，无法切换到角色列表");
    const focus = {
      id: randomUUID(),
      binding,
      socket,
      url: snapshot.url,
      verifiedAt: 0,
      controller: new AbortController(),
    };
    this.cancelUserFocus();
    const epoch = this.options.stopEpoch();
    this.userFocus = focus;
    const assertCurrent = () => {
      this.assertFocusedPage(focus, false);
      if (this.options.stopEpoch() !== epoch) throw new Error("聚焦期间访问状态已变化");
    };
    try {
      const result = await this.request({
        kind: "command",
        command: "focus",
        actionId: randomUUID(),
        context: { ...binding, url: snapshot.url },
      });
      assertCurrent();
      if (!result.ok || result.posted !== false)
        throw new Error(textValue(result.error, "无法切换到已绑定的官网页面"));
      const startedAt = Date.now();
      const observed = await this.request({
        kind: "command",
        command: "observe",
        actionId: randomUUID(),
      });
      assertCurrent();
      if (!observed.ok) throw new Error("无法读取聚焦后的官网页面");
      await this.waitFor(
        (value) =>
          value.visible &&
          !value.loading &&
          value.access === "normal" &&
          value.authenticated === true &&
          value.context.pageGeneration === binding.pageGeneration &&
          value.url === focus.url &&
          Date.parse(value.context.observedAt) >= startedAt,
        { pageId: binding.pageId, after: "", timeoutMs: 5000, signal: focus.controller.signal },
      );
      assertCurrent();
      focus.verifiedAt = Date.now();
      return { id: focus.id };
    } catch (error) {
      if (this.userFocus === focus) this.userFocus = undefined;
      throw error;
    }
  }
  private cancelUserFocus() {
    if (this.userFocus && this.recovery?.focusId === this.userFocus.id)
      this.recovery.controller.abort(new Error("官网聚焦已取消"));
    this.userFocus?.controller.abort(new Error("官网聚焦已取消"));
    this.userFocus = undefined;
  }
  assertFocusedPage(receipt: { id: string }, verified = true): void {
    const focus = this.userFocus;
    if (
      !focus ||
      focus.id !== receipt.id ||
      focus.controller.signal.aborted ||
      this.currentBinding !== focus.binding ||
      this.socket !== focus.socket ||
      focus.socket.destroyed ||
      this.snapshots.get(focus.binding.pageId)?.url !== focus.url ||
      (verified && (!focus.verifiedAt || Date.now() - focus.verifiedAt > 5000))
    )
      throw new Error("官网聚焦状态已失效，请重新开始当前任务");
  }
  async execute(plan: ActionPlan, signal?: AbortSignal): Promise<PageSnapshot> {
    const workflow = nativeWorkflowActivity();
    if (workflow?.driver !== this.activity) {
      const local = signal || new AbortController().signal;
      return nativeWorkflowScope()
        ? withNativeActivity(this.activity, local, () => this.execute(plan, local))
        : withNativeWorkflow(local, () => this.execute(plan, local), {
            context: () => undefined,
            activity: this.activity,
          });
    }
    let activity = this.workflowActivity;
    if (
      !activity ||
      activity.closed ||
      workflow.handle.lease.activityId !== activity.lease.activityId
    )
      throw new Error("原生活动授权已失效");
    signal = AbortSignal.any([...(signal ? [signal] : []), workflow.handle.signal]);
    plan = { ...plan, activity: { ...activity.lease } };
    if (this.detailRead)
      signal = signal
        ? AbortSignal.any([signal, this.detailRead.controller.signal])
        : this.detailRead.controller.signal;
    signal?.throwIfAborted();
    if (this.stopped || this.activePlan) throw new Error(this.reason || "原生输入正在执行");
    const before = await this.snapshot(plan.pageId);
    if (
      plan.pageGeneration !== before.context.pageGeneration ||
      plan.browserSessionEpoch !== this.sessionEpoch ||
      plan.stopEpoch !== this.options.stopEpoch()
    )
      throw new Error("原生输入计划代次已过期");
    const target = plan.target;
    const alreadySatisfied =
      target.kind === "detail-tab"
        ? before.detail?.tabs[0]?.name === target.name
        : target.kind === "detail-subtab"
          ? before.detail?.tabs[0]?.name === `${target.parent} / ${target.name}`
          : target.kind === "detail-entry"
            ? before.controls?.[
                target.section === "pet"
                  ? "selectedPet"
                  : target.section === "mount"
                    ? "selectedMount"
                    : "selectedChild"
              ] === target.index
            : target.kind === "query-field" || target.kind === "market-field"
              ? (target.kind === "query-field"
                  ? before.roleQueryControls?.[target.field]?.value
                  : before.formValues?.[target.field]) === target.value
              : target.kind === "market-choice"
                ? before.market?.menus
                    ?.find((menu) => menu.id === target.panel)
                    ?.choices.some((choice) => choice.value === target.values[0] && choice.selected)
                : target.kind === "market-expand"
                  ? before.market?.expanded?.[target.panel] === true
                  : target.kind === "market-reset-server"
                    ? [
                        "user_serverid",
                        "cross_buy_serverid",
                        "crossbuy_serverid",
                        "buy_serverid",
                      ].filter((key) => Object.hasOwn(before.formValues || {}, key)).length > 0 &&
                      ["user_serverid", "cross_buy_serverid", "crossbuy_serverid", "buy_serverid"]
                        .filter((key) => Object.hasOwn(before.formValues || {}, key))
                        .every((key) => ["", "0"].includes(before.formValues![key]))
                    : target.kind === "market-reset"
                      ? !!before.market &&
                        !!before.formValues &&
                        Object.entries(before.formValues)
                          .filter(
                            ([key]) =>
                              !/^(overall_sel_area|ovarall_sel_server|level_min|level_max)$/.test(
                                key,
                              ),
                          )
                          .every(([, value]) => ["", "0", "false"].includes(value)) &&
                        (before.market?.menus || []).every((menu) =>
                          menu.choices.every(
                            (choice) => !choice.selected || ["", "0"].includes(choice.value),
                          ),
                        )
                      : false;
    if (alreadySatisfied) return before; // Read-only preparation; submit/page/refresh still need a new commit.
    let preflightError: Error | undefined;
    const outcome = await this.options.runAction(
      plan,
      async () => {
        if (activity!.suspended) {
          await this.activateDiagnosticActivity(plan, signal!);
          activity = this.workflowActivity!;
          plan = { ...plan, activity: { ...activity.lease } };
        }
        let submittedRoleControls: ReturnType<typeof submittedRoleQueryControls> | undefined;
        if (plan.target.kind === "query" && plan.expected.kind === "page") {
          const submitting = await this.snapshot(plan.pageId);
          if (
            submitting.context.pageGeneration !== plan.pageGeneration ||
            submitting.context.browserSessionEpoch !== plan.browserSessionEpoch ||
            plan.stopEpoch !== this.options.stopEpoch()
          )
            throw new Error("角色查询提交时页面或授权代次已变化");
          submittedRoleControls = submittedRoleQueryControls(submitting);
        }
        this.startDetailReadBudget();
        this.activePlan = plan;
        const abort = () => {
          void this.stop("用户取消输入");
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          if (plan.target.kind === "listing-detail" && (before.listing || before.market))
            this.returnTarget = {
              url: before.url,
              page: before.listing?.page,
              category: before.market?.category,
              openedByActionId: plan.actionId,
            };
          this.store.authorize(plan.actionId, plan);
          const fromBinding = this.pageBindings.get(before.context.pageId);
          const dispatchedAt = Date.now();
          const result = await this.request({ kind: "command", command: "execute", plan });
          if (!result.ok) {
            if (result.posted === false) {
              preflightError = new UnsupportedAdapterOperation(
                textValue(result.error, "原生输入预检"),
              );
              this.store.result(plan.actionId, {
                state: "not_dispatched",
                error: String(result.error),
              });
              await this.stop(preflightError.message);
              return before;
            }
            throw new Error(textValue(result.error, "原生输入失败"));
          }
          const inputPostedAt = Date.now();
          const inputConfirmedAt = inputPostedAt;
          const priorRequests = new Set(before.business?.map((event) => event.requestId));
          const priorEvents = new Set(before.business?.map((event) => event.eventId));
          const freshMarketCommit = (value: PageSnapshot) => {
            const commit = value.market?.commit;
            if (
              !commit ||
              !value.market?.committed ||
              commit.actionId !== plan.actionId ||
              commit.queryId !== plan.queryId ||
              !commit.requestId ||
              !commit.eventId ||
              priorRequests.has(commit.requestId) ||
              priorEvents.has(commit.eventId)
            )
              return false;
            const response = value.business?.find(
              (event) => event.eventId === commit.eventId && event.requestId === commit.requestId,
            );
            if (
              !response?.success ||
              response.requestId !== commit.requestId ||
              response.eventId !== commit.eventId ||
              response.actionId !== plan.actionId ||
              response.queryId !== plan.queryId ||
              response.startedAt !== commit.startedAt ||
              response.observedAt !== commit.completedAt ||
              response.count !== value.market.rows.length
            )
              return false;
            const started = Date.parse(commit.startedAt),
              completed = Date.parse(commit.completedAt);
            return (
              Number.isFinite(started) &&
              Number.isFinite(completed) &&
              started >= dispatchedAt &&
              completed >= started &&
              completed <= Date.parse(value.context.observedAt)
            );
          };
          const observed = await this.waitFor(
            (value) => {
              if (
                value.context.actionId !== plan.actionId ||
                Date.parse(value.context.observedAt) < inputPostedAt
              )
                return false;
              if (value.access !== "normal" || value.loading || !value.visible) return false;
              if (plan.target.kind === "scroll") {
                const beforeY = before.viewport?.scrollY,
                  afterY = value.viewport?.scrollY;
                return (
                  (beforeY !== undefined &&
                    afterY !== undefined &&
                    (afterY - beforeY) * plan.target.deltaY > 0) ||
                  (value.targetObservation?.actionId === plan.actionId &&
                    typeof result.scrollFromY === "number" &&
                    (value.targetObservation.rect.y - result.scrollFromY) * plan.target.deltaY < 0)
                );
              }
              if (plan.target.kind === "return-to-list")
                return value.url === plan.target.url && (!!value.listing || !!value.market);
              if (plan.expected.kind === "page") {
                if (
                  !value.listing ||
                  value.listing.page !== plan.expected.page ||
                  !value.listingCommitted
                )
                  return false;
                if (plan.target.kind === "sort" && value.listing.order !== plan.target.value)
                  return false;
                if (
                  submittedRoleControls &&
                  !roleQuerySubmissionMatches(value, submittedRoleControls)
                )
                  return false;
                return (
                  value.context.pageId !== before.context.pageId ||
                  value.context.pageGeneration !== before.context.pageGeneration ||
                  value.listingCommit?.actionId === plan.actionId
                );
              }
              if (plan.expected.kind === "detail")
                return (
                  value.productIdentity?.serverId === plan.expected.serverId &&
                  value.productIdentity.eid === plan.expected.eid
                );
              if (plan.target.kind === "detail-tab")
                return (
                  value.detail?.tabs.some(
                    (tab) => plan.target.kind === "detail-tab" && tab.name === plan.target.name,
                  ) || false
                );
              if (plan.target.kind === "detail-subtab")
                return (
                  value.detail?.tabs.some(
                    (tab) =>
                      plan.target.kind === "detail-subtab" &&
                      tab.name.endsWith(" / " + plan.target.name),
                  ) || false
                );
              if (plan.target.kind === "detail-entry") {
                const key =
                  plan.target.section === "pet"
                    ? "selectedPet"
                    : plan.target.section === "mount"
                      ? "selectedMount"
                      : "selectedChild";
                return value.controls?.[key] === plan.target.index;
              }
              if (plan.target.kind === "inspect-item")
                return !!value.detail?.tabs.some((tab) =>
                  tab.tooltips.some(
                    (tip) => plan.target.kind === "inspect-item" && tip.includes(plan.target.name),
                  ),
                );
              if (plan.target.kind === "market-entry")
                return value.market?.category === plan.target.category;
              if (plan.target.kind === "market-field")
                return value.formValues?.[plan.target.field] === plan.target.value;
              if (plan.target.kind === "market-choice")
                return (
                  value.market?.menus
                    ?.find(
                      (menu) =>
                        plan.target.kind === "market-choice" && menu.id === plan.target.panel,
                    )
                    ?.choices.some(
                      (choice) =>
                        plan.target.kind === "market-choice" &&
                        choice.value === plan.target.values[0] &&
                        choice.selected,
                    ) === true
                );
              if (plan.target.kind === "market-level-handle")
                return (
                  Number(
                    value.formValues?.[
                      plan.target.handle === "minimum" ? "level_min" : "level_max"
                    ],
                  ) === plan.target.value
                );
              if (plan.target.kind === "market-level")
                return (
                  Number(value.formValues?.level_min) === plan.target.minimum &&
                  Number(value.formValues?.level_max) === plan.target.maximum
                );
              if (plan.target.kind === "market-submit")
                return (
                  value.market?.category === plan.target.category &&
                  value.market.page === 1 &&
                  freshMarketCommit(value) &&
                  value.context.queryId === plan.queryId
                );
              if (plan.target.kind === "market-page")
                return (
                  value.market?.page === plan.target.page &&
                  freshMarketCommit(value) &&
                  value.context.queryId === plan.queryId
                );
              if (plan.target.kind === "market-expand")
                return value.market?.expanded?.[plan.target.panel] === true;
              if (plan.target.kind === "market-reset-server") {
                const keys = [
                  "user_serverid",
                  "cross_buy_serverid",
                  "crossbuy_serverid",
                  "buy_serverid",
                ].filter((key) => Object.hasOwn(value.formValues || {}, key));
                return (
                  keys.length > 0 && keys.every((key) => ["", "0"].includes(value.formValues![key]))
                );
              }
              if (plan.target.kind === "market-reset")
                return (
                  !!value.formValues &&
                  Object.entries(value.formValues)
                    .filter(([key]) => /^(?:txt_|pet_select_box)/.test(key))
                    .every(([, field]) => field === "" || field === "0")
                );
              if (plan.target.kind === "sort")
                return (
                  freshMarketCommit(value) &&
                  !!value.market?.order &&
                  value.context.queryId === plan.queryId
                );
              if (plan.target.kind === "query-field")
                return value.roleQueryControls?.[plan.target.field]?.value === plan.target.value;
              return false; // No generic mutation or sent-event success counts as a confirmed business result.
            },
            {
              pageId:
                plan.expected.kind === "detail" ||
                plan.target.kind === "return-to-list" ||
                plan.target.kind === "refresh-list" ||
                plan.target.kind === "market-entry"
                  ? ""
                  : plan.pageId,
              after: before.revision,
              timeoutMs: 12_000,
              signal,
            },
          );
          if (plan.stopEpoch !== this.options.stopEpoch()) throw new Error("访问停止代次已变化");
          const toBinding = this.pageBindings.get(observed.context.pageId);
          const navigation: NativeNavigationReceipt | undefined =
            fromBinding &&
            toBinding &&
            result.posted === true &&
            ["refresh-list", "return-to-list", "listing-detail", "market-entry"].includes(
              plan.target.kind,
            )
              ? {
                  plan: structuredClone(plan),
                  dispatchedAt,
                  inputConfirmedAt,
                  committedAt: Date.now(),
                  from: {
                    ...fromBinding,
                    pageId: before.context.pageId,
                    pageGeneration: before.context.pageGeneration,
                    url: before.url,
                  },
                  to: {
                    ...toBinding,
                    pageId: observed.context.pageId,
                    pageGeneration: observed.context.pageGeneration,
                    url: observed.url,
                  },
                  revision: observed.revision,
                }
              : undefined;
          if (
            navigation &&
            plan.target.kind === "return-to-list" &&
            this.returnTarget?.openedByActionId
          ) {
            const openRow = this.options.db
              .prepare(
                "SELECT result FROM access_bridge_commands WHERE action_id=? AND state='completed'",
              )
              .get(this.returnTarget.openedByActionId);
            try {
              const opened = openRow
                ? (JSON.parse(String(openRow.result)) as { navigation?: NativeNavigationReceipt })
                    .navigation
                : undefined;
              const same = (a: NativeNavigationDocument, b: NativeNavigationDocument) =>
                a.pageId === b.pageId &&
                a.pageGeneration === b.pageGeneration &&
                a.url === b.url &&
                a.tabId === b.tabId &&
                a.windowId === b.windowId &&
                a.bindingEpoch === b.bindingEpoch &&
                a.connectionEpoch === b.connectionEpoch;
              if (
                opened?.plan.target.kind === "listing-detail" &&
                opened.plan.runId === plan.runId &&
                opened.plan.stopEpoch === plan.stopEpoch &&
                opened.plan.browserSessionEpoch === plan.browserSessionEpoch &&
                same(opened.from, navigation.to) &&
                same(opened.to, navigation.from)
              )
                navigation.ownedReturn = {
                  openedBy: opened.plan,
                  parent: opened.from,
                  child: opened.to,
                };
            } catch {
              /* Missing or old opening evidence never authorizes cross-tab return. */
            }
          }
          this.store.result(plan.actionId, {
            revision: observed.revision,
            pageId: observed.context.pageId,
            ...(navigation ? { navigation } : {}),
          });
          return observed;
        } catch (error) {
          await this.stop(error instanceof Error ? error.message : "输入结果未知");
          await this.options.onRisk("native-action-unknown", { actionId: plan.actionId });
          throw error;
        } finally {
          signal?.removeEventListener("abort", abort);
          this.activePlan = undefined;
        }
      },
      signal,
    );
    if (preflightError) throw preflightError;
    await this.queueActivityRenew(activity, plan.actionId);
    return outcome;
  }
  async query(
    target: SemanticTarget,
    expected: ActionPlan["expected"],
    signal?: AbortSignal,
  ): Promise<PageSnapshot> {
    if (target.kind === "market-level") {
      let value = await this.snapshot();
      for (const handle of ["maximum", "minimum"] as const) {
        const wanted = handle === "maximum" ? target.maximum : target.minimum,
          key = handle === "maximum" ? "level_max" : "level_min";
        if (Number(value.formValues?.[key]) === wanted) continue;
        value = await this.query(
          { kind: "market-level-handle", category: target.category, handle, value: wanted },
          { kind: "changed" },
          signal,
        );
      }
      if (
        Number(value.formValues?.level_min) !== target.minimum ||
        Number(value.formValues?.level_max) !== target.maximum
      )
        throw new UnsupportedAdapterOperation("官网等级滑块结果核验");
      return value;
    }
    let before = await this.snapshot();
    if (
      target.kind !== "scroll" &&
      target.kind !== "return-to-list" &&
      target.kind !== "refresh-list" &&
      !this.workflowActivity?.suspended
    ) {
      for (let attempt = 0; attempt < 12; attempt++) {
        const inspectionPlan = {
          runId: this.runId,
          queryId: this.queryId,
          actionId: randomUUID(),
          pageId: before.context.pageId,
          pageGeneration: before.context.pageGeneration,
          browserSessionEpoch: this.sessionEpoch,
          stopEpoch: this.options.stopEpoch(),
          target,
          expected,
        };
        const inspected = await this.request({
          kind: "command",
          command: "locate",
          plan: inspectionPlan,
        });
        if (!inspected.ok)
          throw new UnsupportedAdapterOperation(textValue(inspected.error, "语义目标定位"));
        const location = inspected.location as { needsScroll: boolean; deltaY: number };
        if (!location.needsScroll) break;
        if (attempt === 11) throw new UnsupportedAdapterOperation("有界滚动后仍不可见的官网控件");
        await this.query(
          { kind: "scroll", deltaY: location.deltaY, toward: target },
          { kind: "changed" },
          signal,
        );
        before = await this.snapshot();
      }
    }
    return this.execute(
      {
        runId: this.runId,
        queryId: this.queryId,
        actionId: randomUUID(),
        pageId: before.context.pageId,
        pageGeneration: before.context.pageGeneration,
        browserSessionEpoch: this.sessionEpoch,
        stopEpoch: this.options.stopEpoch(),
        target,
        expected,
      },
      signal,
    );
  }
  navigationReceipt(queryId: string, actionId?: string): NativeNavigationReceipt | undefined {
    const rows = actionId
      ? this.options.db
          .prepare(
            "SELECT result FROM access_bridge_commands WHERE action_id=? AND state='completed'",
          )
          .all(actionId)
      : this.options.db
          .prepare(
            "SELECT result FROM access_bridge_commands WHERE state='completed' ORDER BY updated_at DESC LIMIT 100",
          )
          .all();
    for (const row of rows) {
      try {
        const navigation = (
          JSON.parse(String(row.result)) as { navigation?: NativeNavigationReceipt }
        ).navigation;
        if (
          navigation?.plan.queryId === queryId &&
          (!actionId || navigation.plan.actionId === actionId)
        )
          return structuredClone(navigation);
      } catch {
        /* Old receipts without navigation evidence are not accepted. */
      }
    }
    return undefined;
  }
  async returnToList(signal?: AbortSignal) {
    const current = await this.snapshot();
    if (current.listing || current.market) return current;
    const target = this.returnTarget;
    if (!target) throw new UnsupportedAdapterOperation("没有本地授权历史的返回列表");
    const result = await this.query(
      { kind: "return-to-list", url: target.url },
      target.page ? { kind: "page", page: target.page } : { kind: "changed" },
      signal,
    );
    if (target.category && result.market?.category !== target.category)
      throw new UnsupportedAdapterOperation("返回市场查询身份核验");
    return result;
  }
  beginQuery(runId: string = randomUUID(), queryId: string = randomUUID()) {
    this.runId = runId;
    this.queryId = queryId;
    return { runId, queryId };
  }
  async prepareManualRecovery(focus?: { id: string }): Promise<NativeRecoveryTicket> {
    return this.prepareActivation(false, focus);
  }
  private async activationSnapshot(): Promise<PageSnapshot> {
    const pageId = this.pageId || "",
      previous = this.snapshots.get(pageId),
      now = Date.now();
    if (
      pageId &&
      (!previous ||
        now - Date.parse(previous.context.observedAt) > 10_000 ||
        now - Date.parse(previous.context.receivedAt) > 10_000)
    ) {
      const result = await this.request({
        kind: "command",
        command: "observe",
        actionId: randomUUID(),
      });
      if (!result.ok) throw new Error("无法刷新绑定页面的只读观察");
      await this.waitFor((value) => Date.parse(value.context.observedAt) >= now, {
        pageId,
        after: "",
        timeoutMs: 5000,
      });
    }
    return this.snapshot(pageId);
  }
  private async prepareActivation(
    automatic: boolean,
    focus?: { id: string },
  ): Promise<NativeRecoveryTicket> {
    if (this.recovery) throw new Error("已有原生恢复核验正在进行");
    if (
      automatic &&
      (this.store.unknownCommands().length ||
        (this.options.accessReady && !this.options.accessReady()))
    )
      throw new Error("未知动作或访问暂停禁止自动启用原生输入");
    if (focus) this.assertFocusedPage(focus);
    const snapshot = await this.activationSnapshot();
    if (focus) this.assertFocusedPage(focus);
    if (
      snapshot.access !== "normal" ||
      snapshot.authenticated !== true ||
      snapshot.loading ||
      !snapshot.visible ||
      !this.socket ||
      this.socket.destroyed
    )
      throw new Error("原生页面仍未满足人工恢复条件");
    const context = this.pageContexts.get(snapshot.context.pageId);
    if (!context) throw new Error("原生页面绑定已丢失");
    const ticket: NativeRecoveryTicket = {
      ticketId: randomUUID(),
      stopEpoch: this.options.stopEpoch(),
      pageId: snapshot.context.pageId,
      pageGeneration: snapshot.context.pageGeneration,
      browserSessionEpoch: snapshot.context.browserSessionEpoch,
      verifiedAt: 0,
    };
    const recovery = {
      ticket,
      controller: new AbortController(),
      prepared: false,
      automatic,
      focusId: focus?.id,
    };
    this.recovery = recovery;
    this.stopped = true;
    this.reason = "正在核验原生恢复条件";
    try {
      const native = await this.nativeStatus(),
        permissions = native.permissions as Record<string, unknown> | undefined;
      if (
        !native.ok ||
        !permissions ||
        permissions.accessibility !== true ||
        permissions.inputMonitoring !== true ||
        permissions.inputMonitorActive !== true ||
        permissions.locked !== false ||
        permissions.frontmostChrome !== true
      )
        throw new Error("原生权限、输入监控、前台或解锁条件未满足");
      recovery.controller.signal.throwIfAborted();
      if (focus) this.assertFocusedPage(focus);
      context.stopEpoch = ticket.stopEpoch;
      context.boundAt = Date.now();
      context.requiredBindingEpoch = randomUUID();
      const result = await this.request({
        kind: "resume",
        actionId: randomUUID(),
        context: { ...context, pageId: ticket.pageId, recoveryEpoch: context.requiredBindingEpoch },
      });
      recovery.controller.signal.throwIfAborted();
      if (focus) this.assertFocusedPage(focus);
      if (!result.ok) throw new Error(textValue(result.error, "原生恢复握手失败"));
      const activity = await this.beginActivity(recovery.controller.signal, true);
      try {
        await this.waitFor(
          (value) =>
            value.context.stopEpoch === ticket.stopEpoch &&
            value.authenticated === true &&
            value.access === "normal" &&
            !value.loading &&
            value.visible,
          { pageId: ticket.pageId, after: "", timeoutMs: 5000, signal: recovery.controller.signal },
        );
      } finally {
        await activity.close();
      }
      recovery.controller.signal.throwIfAborted();
      if (focus) this.assertFocusedPage(focus);
      if (this.options.stopEpoch() !== ticket.stopEpoch || this.recovery !== recovery)
        throw new Error("新的访问风险使本次原生恢复失效");
      ticket.verifiedAt = Date.now();
      recovery.prepared = true;
      return structuredClone(ticket);
    } catch (error) {
      await this.abortManualRecovery("原生恢复核验失败，已保留停止状态");
      throw error;
    }
  }
  completeManualRecovery(ticket: NativeRecoveryTicket): void {
    const prepared = this.recovery,
      snapshot = this.snapshots.get(ticket.pageId);
    if (
      !prepared ||
      !prepared.prepared ||
      prepared.controller.signal.aborted ||
      prepared.ticket.ticketId !== ticket.ticketId ||
      prepared.ticket.stopEpoch !== ticket.stopEpoch ||
      prepared.ticket.pageId !== ticket.pageId ||
      prepared.ticket.pageGeneration !== ticket.pageGeneration ||
      prepared.ticket.browserSessionEpoch !== ticket.browserSessionEpoch ||
      this.options.stopEpoch() !== ticket.stopEpoch ||
      Date.now() - prepared.ticket.verifiedAt > 5000 ||
      !this.socket ||
      this.socket.destroyed ||
      !snapshot ||
      snapshot.authenticated !== true ||
      snapshot.access !== "normal" ||
      snapshot.loading ||
      !snapshot.visible ||
      snapshot.context.stopEpoch !== ticket.stopEpoch ||
      snapshot.context.pageGeneration !== ticket.pageGeneration ||
      snapshot.context.browserSessionEpoch !== ticket.browserSessionEpoch
    )
      throw new Error("原生恢复票据已失效；没有激活输入");
    if (prepared.automatic) {
      if (
        this.store.unknownCommands().length ||
        (this.options.accessReady && !this.options.accessReady())
      )
        throw new Error("自动启用时出现未知动作或访问暂停");
    } else this.store.reviewUnknown();
    this.recovery = undefined;
    this.idle = false;
    this.stopped = false;
    this.reason = null;
  }
  async finishRun(reason = "本轮已结束") {
    if (this.activePlan || this.pending.size || this.recovery) return; // A different serialized workflow may still own the input/read channel.
    const safe =
      (!this.stopped || this.idle) &&
      !this.activePlan &&
      !this.store.unknownCommands().length &&
      (!this.options.accessReady || this.options.accessReady());
    await this.stop(reason);
    if (
      safe &&
      !this.store.unknownCommands().length &&
      (!this.options.accessReady || this.options.accessReady())
    )
      this.idle = true;
  }
  async resumeForRun(): Promise<void> {
    const activeReady = !this.stopped && !this.idle;
    if (
      (!this.idle && !activeReady) ||
      !!this.activePlan ||
      this.store.unknownCommands().length ||
      (this.options.accessReady && !this.options.accessReady())
    )
      throw new Error("原生输入由风险、人工停止或未知动作暂停，不能自动继续");
    try {
      const ticket = await this.prepareActivation(true);
      this.completeManualRecovery(ticket);
    } catch (error) {
      await this.stop("本轮启动核验失败，已保持停止");
      throw error;
    }
  }
  async abortManualRecovery(reason = "原生恢复已取消") {
    await this.stop(reason);
  }
  async confirmManualRecovery(): Promise<never> {
    throw new Error(
      "原生恢复须先prepareManualRecovery，再在访问状态CAS成功后completeManualRecovery",
    );
  }
  async stop(reason: string) {
    this.cancelUserFocus();
    this.detachActivity(reason);
    this.idle = false;
    const recovery = this.recovery;
    this.recovery = undefined;
    recovery?.controller.abort(new Error(reason));
    for (const value of this.pending.values()) value.reject(new Error(reason));
    this.pending.clear();
    this.stopped = true;
    this.reason = reason;
    this.socket?.write(
      `${JSON.stringify({ kind: "command", command: "stop", actionId: randomUUID() })}\n`,
    );
    this.events.emit("change");
  }
  async close() {
    await this.stop("访问方式已停止");
    this.socket?.destroy();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (existsSync(this.options.socketPath)) {
      const file = lstatSync(this.options.socketPath);
      if (file.isSocket() && file.uid === process.getuid?.()) unlinkSync(this.options.socketPath);
    }
  }
  createCrawlSource(signal: AbortSignal): CrawlSource {
    const listing = async () => {
      let value = await this.snapshot();
      if (!value.listing && this.returnTarget) value = await this.returnToList(signal);
      if (
        !value.listing ||
        value.loading ||
        value.access !== "normal" ||
        (!value.listing.items.length && !value.empty)
      )
        throw new UnsupportedAdapterOperation("当前角色列表读取");
      return value.listing;
    };
    const detail = async (item: Listing) => {
      const current = await this.snapshot();
      if (
        !current.listing &&
        (current.productIdentity?.serverId !== item.serverId ||
          current.productIdentity.eid !== item.eid)
      )
        await this.returnToList(signal);
      const read = {
        controller: new AbortController(),
        timeoutMs: 0,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
      };
      this.detailRead = read;
      try {
        if (
          current.productIdentity?.serverId === item.serverId &&
          current.productIdentity.eid === item.eid
        )
          this.startDetailReadBudget();
        return await collectNativeDetail(
          this,
          item,
          AbortSignal.any([signal, read.controller.signal]),
        );
      } finally {
        clearTimeout(read.timer);
        if (this.detailRead === read) this.detailRead = undefined;
      }
    };
    return {
      prepare: async (order) => {
        let value = await listing();
        for (let attempt = 0; order && value.order !== order && attempt < 2; attempt++) {
          const next = await this.query(
            { kind: "sort", value: order },
            { kind: "page", page: 1 },
            signal,
          );
          if (!next.listing) throw new UnsupportedAdapterOperation("排序结果读取");
          value = next.listing;
        }
        if (order && value.order !== order) throw new UnsupportedAdapterOperation("当前列表排序");
        return value;
      },
      refresh: async (order) => {
        const before = await this.returnToList(signal);
        if (!before.listing) throw new UnsupportedAdapterOperation("列表刷新入口");
        const fresh = await this.query(
          { kind: "refresh-list", url: before.url },
          { kind: "page", page: 1 },
          signal,
        );
        if (!fresh.listing || (order && fresh.listing.order !== order))
          throw new UnsupportedAdapterOperation("刷新后排序核验");
        return fresh.listing;
      },
      page: async (page) => {
        const value = await listing();
        if (value.page === page) return value;
        const result = await this.query(
          page === value.page + 1
            ? { kind: "next-page", currentPage: value.page }
            : { kind: "jump-page", page },
          { kind: "page", page },
          signal,
        );
        if (!result.listing) throw new UnsupportedAdapterOperation("翻页结果读取");
        return result.listing;
      },
      hover: async (item) => {
        const value = await listing();
        const found = value.items.find((entry) => entry.key === item.key);
        if (!found) throw new UnsupportedAdapterOperation("已不在当前列表的商品悬停");
        return found;
      },
      detail,
      onShelf: async (item) => {
        const origin = await this.snapshot();
        let value = origin;
        if (
          value.productIdentity?.serverId !== item.serverId ||
          value.productIdentity.eid !== item.eid
        )
          value = await this.query(
            { kind: "listing-detail", serverId: item.serverId, eid: item.eid },
            { kind: "detail", serverId: item.serverId, eid: item.eid },
            signal,
          );
        if (!value.productState || value.productState === "unknown")
          throw new UnsupportedAdapterOperation("缺少官方主商品状态证据的上架检查");
        const selling = value.productState === "selling";
        if (origin.listing)
          await this.query(
            { kind: "return-to-list", url: origin.url },
            { kind: "page", page: origin.listing.page },
            signal,
          );
        return selling;
      },
      cancelDetails: async (reason) =>
        "code" in reason && reason.code === "CRAWL_TIME_LIMIT"
          ? this.finishRun(reason.message)
          : this.stop(reason.message),
    };
  }
}
