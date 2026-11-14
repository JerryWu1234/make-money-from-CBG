import { expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnalysisConditions, ConditionReviewView } from "./AnalysisConditions";
import {
  CONDITION_REVIEW_VERSION,
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
    engineVersion: CONDITION_REVIEW_VERSION,
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

it("文字条件直接编辑，不显示解析步骤或规则确认卡片", () => {
  const tree = defaultConditions();
  tree.children = [
    { id: "C1", text: "速度大于800" },
    { id: "C2", text: "人物装备＋灵饰＋宝宝装备＋召唤兽数量大于8", join: "and" },
    { id: "C3", text: "等级等于129", join: "or" },
  ];
  const markup = renderToStaticMarkup(<AnalysisConditions value={tree} onChange={() => {}} />);
  expect(markup).toContain("逐条查看 true／false、原始数值和计算过程");
  expect(markup).toContain("速度大于800");
  expect(markup).toContain("且（两者都满足）");
  expect(markup).toContain("或（任一满足）");
  expect(markup.match(/>添加条件<\/button>/g)).toHaveLength(1);
  expect(markup).not.toContain("解析");
  expect(markup).not.toContain("执行口径");
  expect(markup).not.toContain("增加价格条件");
});

it("逐条显示满足、不满足、无法判断及且或关系，最后显示整体结果", () => {
  const review: ConditionReview = {
    engineVersion: CONDITION_REVIEW_VERSION,
    tree: {
      id: "G1",
      operator: "and",
      evaluation: "sequence",
      children: [
        { id: "C1", text: "速度大于800" },
        { id: "C2", text: "人物装备数量大于8", join: "and" },
        { id: "C3", text: "召唤兽成长大于1.2", join: "or" },
      ],
    },
    results: [
      { id: "C1", status: "met", reason: "速度850，大于800" },
      { id: "C2", status: "unmet", reason: "人物装备6件，不大于8" },
      { id: "C3", status: "unknown", reason: "缺少召唤兽成长数据" },
      { id: "G1", status: "unknown", reason: "不满足或无法判断，最终无法判断" },
    ],
  };
  const markup = renderToStaticMarkup(<ConditionReviewView review={review} />);
  expect(markup).toContain("条件 1 速度大于800：满足");
  expect(markup).toContain("条件 2 人物装备数量大于8：不满足");
  expect(markup).toContain("条件 3 召唤兽成长大于1.2：无法判断");
  expect(markup).toContain("速度850，大于800");
  expect(markup).toContain("人物装备6件，不大于8");
  expect(markup).toContain("缺少召唤兽成长数据");
  expect(markup).toContain("最终结果（从上到下计算）：无法判断");
  expect(markup).toMatch(/analysis-condition-join[^>]*>且</);
  expect(markup).toMatch(/analysis-condition-join[^>]*>或</);
  expect(markup).not.toContain("G1");
});
