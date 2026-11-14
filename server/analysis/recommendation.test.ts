import { expect, it, vi } from "vite-plus/test";
import type { SavedRoleRecord } from "../crawler/types";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { recommendationFor } from "./recommendation";
import type { ValuationResult } from "./valuation-types";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { createProfile, DEFAULT_SETTINGS } from "./profile";
import {
  RULE_ENGINE_VERSION,
  describeRule,
  type RuleExpression,
  type CompiledConditionRule,
} from "./condition-rule-types";
import { defaultConditions, type ConditionGroup } from "./conditions";
import { validateDirectConditionResults } from "./direct-condition-review";

function record() {
  const r = analysisRecord();
  r.listing.price = "20000";
  return r;
}
const valuation = (bare = 20000) =>
  ({ asking_price: 20000, bare_role_value: bare, decision: "PASS" }) as ValuationResult;

const compiled = (text: string, expression: RuleExpression): CompiledConditionRule => ({
  version: RULE_ENGINE_VERSION,
  sourceText: text,
  status: "ready" as const,
  expression,
  explanation: describeRule(expression),
  issues: [],
});
const speedRule = () =>
  compiled("速度大于800", {
    op: "gt",
    args: [
      { op: "field", path: "role.speed" },
      { op: "literal", value: 800 },
    ],
  });

function checked(
  tree: ConditionGroup,
  source: SavedRoleRecord,
  bare = 20000,
  specs: Record<string, { field: string; operator: "gt" | "lt" | "gte"; target: number }> = {},
) {
  return validateDirectConditionResults(
    tree.children
      .filter((node) => !("children" in node) && !node.price)
      .map((node) => {
        const spec = specs[node.id] || { field: "速度", operator: "gt", target: 800 };
        const value =
          spec.field === "挂牌价" ? source.listing.price : source.listing.attrs[spec.field];
        const numeric = value === undefined ? null : Number(value);
        return {
          id: node.id,
          sourceText: "text" in node ? node.text : "",
          matched:
            numeric === null
              ? null
              : spec.operator === "gt"
                ? numeric > spec.target
                : spec.operator === "lt"
                  ? numeric < spec.target
                  : numeric >= spec.target,
          reason: numeric === null ? "采集资料缺少该字段" : `${spec.field}为${numeric}`,
          observations:
            numeric === null
              ? []
              : [
                  {
                    label: spec.field,
                    path:
                      spec.field === "挂牌价" ? "/listing/price" : `/listing/attrs/${spec.field}`,
                    quote: String(value),
                    numericValue: numeric,
                  },
                ],
          calculation:
            numeric === null ? null : { operation: "identity", inputs: [0], result: numeric },
          comparison: numeric === null ? null : { operator: spec.operator, target: spec.target },
        };
      }),
    tree,
    source,
    { asking: Number(source.listing.price), bare },
  );
}

it.each([
  [20000, "recommended", 0],
  [20000.004, "recommended", 0],
  [20000.01, "recommended", -0.01],
  [19999.99, "recommended", 0.01],
] as const)("未设置条件时默认不限制挂牌与裸号估值的大小关系 %s", (bare, expected, gap) => {
  expect(recommendationFor(record(), valuation(bare))).toMatchObject({ status: expected, gap });
});

it.each(["and", "or"] as const)("价格不限制不会使其他%s条件被绕过", (join) => {
  const tree = defaultConditions();
  tree.children.push({
    id: "C2",
    text: "挂牌价小于1元",
    join,
    rule: compiled("挂牌价小于1元", {
      op: "lt",
      args: [
        { op: "field", path: "listing.price" },
        { op: "literal", value: 1 },
      ],
    }),
  });
  const source = record();
  const value = {
    ...valuation(18000),
    condition_review: checked(tree, source, 18000, {
      C2: { field: "挂牌价", operator: "lt", target: 1 },
    }),
  };
  expect(recommendationFor(source, value, tree).status).toBe("excluded");
  expect(recommendationFor(record(), valuation(18000), tree).status).toBe("manual");
});

