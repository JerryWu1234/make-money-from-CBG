import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AccessGovernor, type AccessContext } from "../access";
import { CBG_ORIGIN } from "../access/response-classifier";
import { beginPageQuery, bindQueryPage, queryPageContext } from "./runtime";
import {
  activateQueryObservation,
  clearQueryCallbackObservation,
  installQueryCallbackObservation,
} from "./callback-observer";

const dbs: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of dbs.splice(0)) db.close();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture(original: (...args: any[]) => any) {
  const globals: Record<string, any> = { ajax_with_recommend: original };
  vi.stubGlobal("window", globals);
  const frame = { url: () => CBG_ORIGIN + "/equip_search.html" };
  const listeners = new Map<string, (...args: any[]) => void>();
  let receive: (source: any, input: unknown) => unknown;
  const sent: unknown[] = [];
  const exposeBinding = vi.fn(async (name: string, callback: typeof receive) => {
    receive = callback;
    globals[name] = (input: unknown) => {
      sent.push(input);
      return Promise.resolve(receive({ page, frame }, input));
    };
  });
  const page = {
    evaluate: async (fn: (arg?: any) => unknown, arg?: unknown) => fn(arg),
    mainFrame: () => frame,
    exposeBinding,
    on: (event: string, callback: (...args: any[]) => void) => listeners.set(event, callback),
    once: (event: string, callback: (...args: any[]) => void) => listeners.set(event, callback),
  } as unknown as Page;
  return {
    globals,
    page,
    frame,
    sent,
    exposeBinding,
    receive: (input: unknown, source = { page, frame }) => receive(source, input),
    emit: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
  };
}
function bind(page: Page) {
  const directory = mkdtempSync(path.join(tmpdir(), "cbg-callback-observer-"));
  directories.push(directory);
  const filename = path.join(directory, "app.sqlite");
  const db = new DatabaseSync(filename);
  dbs.push(db);
  const governor = new AccessGovernor(db);
  const owner = governor.acquireOwner("callback-observer-test");
  const context: AccessContext = {
    ...owner,
    runId: "run",
    queryId: "initial",
    pageId: "page",
    pageGeneration: 1,
    browserSessionEpoch: "browser",
    stopEpoch: governor.read().stopEpoch,
    sourceKind: "market-equipment",
    actionId: "original-action",
  };
  governor.registerPage(context);
  bindQueryPage(page, governor, context);
  const query = () =>
    beginPageQuery(page, {
      category: "equipment",
      server: "367",
      serverAge: "3",
      conditions: {},
      page: 1,
      sort: "default",
    })!.queryId;
  const reopen = () => {
    const connection = new DatabaseSync(filename);
    dbs.push(connection);
    return new AccessGovernor(connection);
  };
  return { db, governor, context, query, reopen };
}

it("OBS-02 installs once and preserves caller/arguments/return and callback this/return/error", async () => {
  let options: any;
  const requestThis = { component: 1 },
    callbackThis = { callback: 1 };
  const original = vi.fn(function (this: unknown, value, ...rest) {
    expect(this).toBe(requestThis);
    expect(rest).toEqual(["rest"]);
    options = value;
    return 41;
  });
  const x = fixture(original);
  await installQueryCallbackObservation(x.page, "Equipment");
  const wrapper = x.globals.ajax_with_recommend;
  await installQueryCallbackObservation(x.page, "Equipment");
  expect(x.globals.ajax_with_recommend).toBe(wrapper);
  await activateQueryObservation(x.page, "query-1");
  const success = vi.fn(function (this: unknown, value, suffix) {
    expect(this).toBe(callbackThis);
    expect(value.status).toBe(0);
    expect(suffix).toBe(7);
    return 99;
  });
  expect(wrapper.call(requestThis, { data: { page: 1 }, onSuccess: success }, "rest")).toBe(41);
  expect(options.onSuccess.call(callbackThis, { status: 0, msg: [1] }, 7)).toBe(99);
  expect(success).toHaveBeenCalledTimes(1);
  expect(x.globals.__cbgEquipmentResult).toMatchObject({
    queryToken: "query-1",
    count: 1,
    ok: true,
  });
  const thrown = new Error("original callback failure");
  wrapper.call(
    requestThis,
    {
      data: { page: 1 },
      onSuccess() {
        throw thrown;
      },
    },
    "rest",
  );
  expect(() => options.onSuccess({ status: 0, msg: [] })).toThrow(thrown);
  expect(original).toHaveBeenCalledTimes(2);
});
it("old-query callbacks cannot populate the new result and cleanup cannot replace a later website wrapper", async () => {
  const pending: any[] = [];
  const original = vi.fn((options) => {
    pending.push(options);
  });
  const x = fixture(original);
  await installQueryCallbackObservation(x.page, "Pet");
  await activateQueryObservation(x.page, "old");
  x.globals.ajax_with_recommend({ data: { page: 1 } });
  await activateQueryObservation(x.page, "new");
  x.globals.ajax_with_recommend({ data: { page: 1 } });
  pending[1].onSuccess({ status: 0, msg: [1, 2] });
  pending[0].onSuccess({ status: 0, msg: [] });
  expect(x.globals.__cbgPetResult).toMatchObject({ queryToken: "new", count: 2 });
  const later = () => "website replacement";
  x.globals.ajax_with_recommend = later;
  await clearQueryCallbackObservation(x.page);
  expect(x.globals.ajax_with_recommend).toBe(later);
});
it("observation sink errors never suppress the original website callback", async () => {
  let options: any;
  const x = fixture((value) => {
    options = value;
  });
  await installQueryCallbackObservation(x.page, "Pet");
  await activateQueryObservation(x.page, "query");
  Object.defineProperty(x.globals, "__cbgPetResult", {
    set() {
      throw new Error("observer failed");
    },
  });
  const success = vi.fn(() => "website success");
  x.globals.ajax_with_recommend({ data: { page: 1 }, onSuccess: success });
  expect(options.onSuccess({ status: 0, msg: [] })).toBe("website success");
  expect(success).toHaveBeenCalledTimes(1);
});

