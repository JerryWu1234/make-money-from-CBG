import { afterEach, expect, it, vi } from "vite-plus/test";
import { analysisRecord, analysisResponse } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import type { SavedRoleRecord } from "../crawler/types";
import { AnalysisStore } from "./store";
import { AnalysisRunner, type AnalysisClient } from "./runner";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function setup(keys = ["a", "b"]) {
  const crawl = new CrawlStore(":memory:");
  for (const key of keys) {
    const record = analysisRecord(key);
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
  }
  const store = new AnalysisStore(crawl.db);
  vi.spyOn(store, "followsCapture").mockReturnValue(false);
  const reply = (prompt: string) => {
    const key = prompt.match(/商品 ID：([^。]+)。/)![1];
    return { text: JSON.stringify(analysisResponse(crawl.detail(key) as SavedRoleRecord)) };
  };
  const analyze = vi
    .fn<AnalysisClient["analyze"]>()
    .mockImplementation(async (prompt) => reply(prompt));
  const connect = vi.fn(async () => ({ model: "rate-limit-fixture", analyze }));
  const runner = new AnalysisRunner(store, connect);
  cleanups.push(async () => {
    await runner.shutdown();
    crawl.close();
  });
  return { crawl, store, runner, analyze, connect, reply };
}

it("一次429统一冷却，不中断其他有效请求，也不立即同时重发", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const x = setup();
  let release!: () => void;
  const aborted = vi.fn();
  x.analyze
    .mockRejectedValueOnce(new Error("exceeded retry limit, last status: 429 Too Many Requests"))
    .mockImplementationOnce(async (prompt, _schema, signal) => {
      signal.addEventListener("abort", aborted, { once: true });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      signal.removeEventListener("abort", aborted);
      return x.reply(prompt);
    });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(x.store.run(id)).toMatchObject({ status: "running", failed: 0 });
  expect(aborted).not.toHaveBeenCalled();
  expect(x.analyze).toHaveBeenCalledTimes(2);
  release();
  await vi.advanceTimersByTimeAsync(29_999);
  expect(x.store.run(id)?.completed).toBe(1);
  expect(x.analyze).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2_001);
  await x.runner.settled();
  expect(x.store.run(id)).toMatchObject({ status: "completed", completed: 2, failed: 0 });
  expect(x.analyze).toHaveBeenCalledTimes(3);
  expect(aborted).not.toHaveBeenCalled();
});

it("持续429有界重试后明确暂停，保留队列与原始错误", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const x = setup(["a"]);
  x.analyze.mockRejectedValue(
    new Error("exceeded retry limit, last status: 429 Too Many Requests"),
  );
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(x.store.run(id)?.status).toBe("running");
  await vi.advanceTimersByTimeAsync(120_000);
  await x.runner.settled();
  expect(x.analyze).toHaveBeenCalledTimes(3);
  expect(x.store.run(id)).toMatchObject({ status: "paused", queued: 1, failed: 0, completed: 0 });
  expect(x.store.run(id)?.error).toMatch(/429.*限流|限流.*429/);
  expect(x.store.run(id)?.error).not.toContain("exceeded retry limit");
  expect(
    x.store.db.prepare("SELECT error FROM analysis_attempts WHERE state='failed'").get()?.error,
  ).toBe("exceeded retry limit, last status: 429 Too Many Requests");
});

it("暂停和新实例继续仍保留冷却，不能点击继续就重新发出10个请求", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const x = setup();
  x.analyze.mockRejectedValueOnce(new Error("429 Too Many Requests"));
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  await vi.advanceTimersByTimeAsync(0);
  await x.runner.pause(id);
  expect(x.store.run(id)).toMatchObject({ status: "paused", queued: 2, failed: 0 });
  const restartedStore = new AnalysisStore(x.crawl.db);
  vi.spyOn(restartedStore, "followsCapture").mockReturnValue(false);
  const restarted = new AnalysisRunner(restartedStore, x.connect);
  try {
    await restarted.resume(id, false, 10);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(x.analyze).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_001);
    await restarted.settled();
    expect(x.store.run(id)).toMatchObject({
      status: "completed",
      completed: 2,
      failed: 0,
      concurrency: 10,
    });
  } finally {
    await restarted.shutdown();
  }
});