it("无效金额、缺少估值和待补资料不能入榜", () => {
  const r = record();
  for (const bare of [NaN, Infinity, -1])
    expect(recommendationFor(r, valuation(bare)).status).toBe("excluded");
  expect(recommendationFor(r).status).toBe("excluded");
  expect(recommendationFor(r, { ...valuation(), decision: "NEED_INFO" }).status).toBe("excluded");
  for (const price of ["", "0", "-1", "Infinity", "NaN"]) {
    r.listing.price = price;
    expect(recommendationFor(r, valuation()).status).toBe("excluded");
  }
});

it("自定义价格条件取代默认规则，不再附加装备、宝宝或金额阶梯门槛", () => {
  const tree = defaultConditions();
  tree.children = [
    {
      id: "C1",
      text: "",
      price: { comparison: "gte", adjustment: "plus", value: 2000, unit: "amount" },
    },
  ];
  const r = record();
  r.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items = [];
  expect(recommendationFor(r, valuation(18000), tree)).toMatchObject({
    status: "recommended",
    basis: "conditions",
    gap: 2000,
  });
  expect(recommendationFor(r, valuation(18000.01), tree).status).toBe("excluded");
});

it("重新计算价格与整体结果，不信任AI返回的组和价格状态", () => {
  const tree = defaultConditions();
  tree.children.push(
    { id: "C2", text: "速度大于800", join: "or", rule: speedRule() },
    {
      id: "C3",
      text: "烹饪120",
      join: "and",
      rule: compiled("烹饪120", {
        op: "lt",
        args: [
          { op: "field", path: "listing.price" },
          { op: "literal", value: 0 },
        ],
      }),
    },
  );
  const source = record();
  source.listing.attrs.速度 = "850";
  source.listing.attrs.烹饪 = "100";
  const value = {
    ...valuation(20001),
    condition_review: checked(tree, source, 20001, {
      C2: { field: "速度", operator: "gt", target: 800 },
      C3: { field: "烹饪", operator: "gte", target: 120 },
    }),
  } as ValuationResult;
  value.condition_review!.results.find((r) => r.id === "G1")!.status = "met";
  value.condition_review!.results.find((r) => r.id === "C1")!.status = "unmet";
  expect(recommendationFor(source, value, tree).status).toBe("excluded");
  (tree.children[2] as { text: string }).text = "烹饪130";
  expect(recommendationFor(source, value, tree).status).toBe("manual");
  expect(
    recommendationFor(record(), value, { ...tree, children: [{ id: "C2", text: "速度900" }] })
      .status,
  ).toBe("manual");
});

it("批次条件快照决定榜单，设置变更、隐藏、来源变更仍生效", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    for (const key of ["match", "miss", "unknown"]) {
      const r = record();
      r.listing.key = key;
      if (key !== "unknown") r.listing.attrs["速度"] = key === "match" ? "850" : "700";
      crawl.observe(r.listing);
      crawl.save(r.listing, r.detail!);
    }
    const tree = defaultConditions();
    tree.children = [{ id: "C1", text: "速度大于800", rule: speedRule() }];
    const profile = createProfile("条件入榜", { ...DEFAULT_SETTINGS, conditions: tree });
    const store = new AnalysisStore(crawl.db);
    const runId = store.createRun("codex", "test", false, profile);
    for (const key of ["match", "miss", "unknown"])
      crawl.db
        .prepare("UPDATE analysis_tasks SET status='completed',result_json=? WHERE listing_key=?")
        .run(
          JSON.stringify({
            valuation: {
              ...valuation(18000),
              condition_review: checked(tree, crawl.detail(key) as SavedRoleRecord, 18000),
            },
          }),
          key,
        );
    const overview = () => store.overview({ runId, currentProfile: profile });
    expect(overview().ranking.map((item) => item.key)).toEqual(["match"]);
    expect(overview().manualReview?.map((item) => item.key)).toEqual(["unknown"]);
    expect(overview().ranking[0].recommendation?.basis).toBe("conditions");
    store.markRecommendationViewed("match");
    expect(overview().ranking).toHaveLength(0);
    expect(
      store.overview({ runId, currentProfile: profile, showViewed: true }).ranking,
    ).toHaveLength(1);
    expect(
      store.overview({ runId, currentProfile: createProfile("条件变更") }).ranking,
    ).toHaveLength(0);
    const changed = crawl.detail("match") as SavedRoleRecord;
    changed.listing.price = "21000";
    crawl.observe(changed.listing);
    expect(
      store.overview({ runId, currentProfile: profile, showViewed: true }).ranking,
    ).toHaveLength(0);
  } finally {
    crawl.close();
  }
});

