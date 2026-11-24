/** Persisted, public summaries contain field names only, never arbitrary page/error text. */
export type QueryDiagnosticCode =
  | "diagnostics_disabled"
  | "diagnostics_unavailable"
  | "unsupported_condition"
  | "no_valid_baseline"
  | "blocked_no_probe"
  | "diagnostic_failed"
  | "budget_already_spent"
  | "manual_verification_required"
  | "restoration_failed";
export type QueryRestorationStatus = "not_attempted" | "verified" | "failed";
export type QueryDiagnosticState = {
  eventId: string;
  queryId: string;
  code: QueryDiagnosticCode;
  probeCode: Exclude<QueryDiagnosticCode, "restoration_failed">;
  restoration: QueryRestorationStatus;
  unsupportedFields: string[];
  /** Stable action identifier for the UI, rather than an unstructured exception message. */
  nextAction: "verify_original_query" | "restore_original_query";
};

export class QueryDiagnosticError extends Error {
  readonly fields: string[];
  constructor(
    readonly code: "unsupported_condition" | "diagnostic_failed",
    fields: string[],
    message: string,
  ) {
    super(message);
    this.name = "QueryDiagnosticError";
    this.fields = fields.filter((field) => /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(field)).slice(0, 50);
  }
}
