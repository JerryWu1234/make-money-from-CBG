import { watchCrawlAccess } from "./crawler/access-guard";
import { beginPageQuery } from "./query-health/runtime";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { Page, Request } from "playwright-core";
import { DiagnosticLog, diagnostics } from "./diagnostics";
import {
  bindOfficialPage,
  officialGovernor,
  officialPageContext,
  officialPageSignal,
  onOfficialFirstDispatch,
  withOfficialAction,
} from "./official-access";
vi.mock("./crawler/access-guard", () => ({ watchCrawlAccess: vi.fn(async () => async () => {}) }));
const databases: DatabaseSync[] = [],
  pages: { close(): Promise<void> }[] = [],
  directories: string[] = [];
function page(context = {}) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const target = {
    context: () => context,
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    goto: vi.fn(async () => "loaded"),
    mouse: { click: vi.fn(async () => {}), move: vi.fn(async () => {}) },
    keyboard: {},
    on: (event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    off: vi.fn(),
    once: (event: string, listener: () => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
    },
    close: vi.fn(async () => {
      for (const listener of listeners.get("close") ?? []) listener();
      listeners.delete("close");
    }),
  };
  pages.push(target);
  return target;
}
function setup() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const gate = officialGovernor(db),
    state = gate.read();
  gate.updatePolicy(
    { ...state.policy, version: 2, minIntervalMs: 0, maxActionsPerWindow: 100 },
    state.revision,
  );
  return { db, gate };
}
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
  databases.splice(0).forEach((db) => db.close());
  vi.restoreAllMocks();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  vi.useRealTimers();
});
it("两个自有页共享会话和许可账本，组合点击只计一次动作", async () => {
  const { db } = setup(),
    browserContext = {},
    first = page(browserContext),
    second = page(browserContext);
  const clickSpy = first.mouse.click;
  await bindOfficialPage(first as unknown as Page, { runId: "run", sourceKind: "test" });
  await bindOfficialPage(second as unknown as Page, { runId: "run", sourceKind: "test" });
  expect(officialPageContext(first as unknown as Page)?.browserSessionEpoch).toBe(
    officialPageContext(second as unknown as Page)?.browserSessionEpoch,
  );
  await withOfficialAction(first as unknown as Page, "validated-click", async () => {
    await first.mouse.move();
    await first.mouse.click();
  });
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM access_permits WHERE status='completed'").get()?.n,
  ).toBe(1);
  expect(clickSpy).toHaveBeenCalled();
  await second.goto();
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM access_permits WHERE status='completed'").get()?.n,
  ).toBe(2);
});
it("风险提交后旧页面不能派发，未知副作用不返还预算", async () => {
  const { db, gate } = setup(),
    target = page();
  await bindOfficialPage(target as unknown as Page, { runId: "run", sourceKind: "test" });
  await expect(
    withOfficialAction(target as unknown as Page, "lost-click", async () => {
      throw new Error("lost receipt");
    }),
  ).rejects.toThrow("lost receipt");
  expect(gate.read().state).toBe("needs_action");
  await expect(target.goto()).rejects.toThrow();
  expect(db.prepare("SELECT status FROM access_permits").get()?.status).toBe("unknown");
});
it("动作原异常在unknown撤权前持久化，保留同一异常且后续动作仍暂停", async () => {
  vi.useFakeTimers();
  const { db, gate } = setup(),
    target = page(),
    originalGoto = target.goto;
  await bindOfficialPage(target as unknown as Page, { runId: "hover-run", sourceKind: "workflow" });
  const signal = officialPageSignal(target as unknown as Page)!;
  const original = new Error(
    "locator.hover: Timeout 5000ms exceeded\nCall log: node remains covered",
  );
  original.name = "TimeoutError";
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-official-action-log-"));
  directories.push(directory);
  const log = new DiagnosticLog(directory);
  const atFailure: { error: unknown; aborted: boolean; state: string; permitStatus: unknown }[] =
    [];
  vi.spyOn(diagnostics, "record").mockImplementation((event, data) => {
    if (event === "access.action_failed")
      atFailure.push({
        error: data?.error,
        aborted: signal.aborted,
        state: gate.read().state,
        permitStatus: db.prepare("SELECT status FROM access_permits").get()?.status,
      });
    log.record(event, data);
  });
  await expect(
    withOfficialAction(target as unknown as Page, "locator.hover", async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  expect(atFailure).toEqual([
    { error: original, aborted: false, state: "ready", permitStatus: "dispatch_authorized" },
  ]);
  expect(atFailure[0]?.error).toBe(original);
  const permit = db.prepare("SELECT status,end_reason,context_json FROM access_permits").get()!;
  const context = JSON.parse(String(permit.context_json));
  const persisted = new DiagnosticLog(directory).export();
  expect(persisted.writeError).toBeNull();
  expect(persisted.incompleteLines).toBe(0);
  expect(persisted.events).toMatchObject([
    { event: "access.action_dispatch", data: { ...context, action: "locator.hover" } },
    {
      event: "access.action_failed",
      data: {
        ...context,
        action: "locator.hover",
        error: { name: "TimeoutError", message: original.message },
      },
    },
  ]);
  expect(permit).toMatchObject({ status: "unknown", end_reason: "dispatch_outcome_unknown" });
  expect(gate.read()).toMatchObject({
    state: "needs_action",
    stopEpoch: 1,
    reasons: [expect.objectContaining({ code: "unknown_inflight" })],
  });
  await expect(target.goto()).rejects.toThrow();
  expect(originalGoto).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(signal.aborted).toBe(true);
  expect(signal.reason).not.toBe(original);
  await expect(target.goto()).rejects.toBe(signal.reason);
  expect(originalGoto).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) AS n FROM access_permits").get()?.n).toBe(1);
});
it("诊断记录自身抛错仍原样抛出动作异常并保留unknown暂停", async () => {
  vi.useFakeTimers();
  const { db, gate } = setup(),
    target = page();
  await bindOfficialPage(target as unknown as Page, { runId: "hover-run", sourceKind: "workflow" });
  const signal = officialPageSignal(target as unknown as Page)!;
  const original = new Error("original hover failure"),
    diagnosticFailure = new Error("diagnostic sink unavailable");
  const recorded: unknown[] = [];
  vi.spyOn(diagnostics, "record").mockImplementation((event, data) => {
    if (event === "access.action_failed") {
      recorded.push(data?.error);
      throw diagnosticFailure;
    }
  });
  await expect(
    withOfficialAction(target as unknown as Page, "locator.hover", async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  expect(recorded).toEqual([original]);
  expect(recorded[0]).toBe(original);
  expect(gate.read()).toMatchObject({ state: "needs_action", stopEpoch: 1 });
  expect(db.prepare("SELECT status FROM access_permits").get()?.status).toBe("unknown");
  await vi.advanceTimersByTimeAsync(200);
  expect(signal.aborted).toBe(true);
  const next = vi.fn(async () => {});
  await expect(withOfficialAction(target as unknown as Page, "next-action", next)).rejects.toBe(
    signal.reason,
  );
  expect(next).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) AS n FROM access_permits").get()?.n).toBe(1);
});
it("首次读取截止时间在许可实际派发时开始，重新绑定增加页面代次", async () => {
  const { gate } = setup(),
    target = page();
  await bindOfficialPage(target as unknown as Page, { runId: "first", sourceKind: "test" });
  const before = officialPageContext(target as unknown as Page)!;
  await bindOfficialPage(target as unknown as Page, { runId: "second", sourceKind: "test" });
  expect(officialPageContext(target as unknown as Page)?.runId).toBe("second");
  expect(officialPageContext(target as unknown as Page)?.pageGeneration).toBe(
    before.pageGeneration + 1,
  );
  const callback = vi.fn();
  expect(onOfficialFirstDispatch(target as unknown as Page, callback)).toBe(true);
  expect(callback).not.toHaveBeenCalled();
  await target.goto();
  expect(callback).toHaveBeenCalledOnce();
  expect(gate.read().state).toBe("ready");
});

it("explicit crawl binding checks its business lease even when the service owner remains healthy", async () => {
  const { db, gate } = setup(),
    target = page();
  db.exec(
    "CREATE TABLE crawl_lock(id INTEGER PRIMARY KEY,owner TEXT,fence INTEGER,expires_at INTEGER)",
  );
  db.prepare("INSERT INTO crawl_lock VALUES(1,'crawl',4,?)").run(Date.now() + 120000);
  await bindOfficialPage(target as unknown as Page, {
    runId: "crawl",
    sourceKind: "arbitrary-source-name",
    crawlLease: { owner: "crawl", fence: 4 },
  });
  expect(officialPageContext(target as unknown as Page)?.crawlLease).toEqual({
    owner: "crawl",
    fence: 4,
  });
  const service = officialPageContext(target as unknown as Page)!;
  db.prepare("UPDATE crawl_lock SET owner='replacement',fence=5").run();
  gate.renewOwner(service);
  const dispatched = vi.fn(async () => {});
  await expect(
    withOfficialAction(target as unknown as Page, "stale-action", dispatched),
  ).rejects.toThrow("业务租约");
  expect(dispatched).not.toHaveBeenCalled();
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM access_permits WHERE authorized_at IS NOT NULL").get()?.n,
  ).toBe(0);
});

it("T11 迟到响应保留请求发起时query/action，不贴上当前新查询", async () => {
  const { db } = setup(),
    target = page();
  const request = {} as Request;
  await bindOfficialPage(target as unknown as Page, { runId: "run", sourceKind: "test" });
  const old = officialPageContext(target as unknown as Page)!;
  await withOfficialAction(target as unknown as Page, "query-old", async () => {
    target.emit("request", request);
  });
  beginPageQuery(target as unknown as Page, {
    category: "role",
    server: "1",
    serverAge: "older",
    conditions: {},
    page: 2,
    sort: "price",
  });
  const receive = vi.mocked(watchCrawlAccess).mock.calls.at(-1)![3]!;
  receive(
    {
      kind: "unknown",
      reason: "body_unavailable",
      url: "https://xyq.cbg.163.com/cgi-bin/recommend.py",
    },
    { url: "https://xyq.cbg.163.com/cgi-bin/recommend.py", status: 200, resourceType: "script" },
    request,
  );
  const recorded = JSON.parse(
    String(db.prepare("SELECT context_json FROM access_requests").get()?.context_json),
  );
  const permit = JSON.parse(
    String(db.prepare("SELECT context_json FROM access_permits").get()?.context_json),
  );
  expect(recorded.queryId).toBe(old.queryId);
  expect(recorded.actionId).toBe(permit.actionId);
  expect(recorded.actionId).toBeTruthy();
  expect(recorded.queryId).not.toBe(officialPageContext(target as unknown as Page)?.queryId);
});
