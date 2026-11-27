import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ActionPlan } from "./adapters/contracts";
import { withNativeWorkflow } from "./adapters/native-workflow";
import { closeNativeAccess, nativeAccess, nativeBrowserState } from "./native-access";
import { officialGovernor } from "./official-access";

const captured = vi.hoisted(() => ({
  options: undefined as any,
  database: undefined as DatabaseSync | undefined,
  start: vi.fn(async () => {}),
  snapshot: vi.fn(async (): Promise<any> => {
    throw new Error("not bound");
  }),
  status: {
    stopped: true,
    recoveringStopEpoch: undefined as number | undefined,
    connected: false,
    reason: undefined as string | undefined,
  },
  stop: vi.fn(async () => {
    captured.status.stopped = true;
    captured.status.recoveringStopEpoch = undefined;
  }),
}));
const nativePage = vi.hoisted(() => ({ open: vi.fn(async () => {}) }));
vi.mock("./native-cbg-page", () => ({ openNativeCbgPage: nativePage.open }));
vi.mock("./adapters/extension-native", () => ({
  ExtensionNativeRuntime: class {
    constructor(options: unknown) {
      captured.options = options;
    }
    start = captured.start;
    snapshot = captured.snapshot;
    close = async () => {};
    stop = captured.stop;
    status = () => captured.status;
  },
}));
vi.mock("./crawler/controller", () => ({
  crawlDatabase: () => {
    if (!captured.database) throw new Error("test database missing");
    return captured.database;
  },
}));
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  await closeNativeAccess();
  for (const db of dbs.splice(0)) db.close();
  vi.useRealTimers();
  captured.stop.mockClear();
  captured.status = {
    stopped: true,
    recoveringStopEpoch: undefined,
    connected: false,
    reason: undefined,
  };
  captured.database = undefined;
  captured.start.mockClear();
  nativePage.open.mockClear();
  captured.snapshot.mockReset().mockRejectedValue(new Error("not bound"));
});

it("paused heartbeat preserves an already-stopped binding handshake, but still stops active input", async () => {
  vi.useFakeTimers();
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  await nativeAccess(db);
  const gate = officialGovernor(db);
  gate.reportRisk({ reason: "unknown_inflight" });

  // Before its first snapshot, a newly connected extension must be able to
  // deliver the bound status. Repeated stop commands invalidate that handshake.
  await vi.advanceTimersByTimeAsync(3000);
  expect(captured.stop).not.toHaveBeenCalled();
  expect(gate.read().state).toBe("needs_action");

  captured.status.stopped = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(captured.stop).toHaveBeenCalledExactlyOnceWith("官网访问状态已暂停");
  await vi.advanceTimersByTimeAsync(3000);
  expect(captured.stop).toHaveBeenCalledOnce();
  expect(gate.read().state).toBe("needs_action");
});

