import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { QueryDiagnosticSummary } from "./AccessSettings";
import type { QueryDiagnosticState } from "../server/query-health/diagnostic-state";

const summary: QueryDiagnosticState = {
  queryId: "query",
  eventId: "event",
  code: "unsupported_condition",
  probeCode: "unsupported_condition",
  restoration: "not_attempted",
  unsupportedFields: ["school"],
  nextAction: "verify_original_query",
};
it("shows unsupported fields and a concrete manual next step", () => {
  const text = renderToStaticMarkup(<QueryDiagnosticSummary value={summary} />);
  expect(text).toContain("school");
  expect(text).toContain("尚不支持自动诊断");
  expect(text).toContain("核对原条件、排序、页码和查询结果");
});
it("restoration failure and a nonempty Canary never instruct automatic continuation", () => {
  expect(
    renderToStaticMarkup(
      <QueryDiagnosticSummary
        value={{
          ...summary,
          code: "restoration_failed",
          restoration: "failed",
          nextAction: "restore_original_query",
        }}
      />,
    ),
  ).toContain("恢复原条件、排序和页码");
  expect(
    renderToStaticMarkup(
      <QueryDiagnosticSummary
        value={{ ...summary, code: "manual_verification_required", restoration: "verified" }}
      />,
    ),
  ).toContain("即使对照出现商品，也需要人工核对原查询后继续");
});
