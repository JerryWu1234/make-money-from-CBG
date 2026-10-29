import { expect, it, vi } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { recommendationFor } from "./recommendation";
import type { ValuationResult } from "./valuation-types";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { createProfile } from "./profile";
import type { SavedRoleRecord } from "../crawler/types";

// Failure cases: wrong cent boundaries, double-counted configuration categories,
// duplicate set slots, mixed set names, jewelry main stats counted as added stats,
// wild/future-skill/incomplete pets, incomplete inventories, stale quotes, and
// manual-review products accidentally appearing as automatic recommendations.
function record(options: { grade?: number; sets?: number; jewelry?: number; pets?: number } = {}) {
  const r = analysisRecord();
  r.listing.price = "20000";
  const tab = r.detail!.tabs.find((t) => t.name === "道具/法宝")!;
  tab.items = Array.from({ length: Math.max(3, options.sets || 0) }, (_, index) => ({
    index,
    name: "测试装备" + index,
    kind: "equipment",
    category: "人物装备 · " + ["头盔", "衣服", "鞋子", "项链", "腰带"][index],
    description:
      "等级100\n防御60\n灵力60\n敏捷20\n气血200\n锻炼等级" +
      (options.grade ?? 1) +
      "\n宝石：月亮石" +
      (index < (options.sets || 0) ? "\n套装效果：附加状态变身" : ""),
  }));
  for (let index = 0; index < (options.jewelry || 0); index++)
    tab.items.push({
      index: 10 + index,
      name: "测试灵饰" + index,
      kind: "equipment",
      category: "灵饰 · 手镯",
      description: "等级100\n防御22\n精炼等级4\n附加属性：\n气血100[+112]\n防御20[+32]",
    });
  const pets = r.detail!.tabs.find((t) => t.name === "召唤兽/孩子")!;
  pets.pets = Array.from({ length: options.pets || 0 }, (_, index) => ({
    index,
    name: "画魂",
    fields: [
      { name: "类型", value: "画魂" },
      { name: "等级", value: "175" },
      { name: "是否宝宝", value: "是" },
      { name: "成长", value: "1.26" },
      ...["攻击", "防御", "体力", "法力", "速度", "躲闪"].map((name) => ({
        name: name + "资质",
        value: "1400",
      })),
    ],
    skills: [{ index: 0, name: "须弥真言", kind: "skill" }],
    equipment: [],
    innerSkills: [],
  }));
  pets.petCount = pets.pets.length;
  return r;
}
const valuation = (bare = 20000) =>
  ({ bare_role_value: bare, decision: "PASS" }) as ValuationResult;

function emptyRecord() {
  const r = record();
  r.listing.price = "1000";
  const equipment = r.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
  equipment.items = [];
  equipment.text = "没有装备";
  r.detail!.equipmentCapture!.emptyProof = "explicit-text";
  return r;
}

// A verified empty inventory must not fail the old equipment/pet configuration gate
// when the listing alone is already below the complete bare-role estimate.
it("确认空库存的裸号挂牌低于裸号预估价时，也纳入推荐榜", () => {
  expect(recommendationFor(emptyRecord(), valuation(1200))).toMatchObject({
    status: "recommended",
    basis: "bare-role-discount",
    gap: -200,
    factors: [],
    strongerFactors: [],
  });
  const equipped = recommendationFor(
    record({ grade: 6, sets: 5, jewelry: 2, pets: 2 }),
    valuation(20600),
  );
  expect(equipped).toMatchObject({ status: "recommended", basis: "bare-role-discount" });
  expect(equipped.factors).toHaveLength(4);
  expect(equipped.strongerFactors).toHaveLength(4);
});