it("明确额度耗尽不自动重试，历史英文错误显示中文且原证据不改写", async () => {
  const x = setup();
  x.analyze.mockRejectedValueOnce(new Error("429 insufficient_quota"));
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  await x.runner.settled();
  expect(x.analyze).toHaveBeenCalledOnce();
  expect(x.store.run(id)).toMatchObject({ status: "paused", completed: 0, queued: 2, failed: 0 });
  expect(x.store.run(id)?.error).toContain("额度已达上限");
  const original = "exceeded retry limit, last status: 429 Too Many Requests";
  x.store.db.prepare("UPDATE analysis_runs SET error=? WHERE id=?").run(original, id);
  expect(x.store.run(id)?.error).toContain("限流");
  expect(x.store.db.prepare("SELECT error FROM analysis_runs WHERE id=?").get(id)?.error).toBe(
    original,
  );
});

it.each([
  Object.assign(new Error("429 Too Many Requests"), { retryAfterMs: 600_000 }),
  new Error("429 You exceeded your current quota, please check your plan and billing details."),
])("上游要求暂停时停止新派发，先保存其他已发出的有效结果：%s", async (error) => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const x = setup(["a", "b", "c"]);
  let release!: () => void;
  const aborted = vi.fn();
  x.analyze.mockRejectedValueOnce(error).mockImplementationOnce(async (prompt, _schema, signal) => {
    signal.addEventListener("abort", aborted, { once: true });
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    signal.removeEventListener("abort", aborted);
    return x.reply(prompt);
  });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(x.store.run(id)?.status).toBe("running");
  expect(aborted).not.toHaveBeenCalled();
  expect(x.analyze).toHaveBeenCalledTimes(2);
  release();
  await vi.advanceTimersByTimeAsync(0);
  await x.runner.settled();
  expect(x.store.run(id)).toMatchObject({ status: "paused", completed: 1, queued: 2, failed: 0 });
  expect(x.analyze).toHaveBeenCalledTimes(2);
});

it("限流收尾期间仍可主动暂停，立即取消在途且保留队列", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const x = setup(["a", "b", "c"]);
  const aborted = vi.fn();
  x.analyze
    .mockRejectedValueOnce(Object.assign(new Error("429"), { retryAfterMs: 600_000 }))
    .mockImplementationOnce(async (_prompt, _schema, signal) => {
      await new Promise<never>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted();
            reject(signal.reason);
          },
          { once: true },
        ),
      );
      return { text: "unreachable" };
    });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 2);
  await vi.advanceTimersByTimeAsync(0);
  expect(x.store.run(id)?.status).toBe("running");
  await x.runner.pause(id);
  expect(aborted).toHaveBeenCalledOnce();
  expect(x.store.run(id)).toMatchObject({ status: "paused", completed: 0, queued: 3, failed: 0 });
  expect(x.analyze).toHaveBeenCalledTimes(2);
});

it("不同AI提供方的冷却互不影响，旧锁不能覆盖恢复状态", async () => {
  const x = setup(["a"]);
  const state = { retryAt: Date.now() + 600_000, concurrency: 1, rounds: 1 };
  expect(x.store.acquire("fixture-owner")).toBe(true);
  x.store.saveProviderBackoff("codex", state, "fixture-owner");
  x.store.release("fixture-owner");
  expect(() => x.store.saveProviderBackoff("codex", null, "fixture-owner")).toThrow("分析锁已失效");
  const id = await x.runner.start("deepseek");
  await x.runner.settled();
  expect(x.store.run(id)).toMatchObject({ status: "completed", completed: 1, rateLimit: null });
  expect(x.analyze).toHaveBeenCalledOnce();
  expect(x.store.providerBackoff("codex")).toEqual(state);
});
