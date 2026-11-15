import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { ActionPlan } from "./adapters/contracts";
import { withNativeWorkflow } from "./adapters/native-workflow";
import { closeNativeAccess, nativeAccess } from "./native-access";
import { officialGovernor } from "./official-access";

const captured = vi.hoisted(() => ({ options: undefined as any }));
vi.mock("./adapters/extension-native", () => ({
  ExtensionNativeRuntime: class {
    constructor(options: unknown) {
      captured.options = options;
    }
    start = async () => {};
    close = async () => {};
    stop = async () => {};
  },
}));
const dbs: DatabaseSync[] = [];
afterEach(async () => {
  await closeNativeAccess();
  for (const db of dbs.splice(0)) db.close();
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
