import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Page, Request } from "playwright-core";
import { AccessGovernor, type AccessContext, type CrawlLease } from "./access";
import { isBusinessResponse } from "./access/response-classifier";
import { watchCrawlAccess } from "./crawler/access-guard";
import { bindQueryPage, queryPageContext, pendingPageQuery } from "./query-health/runtime";
import { diagnostics } from "./diagnostics";

/** All project-owned official pages use the same database and the same site budget. */
const key = Symbol.for("cbg.official-access.v1");
type Binding = {
  governor: AccessGovernor;
  context: AccessContext;
  control: AbortController;
  dispose: () => Promise<void>;
  firstDispatch?: () => void;
  authenticated?: boolean;
  dispatchContext?: AccessContext;
  requestContexts: WeakMap<Request, AccessContext>;
};
type Runtime = {
  db?: DatabaseSync;
  governor?: AccessGovernor;
  owner: string;
  pages: WeakMap<Page, Binding>;
  epochs: WeakMap<object, string>;
};
const global = globalThis as typeof globalThis & { [key]?: Runtime };
const runtime = (global[key] ??= {
  owner: randomUUID(),
  pages: new WeakMap(),
  epochs: new WeakMap(),
});
const dispatching = new AsyncLocalStorage<Page>();
export function officialGovernor(db?: DatabaseSync) {
  if (db && db !== runtime.db) {
    runtime.db = db;
    runtime.governor = new AccessGovernor(db);
  }
  if (!runtime.governor) throw new Error("官网访问状态尚未初始化，拒绝派发");
  return runtime.governor;
}
export function officialPageContext(page: Page) {
  return queryPageContext(page) ?? runtime.pages.get(page)?.context;
}
export function markOfficialAuthenticated(page: Page) {
  const binding = runtime.pages.get(page);
  if (binding) binding.authenticated = true;
}
export function officialPageSignal(page: Page) {
  return runtime.pages.get(page)?.control.signal;
}
export function onOfficialFirstDispatch(page: Page, callback: () => void) {
  const binding = runtime.pages.get(page);
  if (!binding) return false;
  binding.firstDispatch = callback;
  return true;
}
export async function withOfficialAction<T>(
  page: Page,
  action: string,
  execute: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const binding = runtime.pages.get(page);
  if (!binding || dispatching.getStore() === page) return execute();
  const context = officialPageContext(page)!;
  const combined = AbortSignal.any([binding.control.signal, ...(signal ? [signal] : [])]);
  combined.throwIfAborted();
  // Renew only this owner's still-valid fence; an expired worker cannot silently reclaim it.
  binding.governor.renewOwner(context);
  const actionContext = { ...context, actionId: randomUUID() };
  return binding.governor.runAction(
    actionContext,
    async () => {
      combined.throwIfAborted();
      binding.firstDispatch?.();
      binding.firstDispatch = undefined;
      diagnostics.record("access.action_dispatch", { ...actionContext, action });
      binding.dispatchContext = actionContext;
      try {
        return await dispatching.run(page, execute);
      } finally {
        binding.dispatchContext = undefined;
      }
    },
    combined,
  );
}

