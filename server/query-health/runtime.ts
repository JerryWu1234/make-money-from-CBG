import type { AccessContext, AccessGovernor } from "../access";
import {
  QueryDiagnosticError,
  type QueryDiagnosticCode,
  type QueryDiagnosticState,
  type QueryRestorationStatus,
} from "./diagnostic-state";
import {
  QueryHealthStore,
  type QueryEvidence,
  type QueryIdentity,
  type QueryRecord,
} from "./store";

type Binding = {
  governor: AccessGovernor;
  context: AccessContext;
  store: QueryHealthStore;
  pending?: QueryRecord;
  lastQuery?: QueryRecord;
};
const bindings = new WeakMap<object, Binding>();
const latest = new Map<string, Binding>();
export type QueryDiagnostic = ((identity: QueryIdentity) => Promise<QueryEvidence>) & {
  /** Revoke the ordinary input lease before advancing the stop epoch. No recovery is implied. */
  suspend?: () => Promise<void>;
  prepare?: () => Promise<{
    revision: string;
    conditions: QueryIdentity["conditions"];
    page: number;
    sort: string;
    fields: Record<string, string>;
  }>;
  /** Reusing a page requires fresh evidence of its exact original public query. */
  restore?: (identity: QueryIdentity) => Promise<QueryEvidence>;
};
export class QueryHealthError extends Error {
  constructor(
    readonly queryId: string,
    readonly eventId?: string,
  ) {
    super("查询结果尚未通过健康核验，已暂停并保留原进度，请人工核实后继续");
    this.name = "QueryHealthError";
  }
}
export function bindQueryPage(page: object, governor: AccessGovernor, context: AccessContext) {
  const binding = { governor, context: { ...context }, store: new QueryHealthStore(governor.db) };
  bindings.set(page, binding);
  latest.set(context.pageId, binding);
}
export const pendingPageQuery = (page: object) => bindings.get(page)?.pending;
export const queryPageIdentity = (page: object) => bindings.get(page)?.lastQuery?.identity;
export const queryPageContext = (page: object) => bindings.get(page)?.context;
export const snapshotQueryContexts = (runId?: string) =>
  [...latest.values()]
    .map(({ context }) => ({ ...context }))
    .filter((context) => !runId || context.runId === runId);

export function beginPageQuery(
  page: object,
  identity: Omit<QueryIdentity, "schemaVersion" | "browserSessionEpoch">,
): QueryRecord | undefined {
  const binding = bindings.get(page);
  if (!binding) return undefined; // Offline fixtures/adapters have no service access scope.
  const query = binding.store.begin({
    ...identity,
    schemaVersion: 1,
    browserSessionEpoch: binding.context.browserSessionEpoch,
  });
  binding.pending = query;
  binding.lastQuery = query;
  binding.context = {
    ...binding.context,
    queryId: query.queryId,
    purpose: "ordinary",
    diagnosticPlanId: undefined,
  };
  binding.governor.registerPage(binding.context);
  binding.governor.registerQuery(binding.context, { accepted: false });
  return query;
}