it.each([
  ["请先登录", "login", "needs_action"],
  ["请完成验证码验证", "verification", "needs_action"],
  ["访问过于频繁", "frequency", "cooldown"],
])(
  "ACC-01/02 persists callback refusal %s through the shared classifier",
  async (msg, reason, state) => {
    let options: any;
    const x = fixture((value) => {
      options = value;
    });
    const access = bind(x.page);
    await installQueryCallbackObservation(x.page, "Equipment");
    const token = access.query();
    await activateQueryObservation(x.page, token);
    const result = {
      status: 99,
      msg,
      cookie: "secret-cookie",
      token: "secret-token",
      fp: "secret-fingerprint",
    };
    const success = vi.fn(() => 123);
    x.globals.ajax_with_recommend({ data: { page: 1 }, onSuccess: success });
    expect(options.onSuccess(result)).toBe(123);
    expect(success).toHaveBeenCalledExactlyOnceWith(result);
    expect(access.reopen().read()).toMatchObject({
      state,
      stopEpoch: 1,
      reasons: [expect.objectContaining({ code: reason })],
    });
    const row = access.db.prepare("SELECT context_json,evidence_json FROM access_evidence").get()!;
    expect(JSON.parse(row.context_json as string)).toMatchObject({
      queryId: token,
      actionId: "original-action",
      pageId: "page",
    });
    expect(row.evidence_json).not.toContain(msg);
    expect(JSON.stringify(x.sent)).not.toMatch(/secret-cookie|secret-token|secret-fingerprint/);
    expect(JSON.stringify(row)).not.toMatch(/secret-cookie|secret-token|secret-fingerprint|proof/);
    options.onSuccess({ status: 0, msg: [] });
    expect(access.governor.read()).toMatchObject({ state, stopEpoch: 1 });
  },
);
it("late denial preserves its signed original query while old normal callbacks cannot populate the latest result", async () => {
  const pending: any[] = [];
  const x = fixture((value) => {
    pending.push(value);
  });
  const access = bind(x.page);
  await installQueryCallbackObservation(x.page, "Equipment");
  const old = access.query();
  await activateQueryObservation(x.page, old);
  x.globals.ajax_with_recommend({ data: { page: 1 } });
  const latest = access.query();
  await activateQueryObservation(x.page, latest);
  x.globals.ajax_with_recommend({ data: { page: 2 } });
  pending[1].onSuccess({ status: 0, msg: [1, 2] });
  pending[0].onSuccess({ status: 0, msg: [] });
  expect(x.globals.__cbgEquipmentResult).toMatchObject({ queryToken: latest, page: 2, count: 2 });
  pending[0].onSuccess({ status: 1, msg: "请先登录" });
  expect(access.governor.read().state).toBe("needs_action");
  expect(queryPageContext(x.page)?.queryId).toBe(latest);
  expect(
    JSON.parse(
      access.db.prepare("SELECT context_json FROM access_evidence").get()!.context_json as string,
    ).queryId,
  ).toBe(old);
  expect(x.globals.__cbgEquipmentResult).toMatchObject({ queryToken: latest, count: 2 });
});
it("accepts only authentic locally issued query proofs from the current main-frame origin", async () => {
  let options: any;
  const x = fixture((value) => {
    options = value;
  });
  const access = bind(x.page);
  await installQueryCallbackObservation(x.page, "Pet");
  await activateQueryObservation(x.page, access.query());
  x.globals.ajax_with_recommend({ data: { page: 1 } });
  // Capture the bounded envelope without delivering it yet.
  const bindingName = Object.keys(x.globals).find((key) => key.startsWith("__cbgQueryRisk_"))!;
  x.globals[bindingName] = (input: unknown) => {
    x.sent.push(input);
  };
  options.onSuccess({ status: 1, msg: "请先登录" });
  const message = x.sent[0] as Record<string, unknown>;
  x.receive({ ...message, proof: String(message.proof) + "tampered" });
  x.receive({ ...message, proof: "a".repeat(5000) });
  x.receive(message, { page: {} as Page, frame: x.frame });
  x.receive(message, { page: x.page, frame: { url: () => CBG_ORIGIN } });
  x.frame.url = () => "https://example.org/";
  x.receive(message);
  expect(access.governor.read().state).toBe("ready");
  x.frame.url = () => CBG_ORIGIN + "/equip_search.html";
  x.receive(message);
  expect(access.governor.read().state).toBe("needs_action");
  x.receive({ ...message, msg: "请完成验证码验证" });
  expect(access.governor.read().stopEpoch).toBe(1); // Cross-stop-epoch replay is inert.
});
it.each(["navigation", "clear", "generation", "session", "stop"])(
  "invalidates old proof after %s",
  async (scenario) => {
    let options: any;
    const x = fixture((value) => {
      options = value;
    });
    const access = bind(x.page);
    await installQueryCallbackObservation(x.page, "Equipment");
    await activateQueryObservation(x.page, access.query());
    x.globals.ajax_with_recommend({ data: { page: 1 } });
    if (scenario === "navigation") x.emit("framenavigated", x.frame);
    if (scenario === "clear") await clearQueryCallbackObservation(x.page);
    if (scenario === "generation" || scenario === "session")
      bindQueryPage(x.page, access.governor, {
        ...queryPageContext(x.page)!,
        ...(scenario === "generation"
          ? { pageGeneration: 2 }
          : { browserSessionEpoch: "new-browser" }),
      });
    if (scenario === "stop") access.governor.reportRisk({ reason: "manual_stop" });
    options.onSuccess({ status: 1, msg: "请先登录" });
    expect(access.governor.read().reasons.map((reason) => reason.code)).toEqual(
      scenario === "stop" ? ["manual_stop"] : [],
    );
  },
);
it("OBS-02 bounded summaries do not traverse payloads, invoke data getters or serialize successful arrays", async () => {
  let options: any;
  const x = fixture((value) => {
    options = value;
  });
  const access = bind(x.page);
  await installQueryCallbackObservation(x.page, "Equipment");
  await activateQueryObservation(x.page, access.query());
  const success = vi.fn(() => "original");
  x.globals.ajax_with_recommend({ data: { page: 1 }, onSuccess: success });
  const getter = vi.fn(() => {
    throw new Error("must not invoke website getter");
  });
  const data = { status: 1 };
  Object.defineProperty(data, "msg", { get: getter });
  expect(options.onSuccess(data)).toBe("original");
  const items = Array<unknown>(1000000);
  items[0] = {
    get sensitive() {
      throw new Error("must not traverse");
    },
  };
  expect(options.onSuccess({ status: 0, msg: items })).toBe("original");
  expect(x.globals.__cbgEquipmentResult.count).toBe(1000000);
  expect(options.onSuccess({ status: 1, msg: "请先登录" + "x".repeat(1000000) })).toBe("original");
  expect(options.onSuccess({ status: 4, msg: "unknown token=private-value" })).toBe("original");
  expect(getter).not.toHaveBeenCalled();
  expect(success).toHaveBeenCalledTimes(4);
  expect(access.governor.read().state).toBe("ready");
  expect(access.db.prepare("SELECT count(*) AS n FROM access_evidence").get()?.n).toBe(0);
  expect(x.sent).toHaveLength(1);
});
it("same-token reactivation isolates old normal results and repeated installation uses one binding", async () => {
  const pending: any[] = [];
  const x = fixture((value) => {
    pending.push(value);
  });
  const access = bind(x.page);
  await installQueryCallbackObservation(x.page, "Pet");
  const token = access.query();
  await activateQueryObservation(x.page, token);
  x.globals.ajax_with_recommend({ data: { page: 1 } });
  await installQueryCallbackObservation(x.page, "Pet");
  await activateQueryObservation(x.page, token);
  x.globals.ajax_with_recommend({ data: { page: 2 } });
  pending[1].onSuccess({ status: 0, msg: [1] });
  pending[0].onSuccess({ status: 0, msg: [] });
  expect(x.globals.__cbgPetResult).toMatchObject({ page: 2, count: 1 });
  expect(x.exposeBinding).toHaveBeenCalledTimes(1);
});
it("binding/storage failures and original failure callbacks preserve website return and exception semantics", async () => {
  let options: any;
  const x = fixture((value) => {
    options = value;
    return "request";
  });
  const access = bind(x.page);
  await installQueryCallbackObservation(x.page, "Pet");
  await activateQueryObservation(x.page, access.query());
  const failureThis = {},
    failureError = new Error("website failure");
  const failure = vi.fn(function (this: unknown, ...args) {
    expect(this).toBe(failureThis);
    expect(args).toEqual(["error", 2]);
    throw failureError;
  });
  const success = vi.fn(() => 19);
  expect(
    x.globals.ajax_with_recommend({ data: { page: 1 }, onSuccess: success, onFailure: failure }),
  ).toBe("request");
  expect(() => options.onFailure.call(failureThis, "error", 2)).toThrow(failureError);
  expect(failure).toHaveBeenCalledTimes(1);
  access.db.exec(
    "CREATE TRIGGER callback_evidence_failure BEFORE INSERT ON access_evidence BEGIN SELECT RAISE(FAIL,'fixture storage failure'); END",
  );
  expect(options.onSuccess({ status: 1, msg: "请先登录" })).toBe(19);
  expect(success).toHaveBeenCalledTimes(1);
  expect(() => access.governor.read()).toThrowError(
    expect.objectContaining({ code: "storage_unavailable" }),
  );
});

