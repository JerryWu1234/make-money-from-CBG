import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vite-plus/test";
import type { Page } from "playwright-core";
import { AccessGovernor, DEFAULT_ACCESS_POLICY, type AccessContext } from "../access";
import {
  beginPageQuery,
  bindQueryPage,
  finishPageQuery,
  QueryHealthError,
  queryPageContext,
  pendingPageQuery,
  successfulQueryEvidence,
  type QueryDiagnostic,
} from "./runtime";
import { QueryDiagnosticError } from "./diagnostic-state";

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function fixture(canaryEnabled = true) {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  const governor = new AccessGovernor(db, { policy: { ...DEFAULT_ACCESS_POLICY, canaryEnabled } });
  const owner = governor.acquireOwner("query-test");
  const context: AccessContext = {
    ...owner,
    runId: "run",
    queryId: "initial",
    pageId: "page",
    pageGeneration: 1,
    browserSessionEpoch: "session",
    sourceKind: "market",
    stopEpoch: governor.read().stopEpoch,
  };
  governor.registerPage(context);
  const page = {} as Page;
  bindQueryPage(page, governor, context);
  const identity = {
    category: "equipment",
    server: "367",
    serverAge: "3",
    conditions: { serverid: "367", damage: 600 },
    page: 1,
    sort: "default",
  };
  return { db, governor, page, context, identity };
}
it("T08/T10 晚到A不能接受未完成B、清除B或写入可信基线", async () => {
  const x = fixture(false);
  const first = beginPageQuery(x.page, x.identity)!;
  const second = beginPageQuery(x.page, { ...x.identity, page: 2 })!;
  await expect(finishPageQuery(x.page, first, successfulQueryEvidence(4))).rejects.toBeInstanceOf(
    QueryHealthError,
  );
  expect(pendingPageQuery(x.page)).toBe(second);
  expect(
    x.db.prepare("SELECT accepted FROM access_queries WHERE query_id=?").get(second.queryId)
      ?.accepted,
  ).toBe(0);
  expect(
    x.db.prepare("SELECT 1 FROM query_health_results WHERE query_id=?").get(first.queryId),
  ).toBeUndefined();
  expect(() => x.governor.withProgress(queryPageContext(x.page)!, () => {})).toThrow();
  await finishPageQuery(x.page, second, successfulQueryEvidence(2));
  expect(() => x.governor.withProgress(queryPageContext(x.page)!, () => {})).not.toThrow();
});
it("T09 actively reviews once then uses one real broad baseline, never accepting probe data", async () => {
  const x = fixture();
  await finishPageQuery(
    x.page,
    beginPageQuery(x.page, { ...x.identity, conditions: { serverid: "367" } }),
    successfulQueryEvidence(5),
  );
  await finishPageQuery(x.page, beginPageQuery(x.page, x.identity), successfulQueryEvidence(2));
  const probes: unknown[] = [];
  const query = beginPageQuery(x.page, x.identity);
  await expect(
    finishPageQuery(
      x.page,
      query,
      successfulQueryEvidence(0),
      async (identity) => {
        probes.push(identity.conditions);
        return successfulQueryEvidence(probes.length === 1 ? 0 : 10);
      },
      { pageNumber: 9, exhausted: false },
    ),
  ).rejects.toBeInstanceOf(QueryHealthError);
  expect(probes).toEqual([{ serverid: "367", damage: 600 }, { serverid: "367" }]);
  expect(x.governor.read().state).toBe("needs_action");
  expect(
    x.db
      .prepare(
        "SELECT count(*) AS n FROM query_health_results WHERE purpose!='ordinary' AND accepted=1",
      )
      .get()?.n,
  ).toBe(0);
  expect(
    x.db
      .prepare("SELECT target_claimed,canary_claimed,cursor_json FROM query_diagnostic_events")
      .get(),
  ).toMatchObject({
    target_claimed: 1,
    canary_claimed: 1,
    cursor_json: '{"pageNumber":9,"exhausted":false}',
  });
  expect(() => x.governor.withProgress(queryPageContext(x.page)!, () => {})).toThrow();
});
it.each(["data", "failed", "no_baseline", "disabled"])(
  "T09 %s stops without recursively broadening",
  async (scenario) => {
    const x = fixture(scenario !== "disabled");
    await finishPageQuery(x.page, beginPageQuery(x.page, x.identity), successfulQueryEvidence(1));
    let calls = 0;
    await expect(
      finishPageQuery(
        x.page,
        beginPageQuery(x.page, x.identity),
        successfulQueryEvidence(0),
        async () => {
          calls++;
          if (scenario === "failed") throw new Error("unconfirmed callback");
          return successfulQueryEvidence(scenario === "data" ? 1 : 0);
        },
      ),
    ).rejects.toBeInstanceOf(QueryHealthError);
    expect(calls).toBe(scenario === "disabled" ? 0 : 1);
    expect(x.governor.read().state).toBe("needs_action");
  },
);
it("unknown freezes this chain while explicit blocked evidence stops all probes", async () => {
  const x = fixture();
  await expect(
    finishPageQuery(x.page, beginPageQuery(x.page, x.identity), {
      ...successfulQueryEvidence(0),
      committed: false,
    }),
  ).rejects.toBeInstanceOf(QueryHealthError);
  expect(x.governor.read().state).toBe("ready");
  let calls = 0;
  await expect(
    finishPageQuery(
      x.page,
      beginPageQuery(x.page, x.identity),
      { ...successfulQueryEvidence(0), blocked: true },
      async () => {
        calls++;
        return successfulQueryEvidence(1);
      },
    ),
  ).rejects.toBeInstanceOf(QueryHealthError);
  expect(calls).toBe(0);
  expect(x.governor.read().state).toBe("needs_action");
});
it("rebind updates page/run generation and old accepted context is rejected in the business transaction", async () => {
  const x = fixture();
  await finishPageQuery(x.page, beginPageQuery(x.page, x.identity), successfulQueryEvidence(1));
  const old = queryPageContext(x.page)!;
  const next = { ...x.context, pageGeneration: 2, runId: "new-run" };
  x.governor.registerPage(next);
  bindQueryPage(x.page, x.governor, next);
  expect(queryPageContext(x.page)?.runId).toBe("new-run");
  expect(() => x.governor.withProgress(old, () => {})).toThrow();
});

