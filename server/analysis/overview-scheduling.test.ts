import { afterEach, expect, it, vi } from "vite-plus/test";
import { setImmediate as yieldThread } from "node:timers/promises";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import * as recommendations from "./recommendation";

afterEach(() => vi.restoreAllMocks());

function fixture(count = 48) {
  const crawl = new CrawlStore(":memory:");
  for (let index = 0; index < count; index++) {
    const record = analysisRecord(`poll-${String(index).padStart(3, "0")}`);
    record.listing.price = "1000";
    const equipment = record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!;
    equipment.items = [];
    equipment.text = "没有装备";
    record.detail!.equipmentCapture!.emptyProof = "explicit-text";
    const pets = record.detail!.tabs.find((tab) => tab.name === "召唤兽/孩子")!;
    pets.pets = [];
    pets.petCount = 0;
    crawl.observe(record.listing);
    expect(crawl.save(record.listing, record.detail!)).toBe(true);
  }
  const store = new AnalysisStore(crawl.db);
  const runId = store.createRun("codex", "poll-fixture", true);
  crawl.db
    .prepare("UPDATE analysis_tasks SET status='completed',result_json=?")
    .run(JSON.stringify({ valuation: { bare_role_value: 100, decision: "PASS" } }));
  return { crawl, store, runId };
}

it("推荐不足十条时，反复轮询不重算未变化商品；只更新变更商品且不漏后面的推荐", () => {
  const { crawl, store, runId } = fixture();
  const compute = vi.spyOn(recommendations, "recommendationFor");
  try {
    expect(store.overview({ runId, summary: true }).ranking).toHaveLength(0);
    expect(compute).toHaveBeenCalledTimes(48);
    store.overview({ runId, summary: true, page: 2 });
    expect(compute).toHaveBeenCalledTimes(48);
    crawl.db
      .prepare("UPDATE analysis_tasks SET result_json=? WHERE listing_key='poll-047'")
      .run(JSON.stringify({ valuation: { bare_role_value: 1500, decision: "PASS" } }));
    expect(store.overview({ runId, summary: true }).ranking.map((item) => item.key)).toEqual([
      "poll-047",
    ]);
    expect(compute).toHaveBeenCalledTimes(49);
    store.markRecommendationViewed("poll-047");
    expect(store.overview({ runId, summary: true }).ranking).toHaveLength(0);
    expect(store.overview({ runId, summary: true, showViewed: true }).ranking).toHaveLength(1);
    crawl.fail("poll-047", "模拟后续采集失败");
    expect(store.overview({ runId, summary: true, showViewed: true }).ranking).toHaveLength(0);
  } finally {
    crawl.close();
  }
});

it("冷汇总分批让出主线程，相同并发请求合并；处理中商品变更不能发布旧推荐", async () => {
  const { crawl, store, runId } = fixture();
  try {
    crawl.db
      .prepare("UPDATE analysis_tasks SET result_json=? WHERE listing_key='poll-000'")
      .run(JSON.stringify({ valuation: { bare_role_value: 1500, decision: "PASS" } }));
    const original = recommendations.recommendationFor;
    const compute = vi.spyOn(recommendations, "recommendationFor");
    compute.mockImplementation((...args) => {
      const until = performance.now() + 2;
      while (performance.now() < until) {
        /* 模拟真实资料解析的CPU工作。 */
      }
      return original(...args);
    });
    const first = store.overviewAsync({ runId, summary: true });
    const second = store.overviewAsync({ runId, summary: true });
    while (!compute.mock.calls.length) await yieldThread();
    expect(compute.mock.calls.length).toBeLessThan(48);
    crawl.fail("poll-000", "在异步汇总期间下架或失败");
    const [a, b] = await Promise.all([first, second]);
    expect(a.ranking).toHaveLength(0);
    expect(b).toEqual(a);
    expect(compute.mock.calls.length).toBeLessThanOrEqual(48);
  } finally {
    crawl.close();
  }
});

it("让出线程期间出现更新的完整分析结果，不能再发布旧任务的推荐", async () => {
  const { crawl, store } = fixture();
  try {
    crawl.db
      .prepare("UPDATE analysis_tasks SET result_json=? WHERE listing_key='poll-000'")
      .run(JSON.stringify({ valuation: { bare_role_value: 1500, decision: "PASS" } }));
    const original = recommendations.recommendationFor;
    const compute = vi.spyOn(recommendations, "recommendationFor").mockImplementation((...args) => {
      const until = performance.now() + 2;
      while (performance.now() < until) {
        /* CPU fixture */
      }
      return original(...args);
    });
    const pending = store.overviewAsync({ summary: true });
    while (!compute.mock.calls.length) await yieldThread();
    const next = store.createRun("codex", "new-model", true);
    crawl.db
      .prepare(
        "UPDATE analysis_tasks SET status='completed',result_json=? WHERE run_id=? AND listing_key='poll-000'",
      )
      .run(JSON.stringify({ valuation: { bare_role_value: 100, decision: "NEED_INFO" } }), next);
    expect((await pending).ranking.map((item) => item.key)).not.toContain("poll-000");
  } finally {
    crawl.close();
  }
});
