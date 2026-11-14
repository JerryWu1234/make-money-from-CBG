import { expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConditionReviewView } from "./AnalysisConditions";
import { RULE_ENGINE_VERSION } from "../server/analysis/condition-rule-types";
import type { ConditionReview } from "../server/analysis/conditions";

it("旧AI满足记录标为历史依据，当前程序判断展示可追溯证据", () => {
  const old: ConditionReview = {
    tree: {
      id: "G1",
      operator: "and",
      evaluation: "sequence",
      children: [{ id: "C1", text: "合计数量大于8" }],
    },
    results: [{ id: "C1", status: "met", reason: "合计3，不大于8" }],
  };
  expect(renderToStaticMarkup(<ConditionReviewView review={old} />)).toContain(
    "历史条件记录，不作为当前入榜依据",
  );
  const current: ConditionReview = {
    ...old,
    engineVersion: RULE_ENGINE_VERSION,
    results: [
      {
        id: "C1",
        status: "unmet",
        reason: "合计3 > 8 不成立",
        evidence: [{ path: "/detail/pets", label: "召唤兽数量", value: 3 }],
      },
    ],
  };
  const markup = renderToStaticMarkup(<ConditionReviewView review={current} />);
  expect(markup).not.toContain("历史条件记录");
  expect(markup).toContain("查看采集依据（1项）");
  expect(markup).toContain("召唤兽数量");
  expect(markup).not.toContain("/detail/pets");
});
