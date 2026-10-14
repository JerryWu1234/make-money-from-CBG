import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { CrawlStore } from "../crawler/store";
import type { SavedRoleRecord } from "../crawler/types";
import { analysisRecord, analysisResponse } from "../../tests/fixtures/analysis";
import { AnalysisStore } from "./store";
import { AnalysisRunner } from "./runner";
import { createProfile } from "./profile";
import { calculateValuation } from "./valuation-calculator";

// Failure cases: new captures are omitted or duplicated, unfinished details enter the queue,
// trial scope expands, a completed/paused run receives tasks, frozen settings change,
// or an empty queue ends while collection is still active and pause cannot interrupt waiting.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function setup() {
  const crawl = new CrawlStore(":memory:");
  const store = new AnalysisStore(crawl.db);
  let collecting = true;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const analyzed: string[] = [];
  const analyze = vi.fn(async () => {
    const row = crawl.db.prepare("SELECT * FROM analysis_tasks WHERE status='running'").get()!;
    const key = String(row.listing_key);
    analyzed.push(key);
    if (analyzed.length === 1) await gate;
    const run = crawl.db
      .prepare("SELECT profile_json FROM analysis_runs WHERE id=?")
      .get(row.run_id)!;
    const profile = run.profile_json ? JSON.parse(String(run.profile_json)) : null;
    return {
      text: JSON.stringify(
        profile
          ? {
              decision: calculateValuation(crawl.detail(key) as SavedRoleRecord, profile).decision,
              reason: "模拟 AI 核对资料",
              extracted_facts: [],
            }
          : analysisResponse(crawl.detail(key) as SavedRoleRecord),
      ),
      usage: null,
    };
  });
  const connect = vi.fn(async () => ({ model: "frozen-model", analyze }));
  const runner = new AnalysisRunner(store, connect, () => collecting);
  const add = (key: string, index: number, complete = true) => {
    const record = analysisRecord(key);
    crawl.observe(record.listing);
    if (complete) crawl.save(record.listing, record.detail!);
    crawl.db
      .prepare("UPDATE listings SET first_seen_at=? WHERE key=?")
      .run(new Date(Date.UTC(2026, 9, 14, 0, 0, index)).toISOString(), key);
  };
  cleanups.push(async () => {
    collecting = false;
    release();
    await runner.shutdown();
    crawl.close();
  });
  return {
    crawl,
    store,
    runner,
    add,
    analyzed,
    connect,
    release,
    finishCapture: () => {
      collecting = false;
    },
  };
}
describe("采集期间追加分析队列", () => {
  it("第1个采齐启动，第2到10个按采集顺序追加一次并保持冻结模型和Prompt", async () => {
    const x = setup();
    x.add("role-1", 1);
    const profile = createProfile("frozen prompt", undefined, false);
    const id = await x.runner.start("codex", false, profile);
    expect(x.store.run(id)).toMatchObject({ total: 1, status: "running", model: "frozen-model" });
    for (let index = 2; index <= 10; index++) {
      x.add(`role-${index}`, index);
      expect(x.runner.appendCaptured()).toBe(1);
      expect(x.runner.appendCaptured()).toBe(0);
    }
    expect(x.store.run(id)!.total).toBe(10);
    const tasks = x.crawl.db
      .prepare("SELECT listing_key,prompt_text FROM analysis_tasks WHERE run_id=? ORDER BY ordinal")
      .all(id);
    expect(tasks.map((task) => task.listing_key)).toEqual(
      Array.from({ length: 10 }, (_, index) => `role-${index + 1}`),
    );
    expect(tasks.every((task) => String(task.prompt_text).includes("frozen prompt"))).toBe(true);
    x.finishCapture();
    x.release();
    await x.runner.settled();
    expect(x.store.run(id)).toMatchObject({ completed: 10, failed: 0, total: 10 });
    expect(x.connect).toHaveBeenCalledOnce();
    expect(x.analyzed).toEqual(tasks.map((task) => task.listing_key));
  });
  it("详情未完成不追加，完成后追加；暂停后不再追加", async () => {
    const x = setup();
    x.add("a", 1);
    const id = await x.runner.start("codex");
    x.add("b", 2, false);
    expect(x.runner.appendCaptured()).toBe(0);
    const record = analysisRecord("b");
    x.crawl.save(record.listing, record.detail!);
    expect(x.runner.appendCaptured()).toBe(1);
    x.finishCapture();
    x.release();
    await x.runner.pause(id);
    x.add("c", 3);
    expect(x.runner.appendCaptured()).toBe(0);
    expect(x.store.run(id)!.total).toBe(2);
  });
  it("指定商品试分析不跟随新采集，也不扩大数量限制", async () => {
    const x = setup();
    x.add("a", 1);
    const id = await x.runner.start("codex", false, undefined, true, undefined, 1, ["a"]);
    x.add("b", 2);
    expect(x.runner.appendCaptured()).toBe(0);
    x.finishCapture();
    x.release();
    await x.runner.settled();
    expect(x.store.run(id)).toMatchObject({ total: 1, completed: 1 });
    expect(x.analyzed).toEqual(["a"]);
  });
  it("队列暂空时等待采集，暂停可以结束等待并保留新角色给续跑", async () => {
    const x = setup();
    x.add("a", 1);
    const id = await x.runner.start("codex");
    x.release();
    await vi.waitFor(() => expect(x.store.run(id)!.completed).toBe(1));
    expect(x.store.run(id)!.status).toBe("running");
    await x.runner.pause(id);
    expect(x.store.run(id)!.status).toBe("paused");
    x.add("b", 2);
    expect(x.runner.appendCaptured()).toBe(0);
    x.finishCapture();
    await x.runner.resume(id);
    await x.runner.settled();
    expect(x.store.run(id)).toMatchObject({ completed: 2, status: "completed" });
  });
});