/** Called before rows enter seen/history/cursors or a quote is adopted. Diagnostics return evidence only. */
export async function finishPageQuery(
  page: object,
  query: QueryRecord | undefined,
  evidence: QueryEvidence,
  diagnose?: QueryDiagnostic,
  cursor?: unknown,
) {
  const binding = bindings.get(page);
  if (!binding || !query) return;
  // An older completion must not accept or clear a newer pending query on this page.
  if (
    binding.pending !== query ||
    binding.context.queryId !== query.queryId ||
    binding.context.browserSessionEpoch !== query.identity.browserSessionEpoch
  )
    throw new QueryHealthError(query.queryId);
  const { governor, store } = binding;
  const policy = governor.read().policy;
  const verdict = store.observe(query, evidence, policy.baselineTtlMs);
  binding.pending = undefined;
  try {
    governor.registerQuery(binding.context, { accepted: verdict.accepted });
  } catch (error) {
    store.db
      .prepare("UPDATE query_health_results SET accepted=0,access='suspect' WHERE query_id=?")
      .run(query.queryId);
    throw error;
  }
  if (verdict.accepted) return;
  if (verdict.result === "unknown" && verdict.access !== "blocked")
    throw new QueryHealthError(query.queryId);
  const anomalyEpoch = binding.context.stopEpoch;
  let suspensionError: unknown;
  try {
    await diagnose?.suspend?.();
  } catch (error) {
    suspensionError = error;
  }
  const risk = governor.reportRisk(
    {
      reason: "query_" + verdict.access,
      state: verdict.access === "blocked" ? "needs_action" : "suspect",
      context: binding.context,
      evidence: { queryId: query.queryId, ...verdict },
    },
    binding.context,
  );
  const eventId = store.event(query, anomalyEpoch, cursor);
  binding.context = {
    ...binding.context,
    stopEpoch: risk.stopEpoch,
    purpose: "diagnostic",
    diagnosticPlanId: eventId,
  };
  let conclusion = verdict.access === "blocked" ? "blocked_no_probe" : "diagnostics_disabled";
  let probeCode: Exclude<QueryDiagnosticCode, "restoration_failed"> =
    verdict.access === "blocked"
      ? "blocked_no_probe"
      : !policy.canaryEnabled
        ? "diagnostics_disabled"
        : "diagnostics_unavailable";
  let restorationStatus: QueryRestorationStatus = "not_attempted";
  let unsupportedFields: string[] = [];
  let diagnosticsStarted = false;
  let restoration = "not_confirmed_task_paused";
  const probe = async (
    identity: QueryIdentity,
    purpose: "target_review" | "canary" | "restoration",
    execute: (identity: QueryIdentity) => Promise<QueryEvidence>,
  ) => {
    const record = store.begin(identity, purpose, eventId);
    binding.context = { ...binding.context, queryId: record.queryId };
    governor.registerPage(binding.context);
    governor.registerQuery(binding.context, { accepted: false });
    let result: QueryEvidence;
    try {
      result = await execute(identity);
    } catch (error) {
      store.observe(
        record,
        { count: -1, loaded: false, committed: false, emptyMarker: false, identityMatched: false },
        policy.baselineTtlMs,
      );
      throw error;
    }
    const observed = store.observe(record, result, policy.baselineTtlMs);
    governor.registerQuery(binding.context, { accepted: false });
    if (observed.access === "blocked") {
      await diagnose?.suspend?.();
      governor.reportRisk(
        {
          reason: "query_blocked",
          state: "needs_action",
          context: binding.context,
          evidence: { queryId: record.queryId, eventId, purpose },
        },
        binding.context,
      );
    }
    return observed;
  };
  try {
    if (suspensionError) throw suspensionError;
    if (
      verdict.access !== "blocked" &&
      policy.canaryEnabled &&
      diagnose &&
      evidence.loaded &&
      evidence.committed &&
      verdict.result === "empty"
    ) {
      governor.registerDiagnosticPlan(eventId, binding.context, policy.diagnosticMaxActions);
      if (!store.claim(eventId, "target")) {
        conclusion = "target_already_spent_or_unknown";
        probeCode = "budget_already_spent";
      } else {
        if (diagnose.prepare) store.saveOriginalSnapshot(eventId, await diagnose.prepare());
        diagnosticsStarted = true;
        const reviewed = await probe(query.identity, "target_review", diagnose);
        conclusion = "target_" + reviewed.result;
        probeCode =
          reviewed.access === "blocked" ? "blocked_no_probe" : "manual_verification_required";
        if (reviewed.result === "empty" && reviewed.access !== "blocked") {
          const baseline = store.broadBaseline(query.identity, policy.baselineTtlMs);
          if (!baseline) {
            conclusion = "no_valid_broad_baseline";
            probeCode = "no_valid_baseline";
          } else if (store.claim(eventId, "canary")) {
            const control = await probe(baseline, "canary", diagnose);
            conclusion = "canary_" + control.result + "_manual_verification_required";
            probeCode =
              control.access === "blocked" ? "blocked_no_probe" : "manual_verification_required";
          }
        }
      }
    }
  } catch (error) {
    probeCode = error instanceof QueryDiagnosticError ? error.code : "diagnostic_failed";
    unsupportedFields = error instanceof QueryDiagnosticError ? error.fields : [];
    conclusion =
      probeCode === "unsupported_condition"
        ? "unsupported_condition"
        : "diagnostic_failed_or_unknown_no_replay";
  } finally {
    // A hard block or a newer stop epoch forbids even a restoration action. Claims are
    // spent before dispatch so neither reconnect nor another connection can replay it.
    if (
      diagnosticsStarted &&
      diagnose?.restore &&
      governor.read().state === "suspect" &&
      governor.read().stopEpoch === binding.context.stopEpoch &&
      store.claim(eventId, "restoration")
    ) {
      try {
        const verified = await probe(query.identity, "restoration", diagnose.restore);
        restoration =
          verified.result !== "unknown" && verified.access !== "blocked"
            ? "original_query_verified_task_paused"
            : "restore_unknown_task_paused";
        restorationStatus =
          verified.result !== "unknown" && verified.access !== "blocked" ? "verified" : "failed";
      } catch {
        restoration = "restore_failed_or_unknown_task_paused";
        restorationStatus = "failed";
      }
    }
    try {
      await diagnose?.suspend?.();
    } catch {
      probeCode = "diagnostic_failed";
      conclusion = "activity_release_unconfirmed_manual_verification";
    }
    const summary: QueryDiagnosticState = {
      eventId,
      queryId: query.queryId,
      probeCode,
      code: restorationStatus === "failed" ? "restoration_failed" : probeCode,
      restoration: restorationStatus,
      unsupportedFields,
      nextAction:
        restorationStatus === "verified" || !diagnosticsStarted
          ? "verify_original_query"
          : "restore_original_query",
    };
    store.finish(eventId, conclusion, summary);
    governor.reportRisk(
      {
        reason: "query_manual_verification",
        state: "needs_action",
        context: binding.context,
        queryDiagnostic: summary,
        evidence: {
          queryId: query.queryId,
          eventId,
          conclusion,
          restoration,
        },
      },
      binding.context,
    );
  }
  throw new QueryHealthError(query.queryId, eventId);
}

