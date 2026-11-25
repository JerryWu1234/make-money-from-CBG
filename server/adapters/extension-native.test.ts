import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { ExtensionNativeRuntime } from "./extension-native";
import type { ActionPlan } from "./contracts";

function fixture() {
  const db = new DatabaseSync(":memory:"),
    risks: unknown[] = [],
    writes: any[] = [];
  let epoch = 0,
    sequence = 0,
    dispatches = 0,
    activityGranted = true,
    legacyAwakeOnly = false,
    holdRenewals = false,
    holdEnds = false;
  const runtime = new ExtensionNativeRuntime({
    db,
    socketPath: "/private/tmp/not-started-cbg-fixture.sock",
    stopEpoch: () => epoch,
    onRisk: async (reason, evidence) => {
      risks.push({ reason, evidence });
      epoch++;
    },
    runAction: async (_plan, dispatch) => {
      dispatches++;
      return dispatch();
    },
  });
  const internals = runtime as any;
  internals.socket = {
    destroyed: false,
    write: (value: string) => {
      const message = JSON.parse(value);
      writes.push(message);
      if (
        message.kind === "activity" &&
        !(holdRenewals && message.command === "renew") &&
        !(holdEnds && message.command === "end")
      )
        queueMicrotask(() => {
          void internals.receive({
            kind: "input-result",
            actionId: message.actionId,
            ok: activityGranted,
            ...(legacyAwakeOnly ? { awake: true } : { active: message.command !== "end" }),
            activityId: message.activity.activityId,
            error: activityGranted ? undefined : "native-activity-grant-failed",
          });
        });
      if (message.kind === "resume" && !message.context?.recoveryEpoch)
        queueMicrotask(() => {
          void internals.receive({ kind: "input-result", actionId: message.actionId, ok: true });
        });
    },
    destroy: () => {},
  };
  const envelope = (kind: string, payload: unknown) => ({
    version: 1,
    connectionEpoch: "connection",
    messageId: `message-${++sequence}`,
    sequence,
    kind,
    payload,
  });
  const receive = (kind: string, payload: unknown) => internals.receive(envelope(kind, payload));
  const base = () => ({
    pageId: "page-1",
    pageGeneration: 1,
    observedAt: new Date().toISOString(),
    url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=role",
    title: "fixture",
    revision: "revision-1",
    visible: true,
    loading: false,
    access: "normal",
    empty: true,
    listing: { page: 1, totalPages: 2, order: "selling_time DESC", serverType: "1,2,3", items: [] },
    business: [],
  });
  const bind = async () => {
    await receive("status", { bound: true, pageId: "page-1", pageGeneration: 1 });
    await receive("snapshot", base());
  };
  return {
    db,
    runtime,
    internals,
    risks,
    writes,
    base,
    bind,
    receive,
    envelope,
    setEpoch: (next: number) => {
      epoch = next;
    },
    dispatches: () => dispatches,
    denyActivityGrant: () => {
      activityGranted = false;
    },
    legacyAwakeOnly: () => {
      legacyAwakeOnly = true;
    },
    holdRenewals: () => {
      holdRenewals = true;
    },
    holdEnds: (value: boolean) => {
      holdEnds = value;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("extension-native runtime fences and observation", () => {
  it("binding and idle hold no activity; a failed activity grant prevents any input", async () => {
    const f = fixture();
    await f.bind();
    expect(f.writes.filter((write) => write.kind === "activity")).toHaveLength(0);
    f.denyActivityGrant();
    const before = await f.runtime.snapshot();
    await expect(
      f.runtime.execute({
        ...before.context,
        actionId: "denied",
        target: { kind: "refresh-list", url: before.url },
        expected: { kind: "page", page: 1 },
      }),
    ).rejects.toThrow("activity-grant-failed");
    expect(f.writes.filter((write) => write.command === "execute")).toHaveLength(0);
    expect(f.runtime.status().stopped).toBe(true);
    f.db.close();
  });
  it("a legacy awake-only ACK cannot grant input authorization", async () => {
    const f = fixture();
    await f.bind();
    f.legacyAwakeOnly();
    await expect(f.runtime.activity.begin(new AbortController().signal)).rejects.toThrow(
      "输入活动授权申请失败",
    );
    expect(f.runtime.status().stopped).toBe(true);
    expect(f.writes.some((message) => message.command === "execute")).toBe(false);
    f.db.close();
  });
  it("a matching end ACK that still claims active cannot confirm authorization revocation", async () => {
    const f = fixture();
    await f.bind();
    const activity = await f.runtime.activity.begin(new AbortController().signal);
    f.holdEnds(true);
    const closing = activity.close();
    const rejected = expect(closing).rejects.toThrow("活动结束未确认");
    await Promise.resolve();
    await Promise.resolve();
    const ended = f.writes
      .filter((message) => message.kind === "activity" && message.command === "end")
      .at(-1);
    await f.internals.receive({
      kind: "input-result",
      actionId: ended.actionId,
      activityId: ended.activity.activityId,
      ok: true,
      active: true,
    });
    await rejected;
    expect(f.runtime.status().stopped).toBe(true);
    expect(f.writes.some((message) => message.command === "execute")).toBe(false);
    f.db.close();
  });
  it("retains the activity throughout a page wait and releases only after business confirmation", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.bind();
    const before = await f.runtime.snapshot();
    const plan: ActionPlan = {
      ...before.context,
      actionId: "waiting",
      target: { kind: "refresh-list", url: before.url },
      expected: { kind: "page", page: 1 },
    };
    const operation = f.runtime.execute(plan);
    await vi.advanceTimersByTimeAsync(1);
    await f.internals.receive({
      kind: "input-result",
      actionId: plan.actionId,
      ok: true,
      posted: true,
    });
    await vi.advanceTimersByTimeAsync(9000);
    expect(f.internals.workflowActivity).toBeDefined();
    expect(f.writes.some((write) => write.kind === "activity" && write.command === "renew")).toBe(
      true,
    );
    expect(f.writes.some((write) => write.kind === "activity" && write.command === "end")).toBe(
      false,
    );
    f.holdRenewals();
    await f.receive("snapshot", {
      ...f.base(),
      revision: "new-result",
      actionContext: plan,
      listingCommitted: true,
      listingCommit: { actionId: plan.actionId, sequence: 1 },
    });
    await vi.advanceTimersByTimeAsync(1);
    const pendingRenewal = f.writes
      .filter((write) => write.kind === "activity" && write.command === "renew")
      .at(-1);
    expect(pendingRenewal.activity.progressSequence).toBe(1);
    const renewalCount = f.writes.filter(
      (write) => write.kind === "activity" && write.command === "renew",
    ).length;
    await vi.advanceTimersByTimeAsync(3000);
    expect(
      f.writes.filter((write) => write.kind === "activity" && write.command === "renew"),
    ).toHaveLength(renewalCount);
    await f.internals.receive({
      kind: "input-result",
      actionId: pendingRenewal.actionId,
      ok: true,
      active: true,
      activityId: pendingRenewal.activity.activityId,
    });
    await operation;
    expect(
      f.writes.filter((write) => write.kind === "activity" && write.command === "end"),
    ).toHaveLength(1);
    expect(f.internals.workflowActivity).toBeUndefined();
    f.db.close();
  });
  it("a rejected business-progress renewal stops input and persists the activity risk", async () => {
    const f = fixture();
    await f.bind();
    const activity = await f.runtime.activity.begin(new AbortController().signal);
    f.denyActivityGrant();
    await expect(
      f.internals.queueActivityRenew(f.internals.workflowActivity, "confirmed-business"),
    ).rejects.toThrow("activity-grant-failed");
    expect(f.runtime.status().stopped).toBe(true);
    expect(f.risks).toHaveLength(1);
    expect(activity.signal.aborted).toBe(true);
    await activity.close();
    f.db.close();
  });
  it("an old end failure cannot stop an activity started while its ACK was pending", async () => {
    const f = fixture();
    await f.bind();
    const old = await f.runtime.activity.begin(new AbortController().signal);
    f.holdEnds(true);
    const closing = old.close();
    const rejected = expect(closing).rejects.toThrow("old-end-denied");
    await Promise.resolve();
    await Promise.resolve();
    const ending = f.writes
      .filter((write) => write.kind === "activity" && write.command === "end")
      .at(-1);
    const next = await f.runtime.activity.begin(new AbortController().signal);
    await f.internals.receive({
      kind: "input-result",
      actionId: ending.actionId,
      ok: false,
      error: "old-end-denied",
    });
    await rejected;
    expect(next.signal.aborted).toBe(false);
    expect(f.runtime.status().stopped).toBe(false);
    f.holdEnds(false);
    await next.close();
    f.db.close();
  });
  it("cancellation while resuming an idle binding cannot acquire an activity", async () => {
    const f = fixture();
    await f.bind();
    const control = new AbortController();
    f.internals.idle = true;
    vi.spyOn(f.runtime, "resumeForRun").mockImplementation(async () => {
      control.abort(new Error("cancelled before activation"));
    });
    await expect(f.runtime.activity.begin(control.signal)).rejects.toThrow(
      "cancelled before activation",
    );
    expect(f.writes.filter((write) => write.kind === "activity")).toHaveLength(0);
    f.db.close();
  });
  it.each(["cancel", "disconnect", "expired"])(
    "%s releases the activity and never restarts it from heartbeat",
    async (scenario) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.bind();
      const control = new AbortController();
      const handle = await f.runtime.activity.begin(control.signal);
      if (scenario === "cancel") control.abort(new Error("cancelled workflow"));
      if (scenario === "disconnect")
        await f.internals.receive({
          kind: "host-status",
          stopped: true,
          reason: "native-host-disconnected",
        });
      if (scenario === "expired") await vi.advanceTimersByTimeAsync(180001);
      expect(handle.signal.aborted).toBe(true);
      expect(f.runtime.status().stopped).toBe(true);
      const count = f.writes.length;
      await vi.advanceTimersByTimeAsync(30000);
      expect(f.writes).toHaveLength(count);
      await handle.close();
      expect(f.internals.workflowActivity).toBeUndefined();
      f.db.close();
    },
  );
  it("an old cancellation or cleanup cannot stop the next activity", async () => {
    const f = fixture();
    await f.bind();
    const old = await f.runtime.activity.begin(new AbortController().signal);
    await f.runtime.stop("pause");
    await f.bind();
    const next = await f.runtime.activity.begin(new AbortController().signal);
    await old.close();
    await f.internals.failActivity("late-old-heartbeat", old.lease);
    expect(next.signal.aborted).toBe(false);
    expect(f.internals.workflowActivity.lease.activityId).toBe(next.lease.activityId);
    await next.close();
    f.db.close();
  });
  it("restores a read-only snapshot on duplicate delivery without rewriting its old stop epoch", async () => {
    const f = fixture();
    await f.bind();
    const message = f.envelope("snapshot", { ...f.base(), revision: "duplicate" });
    await f.internals.receive(message);
    f.internals.snapshots.clear();
    f.setEpoch(5);
    await f.internals.receive(message);
    expect((await f.runtime.snapshot()).context.stopEpoch).toBe(0);
    expect((await f.runtime.snapshot()).revision).toBe("duplicate");
    expect(
      f.db
        .prepare("SELECT COUNT(*) AS n FROM access_bridge_receipts WHERE message_id=?")
        .get(message.messageId)?.n,
    ).toBe(1);
    f.db.close();
  });
  it("archives unbound or future snapshots without making them current", async () => {
    const f = fixture();
    await f.receive("snapshot", f.base());
    await expect(f.runtime.snapshot()).rejects.toThrow("缺失或过期");
    await f.bind();
    await f.receive("snapshot", {
      ...f.base(),
      revision: "future",
      observedAt: new Date(Date.now() + 3600000).toISOString(),
    });
    expect((await f.runtime.snapshot()).revision).toBe("revision-1");
    f.db.close();
  });
  it.each([
    { status: 403 },
    { status: 429 },
    { status: 200, denial: { status: 1, msg: "请先登录" } },
  ])("persists shared response protection before receipt/ACK: %j", async (business) => {
    const f = fixture();
    await f.bind();
    await f.receive("snapshot", {
      ...f.base(),
      revision: "blocked",
      business: [
        {
          kind: "jsonp",
          endpoint: "/cgi-bin/recommend.py",
          observedAt: new Date().toISOString(),
          ...business,
        },
      ],
    });
    expect(f.risks).toHaveLength(1);
    expect(f.runtime.status().stopped).toBe(true);
    expect(f.writes.at(-1).kind).toBe("ack");
    f.db.close();
  });
  it("skips an already-selected detail tab before acquiring an action permit", async () => {
    const f = fixture();
    await f.bind();
    await f.receive("snapshot", {
      ...f.base(),
      detail: {
        url: "fixture",
        collectedAt: "now",
        tabs: [{ name: "技能", text: "", fields: [], tables: [], elements: [], tooltips: [] }],
        raw: {},
      },
    });
    const before = await f.runtime.snapshot();
    const plan: ActionPlan = {
      ...before.context,
      actionId: "noop",
      target: { kind: "detail-tab", name: "技能" },
      expected: { kind: "changed" },
    };
    expect((await f.runtime.execute(plan)).detail?.tabs[0].name).toBe("技能");
    expect(f.dispatches()).toBe(0);
    expect(f.writes.some((write) => write.command === "execute")).toBe(false);
    f.db.close();
  });
  it("handshakes a fresh recovery binding and never relabels queued pre-recovery evidence", async () => {
    const f = fixture();
    await f.bind();
    await f.receive("snapshot", { ...f.base(), authenticated: true });
    await f.runtime.stop("manual-check");
    f.setEpoch(1);
    vi.spyOn(f.runtime, "nativeStatus").mockResolvedValue({
      ok: true,
      permissions: {
        accessibility: true,
        inputMonitoring: true,
        inputMonitorActive: true,
        locked: false,
        frontmostChrome: true,
      },
    });
    const recovery = f.runtime.prepareManualRecovery();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    const message = f.writes.find(
      (value) => value.kind === "resume" && value.context?.recoveryEpoch,
    );
    expect(message.context.recoveryEpoch).toBeTypeOf("string");
    await f.internals.receive({ kind: "input-result", actionId: message.actionId, ok: true });
    await f.receive("snapshot", {
      ...f.base(),
      authenticated: true,
      revision: "stale-after-resume",
    });
    expect((await f.runtime.snapshot()).context.stopEpoch).toBe(0);
    await f.receive("snapshot", {
      ...f.base(),
      authenticated: true,
      revision: "fresh-after-resume",
      bindingContext: { recoveryEpoch: message.context.recoveryEpoch },
    });
    const ticket = await recovery;
    expect(f.runtime.status().stopped).toBe(true);
    f.runtime.completeManualRecovery(ticket);
    expect((await f.runtime.snapshot()).context.stopEpoch).toBe(1);
    expect(f.runtime.status().stopped).toBe(false);
    f.db.close();
  });
  it("keeps recovery stopped when native permission preflight fails", async () => {
    const f = fixture();
    await f.bind();
    await f.receive("snapshot", { ...f.base(), authenticated: true });
    await f.runtime.stop("manual-check");
    vi.spyOn(f.runtime, "nativeStatus").mockResolvedValue({
      ok: true,
      permissions: { accessibility: false },
    });
    await expect(f.runtime.prepareManualRecovery()).rejects.toThrow("原生权限");
    expect(f.runtime.status().stopped).toBe(true);
    expect(f.runtime.status().recoveringStopEpoch).toBeUndefined();
    expect(f.writes.some((value) => value.kind === "resume" && value.context?.recoveryEpoch)).toBe(
      false,
    );
    f.db.close();
  });
  it("revokes a recovery handshake on disconnect or a newer risk", async () => {
    const f = fixture();
    await f.bind();
    await f.receive("snapshot", { ...f.base(), authenticated: true });
    await f.runtime.stop("manual-check");
    vi.spyOn(f.runtime, "nativeStatus").mockResolvedValue({
      ok: true,
      permissions: {
        accessibility: true,
        inputMonitoring: true,
        inputMonitorActive: true,
        locked: false,
        frontmostChrome: true,
      },
    });
    const operation = f.runtime.prepareManualRecovery(),
      asserted = expect(operation).rejects.toThrow("新风险");
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(f.runtime.status().recoveringStopEpoch).toBe(0);
    f.setEpoch(1);
    await f.runtime.stop("新风险中断恢复");
    await asserted;
    expect(f.runtime.status().stopped).toBe(true);
    expect(f.runtime.status().recoveringStopEpoch).toBeUndefined();
    expect(() =>
      f.runtime.completeManualRecovery({
        ticketId: "stale",
        stopEpoch: 0,
        pageId: "page-1",
        pageGeneration: 1,
        browserSessionEpoch: "old",
        verifiedAt: Date.now(),
      }),
    ).toThrow("票据已失效");
    f.db.close();
  });
  it("re-enables two normally completed or timed runs without reviewing unknown actions", async () => {
    const f = fixture();
    await f.bind();
    await f.receive("snapshot", { ...f.base(), authenticated: true });
    vi.spyOn(f.runtime, "nativeStatus").mockResolvedValue({
      ok: true,
      permissions: {
        accessibility: true,
        inputMonitoring: true,
        inputMonitorActive: true,
        locked: false,
        frontmostChrome: true,
      },
    });
    for (const reason of ["completed", "time_limit"]) {
      await f.runtime.finishRun(reason);
      expect(f.runtime.status().idle).toBe(true);
      expect(f.runtime.status().stopped).toBe(true);
      const activation = f.runtime.resumeForRun();
      for (let index = 0; index < 12; index++) await Promise.resolve();
      const message = f.writes.filter((value) => value.kind === "resume" && value.context).at(-1);
      await f.internals.receive({ kind: "input-result", actionId: message.actionId, ok: true });
      await f.receive("snapshot", {
        ...f.base(),
        authenticated: true,
        revision: "resumed-" + reason,
        bindingContext: { recoveryEpoch: message.context.recoveryEpoch },
      });
      await activation;
      expect(f.runtime.status().stopped).toBe(false);
      expect(f.runtime.status().idle).toBe(false);
    }
    expect(
      f.db.prepare("SELECT COUNT(*) AS n FROM access_bridge_commands WHERE state='reviewed'").get()
        ?.n,
    ).toBe(0);
    f.db.close();
  });
  it("never converts a manual stop or an unknown dispatch into an automatic idle restart", async () => {
    const f = fixture();
    await f.bind();
    await f.runtime.stop("user-stop");
    await f.runtime.finishRun("completed");
    expect(f.runtime.status().idle).toBe(false);
    await expect(f.runtime.resumeForRun()).rejects.toThrow("人工停止");
    await f.receive("status", { bound: true, pageId: "page-1", pageGeneration: 1 });
    await f.receive("snapshot", f.base());
    f.internals.store.authorize("unconfirmed", {});
    await f.runtime.finishRun("time_limit");
    expect(f.runtime.status().idle).toBe(false);
    await expect(f.runtime.resumeForRun()).rejects.toThrow("未知动作");
    expect(f.runtime.status().unknownActions).toBe(1);
    f.db.close();
  });
  it("does not accept an old same-page snapshot as a fresh refresh/query commit", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.bind();
    const before = await f.runtime.snapshot();
    const plan: ActionPlan = {
      ...before.context,
      actionId: "refresh",
      target: { kind: "refresh-list", url: before.url },
      expected: { kind: "page", page: 1 },
    };
    const operation = f.runtime.execute(plan);
    const asserted = expect(operation).rejects.toThrow("结果未知");
    await vi.advanceTimersByTimeAsync(1);
    await f.internals.receive({
      kind: "input-result",
      actionId: "refresh",
      ok: true,
      posted: true,
    });
    await f.receive("snapshot", { ...f.base(), revision: "unrelated-mutation" });
    await vi.advanceTimersByTimeAsync(12001);
    await asserted;
    expect(f.risks).toHaveLength(1);
    expect(f.runtime.status().unknownActions).toBe(1);
    expect(f.writes.filter((write) => write.command === "execute")).toHaveLength(1);
    f.db.close();
  });
  it.each([
    { kind: "market-submit", category: "equipment" },
    { kind: "market-page", page: 1 },
    { kind: "sort", value: "price ASC" },
  ] as const)(
    "$kind requires a current callback receipt as well as a fresh snapshot",
    async (target) => {
      vi.useFakeTimers();
      const f = fixture();
      await f.bind();
      const startedAt = new Date().toISOString();
      const market = {
        category: "equipment",
        page: 1,
        totalPages: 1,
        order: "price ASC",
        conditions: {},
        rows: [],
        empty: true,
        committed: true,
      };
      const oldResponse = {
        kind: "jsonp",
        endpoint: "/cgi-bin/recommend.py",
        status: 200,
        success: true,
        count: 0,
        requestId: "old-request",
        eventId: "old-event",
        actionId: "old-action",
        queryId: "old-query",
        startedAt,
        observedAt: startedAt,
      };
      await f.receive("snapshot", {
        ...f.base(),
        listing: undefined,
        market,
        business: [oldResponse],
      });
      const before = await f.runtime.snapshot();
      const plan: ActionPlan = {
        ...before.context,
        actionId: "current-submit",
        target,
        expected: { kind: "changed" },
      };
      let completed = false;
      const operation = f.runtime.execute(plan).then((value) => {
        completed = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(1);
      await f.internals.receive({
        kind: "input-result",
        actionId: plan.actionId,
        ok: true,
        posted: true,
      });
      const deliver = async (
        requestId: string,
        eventId: string,
        responseOverride: Record<string, unknown> = {},
        time = new Date().toISOString(),
        ignoredOldResponse = false,
      ) => {
        const commit = {
          actionId: plan.actionId,
          queryId: plan.queryId,
          requestId,
          eventId,
          startedAt: time,
          completedAt: new Date().toISOString(),
        };
        await f.receive("snapshot", {
          ...f.base(),
          listing: undefined,
          observedAt: new Date().toISOString(),
          revision: `snapshot-${requestId}-${eventId}-${Object.keys(responseOverride).join(",")}`,
          actionContext: plan,
          market: { ...market, commit },
          business: [
            { ...oldResponse, ...commit, observedAt: commit.completedAt, ...responseOverride },
            ...(ignoredOldResponse ? [oldResponse] : []),
          ],
        });
        await vi.advanceTimersByTimeAsync(1);
      };
      // Merely restamping the old business receipt with the current query is insufficient.
      await deliver("old-request", "old-event");
      expect(completed).toBe(false);
      await deliver("new-request", "new-event", { eventId: "another-event" });
      expect(completed).toBe(false);
      await deliver("new-request", "new-event", { success: false });
      expect(completed).toBe(false);
      await deliver(
        "new-request",
        "new-event",
        {},
        new Date(Date.parse(startedAt) - 1).toISOString(),
      );
      expect(completed).toBe(false);
      await deliver("new-request", "new-event", {}, new Date().toISOString(), true);
      await expect(operation).resolves.toMatchObject({
        market: { committed: true, commit: { actionId: plan.actionId } },
      });
      expect(completed).toBe(true);
      expect(f.risks).toHaveLength(0);
      f.db.close();
    },
  );
});
