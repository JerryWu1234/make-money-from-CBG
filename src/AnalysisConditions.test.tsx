import { expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisConditions, ConditionReviewView } from "./AnalysisConditions";
import { RULE_ENGINE_VERSION } from "../server/analysis/condition-rule-types";
import {
  defaultConditions,
  normalizeConditions,
  type ConditionReview,
} from "../server/analysis/conditions";

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

it("价格控件仅提供小于、大于、不限制，默认不限制且无调整输入", () => {
  const markup = renderToStaticMarkup(<AnalysisConditions onChange={() => {}} />);
  const select = markup.match(/<select\b[^>]*aria-label="C1价格比较"[\s\S]*?<\/select>/)?.[0] || "";
  expect(select.match(/<option\b/g)).toHaveLength(3);
  expect(select).toContain('value="none"');
  expect(select).toContain('value="lt"');
  expect(select).toContain('value="gt"');
  expect(select).toContain("挂牌价小于裸号估值");
  expect(select).toContain("挂牌价大于裸号估值");
  expect(select).toMatch(/<option[^>]*value="none"[^>]*selected/);
  expect(markup).toContain("未自定义时，默认：价格不限制。");
  expect(markup).not.toContain('aria-label="C1估值调整"');
  expect(markup).not.toContain('aria-label="C1调整数值"');
});

it("旧版等价、包含边界及调整额条件保留历史展示和原始值", () => {
  for (const comparison of ["eq", "lte", "gte"] as const) {
    const tree = defaultConditions();
    tree.children = [
      {
        id: "C1",
        text: "",
        price: { comparison, adjustment: "minus", unit: "amount", value: 500 },
      },
    ];
    expect(normalizeConditions(tree)).toEqual(tree);
    const original = JSON.stringify(tree);
    const markup = renderToStaticMarkup(<AnalysisConditions value={tree} onChange={() => {}} />);
    expect(markup).toContain('value="legacy"');
    expect(markup).toContain("历史条件：");
    expect(markup).toContain("减去500元");
    expect(JSON.stringify(tree)).toBe(original);
  }
});
