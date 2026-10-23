import { expect, it } from "vite-plus/test";
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

// Failure cases: viewed rows reappear after refresh, top ten are not replenished,
// showing all bypasses eligibility, invalid keys mutate history, or clear retains old views.
it("查看记录持久化，默认隐藏并补足10条，显示全部保留已查看标记", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    for (let n = 0; n < 12; n++) {
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
    expect(store.overview().ranking.map((i) => i.key)).toHaveLength(10);
    expect(store.markRecommendationViewed("view-00")).toEqual({ key: "view-00", viewed: true });
    store.markRecommendationViewed("view-00");
    expect(crawl.db.prepare("SELECT count(*) n FROM recommendation_views").get()!.n).toBe(1);
    expect(store.overview().ranking.map((i) => i.key)).toEqual(
      Array.from({ length: 10 }, (_, n) => "view-" + String(n + 1).padStart(2, "0")),
    );
    const reopened = new AnalysisStore(crawl.db);
    expect(reopened.overview().ranking.some((i) => i.key === "view-00")).toBe(false);
    expect(reopened.overview({ showViewed: true }).ranking[0]).toMatchObject({
      key: "view-00",
      recommendationViewed: true,
    });
    for (const key of [null, undefined, 1, "", " view-00", "x".repeat(101), "missing"])
      expect(() => store.markRecommendationViewed(key)).toThrow();
    expect(store.overview().results.total).toBe(12);
    crawl.clear();
    expect(crawl.db.prepare("SELECT count(*) n FROM recommendation_views").get()!.n).toBe(0);
  } finally {
    crawl.close();
  }
});
