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

it("暖轮询不再从SQLite传回未变化候选的完整详情", () => {
  const { crawl, store, runId } = fixture();
  try {
    store.overview({ runId, summary: true });
    const original = crawl.db.prepare.bind(crawl.db);
    let detailReads = 0,
      candidateLookups = 0;
    const spy = vi.spyOn(crawl.db, "prepare").mockImplementation((sql) => {
      const statement = original(sql);
      const get = statement.get.bind(statement);
      const all = statement.all.bind(statement);
      statement.get = (...args) => {
        if (sql.includes("WHERE l.key=? AND t.id=?")) candidateLookups++;
        const row = Reflect.apply(get, undefined, args) as ReturnType<typeof get>;
        if (row?.detail_json != null) detailReads++;
        return row;
      };
      statement.all = (...args) => {
        const rows = Reflect.apply(all, undefined, args) as ReturnType<typeof all>;
        detailReads += rows.filter((row) => row.detail_json != null).length;
        return rows;
      };
      return statement;
    });
    try {
      expect(store.overview({ runId, summary: true }).ranking).toHaveLength(0);
      expect(detailReads).toBe(0);
      expect(candidateLookups).toBe(0);
    } finally {
      spy.mockRestore();
    }
  } finally {
    crawl.close();
  }
});