it.each(["verified", "unknown", "failed", "hard-block"])(
  "T09 restoration %s records evidence while every diagnostic proof stays frozen",
  async (scenario) => {
    const x = fixture();
    await finishPageQuery(x.page, beginPageQuery(x.page, x.identity), successfulQueryEvidence(1));
    let restores = 0;
    const diagnostic: QueryDiagnostic = async () => ({
      ...successfulQueryEvidence(0),
      blocked: scenario === "hard-block",
    });
    diagnostic.restore = async () => {
      restores++;
      if (scenario === "failed") throw new Error("restore action unknown");
      return { ...successfulQueryEvidence(0), identityMatched: scenario !== "unknown" };
    };
    await expect(
      finishPageQuery(
        x.page,
        beginPageQuery(x.page, x.identity),
        successfulQueryEvidence(0),
        diagnostic,
      ),
    ).rejects.toBeInstanceOf(QueryHealthError);
    expect(restores).toBe(scenario === "hard-block" ? 0 : 1);
    expect(x.governor.read().state).toBe("needs_action");
    expect(
      x.db
        .prepare(
          "SELECT count(*) AS n FROM query_health_results WHERE purpose!='ordinary' AND accepted=1",
        )
        .get()?.n,
    ).toBe(0);
    if (scenario === "failed")
      expect(
        x.db.prepare("SELECT result FROM query_health_results WHERE purpose='restoration'").get()
          ?.result,
      ).toBe("unknown");
    const archived = JSON.parse(
      String(
        x.db
          .prepare(
            "SELECT evidence_json FROM access_evidence WHERE reason='query_manual_verification'",
          )
          .get()?.evidence_json,
      ),
    );
    if (scenario === "hard-block") expect(archived.disposition).toBe("stale_source_archive_only");
    expect((archived.summary ?? archived).restoration).toBe(
      scenario === "verified"
        ? "original_query_verified_task_paused"
        : scenario === "unknown"
          ? "restore_unknown_task_paused"
          : scenario === "failed"
            ? "restore_failed_or_unknown_task_paused"
            : "not_confirmed_task_paused",
    );
    const persisted = JSON.parse(
      String(x.db.prepare("SELECT outcome_json FROM query_diagnostic_events").get()?.outcome_json),
    );
    if (scenario === "hard-block") {
      // A newer hard block owns the current pause; the old diagnostic is archive-only.
      expect(x.governor.read().queryDiagnostic).toBeUndefined();
      expect(x.governor.read().reasons.some((reason) => reason.code === "query_blocked")).toBe(
        true,
      );
    } else expect(persisted).toEqual(x.governor.read().queryDiagnostic);
    expect(persisted.restoration).toBe(
      scenario === "verified" ? "verified" : scenario === "hard-block" ? "not_attempted" : "failed",
    );
    expect(persisted.code).toBe(
      scenario === "unknown" || scenario === "failed"
        ? "restoration_failed"
        : scenario === "hard-block"
          ? "blocked_no_probe"
          : "no_valid_baseline",
    );
  },
);

it.each(["disabled", "unavailable", "unsupported", "no-baseline"])(
  "persists a concrete %s next action across store/governor recreation",
  async (scenario) => {
    const x = fixture(scenario !== "disabled");
    await finishPageQuery(x.page, beginPageQuery(x.page, x.identity), successfulQueryEvidence(1));
    const diagnostic: QueryDiagnostic = async () => successfulQueryEvidence(0);
    if (scenario === "unsupported")
      diagnostic.prepare = async () => {
        throw new QueryDiagnosticError("unsupported_condition", ["school"], "unsupported field");
      };
    await expect(
      finishPageQuery(
        x.page,
        beginPageQuery(x.page, x.identity),
        successfulQueryEvidence(0),
        scenario === "unavailable" ? undefined : diagnostic,
      ),
    ).rejects.toBeInstanceOf(QueryHealthError);
    const summary = new AccessGovernor(x.db).read().queryDiagnostic!;
    expect(summary.code).toBe(
      {
        disabled: "diagnostics_disabled",
        unavailable: "diagnostics_unavailable",
        unsupported: "unsupported_condition",
        "no-baseline": "no_valid_baseline",
      }[scenario],
    );
    expect(summary.unsupportedFields).toEqual(scenario === "unsupported" ? ["school"] : []);
    expect(
      JSON.parse(
        String(
          x.db.prepare("SELECT outcome_json FROM query_diagnostic_events").get()?.outcome_json,
        ),
      ),
    ).toEqual(summary);
    expect(
      x.db
        .prepare(
          "SELECT count(*) AS n FROM query_health_results WHERE purpose!='ordinary' AND accepted=1",
        )
        .get()?.n,
    ).toBe(0);
  },
);
