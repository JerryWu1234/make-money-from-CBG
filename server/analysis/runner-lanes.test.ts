import { afterEach, expect, it, vi } from "vite-plus/test";
import { analysisRecord, analysisResponse } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import type { SavedRoleRecord } from "../crawler/types";
import { AnalysisStore } from "./store";
import { AnalysisRunner } from "./runner";

// 失败方式：旧库缺列、来源污染输入哈希、侧内乱序、新号被旧队列挡住、老号饿死、
// 超过总并发、空侧不借位、借位任务被抢断，以及暂停续跑丢失来源或成功结果。
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function setup() {
  const crawl = new CrawlStore(":memory:");
  const store = new AnalysisStore(crawl.db);
  let captured = 0;
  const add = (key: string, lane: "new" | "old") => {
    const record = analysisRecord(key);
    crawl.observe(record.listing, lane);
    crawl.save(record.listing, record.detail!);
    crawl.db
      .prepare("UPDATE listings SET first_seen_at=? WHERE key=?")
      .run(new Date(Date.UTC(2026, 9, 23, 0, 0, captured++)).toISOString(), key);
  };
  const gates = new Map<string, () => void>();
  const started: string[] = [];
  const aborted: string[] = [];
  const analyze = vi.fn(async (prompt: string, _schema: unknown, signal: AbortSignal) => {
    const key = prompt.match(/商品 ID：([^。]+)。/)![1];
    started.push(key);
    await new Promise<void>((resolve, reject) => {
      gates.set(key, resolve);
      signal.addEventListener(
        "abort",
        () => {
          aborted.push(key);
          reject(signal.reason);
        },
        { once: true },
      );
    });
    return { text: JSON.stringify(analysisResponse(crawl.detail(key) as SavedRoleRecord)) };
  });
  const connect = vi.fn(async () => ({ model: "lanes-test", analyze }));
  const runner = new AnalysisRunner(store, connect);
  cleanups.push(async () => {
    await runner.shutdown();
    crawl.close();
  });
  const seed = (lane: "new" | "old", count: number) => {
    for (let index = 0; index < count; index++) add(`${lane}-${index}`, lane);
  };
  return { crawl, store, runner, analyze, connect, gates, started, aborted, add, seed };
}

it("默认10并发按7新3老启动，完成一个立即补同侧，持续新号也保留老号槽位", async () => {
  const x = setup();
  x.seed("old", 12);
  x.seed("new", 12);
  const id = await x.runner.start("codex");
  expect(x.store.run(id)).toMatchObject({
    concurrency: 10,
    runningCount: 10,
    newRunning: 7,
    oldRunning: 3,
    newLimit: 7,
    oldLimit: 3,
  });
  expect(x.started).toEqual([
    ...Array.from({ length: 7 }, (_, index) => `new-${index}`),
    "old-0",
    "old-1",
    "old-2",
  ]);
  x.gates.get("old-0")!();
  await vi.waitFor(() => expect(x.started).toContain("old-3"));
  expect(x.store.run(id)).toMatchObject({ completed: 1, newRunning: 7, oldRunning: 3 });
  x.gates.get("new-0")!();
  await vi.waitFor(() => expect(x.started).toContain("new-7"));
  expect(x.store.run(id)).toMatchObject({ completed: 2, runningCount: 10 });
});

it.each([
  [2, 1, 1],
  [3, 2, 1],
  [4, 3, 1],
])("%s并发按比例分配两侧，至少各保留一个槽", async (concurrency, newLimit, oldLimit) => {
  const x = setup();
  x.seed("old", 5);
  x.seed("new", 5);
  const id = await x.runner.start(
    "codex",
    false,
    undefined,
    false,
    undefined,
    1,
    undefined,
    concurrency,
  );
  expect(x.store.run(id)).toMatchObject({
    concurrency,
    newLimit,
    oldLimit,
    newRunning: newLimit,
    oldRunning: oldLimit,
  });
});