it.each([
  [1000.11, "recommended", -0.01],
  [1000.104, "excluded", 0],
  [1000.1, "excluded", 0],
  [1000.09, "excluded", 0.01],
] as const)("空号按分核对价格方向，裸号估值%s时为%s", (bare, expected, gap) => {
  const r = emptyRecord();
  r.listing.price = "1000.10";
  const result = recommendationFor(r, valuation(bare));
  expect(result).toMatchObject({ status: expected, gap });
  if (expected === "recommended") expect(result).toHaveProperty("basis", "bare-role-discount");
  else expect(result).not.toHaveProperty("basis");
});

it("裸号直入条件仍拒绝无效金额、缺失估值与待确认结果", () => {
  const r = emptyRecord();
  for (const bare of [null, 0, -1, NaN, Infinity])
    expect(recommendationFor(r, { ...valuation(1200), bare_role_value: bare }).status).toBe(
      "excluded",
    );
  expect(recommendationFor(r).status).toBe("excluded");
  expect(recommendationFor(r, { ...valuation(1200), decision: "NEED_INFO" }).status).toBe(
    "excluded",
  );
  for (const asking of ["", "0", "-1", "NaN", "Infinity"])
    expect(
      recommendationFor({ ...r, listing: { ...r.listing, price: asking } }, valuation(1200)).status,
    ).toBe("excluded");
});

it.each(["equipmentCapture", "petCapture"] as const)(
  "裸号直入不能绕过%s的完整性核验",
  (capture) => {
    for (const state of ["unfinished", "missing", "issues"] as const) {
      const r = emptyRecord();
      if (state === "missing") delete r.detail![capture];
      else if (state === "unfinished") r.detail![capture]!.complete = false;
      else r.detail![capture]!.issues = ["库存尚未核验完整"];
      expect(recommendationFor(r, valuation(1200)).status).toBe("excluded");
    }
  },
);

it("空装备没有明确核验依据时，不能作为裸号直接推荐", () => {
  const r = emptyRecord();
  r.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.text = "装备区域加载中";
  delete r.detail!.equipmentCapture!.emptyProof;
  expect(recommendationFor(r, valuation(1200)).status).toBe("excluded");
});

it("不限制差额百分比，仍按金额阶梯核对配置", () => {
  const r = record({ grade: 6, sets: 5, jewelry: 2, pets: 2 });
  r.listing.price = "1000";
  expect(recommendationFor(r, valuation(850)).status).toBe("recommended");
  expect(recommendationFor(r, valuation(849.99)).status).toBe("recommended");
  expect(recommendationFor(r, valuation(1653.64)).status).toBe("recommended");
  r.listing.price = "880";
  expect(recommendationFor(r, valuation(355.49))).toMatchObject({
    status: "recommended",
    gap: 524.51,
  });
  expect(recommendationFor(record(), valuation(19475.49)).status).toBe("excluded");
});
const status = (r: SavedRoleRecord, gap = 0) =>
  recommendationFor(r, valuation(Number(r.listing.price) - gap)).status;