const locatorActions = new Set([
  "click",
  "dblclick",
  "tap",
  "hover",
  "fill",
  "clear",
  "press",
  "pressSequentially",
  "type",
  "check",
  "uncheck",
  "setChecked",
  "selectOption",
  "dragTo",
  "dispatchEvent",
]);
const locatorFactories = new Set([
  "locator",
  "getByRole",
  "getByText",
  "getByLabel",
  "getByPlaceholder",
  "getByTitle",
  "getByAltText",
  "getByTestId",
  "first",
  "last",
  "nth",
  "filter",
  "and",
  "or",
]);
function protectedLocator(page: Page, target: object): object {
  return new Proxy(target, {
    get(object, name) {
      const value = Reflect.get(object, name);
      if (typeof value !== "function") return value;
      if (locatorActions.has(String(name)))
        return (...args: unknown[]) =>
          withOfficialAction(
            page,
            `locator.${String(name)}`,
            async () => await Reflect.apply(value, object, args),
          );
      if (locatorFactories.has(String(name)))
        return (...args: unknown[]) => protectedLocator(page, Reflect.apply(value, object, args));
      if (name === "all")
        return async (...args: unknown[]) =>
          ((await Reflect.apply(value, object, args)) as object[]).map((item: object) =>
            protectedLocator(page, item),
          );
      return value.bind(object);
    },
  });
}
function instrument(page: Page) {
  const mutable = page as unknown as Record<string, unknown>;
  for (const name of [
    "goto",
    "reload",
    "goBack",
    "goForward",
    "click",
    "dblclick",
    "hover",
    "fill",
    "press",
    "check",
    "uncheck",
    "selectOption",
  ]) {
    const original = mutable[name];
    if (typeof original === "function")
      mutable[name] = (...args: unknown[]) =>
        withOfficialAction(page, `page.${name}`, () => Reflect.apply(original, page, args));
  }
  for (const name of locatorFactories) {
    const original = mutable[name];
    if (typeof original === "function")
      mutable[name] = (...args: unknown[]) =>
        protectedLocator(page, Reflect.apply(original, page, args));
  }
  for (const device of [page.mouse, page.keyboard]) {
    const methods =
      device === page.mouse
        ? ["click", "dblclick", "move", "down", "up", "wheel"]
        : ["press", "type", "insertText", "down", "up"];
    for (const name of methods) {
      const object = device as unknown as Record<string, unknown>;
      const original = object[name];
      if (typeof original === "function")
        object[name] = (...args: unknown[]) =>
          withOfficialAction(page, name, () => Reflect.apply(original, device, args));
    }
  }
}
export async function bindOfficialPage(
  page: Page,
  options: {
    runId: string;
    sourceKind: string;
    signal?: AbortSignal;
    recoveryToken?: string;
    crawlLease?: CrawlLease;
  },
) {
  if (!runtime.governor) {
    const { crawlDatabase } = await import("./crawler/controller");
    officialGovernor(crawlDatabase());
  }
  const governor = officialGovernor();
  const prior = runtime.pages.get(page);
  if (prior) await prior.dispose();
  const owner = governor.acquireOwner(runtime.owner);
  let browserSessionEpoch = runtime.epochs.get(page.context());
  if (!browserSessionEpoch) {
    browserSessionEpoch = randomUUID();
    runtime.epochs.set(page.context(), browserSessionEpoch);
  }
  const context: AccessContext = {
    ...owner,
    schemaVersion: 1,
    runId: options.runId,
    queryId: randomUUID(),
    actionId: null,
    pageId: prior?.context.pageId ?? randomUUID(),
    pageGeneration: (prior?.context.pageGeneration ?? 0) + 1,
    browserSessionEpoch,
    stopEpoch: governor.read().stopEpoch,
    sourceKind: options.sourceKind,
    ...(options.crawlLease ? { crawlLease: { ...options.crawlLease } } : {}),
    ...(options.recoveryToken
      ? { purpose: "recovery" as const, recoveryToken: options.recoveryToken }
      : {}),
  };
  governor.registerPage(context);
  const control = new AbortController();
  const binding: Binding = {
    governor,
    context,
    control,
    dispose: async () => {},
    requestContexts: prior?.requestContexts ?? new WeakMap(),
  };
  runtime.pages.set(page, binding);
  bindQueryPage(page, governor, context);
  if (!prior) instrument(page);
  const request = (value: Request) => {
    let correlated: AccessContext | undefined;
    if (!binding.dispatchContext) {
      const pending = pendingPageQuery(page);
      try {
        const address = new URL(value.url());
        const parameters = new URLSearchParams(address.search);
        const body = value.postData();
        if (body && body.length <= 65536)
          for (const [name, value] of new URLSearchParams(body)) parameters.set(name, value);
        if (
          pending &&
          isBusinessResponse({
            url: address.href,
            resourceType: value.resourceType(),
            mainFrame: value.frame() === page.mainFrame(),
          }) &&
          parameters.get("page") === String(pending.identity.page) &&
          Object.entries(pending.identity.conditions).every(
            ([name, value]) => parameters.get(name) === String(value),
          ) &&
          (!parameters.has("order_by") || parameters.get("order_by") === pending.identity.sort)
        )
          correlated = { ...officialPageContext(page)!, actionId: null };
      } catch {
        /* An unprovable delayed request stays explicitly unassociated. */
      }
    }
    binding.requestContexts.set(value, {
      ...(binding.dispatchContext ??
        correlated ?? { ...context, queryId: "unassociated", actionId: null }),
    });
  };
  page.on("request", request);
  const stopOwnedPage = () => {
    // Keep the selected list/recovery page available for manual login and verification.
    if (!["crawl-list", "workflow", "recovery"].includes(binding.context.sourceKind))
      void page.close().catch(() => {});
  };
  control.signal.addEventListener("abort", stopOwnedPage, { once: true });
  const abort = () => control.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setInterval(() => {
    try {
      const state = governor.read();
      const current = officialPageContext(page)!;
      const diagnostic =
        state.state === "suspect" && current.purpose === "diagnostic" && !!current.diagnosticPlanId;
      const recovery = current.purpose === "recovery" && !!current.recoveryToken;
      if (
        state.stopEpoch !== current.stopEpoch ||
        (state.state !== "ready" && !diagnostic && !recovery)
      )
        control.abort(new Error("官网访问已暂停，停止新动作并保留资料"));
    } catch (error) {
      control.abort(error);
    }
  }, 200);
  timer.unref();
  const heartbeat = setInterval(() => {
    try {
      governor.renewOwner(owner);
    } catch (error) {
      control.abort(error);
    }
  }, 30_000);
  heartbeat.unref();
  let stopWatch: (() => Promise<void>) | undefined;
  binding.dispose = async () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    control.signal.removeEventListener("abort", stopOwnedPage);
    options.signal?.removeEventListener("abort", abort);
    page.off("request", request);
    await stopWatch?.();
  };
  page.once("close", () => {
    control.abort(new Error("官网工作页已关闭"));
    void binding.dispose();
  });
  stopWatch = await watchCrawlAccess(
    page,
    control.signal,
    (error, request) => {
      try {
        const detail = error as typeof error & { status?: number; retryAfter?: string };
        governor.reportRisk({
          reason:
            detail.status === 429
              ? "http_429"
              : detail.status === 403
                ? "http_403"
                : error.kind === "busy"
                  ? "frequency"
                  : error.kind === "login"
                    ? "login"
                    : "verification",
          state: error.kind === "busy" ? "cooldown" : "needs_action",
          retryAfter: detail.retryAfter,
          context: request ? binding.requestContexts.get(request) : officialPageContext(page),
          evidence: { message: error.message },
        });
        control.abort(error);
      } catch (failure) {
        control.abort(failure);
      }
    },
    (classification, summary, request) => {
      governor.recordRequest(
        (request && binding.requestContexts.get(request)) ?? {
          ...context,
          queryId: "unassociated",
          actionId: null,
        },
        { ...summary, classification },
      );
    },
    (failure) => {
      control.abort(failure);
    },
    (error) => {
      if (options.sourceKind === "workflow" && !binding.authenticated && error.kind === "login")
        return false;
      if (options.sourceKind === "recovery") {
        const existing = governor.read().reasons.map((reason) => reason.code);
        if (
          (error.kind === "login" && existing.includes("login")) ||
          (error.kind === "verification" &&
            existing.some((reason) => ["verification", "http_403"].includes(reason)))
        )
          return false;
      }
      return true;
    },
  );
}

