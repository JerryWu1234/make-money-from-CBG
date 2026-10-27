import { afterEach, expect, it, vi } from "vite-plus/test";
import { analysisRecord, analysisResponse } from "../../tests/fixtures/analysis";
import type { SavedRoleRecord } from "../crawler/types";
import { CrawlStore } from "../crawler/store";
import { AnalysisRunner, type AnalysisClient } from "./runner";
import { AnalysisStore } from "./store";

// 失败方式：结果未入库即复用、失败/暂停记录丢失、提交失败仍清理、
// 回退失败覆盖成功结果、暂停后晚到回复落库、关闭异常泄漏锁、429 绕过冷却。
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
});

function setup(
  keys: string[],
  options: {
    response?: (key: string, signal: AbortSignal) => Promise<string>;
    release?: (key: string, persisted: boolean) => Promise<void>;
    close?: () => Promise<void>;
  } = {},
) {
  const crawl = new CrawlStore(":memory:");
  for (const key of keys) {
    const record = analysisRecord(key);
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
  }
  const store = new AnalysisStore(crawl.db);
  vi.spyOn(store, "followsCapture").mockReturnValue(false);
  const snapshots: Array<{
    key: string;
    persisted: boolean;
    state: unknown;
    raw: unknown;
    result: unknown;
  }> = [];
  const analyze = vi.fn(async (prompt: string, _schema: unknown, signal: AbortSignal) => {
    const key = prompt.match(/商品 ID：([^。]+)。/)![1];
    const text = options.response
      ? await options.response(key, signal)
      : JSON.stringify(analysisResponse(crawl.detail(key) as SavedRoleRecord));
    return { text };
  });
  const close = vi.fn(async () => options.close?.());
  const acquire = vi.fn(async (_signal: AbortSignal) => {
    let key = "";
    return {
      analyze: async (prompt: string, schema: unknown, signal: AbortSignal) => {
        key = prompt.match(/商品 ID：([^。]+)。/)![1];
        return analyze(prompt, schema, signal);
      },
      release: async (persisted: boolean) => {
        const row = crawl.db
          .prepare(
            `SELECT a.state, a.raw_response AS raw, t.result_json AS result
             FROM analysis_attempts a JOIN analysis_tasks t ON t.id=a.task_id
             WHERE t.listing_key=? ORDER BY a.rowid DESC LIMIT 1`,
          )
          .get(key);
        snapshots.push({ key, persisted, state: row?.state, raw: row?.raw, result: row?.result });
        await options.release?.(key, persisted);
      },
    };
  });
  const createSessionPool = vi.fn((_concurrency: number) => ({ acquire, close }));
  const client: AnalysisClient = {
    model: "test",
    analyze: async () => {
      throw new Error("会话模式不应调用普通分析");
    },
    createSessionPool,
  };
  const runner = new AnalysisRunner(store, async () => client);
  cleanups.push(async () => {
    await runner.shutdown();
    crawl.close();
  });
  return { crawl, store, runner, analyze, acquire, close, createSessionPool, snapshots };
}

it("成功结果落库后才释放会话，并等待释放后处理下一个角色", async () => {
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
  const x = setup(["a", "b"], {
    release: async (key) => {
      if (key === "a") await firstReleased;
    },
  });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  try {
    await vi.waitFor(() => expect(x.snapshots).toHaveLength(1));
    expect(x.createSessionPool).toHaveBeenCalledWith(1);
    expect(x.snapshots[0]).toMatchObject({ key: "a", persisted: true, state: "completed" });
    expect(x.snapshots[0]!.raw).toEqual(expect.any(String));
    expect(x.snapshots[0]!.result).toEqual(expect.any(String));
    expect(x.analyze).toHaveBeenCalledTimes(1);
    expect(x.store.run(id)).toMatchObject({ status: "running", completed: 1 });
    releaseFirst();
    await x.runner.settled();
    expect(x.store.run(id)).toMatchObject({ status: "completed", completed: 2 });
    expect(x.snapshots.map(({ key, persisted, state }) => ({ key, persisted, state }))).toEqual([
      { key: "a", persisted: true, state: "completed" },
      { key: "b", persisted: true, state: "completed" },
    ]);
    expect(x.close).toHaveBeenCalledOnce();
  } finally {
    releaseFirst();
  }
});

it("输出校验失败时先保存原始回复和失败记录，再释放会话", async () => {
  const x = setup(["a"], { response: async () => "not-json" });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  await x.runner.settled();
  expect(x.store.run(id)).toMatchObject({ status: "paused", failed: 1 });
  expect(x.snapshots).toEqual([
    { key: "a", persisted: true, state: "failed", raw: "not-json", result: null },
  ]);
});