it("paused heartbeat preserves the current recovery but cancels it once a new risk changes the epoch", async () => {
  vi.useFakeTimers();
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  await nativeAccess(db);
  const gate = officialGovernor(db);
  const paused = gate.reportRisk({ reason: "login" });
  captured.status.recoveringStopEpoch = paused.stopEpoch;
  await vi.advanceTimersByTimeAsync(2000);
  expect(captured.stop).not.toHaveBeenCalled();

  gate.reportRisk({ reason: "manual_stop" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(captured.stop).toHaveBeenCalledExactlyOnceWith("官网访问状态已暂停");
  expect(captured.status.recoveringStopEpoch).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2000);
  expect(captured.stop).toHaveBeenCalledOnce();
});

it("native final dispatch keeps a crawl fence across page changes and never lends it to a queued market workflow", async () => {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  db.exec(
    "CREATE TABLE crawl_lock(id INTEGER PRIMARY KEY,owner TEXT,fence INTEGER,expires_at INTEGER)",
  );
  db.prepare("INSERT INTO crawl_lock VALUES(1,'crawl',1,?)").run(Date.now() + 120000);
  await nativeAccess(db);
  const gate = officialGovernor();
  const state = gate.read();
  gate.updatePolicy(
    { ...state.policy, version: state.policy.version + 1, minIntervalMs: 0 },
    state.revision,
  );
  const plan: ActionPlan = {
    runId: "run",
    queryId: "query",
    pageId: "new-detail-page",
    pageGeneration: 2,
    browserSessionEpoch: "session",
    stopEpoch: 0,
    actionId: "action",
    target: { kind: "query" },
    expected: { kind: "changed" },
  };
  const dispatch = vi.fn(async () => "sent");
  db.prepare("UPDATE crawl_lock SET owner='replacement',fence=2").run();
  await expect(
    withNativeWorkflow(
      new AbortController().signal,
      () => captured.options.runAction(plan, dispatch),
      { crawlLease: { owner: "crawl", fence: 1 }, context: () => undefined },
    ),
  ).rejects.toThrow("业务租约");
  expect(dispatch).not.toHaveBeenCalled();
  await expect(
    withNativeWorkflow(
      new AbortController().signal,
      () => captured.options.runAction({ ...plan, pageId: "market", actionId: "market" }, dispatch),
      { context: () => undefined },
    ),
  ).resolves.toBe("sent");
  expect(dispatch).toHaveBeenCalledOnce();
  const stored = JSON.parse(
    String(
      db.prepare("SELECT context_json FROM access_permits WHERE status='completed'").get()
        ?.context_json,
    ),
  );
  expect(stored.crawlLease).toBeUndefined();
});

it("native status polling starts only the local listener without requiring a start or extension click", async () => {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  captured.database = db;
  const result = await nativeBrowserState();
  expect(captured.start).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ connected: false, running: false, isLoggedIn: false });
  expect(result.message).toContain("自动连接");
  expect(captured.stop).not.toHaveBeenCalled();
  expect(nativePage.open).not.toHaveBeenCalled();
  expect(db.prepare("SELECT count(*) AS count FROM access_permits").get()?.count).toBe(0);
});
it("an explicit native open starts the listener and opens the CBG home page without starting a search or collection", async () => {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  captured.database = db;

  const result = await nativeBrowserState(true);

  expect(captured.start).toHaveBeenCalledOnce();
  expect(nativePage.open).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ connected: false, running: false, isLoggedIn: false });
  expect(captured.stop).not.toHaveBeenCalled();
  expect(db.prepare("SELECT count(*) AS count FROM access_permits").get()?.count).toBe(0);
});
it.each([
  { visible: true, listingCommitted: true, workflowStep: "completed" },
  { visible: false, listingCommitted: true, workflowStep: "completed" },
  { visible: true, listingCommitted: false, workflowStep: "idle" },
])(
  "only a committed role list enables collection (%o) while preserving a stopped access gate",
  async ({ visible, listingCommitted, workflowStep }) => {
    const db = new DatabaseSync(":memory:");
    dbs.push(db);
    await nativeAccess(db);
    const gate = officialGovernor(db);
    const paused = gate.reportRisk({ reason: "login" });
    captured.status.connected = true;
    captured.snapshot.mockResolvedValue({
      listing: { items: [{}] },
      visible,
      listingCommitted,
      authenticated: true,
      access: "normal",
      loading: false,
      url: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py",
      title: "角色列表",
    });
    expect(await nativeBrowserState()).toMatchObject({
      connected: true,
      isLoggedIn: true,
      workflowStep,
      running: false,
    });
    expect(gate.read()).toMatchObject({
      state: "needs_action",
      revision: paused.revision,
      stopEpoch: paused.stopEpoch,
    });
    expect(captured.stop).not.toHaveBeenCalled();
    expect(db.prepare("SELECT count(*) AS count FROM access_permits").get()?.count).toBe(0);
  },
);
it("a logged-in CBG home page reports login while waiting for a manual full-server search", async () => {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  await nativeAccess(db);
  captured.status.connected = true;
  captured.snapshot.mockResolvedValue({
    authenticated: true,
    access: "normal",
    loading: false,
    url: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py?act=show_search_role_form",
  });
  const result = await nativeBrowserState();
  expect(result).toMatchObject({
    isLoggedIn: true,
    loginStatus: "logged_in",
    workflowStep: "idle",
  });
  expect(result.message).toContain("全服搜索");
  expect(result.message).not.toContain("server-stop");
});

it("reports that a page navigation is waiting for extension rebinding", async () => {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  await nativeAccess(db);
  captured.status.connected = true;
  captured.status.reason = "unexpected-navigation-rebind-required";

  const result = await nativeBrowserState();

  expect(result.workflowStep).toBe("idle");
  expect(result.message).toContain("等待重新绑定");
});

it("a disconnected native host cannot expose a cached role list as ready", async () => {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  await nativeAccess(db);
  captured.snapshot.mockResolvedValue({
    listing: { items: [{}] },
    visible: true,
    authenticated: true,
    access: "normal",
    loading: false,
    url: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py",
  });
  expect(await nativeBrowserState()).toMatchObject({
    connected: false,
    isLoggedIn: false,
    workflowStep: "idle",
  });
});