// Failure cases: page boundaries truncate eligible rows, viewed rows reappear,
// a shrinking last page is empty, invalid pages crash, or showing all bypasses eligibility.
it("推荐分页包含50条以后的商品，查看后隐藏并在末页缩减时回退", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    for (let n = 0; n < 52; n++) {
      const r = record();
      r.listing.key = "view-" + String(n).padStart(2, "0");
      crawl.observe(r.listing);
      crawl.save(r.listing, r.detail!);
    }
    const store = new AnalysisStore(crawl.db);
    store.createRun("codex", "test");
    crawl.db
      .prepare("UPDATE analysis_tasks SET status='completed',result_json=?")
      .run(JSON.stringify({ valuation: valuation() }));
    const keys = (from: number, count: number) =>
      Array.from({ length: count }, (_, n) => "view-" + String(n + from).padStart(2, "0"));
    expect(store.overview()).toMatchObject({
      rankingPagination: { page: 1, totalPages: 3, total: 52 },
    });
    expect(store.overview().ranking.map((i) => i.key)).toEqual(keys(0, 20));
    expect(store.overview({ rankingPage: 2 }).ranking.map((i) => i.key)).toEqual(keys(20, 20));
    expect(store.overview({ rankingPage: 3 }).ranking.map((i) => i.key)).toEqual(keys(40, 12));
    expect(store.overview({ rankingPage: 999 }).rankingPagination).toEqual({
      page: 3,
      totalPages: 3,
      total: 52,
      eligibleTotal: 52,
      hiddenTotal: 0,
    });
    for (const invalidPage of [NaN, Infinity, -1, 0])
      expect(store.overview({ rankingPage: invalidPage }).rankingPagination?.page).toBe(1);
    expect(store.overview({ includeRanking: false, rankingPage: 2 })).not.toHaveProperty(
      "rankingPagination",
    );
    expect(store.markRecommendationViewed("view-00")).toEqual({ key: "view-00", viewed: true });
    store.markRecommendationViewed("view-00");
    expect(crawl.db.prepare("SELECT count(*) n FROM recommendation_views").get()!.n).toBe(1);
    expect(store.overview().ranking.map((i) => i.key)).toEqual(keys(1, 20));
    expect(store.overview({ rankingPage: 3 }).ranking.map((i) => i.key)).toEqual(keys(41, 11));
    const reopened = new AnalysisStore(crawl.db);
    expect(reopened.overview().ranking.some((i) => i.key === "view-00")).toBe(false);
    expect(reopened.overview({ showViewed: true }).ranking[0]).toMatchObject({
      key: "view-00",
      recommendationViewed: true,
    });
    for (const key of keys(40, 12)) store.markRecommendationViewed(key);
    const shrunk = store.overview({ rankingPage: 3 });
    expect(shrunk.rankingPagination).toEqual({
      page: 2,
      totalPages: 2,
      total: 39,
      eligibleTotal: 52,
      hiddenTotal: 13,
    });
    expect(shrunk.ranking.map((item) => item.key)).toEqual(keys(21, 19));
    expect(store.overview({ rankingPage: 3, showViewed: true }).rankingPagination).toEqual({
      page: 3,
      totalPages: 3,
      total: 52,
      eligibleTotal: 52,
      hiddenTotal: 13,
    });
    for (const key of [null, undefined, 1, "", " view-00", "x".repeat(101), "missing"])
      expect(() => store.markRecommendationViewed(key)).toThrow();
    expect(store.overview().results.total).toBe(52);
    crawl.clear();
    expect(crawl.db.prepare("SELECT count(*) n FROM recommendation_views").get()!.n).toBe(0);
  } finally {
    crawl.close();
  }
});