it("暂停时先保存中断记录，再释放会话并关闭池", async () => {
  let started!: () => void;
  const analyzing = new Promise<void>((resolve) => (started = resolve));
  const x = setup(["a"], {
    response: async (_key, signal) => {
      started();
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return "";
    },
  });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  await analyzing;
  await x.runner.pause(id);
  expect(x.store.run(id)).toMatchObject({ status: "paused", queued: 1, completed: 0 });
  expect(x.snapshots).toEqual([
    { key: "a", persisted: true, state: "interrupted", raw: null, result: null },
  ]);
  expect(x.close).toHaveBeenCalledOnce();
});

it("暂停时底层请求晚退出，等待租约清理后才关闭池且不写入晚到结果", async () => {
  let started!: () => void;
  let finishRequest!: () => void;
  const analyzing = new Promise<void>((resolve) => (started = resolve));
  const requestFinished = new Promise<void>((resolve) => (finishRequest = resolve));
  let x!: ReturnType<typeof setup>;
  x = setup(["a"], {
    response: async () => {
      started();
      await requestFinished;
      return JSON.stringify(analysisResponse(x.crawl.detail("a") as SavedRoleRecord));
    },
    release: async () => requestFinished,
  });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  try {
    await analyzing;
    const paused = x.runner.pause(id);
    await vi.waitFor(() => expect(x.snapshots).toHaveLength(1));
    expect(x.snapshots[0]).toMatchObject({ persisted: true, state: "interrupted", result: null });
    expect(x.close).not.toHaveBeenCalled();
    finishRequest();
    await paused;
    expect(x.store.run(id)).toMatchObject({ status: "paused", queued: 1, completed: 0 });
    expect(x.close).toHaveBeenCalledOnce();
  } finally {
    finishRequest();
  }
});

it("结果事务提交失败时会话不得以已保存状态释放", async () => {
  const x = setup(["a"]);
  vi.spyOn(x.store, "finish").mockImplementation(() => {
    throw new Error("写入失败");
  });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  await x.runner.settled();
  expect(x.store.run(id)).toMatchObject({ status: "paused", completed: 0 });
  expect(x.snapshots).toEqual([
    { key: "a", persisted: false, state: "running", raw: null, result: null },
  ]);
  expect(x.close).toHaveBeenCalledOnce();
});

it("回退失败时保留已入库的结果并暂停，不开始下一个角色", async () => {
  const x = setup(["a", "b"], {
    release: async () => {
      throw new Error("会话回退失败");
    },
  });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  await x.runner.settled();
  expect(x.store.run(id)).toMatchObject({ status: "paused", completed: 1, queued: 1 });
  expect(x.store.run(id)!.error).toContain("会话回退失败");
  expect(x.snapshots[0]).toMatchObject({ persisted: true, state: "completed" });
  expect(x.snapshots[0]!.result).toEqual(expect.any(String));
  expect(x.analyze).toHaveBeenCalledTimes(1);
  expect(x.close).toHaveBeenCalledOnce();
});

it("池关闭失败时保留结果、报告暂停并释放分析锁", async () => {
  const x = setup(["a"], {
    close: async () => {
      throw new Error("关闭会话池失败");
    },
  });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  await expect(x.runner.settled()).resolves.toBeUndefined();
  expect(x.store.run(id)).toMatchObject({
    status: "paused",
    completed: 1,
    error: "关闭会话池失败",
  });
  expect(x.snapshots[0]).toMatchObject({ persisted: true, state: "completed" });
  expect(x.snapshots[0]!.result).toEqual(expect.any(String));
  expect(x.crawl.db.prepare("SELECT count(*) AS n FROM analysis_lock").get()?.n).toBe(0);
  expect(x.runner.isRunning()).toBe(false);
});

it("会话内 429 仍遵循统一冷却并在结果落库后释放", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  let calls = 0;
  let x!: ReturnType<typeof setup>;
  x = setup(["a"], {
    response: async () => {
      if (++calls === 1) throw new Error("429 Too Many Requests");
      return JSON.stringify(analysisResponse(x.crawl.detail("a") as SavedRoleRecord));
    },
  });
  const id = await x.runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
  await vi.advanceTimersByTimeAsync(0);
  expect(x.analyze).toHaveBeenCalledTimes(1);
  expect(x.snapshots).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(x.analyze).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2_001);
  await x.runner.settled();
  expect(x.store.run(id)).toMatchObject({ status: "completed", completed: 1 });
  expect(x.acquire).toHaveBeenCalledOnce();
  expect(x.analyze).toHaveBeenCalledTimes(2);
  expect(x.snapshots).toHaveLength(1);
  expect(x.snapshots[0]).toMatchObject({ persisted: true, state: "completed" });
});