it.each(["new", "old"] as const)("只有%s号时借满10个槽，新侧到达后只在完成时补入", async (lane) => {
  const x = setup();
  x.seed(lane, 12);
  const id = await x.runner.start("codex");
  expect(x.started).toHaveLength(10);
  expect(x.store.run(id)!.runningCount).toBe(10);
  const other = lane === "new" ? "old" : "new";
  x.add(`${other}-inserted`, other);
  expect(x.runner.appendCaptured()).toBe(1);
  expect(x.started).not.toContain(`${other}-inserted`);
  expect(x.aborted).toEqual([]);
  x.gates.get(x.started[0])!();
  await vi.waitFor(() => expect(x.started).toContain(`${other}-inserted`));
  expect(x.aborted).toEqual([]);
  expect(x.store.run(id)).toMatchObject({ completed: 1, runningCount: 10 });
});

it("追加新号越过历史FIFO，暂停续跑保留lane与成功结果", async () => {
  const x = setup();
  x.seed("old", 6);
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 2);
  x.add("fresh", "new");
  x.runner.appendCaptured();
  x.gates.get("old-0")!();
  await vi.waitFor(() => expect(x.started).toContain("fresh"));
  expect(x.started).toEqual(["old-0", "old-1", "fresh"]);
  await x.runner.pause(id);
  expect(x.store.run(id)).toMatchObject({
    completed: 1,
    queued: 6,
    runningCount: 0,
    error: null,
    pauseNotice: "已暂停，继续时先处理这件商品",
  });
  x.crawl.db.prepare("UPDATE listings SET capture_lane='old' WHERE key='fresh'").run();
  x.gates.clear();
  const reopenedStore = new AnalysisStore(x.crawl.db);
  const reopened = new AnalysisRunner(reopenedStore, x.connect);
  try {
    await reopened.resume(id);
    expect(x.started.slice(3)).toEqual(["fresh", "old-1"]);
    expect(reopenedStore.run(id)).toMatchObject({
      concurrency: 2,
      completed: 1,
      newRunning: 1,
      oldRunning: 1,
      newLimit: 1,
      oldLimit: 1,
    });
    expect(x.started.filter((key) => key === "old-0")).toHaveLength(1);
  } finally {
    await reopened.shutdown();
  }
});

it("单并发在两侧之间轮换，不会让老号一直等待", async () => {
  const x = setup();
  x.seed("old", 3);
  x.seed("new", 5);
  await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  expect(x.started).toEqual(["new-0"]);
  for (const [done, next] of [
    ["new-0", "old-0"],
    ["old-0", "new-1"],
    ["new-1", "old-1"],
  ]) {
    x.gates.get(done)!();
    await vi.waitFor(() => expect(x.started.at(-1)).toBe(next));
  }
});

it("两侧在途项遇到AI校验错误时一起暂停，保留首个错误和未完成队列", async () => {
  const x = setup();
  x.seed("old", 12);
  x.seed("new", 12);
  x.analyze.mockResolvedValueOnce({ text: "not-json" });
  const id = await x.runner.start("codex");
  await x.runner.settled();
  expect(x.analyze).toHaveBeenCalledTimes(10);
  const run = x.store.run(id)!;
  expect(run).toMatchObject({
    status: "paused",
    failed: 1,
    queued: 23,
    newRunning: 0,
    oldRunning: 0,
  });
  expect(run.error).not.toContain("已暂停");
  expect(
    x.store.db.prepare("SELECT error FROM analysis_tasks WHERE status='failed'").all(),
  ).toEqual([{ error: run.error }]);
});

it("任务冻结lane，来源变化不改变输入hash，旧任务缺列时迁移为old", () => {
  const x = setup();
  x.add("a", "new");
  x.add("b", "old");
  const id = x.store.createRun("codex", "lanes-test", true);
  const task = x.store.next(id, "new")!;
  expect(task).toMatchObject({ lane: "new", document: { productKey: "a" } });
  x.crawl.db.prepare("UPDATE listings SET capture_lane='old' WHERE key='a'").run();
  const second = x.store.createRun("codex", "lanes-test", true);
  const updated = x.store.next(second, "new")!;
  expect(updated.lane).toBe("old");
  expect(updated.document.contentHash).toBe(task.document.contentHash);
  expect(x.store.next(id, "new")!.lane).toBe("new");
  x.crawl.db.exec("ALTER TABLE analysis_tasks DROP COLUMN queue_lane");
  const migrated = new AnalysisStore(x.crawl.db);
  expect(migrated.next(id, "new")).toMatchObject({
    lane: "old",
    document: { productKey: "a" },
  });
  expect(migrated.run(id)).toMatchObject({
    newRunning: 0,
    oldRunning: 0,
    newLimit: 7,
    oldLimit: 3,
  });
});