it.each([
  [{}, -10000, "recommended"],
  [{}, 0, "recommended"],
  [{}, 100, "recommended"],
  [{}, 100.01, "excluded"],
  [{ grade: 4 }, 200, "recommended"],
  [{ grade: 4 }, 200.01, "excluded"],
  [{ grade: 4, sets: 3 }, 300, "recommended"],
  [{ grade: 4, sets: 3 }, 300.01, "excluded"],
  [{ grade: 4, sets: 3, jewelry: 1 }, 500, "recommended"],
  [{ grade: 4, sets: 3, jewelry: 1 }, 500.01, "excluded"],
  [{ grade: 6, sets: 3, jewelry: 1 }, 800, "recommended"],
  [{ grade: 6, sets: 3, jewelry: 1 }, 800.01, "excluded"],
  [{ grade: 6, sets: 5, jewelry: 1 }, 1000, "recommended"],
  [{ grade: 6, sets: 5, jewelry: 1 }, 1000.01, "manual"],
  [{}, 2000, "manual"],
] as const)("金额阶梯 %j / 差额%s元 => %s", (options, gap, expected) => {
  expect(status(record(options), gap)).toBe(expected);
});
it("按分比较金额；缺失、无效报价及资料不足不推荐", () => {
  const r = record();
  r.listing.price = "1000.10";
  expect(recommendationFor(r, valuation(900.1))).toMatchObject({ status: "recommended", gap: 100 });
  expect(recommendationFor(r, valuation(900.09)).status).toBe("excluded");
  for (const bare of [-1, NaN, Infinity])
    expect(recommendationFor(r, valuation(bare)).status).toBe("excluded");
  expect(recommendationFor(r).status).toBe("excluded");
  expect(recommendationFor(r, { ...valuation(), decision: "NEED_INFO" }).status).toBe("excluded");
  r.listing.price = "0";
  expect(status(r)).toBe("excluded");
});
it.each([0, 1, 2, 3, 4])("无合格宝宝时至少3件带宝石装备，当前%s件", (count) => {
  const r = record();
  const tab = r.detail!.tabs.find((t) => t.name === "道具/法宝")!;
  tab.items = Array.from({ length: count }, (_, index) => ({ ...tab.items![0], index }));
  expect(status(r)).toBe(count >= 3 ? "recommended" : "excluded");
});
it("星辉石计入基础件数，材料、宝宝装备、专用和修理失败3次不算", () => {
  const r = record();
  const item = r.detail!.tabs.find((t) => t.name === "道具/法宝")!.items![0];
  item.description = "等级100\n防御22\n精炼等级3";
  item.category = "灵饰 · 手镯";
  expect(status(r)).toBe("recommended");
  for (const category of ["材料 · 精魄灵石", "召唤兽装备", "上古玉魄"]) {
    item.category = category;
    expect(status(r)).toBe("excluded");
  }
  item.category = "人物装备 · 头盔";
  item.description = "等级100\n防御60\n锻炼等级4\n修理失败3次";
  expect(status(r)).toBe("excluded");
  item.description = "等级100\n防御60\n锻炼等级4\n玩家123专用";
  expect(status(r)).toBe("excluded");
});
it("套装每类只算一次，必须同名且不同部位", () => {
  const r = record({ grade: 6, sets: 5 });
  expect(recommendationFor(r, valuation()).factors).toHaveLength(2);
  expect(recommendationFor(r, valuation()).strongerFactors).toHaveLength(2);
  const items = r.detail!.tabs.find((t) => t.name === "道具/法宝")!.items!;
  for (const item of items) item.category = "人物装备 · 头盔";
  expect(recommendationFor(r, valuation()).factors).toHaveLength(1);
  items.forEach((item, index) => {
    item.category = "人物装备 · " + ["头盔", "衣服", "鞋子", "项链", "腰带"][index];
    item.description += index < 3 ? "" : "\n套装效果：变身术之鬼将";
  });
  items[2].description = items[2].description!.replace("附加状态变身", "变身术之鬼将");
  expect(recommendationFor(r, valuation()).factors).toHaveLength(1);
});
it("灵饰需4段及2条有效附加属性，主属性和不符加点方案的属性不能凑数", () => {
  const r = record({ jewelry: 2 });
  const items = r.detail!.tabs.find((t) => t.name === "道具/法宝")!.items!;
  expect(recommendationFor(r, valuation()).strongerFactors).toContain("2件4段双有效属性灵饰");
  for (const item of items.slice(3))
    item.description =
      "等级100\n法术伤害22\n精炼等级4\n附加属性：\n法术伤害10[+16]\n法术暴击等级10[+16]";
  expect(recommendationFor(r, valuation()).factors).toHaveLength(0);
  r.detail!.tabs[0].fields.push({ name: "属性保存方案", value: "魔力,魔力" });
  expect(recommendationFor(r, valuation()).factors).toHaveLength(1);
  for (const item of items.slice(3))
    item.description = "等级100\n防御22\n精炼等级4\n附加属性：\n气血100[+112]\n法术伤害0[+16]";
  expect(recommendationFor(r, valuation()).factors).toHaveLength(0);
});
it.each([165, 175, 185, 164, 186, 0])("非野生宝宝等级%s与角色相差不超过10级", (level) => {
  const r = record({ pets: 1 });
  r.detail!.tabs.find((t) => t.name === "道具/法宝")!.items = [];
  const pet = r.detail!.tabs.find((t) => t.name === "召唤兽/孩子")!.pets![0];
  pet.fields.find((f) => f.name === "等级")!.value = String(level);
  expect(status(r)).toBe(level >= 165 && level <= 185 ? "recommended" : "excluded");
  pet.fields.find((f) => f.name === "是否宝宝")!.value = "否";
  expect(status(r)).toBe("excluded");
});
it("只有完整资料且有当前技能的宝宝贡献配置类别；未来技能不算", () => {
  const r = record({ pets: 2 });
  expect(recommendationFor(r, valuation()).strongerFactors).toHaveLength(1);
  const pets = r.detail!.tabs.find((t) => t.name === "召唤兽/孩子")!.pets!;
  pets[0].fields = pets[0].fields.filter((f) => f.name !== "成长");
  expect(recommendationFor(r, valuation()).strongerFactors).toHaveLength(0);
  pets[1].skills[0].skillObservation = { rawName: "须弥真言", type: "skill", state: "future" };
  expect(recommendationFor(r, valuation()).factors).toHaveLength(0);
});
it("不完整采集不能凭部分装备或宝宝入选", () => {
  const r = record({ pets: 1 });
  r.detail!.equipmentCapture!.complete = false;
  r.detail!.petCapture!.complete = false;
  expect(status(r)).toBe("excluded");
});
it("榜单应用阶梯、分出人工复核，并排除过期或参数变化的结果", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    for (const key of ["equal", "boundary", "higher", "outside", "manual"]) {
      const r = record({ grade: 4 });
      r.listing.key = key;
      crawl.observe(r.listing);
      expect(crawl.save(r.listing, r.detail!)).toBe(true);
    }
    const store = new AnalysisStore(crawl.db),
      id = store.createRun("codex", "test", true);
    for (const [key, gap] of Object.entries({
      equal: 0,
      boundary: 200,
      higher: -600,
      outside: 200.01,
      manual: 1000.01,
    }))
      crawl.db
        .prepare("UPDATE analysis_tasks SET status='completed',result_json=? WHERE listing_key=?")
        .run(JSON.stringify({ valuation: valuation(20000 - gap) }), key);
    expect(
      store
        .overview({ runId: id })
        .ranking.map((i) => i.key)
        .sort(),
    ).toEqual(["boundary", "equal", "higher"]);
    expect(store.overview({ runId: id }).manualReview?.map((i) => i.key)).toEqual(["manual"]);
    expect(store.overview({ runId: id }).ranking[0].assetSummary?.equipment).toContain("宝石4段");
    expect(
      store.overview({ runId: id, currentProfile: createProfile("changed") }).ranking,
    ).toHaveLength(0);
    crawl.db
      .prepare(
        "UPDATE analysis_tasks SET result_json=json_set(result_json,'$.valuation.pet_pricing',json(?)) WHERE listing_key='higher'",
      )
      .run(JSON.stringify({ searchedAt: new Date(Date.now() - 25 * 3600000).toISOString() }));
    const changed = crawl.detail("equal") as SavedRoleRecord;
    changed.listing.price = "20001";
    crawl.observe(changed.listing);
    expect(store.overview({ runId: id }).ranking.map((i) => i.key)).toEqual(["boundary"]);
  } finally {
    crawl.close();
  }
});