export async function recoverOfficialAccess(revision: number, acknowledgedReasons: string[]) {
  const governor = officialGovernor();
  const state = governor.read();
  if (state.revision !== revision) throw new Error("访问状态已变化，请重新核对全部原因");
  if (!state.reasons.every((reason) => acknowledgedReasons.includes(reason.code)))
    throw new Error("请先核对并确认全部暂停原因");
  const owner = governor.acquireOwner(runtime.owner);
  const token = governor.beginRecovery(revision, owner);
  const { browserSettings } = await import("./browser-settings");
  if (browserSettings().accessAdapter === "extension-native") {
    const { nativeAccess } = await import("./native-access");
    const adapter = await nativeAccess();
    const ticket = await adapter.prepareManualRecovery();
    try {
      const result = governor.finishRecovery(token, acknowledgedReasons);
      try {
        adapter.completeManualRecovery(ticket);
      } catch (error) {
        governor.reportRisk({
          reason: "native_recovery_activation_failed",
          evidence: { message: error instanceof Error ? error.message : "activation_failed" },
        });
        throw error;
      }
      return result;
    } catch (error) {
      await adapter.abortManualRecovery("恢复状态变化，保留原生停止状态").catch(() => {});
      throw error;
    }
  }
  const { getCbgPage } = await import("./session");
  const page = getCbgPage();
  if (!page || page.isClosed() || new URL(page.url()).origin !== "https://xyq.cbg.163.com")
    throw new Error("请先在绑定的官网页面完成登录或验证，再人工继续");
  await bindOfficialPage(page, {
    runId: "recovery",
    sourceKind: "recovery",
    recoveryToken: token.token,
  });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
  const { assertAvailable } = await import("./crawler/page");
  const { readPageSnapshot, buildPageState } = await import("./page-state");
  await assertAvailable(page);
  const verified = buildPageState(await page.evaluate(readPageSnapshot));
  if (!verified.isLoggedIn) throw new Error("尚未取得当前页面的正向登录证据，访问保护继续暂停");
  const ready = await page.evaluate(
    () =>
      document.readyState === "complete" &&
      !!document.body?.innerText.trim() &&
      !Array.from(document.querySelectorAll("#LoadingCover,#LoadingImg,#loading_img")).some(
        (node) => node.checkVisibility(),
      ),
  );
  if (!ready) throw new Error("官网页面尚未完成加载，请核实后继续");
  // A single recovery-budget reload supplies fresh page evidence. No ordinary query
  // or uncertain click is replayed; final recovery still compares the stopped revision.
  return governor.finishRecovery(token, acknowledgedReasons);
}

export async function openOfficialRecovery(revision: number) {
  const governor = officialGovernor();
  const { browserSettings } = await import("./browser-settings");
  if (browserSettings().accessAdapter === "extension-native") {
    const { nativeAccess } = await import("./native-access");
    await nativeAccess();
    return governor.read();
  }
  if (!browserSettings().showWorkPages)
    throw new Error("请先在浏览器设置中开启显示操作过程，再打开人工处理页面");
  const owner = governor.acquireOwner(runtime.owner);
  const token = governor.beginRecovery(revision, owner);
  const session = await import("./session");
  const browser = await session.getBrowser(true);
  const page = await session.createRecoveryWorkPage(browser, token.token);
  // This recovery path has one fixed destination and never runs the ordinary workflow.
  await page.goto("https://xyq.cbg.163.com/", { waitUntil: "domcontentloaded", timeout: 45000 });
  return governor.read();
}