it("大资料榜单只排序轻量候选，再按原序补足推荐和人工复核", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    for (const kind of ["excluded", "recommended", "manual"]) {
      for (let index = 0; index < 12; index++) {
        const r = record();
        r.listing.key = `${kind}-${String(index).padStart(2, "0")}`;
        if (kind !== "manual") r.listing.attrs["速度"] = kind === "recommended" ? "850" : "700";
        r.detail!.tabs[0].text += "采集证据".repeat(8192);
        crawl.observe(r.listing);
        crawl.save(r.listing, r.detail!);
      }
    }
    const store = new AnalysisStore(crawl.db);
    const conditions: ConditionGroup = {
      id: "G1",
      operator: "and",
      evaluation: "sequence",
      children: [{ id: "C1", text: "速度大于800", rule: speedRule() }],
    };
    const profile = createProfile("大资料榜单回归", { ...DEFAULT_SETTINGS, conditions });
    const runId = store.createRun("codex", "test", false, profile);
    const complete = crawl.db.prepare(
      "UPDATE analysis_tasks SET status='completed',result_json=? WHERE listing_key=?",
    );
    for (const kind of ["excluded", "recommended", "manual"]) {
      for (let index = 0; index < 12; index++)
        complete.run(
          JSON.stringify({
            score: 12 - index,
            valuation: {
              ...valuation(kind === "excluded" ? 19000 : kind === "manual" ? 18000 : 20000),
              condition_review: checked(
                conditions,
                crawl.detail(`${kind}-${String(index).padStart(2, "0")}`) as SavedRoleRecord,
                kind === "excluded" ? 19000 : kind === "manual" ? 18000 : 20000,
              ),
              ...(index % 2
                ? { margin_of_safety: kind === "excluded" ? 100 : 12 - index }
                : { price_difference_ratio: kind === "excluded" ? 100 : 12 - index }),
            },
          }),
          `${kind}-${String(index).padStart(2, "0")}`,
        );
    }
    const prepare = crawl.db.prepare.bind(crawl.db);
    const sortQueries: { sql: string; columns: string[]; fields: number }[] = [];
    const spy = vi.spyOn(crawl.db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      if (sql.includes("ORDER BY coalesce("))
        sortQueries.push({
          sql,
          columns: statement.columns().map((column) => column.name),
          fields: Math.max(
            ...prepare("EXPLAIN " + sql)
              .all(...(sql.includes("t.run_id=?") ? [runId] : []))
              .filter((row) => row.opcode === "SorterInsert")
              .map((row) => Number(row.p4)),
          ),
        });
      return statement;
    });
    try {
      const first = store.overview({ runId, summary: true, currentProfile: profile });
      const keys = (kind: string, start = 0, count = 10) =>
        Array.from(
          { length: count },
          (_, index) => `${kind}-${String(index + start).padStart(2, "0")}`,
        );
      expect(first.ranking.map((item) => item.key)).toEqual(keys("recommended", 0, 12));
      expect(first.manualReview?.map((item) => item.key)).toEqual(keys("manual"));
      expect(first.ranking[0].taskId).toBe(
        crawl.db
          .prepare("SELECT id FROM analysis_tasks WHERE run_id=? AND listing_key=?")
          .get(runId, "recommended-00")!.id,
      );
      store.markRecommendationViewed("recommended-00");
      const filtered = store.overview({
        runId,
        summary: true,
        currentProfile: profile,
        search: "没有对应商品",
        filter: "ready",
      });
      expect(filtered.records.total).toBe(0);
      expect(filtered.ranking.map((item) => item.key)).toEqual(keys("recommended", 1, 11));
      expect(filtered.manualReview?.map((item) => item.key)).toEqual(keys("manual"));
      expect(store.overview({ runId, showViewed: true }).ranking[0]).toMatchObject({
        key: "recommended-00",
        recommendationViewed: true,
      });
      const nextRun = store.createRun("codex", "test", false, profile);
      expect(store.overview().ranking.map((item) => item.key)).toEqual(keys("recommended", 1, 11));
      expect(store.overview({ runId: nextRun }).ranking).toEqual([]);
      expect(sortQueries.length).toBeGreaterThan(0);
      for (const query of sortQueries) {
        expect(query.columns).toEqual(["key", "task_id", "viewed_at"]);
        expect(query.sql).not.toContain("json_remove(");
        expect(query.fields).toBeLessThanOrEqual(6);
      }
    } finally {
      spy.mockRestore();
    }
  } finally {
    crawl.close();
  }
});
