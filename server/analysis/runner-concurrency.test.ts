import { afterEach, expect, it, vi } from "vite-plus/test";
import { analysisRecord, analysisResponse } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import type { SavedRoleRecord } from "../crawler/types";
import { AnalysisStore } from "./store";
import { AnalysisRunner } from "./runner";

// 失败方式：超过并发上限、同一角色重复调用、提前结束批次、暂停漏回队列、错误被覆盖、续跑丢失配置。
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function setup() {
  const crawl = new CrawlStore(":memory:");
  const add = (key: string) => {
    const record = analysisRecord(key);
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
  };
  for (const key of ["a", "b", "c", "d", "e"]) add(key);
  const store = new AnalysisStore(crawl.db);
  const followCapture = vi.spyOn(store, "followsCapture").mockReturnValue(false);
  const gates = new Map<string, () => void>();
  let active = 0,
    maximum = 0;
  const analyze = vi.fn(async (prompt: string, _schema: unknown, signal: AbortSignal) => {
    const key = prompt.match(/商品 ID：([^。]+)。/)![1];
    active++;
    maximum = Math.max(maximum, active);
    try {
      await new Promise<void>((resolve, reject) => {
        gates.set(key, resolve);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { text: JSON.stringify(analysisResponse(crawl.detail(key) as SavedRoleRecord)) };
    } finally {
      active--;
    }
  });
  const connect = vi.fn(async () => ({ model: "parallel-test", analyze }));
  const runner = new AnalysisRunner(store, connect);
  cleanups.push(async () => {
    await runner.shutdown();
    crawl.close();
  });
  return {
    crawl,
    store,
    runner,
    analyze,
    connect,
    gates,
    add,
    followCapture,
    active: () => active,
    maximum: () => maximum,
  };
}

it.each([undefined, 1, 2, 4])(
  "并发数 %s 限制在途调用，乱序完成也不重复或提前结束",
  async (concurrency) => {
    const x = setup();
    if (concurrency === undefined) for (const key of "fghijkl") x.add(key);
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
    const limit = concurrency ?? 10;
    const total = x.store.run(id)!.total;
    expect(x.active()).toBe(limit);
    expect(x.store.run(id)).toMatchObject({
      status: "running",
      concurrency: limit,
      runningCount: limit,
    });
    expect(x.store.run(id)!.currentItems).toHaveLength(limit);
    x.gates.get(String.fromCharCode(96 + limit))!();
    await vi.waitFor(() => expect(x.store.run(id)!.completed).toBe(1));
    expect(x.store.run(id)!.status).toBe("running");
    while (x.store.run(id)!.completed < total) {
      x.gates.forEach((release) => release());
      await vi.waitFor(() => expect(x.store.run(id)!.completed > 1).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await x.runner.settled();
    expect(x.maximum()).toBe(limit);
    expect(x.store.run(id)).toMatchObject({
      status: "completed",
      completed: total,
      runningCount: 0,
    });
    expect(x.analyze).toHaveBeenCalledTimes(total);
  },
);

it("暂停全部在途角色，保留成功结果，改成2并发续跑且保存配置", async () => {
  const x = setup();
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 3);
  x.gates.get("b")!();
  await vi.waitFor(() => expect(x.store.run(id)!.completed).toBe(1));
  await x.runner.pause(id);
  expect(x.active()).toBe(0);
  expect(x.store.run(id)).toMatchObject({
    status: "paused",
    completed: 1,
    queued: 4,
    runningCount: 0,
  });
  x.gates.clear();
  await x.runner.resume(id, false, 2);
  expect(x.active()).toBe(2);
  expect(x.store.run(id)!.concurrency).toBe(2);
  await x.runner.pause(id);
  const reopened = new AnalysisRunner(new AnalysisStore(x.store.db), x.connect);
  vi.spyOn(reopened.store, "followsCapture").mockReturnValue(false);
  await reopened.resume(id);
  expect(reopened.store.run(id)!.concurrency).toBe(2);
  expect(x.active()).toBe(2);
  await reopened.pause(id);
});

it("AI校验错误暂停整批，中断其余在途项并保留首个错误", async () => {
  const x = setup();
  x.analyze.mockResolvedValueOnce({ text: "not-json" });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 3);
  await x.runner.settled();
  expect(x.analyze).toHaveBeenCalledTimes(3);
  expect(x.active()).toBe(0);
  const run = x.store.run(id)!;
  expect(run).toMatchObject({ status: "paused", failed: 1, queued: 4, runningCount: 0 });
  expect(run.error).not.toContain("已暂停");
  const errors = x.store.db.prepare("SELECT error FROM analysis_tasks WHERE status='failed'").all();
  expect(errors).toEqual([{ error: run.error }]);
});

it("边采边分析时新角色加入空闲槽位，不等待原先的慢角色", async () => {
  const x = setup();
  x.followCapture.mockRestore();
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 3);
  x.gates.get("c")!();
  await vi.waitFor(() => expect(x.gates.has("d")).toBe(true));
  x.add("f");
  x.runner.appendCaptured();
  x.gates.get("d")!();
  await vi.waitFor(() => expect(x.gates.has("e")).toBe(true));
  x.gates.get("e")!();
  await vi.waitFor(() => expect(x.gates.has("f")).toBe(true));
  expect(x.gates.has("a")).toBe(true);
  expect(x.store.run(id)!.total).toBe(6);
  await x.runner.pause(id);
});

it("仅剩一个慢请求时，新采集角色仍能使用空闲槽位", async () => {
  const x = setup();
  x.followCapture.mockRestore();
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 3);
  for (const key of ["b", "c", "d", "e"]) {
    await vi.waitFor(() => expect(x.gates.has(key)).toBe(true));
    x.gates.get(key)!();
  }
  await vi.waitFor(() => expect(x.store.run(id)!.completed).toBe(4));
  expect(x.active()).toBe(1);
  x.add("f");
  x.runner.appendCaptured();
  await vi.waitFor(() => expect(x.gates.has("f")).toBe(true), { timeout: 2500 });
  expect(x.active()).toBe(2);
  await x.runner.pause(id);
});

it.each([0, -1, 1.5, Infinity, NaN])(
  "拒绝无效并发数 %s，不连接AI或创建批次",
  async (concurrency) => {
    const x = setup();
    await expect(
      x.runner.start("codex", false, undefined, false, undefined, 1, undefined, concurrency),
    ).rejects.toThrow("并发数");
    expect(x.connect).not.toHaveBeenCalled();
    expect(x.store.activeRun()).toBeNull();
  },
);
