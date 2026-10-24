import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrawlStore } from "../crawler/store";
import type { SavedRoleRecord } from "../crawler/types";
import { analysisRecord, analysisResponse } from "../../tests/fixtures/analysis";
import { AnalysisStore } from "./store";
import { AnalysisRunner } from "./runner";
import { createProfile } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import { BARE_ROLE_TEMPLATE } from "./bare-role-prompt";

// Failure cases: new captures are omitted or duplicated, unfinished details enter the queue,
// trial scope expands, a completed/paused run receives tasks, frozen settings change,
// or an empty queue ends when collection stops and pause cannot interrupt waiting.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function setup(filename = ":memory:") {
  const crawl = new CrawlStore(filename);
  const store = new AnalysisStore(crawl.db);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const analyzed: string[] = [];
  const analyze = vi.fn(async (prompt: string) => {
    const productKey = prompt.match(/商品 ID：([^。\n]+)[。\n]/)![1];
    const row = crawl.db
      .prepare("SELECT * FROM analysis_tasks WHERE status='running' AND listing_key=?")
      .get(productKey)!;
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
  const runner = new AnalysisRunner(store, connect);
  const add = (key: string, index: number, complete = true) => {
    const record = analysisRecord(key);
    crawl.observe(record.listing);
    if (complete) crawl.save(record.listing, record.detail!);
    crawl.db
      .prepare("UPDATE listings SET first_seen_at=? WHERE key=?")
      .run(new Date(Date.UTC(2026, 9, 14, 0, 0, index)).toISOString(), key);
  };
  cleanups.push(async () => {
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
  };
}
describe("分析队列持续处理并等待新角色", () => {
  it("候选和采集失败不触发模型，完整商品发布后立即分析且不重复", async () => {
    const x = setup();
    x.release();
    x.add("publication", 1, false);
    const id = await x.runner.start("codex", false);
    expect(x.analyzed).toEqual([]);
    expect(x.crawl.records(1, 20, "complete").total).toBe(0);
    x.crawl.fail("publication", "资料未完整");
    expect(x.runner.appendCaptured()).toBe(0);
    expect(x.analyzed).toEqual([]);
    const record = analysisRecord("publication");
    expect(x.crawl.save(record.listing, record.detail!)).toBe(true);
    expect(x.runner.appendCaptured()).toBe(1);
    expect(x.runner.appendCaptured()).toBe(0);
    await vi.waitFor(() => expect(x.store.run(id)?.completed).toBe(1), { timeout: 2500 });
    expect(x.analyzed).toEqual(["publication"]);
    expect(x.crawl.records(1, 20, "complete").total).toBe(1);
    expect(x.crawl.records(1, 20, "tasks").total).toBe(0);
  });
  it("裸号待命时不反复重放已复用结果；新增与修改资料立即重新检查", async () => {
    const x = setup();
    const profile = createProfile("冻结裸号设置", undefined, false);
    x.add("a", 1);
    x.release();
    await x.runner.start("codex", false, profile, true);
    await x.runner.settled();
    const id = await x.runner.start("codex", false, profile);
    expect(x.store.run(id)).toMatchObject({ total: 0, phase: "waiting_capture" });
    const prepare = vi.spyOn(x.crawl.db, "prepare");
    expect(x.runner.appendCaptured()).toBe(0);
    expect(x.runner.appendCaptured()).toBe(0);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("AND t.input_hash=?"))).toHaveLength(
      0,
    );
    prepare.mockRestore();
    x.add("b", 2);
    expect(x.runner.appendCaptured()).toBe(1);
    await vi.waitFor(() => expect(x.store.run(id)?.completed).toBe(1), { timeout: 2500 });
    const changed = analysisRecord("a");
    changed.listing.price = "1234";
    x.crawl.observe(changed.listing);
    x.crawl.save(changed.listing, changed.detail!);
    expect(x.runner.appendCaptured()).toBe(1);
    await vi.waitFor(() => expect(x.store.run(id)?.completed).toBe(2), { timeout: 2500 });
    expect(x.analyzed).toEqual(["a", "b", "a"]);
  });
  it("另一个数据库连接写入采集结果也会打破待命快照，不漏掉新角色", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cbg-idle-append-"));
    const filename = join(directory, "fixture.sqlite");
    const x = setup(filename);
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const profile = createProfile("冻结裸号设置", undefined, false);
    x.add("a", 1);
    x.release();
    await x.runner.start("codex", false, profile, true);
    await x.runner.settled();
    const id = await x.runner.start("codex", false, profile);
    const other = new CrawlStore(filename);
    try {
      expect(x.runner.appendCaptured()).toBe(0);
      const before = x.crawl.db.prepare("SELECT total_changes() n").get()!.n;
      const next = analysisRecord("external");
      other.observe(next.listing);
      other.save(next.listing, next.detail!);
      expect(x.crawl.db.prepare("SELECT total_changes() n").get()!.n).toBe(before);
      expect(x.runner.appendCaptured()).toBe(1);
      await vi.waitFor(() => expect(x.store.run(id)?.completed).toBe(1), { timeout: 2500 });
      expect(x.analyzed).toEqual(["a", "external"]);
    } finally {
      other.close();
    }
  });
  it("等待新角色期间行情过期即暂停，不能续跑旧行情且不发出AI请求", async () => {
    const x = setup();
    const source = {
      serverId: "132",
      serverName: "测试服",
      age: "older" as const,
      rank: 1,
      goldPrice: 210,
      goldUnit: 30000000,
      baselineUnitConfirmed: true,
      source: "auto" as const,
      fetchedAt: new Date().toISOString(),
      sources: [],
    };
    const profile = { ...createProfile("冻结行情", undefined, false), marketSources: [source] };
    const id = await x.runner.start("codex", false, profile);
    expect(x.store.run(id)?.marketExpired).toBe(false);
    const expired = {
      ...profile,
      marketSources: [{ ...source, fetchedAt: new Date(Date.now() - 25 * 3600000).toISOString() }],
    };
    x.crawl.db
      .prepare("UPDATE analysis_runs SET profile_json=? WHERE id=?")
      .run(JSON.stringify(expired), id);
    x.add("a", 1);
    await vi.waitFor(
      () =>
        expect(x.store.run(id)).toMatchObject({
          status: "paused",
          marketExpired: true,
          error: expect.stringContaining("区服行情已过期"),
        }),
      { timeout: 2500 },
    );
    await x.runner.settled();
    expect(x.analyzed).toEqual([]);
    expect(x.crawl.count()).toBe(1);
    expect(x.connect).toHaveBeenCalledTimes(1);
    await expect(x.runner.resume(id)).rejects.toThrow("区服行情已过期");
    expect(x.connect).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(
        String(
          x.crawl.db.prepare("SELECT profile_json FROM analysis_runs WHERE id=?").get(id)!
            .profile_json,
        ),
      ),
    ).toEqual(expired);
  });
  it("空库可先启动等待，未完整角色不调用AI，首个采齐后自动分析，空批次暂停恢复不丢设置", async () => {
    const x = setup();
    const profile = createProfile("空库冻结设置", undefined, false);
    const id = await x.runner.start("codex", false, profile);
    expect(x.store.run(id)).toMatchObject({
      status: "running",
      total: 0,
      phase: "waiting_capture",
    });
    expect(x.analyzed).toEqual([]);
    expect(await x.runner.start("codex", false, profile)).toBe(id);
    expect(x.connect).toHaveBeenCalledOnce();
    await x.runner.pause(id);
    expect(x.store.run(id)).toMatchObject({ status: "paused", total: 0 });
    await x.runner.resume(id);
    expect(x.store.run(id)).toMatchObject({ status: "running", phase: "waiting_capture" });
    x.add("first", 1, false);
    expect(x.runner.appendCaptured()).toBe(0);
    expect(x.analyzed).toEqual([]);
    const record = analysisRecord("first");
    x.crawl.save(record.listing, record.detail!);
    x.release();
    await vi.waitFor(
      () =>
        expect(x.store.run(id)).toMatchObject({
          status: "running",
          total: 1,
          completed: 1,
          phase: "waiting_capture",
        }),
      { timeout: 2500 },
    );
    expect(x.analyzed).toEqual(["first"]);
    const task = x.crawl.db.prepare("SELECT id FROM analysis_tasks WHERE run_id=?").get(id)!;
    expect(x.store.detail(String(task.id))?.profile?.hash).toBe(profile.hash);
  });
  it("没有采集任务也处理完已有角色，空闲不调用AI，新完整角色自动同批接续", async () => {
    const x = setup();
    x.add("a", 1);
    x.add("b", 2);
    const id = await x.runner.start("codex");
    x.release();
    await vi.waitFor(() =>
      expect(x.store.run(id)).toMatchObject({
        status: "running",
        completed: 2,
        queued: 0,
        phase: "waiting_capture",
      }),
    );
    const firstTask = x.store.overview().records.items[0].taskId!;
    const original = structuredClone(x.store.detail(firstTask));
    expect(await x.runner.start("codex")).toBe(id);
    expect(x.connect).toHaveBeenCalledOnce();
    expect(x.analyzed).toEqual(["a", "b"]);

    x.add("c", 3, false);
    expect(x.runner.appendCaptured()).toBe(0);
    expect(x.store.run(id)?.total).toBe(2);
    const record = analysisRecord("c");
    x.crawl.save(record.listing, record.detail!);
    // No collection callback or second start: the waiting worker discovers the new role.
    await vi.waitFor(
      () =>
        expect(x.store.run(id)).toMatchObject({
          status: "running",
          total: 3,
          completed: 3,
          phase: "waiting_capture",
        }),
      { timeout: 2500 },
    );
    expect(x.analyzed).toEqual(["a", "b", "c"]);
    expect(x.connect).toHaveBeenCalledOnce();
    expect(x.store.detail(firstTask)).toEqual(original);
    await x.runner.pause(id);
    expect(x.runner.isRunning()).toBe(false);
    expect(x.store.run(id)).toMatchObject({ status: "paused", phase: null });
    await x.runner.resume(id);
    expect(x.store.run(id)).toMatchObject({ status: "running", phase: "waiting_capture" });
    expect(x.analyzed).toHaveLength(3);
  });

  it("历史已完成的普通批次可直接恢复等待，不重建批次、不重算角色", async () => {
    const x = setup();
    x.add("a", 1);
    const id = await x.runner.start("codex");
    x.release();
    await vi.waitFor(() => expect(x.store.run(id)?.completed).toBe(1));
    await x.runner.pause(id);
    x.crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(id);
    expect(await x.runner.start("codex")).toBe(id);
    expect(x.store.run(id)).toMatchObject({
      status: "running",
      phase: "waiting_capture",
      completed: 1,
    });
    expect(x.analyzed).toEqual(["a"]);
    expect(x.store.overview().runs).toHaveLength(1);
    await x.runner.pause(id);
    x.crawl.db.prepare("UPDATE analysis_runs SET status='completed' WHERE id=?").run(id);
    await x.runner.resume(id);
    expect(x.store.run(id)).toMatchObject({ status: "running", phase: "waiting_capture" });
    expect(x.analyzed).toEqual(["a"]);
  });

  it("所有商品仅有试分析结果时，普通分析创建等待批次，试分析范围保持不变", async () => {
    const x = setup();
    x.add("a", 1);
    const trial = await x.runner.start("codex", false, undefined, true);
    x.release();
    await x.runner.settled();
    const id = await x.runner.start("codex");
    expect(id).not.toBe(trial);
    expect(x.store.run(id)).toMatchObject({
      status: "running",
      total: 0,
      phase: "waiting_capture",
    });
    expect(x.store.overview().results.total).toBe(1);
    x.add("b", 2);
    await vi.waitFor(
      () =>
        expect(x.store.run(id)).toMatchObject({ completed: 1, total: 1, phase: "waiting_capture" }),
      { timeout: 2500 },
    );
    expect(x.store.run(trial)).toMatchObject({ status: "completed", total: 1, completed: 1 });
    expect(x.store.followsCapture(trial)).toBe(false);
    expect(x.analyzed).toEqual(["a", "b"]);
  });

  it("第1个采齐启动，第2到10个按采集顺序追加一次并保持冻结模型和Prompt", async () => {
    const x = setup();
    x.add("role-1", 1);
    const profile = createProfile("frozen prompt", undefined, false);
    profile.settings.mountBoundary = "lower";
    const frozenProfile = structuredClone(profile);
    const id = await x.runner.start("codex", false, profile);
    profile.template = "later template";
    profile.settings.mountBoundary = "upper";
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
    expect(tasks.every((task) => String(task.prompt_text).startsWith(BARE_ROLE_TEMPLATE))).toBe(
      true,
    );
    expect(
      tasks.every((task) => String(task.prompt_text).includes('"mountBoundary":"lower"')),
    ).toBe(true);
    const stored = x.crawl.db.prepare("SELECT profile_json FROM analysis_runs WHERE id=?").get(id)!;
    expect(JSON.parse(String(stored.profile_json))).toEqual(frozenProfile);
    x.release();
    await vi.waitFor(() =>
      expect(x.store.run(id)).toMatchObject({
        completed: 10,
        failed: 0,
        total: 10,
        phase: "waiting_capture",
      }),
    );
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
    x.release();
    await x.runner.settled();
    expect(x.store.run(id)).toMatchObject({ total: 1, completed: 1 });
    expect(x.analyzed).toEqual(["a"]);
  });
  it("采集已停止仍等待，暂停可结束等待，恢复后新角色沿用原批次", async () => {
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
    await x.runner.resume(id);
    await vi.waitFor(() =>
      expect(x.store.run(id)).toMatchObject({
        completed: 2,
        status: "running",
        phase: "waiting_capture",
      }),
    );
  });
});