export const successfulQueryEvidence = (
  count: number,
  emptyMarker = count === 0,
): QueryEvidence => ({
  count,
  loaded: true,
  committed: true,
  emptyMarker,
  identityMatched: true,
});

export const pageQueryProofs = (page: object): AccessContext[] => {
  const context = queryPageContext(page);
  return context && context.purpose !== "diagnostic" ? [{ ...context }] : [];
};

/** Missing callbacks/loading failures freeze this query without inventing a shared restriction. */
export function failPendingPageQuery(page: object): void {
  const binding = bindings.get(page);
  if (!binding?.pending) return;
  const query = binding.pending;
  binding.pending = undefined;
  binding.store.observe(
    query,
    { count: -1, loaded: false, committed: false, emptyMarker: false, identityMatched: false },
    binding.governor.read().policy.baselineTtlMs,
  );
  binding.governor.registerQuery(binding.context, { accepted: false });
  throw new QueryHealthError(query.queryId);
}

// Observer adapters pass a stable local subject; no Playwright or extension API is consumed.
export const bindQuerySubject = bindQueryPage;
export const beginObservedQuery = beginPageQuery;
export const finishObservedQuery = finishPageQuery;
export const querySubjectContext = queryPageContext;

/** Called only after the native wrapper validates its local navigation receipt. */
export function moveObservedQuery(
  subject: object,
  query: QueryRecord,
  document: Pick<AccessContext, "pageId" | "pageGeneration">,
  actionId: string,
  navigation: { kind: "refresh-list" | "return-to-list"; url: string; openingActionId?: string },
): AccessContext {
  const binding = bindings.get(subject);
  if (!binding || binding.pending !== query || binding.context.queryId !== query.queryId)
    throw new QueryHealthError(query.queryId);
  const priorPage = binding.context.pageId;
  binding.context = binding.governor.movePendingQuery(
    binding.context,
    document,
    actionId,
    navigation,
  );
  if (latest.get(priorPage) === binding) latest.delete(priorPage);
  latest.set(binding.context.pageId, binding);
  return binding.context;
}

/** A late callback can only protect its original query on the same live page/session/stop epoch. */
export function reportQueryCallbackRisk(
  page: object,
  expected: AccessContext,
  classification: Extract<
    import("../access/response-classifier").ResponseClassification,
    { kind: "blocked" }
  >,
): boolean {
  const binding = bindings.get(page);
  if (!binding) return false;
  const current = binding.context;
  if (
    current.owner !== expected.owner ||
    current.fence !== expected.fence ||
    current.runId !== expected.runId ||
    current.pageId !== expected.pageId ||
    current.pageGeneration !== expected.pageGeneration ||
    current.browserSessionEpoch !== expected.browserSessionEpoch ||
    current.stopEpoch !== expected.stopEpoch
  )
    return false;
  binding.governor.reportRisk(
    {
      reason: classification.reason,
      context: expected,
      evidence: {
        schemaVersion: 1,
        sourceKind: "website_callback",
        endpoint: classification.url,
        httpStatus: 200,
        classification: { kind: "blocked", reason: classification.reason },
      },
    },
    expected,
  );
  return true;
}