it("空号直入榜单沿用原排序、已查看和有效结果约束，并保留配置阶梯", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    const bareValues = {
      "discount-best": 2500,
      "discount-viewed": 2000,
      "discount-listing-changed": 1900,
      "discount-detail-changed": 1800,
      "discount-expired": 1700,
      "discount-need-info": 2000,
      "empty-equal": 1000,
      "empty-overpriced": 900,
      "legacy-tier": 900,
      "legacy-manual": 3000,
    };
    for (const key of Object.keys(bareValues)) {
      const r = key.startsWith("legacy") ? record() : emptyRecord();
      r.listing.key = key;
      r.listing.price = key === "legacy-manual" ? "5000" : "1000";
      crawl.observe(r.listing);
      expect(crawl.save(r.listing, r.detail!)).toBe(true);
    }
    const store = new AnalysisStore(crawl.db);
    const profile = createProfile("空号直入榜单回归");
    const runId = store.createRun("codex", "test", false, profile);
    for (const [key, bare] of Object.entries(bareValues)) {
      const asking = key === "legacy-manual" ? 5000 : 1000;
      crawl.db
        .prepare("UPDATE analysis_tasks SET status='completed',result_json=? WHERE listing_key=?")
        .run(
          JSON.stringify({
            valuation: {
              ...valuation(bare),
              decision: key === "discount-need-info" ? "NEED_INFO" : "PASS",
              price_difference_ratio: (bare - asking) / asking,
            },
          }),
          key,
        );
    }
    const overview = () => store.overview({ runId, currentProfile: profile });
    expect(overview().ranking.map((item) => item.key)).toEqual([
      "discount-best",
      "discount-viewed",
      "discount-listing-changed",
      "discount-detail-changed",
      "discount-expired",
      "legacy-tier",
    ]);
    expect(overview().ranking[0].recommendation).toMatchObject({
      basis: "bare-role-discount",
      gap: -1500,
      factors: [],
    });
    expect(overview().manualReview?.map((item) => item.key)).toEqual(["legacy-manual"]);
    expect(overview().ranking.at(-1)?.recommendation).not.toHaveProperty("basis");

    store.markRecommendationViewed("discount-viewed");
    const changedListing = crawl.detail("discount-listing-changed") as SavedRoleRecord;
    changedListing.listing.price = "1001";
    crawl.observe(changedListing.listing);
    const changedDetail = crawl.detail("discount-detail-changed") as SavedRoleRecord;
    changedDetail.detail!.tabs[0].fields.push({ name: "称谓", value: "资料已变化" });
    expect(crawl.save(changedDetail.listing, changedDetail.detail!)).toBe(true);
    crawl.db
      .prepare(
        "UPDATE analysis_tasks SET result_json=json_set(result_json,'$.valuation.pet_pricing',json(?)) WHERE listing_key='discount-expired'",
      )
      .run(JSON.stringify({ searchedAt: new Date(Date.now() - 25 * 3600000).toISOString() }));
    expect(overview().ranking.map((item) => item.key)).toEqual(["discount-best", "legacy-tier"]);
    expect(
      store
        .overview({ runId, currentProfile: profile, showViewed: true })
        .ranking.map((item) => item.key),
    ).toEqual(["discount-best", "discount-viewed", "legacy-tier"]);
    expect(
      store.overview({ runId, currentProfile: createProfile("已变更的裸号计算规则") }).ranking,
    ).toEqual([]);
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
    expect(shrunk.rankingPagination).toEqual({ page: 2, totalPages: 2, total: 39 });
    expect(shrunk.ranking.map((item) => item.key)).toEqual(keys(21, 19));
    expect(store.overview({ rankingPage: 3, showViewed: true }).rankingPagination).toEqual({
      page: 3,
      totalPages: 3,
      total: 52,
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
        r.detail!.tabs[0].text += "采集证据".repeat(8192);
        crawl.observe(r.listing);
        crawl.save(r.listing, r.detail!);
      }
    }
    const store = new AnalysisStore(crawl.db);
    const profile = createProfile("大资料榜单回归");
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