it("记录分页不触发尚未打开的推荐榜扫描，仍返回当前页和完整计数", () => {
  const { crawl, store, runId } = fixture(48),
    prepare = crawl.db.prepare.bind(crawl.db);
  const compute = vi.spyOn(recommendations, "recommendationFor");
  const spy = vi.spyOn(crawl.db, "prepare").mockImplementation((sql) => {
    if (sql.includes("ORDER BY coalesce(")) throw new Error("不应扫描推荐候选");
    return prepare(sql);
  });
  try {
    const output = store.overview({
      includeRanking: false,
      runId,
      summary: true,
      page: 2,
    });
    expect(output.records).toMatchObject({ page: 2, total: 48 });
    expect(output.records.items).toHaveLength(20);
    expect(output.records.items[0].key).toBe("poll-020");
    expect(output.results.total).toBe(48);
    expect(output).toMatchObject({ rankingDeferred: true });
    expect(compute).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
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

it("汇总期间标记已查看，不计入分页总数且不显示旧推荐", async () => {
  const { crawl, store, runId } = fixture();
  try {
    crawl.db
      .prepare("UPDATE analysis_tasks SET result_json=?")
      .run(JSON.stringify({ valuation: { bare_role_value: 1500, decision: "PASS" } }));
    const original = recommendations.recommendationFor;
    const compute = vi.spyOn(recommendations, "recommendationFor").mockImplementation((...args) => {
      const until = performance.now() + 2;
      while (performance.now() < until) {
        /* CPU fixture */
      }
      return original(...args);
    });
    const pending = store.overviewAsync({ runId, summary: true });
    while (!compute.mock.calls.length) await yieldThread();
    store.markRecommendationViewed("poll-000");
    const output = await pending;
    expect(output.ranking.map((item) => item.key)).not.toContain("poll-000");
    expect(output.rankingPagination).toEqual({ page: 1, totalPages: 3, total: 47 });
    expect(output.ranking).toHaveLength(20);
  } finally {
    crawl.close();
  }
});

it("并发请求隐藏已查看时，显示已查看的分页不丢失其结果", async () => {
  const { crawl, store, runId } = fixture();
  try {
    crawl.db
      .prepare("UPDATE analysis_tasks SET result_json=?")
      .run(JSON.stringify({ valuation: { bare_role_value: 1500, decision: "PASS" } }));
    store.markRecommendationViewed("poll-000");
    const original = recommendations.recommendationFor;
    const compute = vi.spyOn(recommendations, "recommendationFor").mockImplementation((...args) => {
      const until = performance.now() + 2;
      while (performance.now() < until) {
        /* CPU fixture: allow the two requests to interleave. */
      }
      return original(...args);
    });
    const showing = store.overviewAsync({ runId, summary: true, showViewed: true });
    while (!compute.mock.calls.length) await yieldThread();
    const hidden = store.overview({ runId, summary: true, showViewed: false });
    const visible = await showing;
    expect(hidden.rankingPagination?.total).toBe(47);
    expect(hidden.ranking.map((item) => item.key)).not.toContain("poll-000");
    expect(visible.rankingPagination).toEqual({ page: 1, totalPages: 3, total: 48 });
    expect(visible.ranking).toHaveLength(20);
    expect(visible.ranking[0]).toMatchObject({ key: "poll-000", recommendationViewed: true });
  } finally {
    crawl.close();
  }
});

it("轻量进度不传回角色原文或计算推荐，后续完成数立即可见", () => {
  const { crawl, store, runId } = fixture();
  const compute = vi.spyOn(recommendations, "recommendationFor");
  const original = crawl.db.prepare.bind(crawl.db);
  let sourceReads = 0;
  const spy = vi.spyOn(crawl.db, "prepare").mockImplementation((sql) => {
    const statement = original(sql),
      get = statement.get.bind(statement),
      all = statement.all.bind(statement);
    const inspect = (row: Record<string, unknown> | undefined) => {
      sourceReads += Object.entries(row || {}).filter(
        ([key, value]) => /(?:^|_)detail_json$/.test(key) && value != null,
      ).length;
    };
    statement.get = (...args) => {
      const row = Reflect.apply(get, undefined, args) as ReturnType<typeof get>;
      inspect(row);
      return row;
    };
    statement.all = (...args) => {
      const rows = Reflect.apply(all, undefined, args) as ReturnType<typeof all>;
      rows.forEach(inspect);
      return rows;
    };
    return statement;
  });
  try {
    crawl.db
      .prepare("UPDATE analysis_tasks SET status='running' WHERE listing_key='poll-000'")
      .run();
    expect(store.progress({ runId, scope: "complete" }).run).toMatchObject({
      completed: 47,
      runningCount: 1,
    });
    crawl.db
      .prepare("UPDATE analysis_tasks SET status='completed' WHERE listing_key='poll-000'")
      .run();
    const next = store.progress({ runId, scope: "complete" });
    expect(next.run).toMatchObject({ completed: 48, runningCount: 0 });
    expect(next).not.toHaveProperty("ranking");
    expect(next).not.toHaveProperty("records");
    expect(compute).not.toHaveBeenCalled();
    expect(sourceReads).toBe(0);
  } finally {
    spy.mockRestore();
    crawl.close();
  }
});

it("记录请求全部取消后停止后台计算，不再为已断开的页面扫描原文", async () => {
  const { crawl, store, runId } = fixture();
  const original = recommendations.recommendationFor;
  const compute = vi.spyOn(recommendations, "recommendationFor").mockImplementation((...args) => {
    const until = performance.now() + 2;
    while (performance.now() < until) {
      /* CPU fixture */
    }
    return original(...args);
  });
  const control = new AbortController();
  const error = new Error("client disconnected");
  const pending = store
    .overviewAsync({ runId, summary: true }, control.signal)
    .catch((e: unknown) => e);
  try {
    while (!compute.mock.calls.length) await yieldThread();
    control.abort(error);
    expect(await pending).toBe(error);
    const count = compute.mock.calls.length;
    for (let n = 0; n < 3; n++) await yieldThread();
    expect(compute).toHaveBeenCalledTimes(count);
    expect(count).toBeLessThan(48);
  } finally {
    crawl.close();
  }
});

it("一个读者取消不影响另一个共享请求，返回时重新读取最新批次进度", async () => {
  const { crawl, store, runId } = fixture();
  const original = recommendations.recommendationFor;
  const compute = vi.spyOn(recommendations, "recommendationFor").mockImplementation((...args) => {
    const until = performance.now() + 2;
    while (performance.now() < until) {
      /* CPU fixture */
    }
    return original(...args);
  });
  const control = new AbortController();
  const cancelled = store
    .overviewAsync({ runId, summary: true }, control.signal)
    .catch((e: unknown) => e);
  const shared = store.overviewAsync({ runId, summary: true });
  try {
    while (!compute.mock.calls.length) await yieldThread();
    control.abort(new Error("first reader left"));
    crawl.db
      .prepare("UPDATE analysis_tasks SET status='failed' WHERE listing_key='poll-047'")
      .run();
    expect(await cancelled).toBeInstanceOf(Error);
    expect((await shared).run).toMatchObject({ completed: 47, failed: 1 });
  } finally {
    crawl.close();
  }
});