it("replayed callback proofs have bounded evidence and cannot renew a stopped epoch", async () => {
  let options: any;
  const x = fixture((value) => {
    options = value;
  });
  const access = bind(x.page);
  await installQueryCallbackObservation(x.page, "Pet");
  await activateQueryObservation(x.page, access.query());
  x.globals.ajax_with_recommend({ data: { page: 1 } });
  options.onSuccess({ status: 1, msg: "请先登录" });
  const envelope = x.sent[0] as Record<string, unknown>;
  for (let i = 0; i < 100; i++) x.receive(envelope);
  expect(access.governor.read().stopEpoch).toBe(1);
  expect(access.db.prepare("SELECT count(*) AS n FROM access_evidence").get()?.n).toBe(1);
});

it("concurrent installs share one binding and do not multiply the original callback", async () => {
  let options: any;
  const original = vi.fn((value) => {
    options = value;
    return 1;
  });
  const x = fixture(original);
  await Promise.all([
    installQueryCallbackObservation(x.page, "Pet"),
    installQueryCallbackObservation(x.page, "Pet"),
  ]);
  await activateQueryObservation(x.page, "query");
  const success = vi.fn(() => 2);
  expect(x.globals.ajax_with_recommend({ data: { page: 1 }, onSuccess: success })).toBe(1);
  expect(options.onSuccess({ status: 0, msg: [] })).toBe(2);
  expect(x.exposeBinding).toHaveBeenCalledTimes(1);
  expect(original).toHaveBeenCalledTimes(1);
  expect(success).toHaveBeenCalledTimes(1);
});

it("option metadata cannot invoke website getters or suppress the protective refusal summary", async () => {
  let options: any;
  const x = fixture((value) => {
    options = value;
  });
  const access = bind(x.page);
  await installQueryCallbackObservation(x.page, "Pet");
  await activateQueryObservation(x.page, access.query());
  const getter = vi.fn(() => {
    throw new Error("website option getter");
  });
  const data = {};
  Object.defineProperty(data, "page", { get: getter });
  Object.defineProperty(data, "server_type", { get: getter });
  const success = vi.fn(() => 5);
  x.globals.ajax_with_recommend({ data, onSuccess: success });
  expect(options.onSuccess({ status: 1, msg: "请先登录" })).toBe(5);
  expect(getter).not.toHaveBeenCalled();
  expect(access.governor.read().state).toBe("needs_action");
});
