import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AnalysisRateLimit, type AnalysisBackoff } from "./rate-limit";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("同波10个429只计一次冷却，等待后只派一个探测请求，成功后逐步恢复", async () => {
  let state: AnalysisBackoff | null = null;
  const gate = new AnalysisRateLimit(10, null, (next) => {
    state = next;
  });
  let calls = 0,
    active = 0;
  const releases: (() => void)[] = [];
  const request = vi.fn(async () => {
    if (++calls <= 10) throw new Error("429 Too Many Requests");
    active++;
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    active--;
    return "ok";
  });
  const controller = new AbortController();
  const jobs = Array.from({ length: 10 }, () => gate.run(request, controller.signal));
  const settled = Promise.all(jobs);
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(10);
  expect(state).toMatchObject({ concurrency: 1, rounds: 1 });
  await vi.advanceTimersByTimeAsync(29_999);
  expect(request).toHaveBeenCalledTimes(10);
  await vi.advanceTimersByTimeAsync(1);
  expect(request).toHaveBeenCalledTimes(11);
  expect(active).toBe(1);
  releases.shift()!();
  await vi.advanceTimersByTimeAsync(0);
  expect(active).toBe(2);
  expect(state).toMatchObject({ concurrency: 2, rounds: 0 });
  while (calls < 20 || active) {
    for (const release of releases.splice(0)) release();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(await settled).toEqual(Array(10).fill("ok"));
  expect(state).toBeNull();
});

it("Retry-After为最短等待时间，过长则保存冷却并暂停而不提前重试", async () => {
  const save = vi.fn();
  const gate = new AnalysisRateLimit(10, null, save);
  const request = vi.fn().mockRejectedValue(
    Object.assign(new Error("429 Too Many Requests"), {
      retryAfterMs: 600_000,
    }),
  );
  await expect(gate.run(request, new AbortController().signal)).rejects.toThrow("等待时间过长");
  expect(request).toHaveBeenCalledOnce();
  expect(save).toHaveBeenCalledWith({ retryAt: Date.now() + 600_000, concurrency: 1, rounds: 1 });
});

it("正常Retry-After延后恢复，取消冷却中的请求后不会再调用", async () => {
  const gate = new AnalysisRateLimit(10, null, vi.fn());
  const request = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error("429 Too Many Requests"), {
        retryAfterMs: 90_000,
      }),
    )
    .mockResolvedValue("ok");
  const controller = new AbortController();
  const job = gate.run(request, controller.signal);
  const rejected = expect(job).rejects.toThrow("用户暂停");
  await vi.advanceTimersByTimeAsync(89_999);
  expect(request).toHaveBeenCalledOnce();
  controller.abort(new Error("用户暂停"));
  await rejected;
  await vi.advanceTimersByTimeAsync(90_000);
  expect(request).toHaveBeenCalledOnce();
});

it("同波不同Retry-After合并最长截止，仍然只计一轮", async () => {
  let state: AnalysisBackoff | null = null;
  const gate = new AnalysisRateLimit(2, null, (next) => {
    state = next;
  });
  const controller = new AbortController();
  const request = vi
    .fn()
    .mockRejectedValueOnce(Object.assign(new Error("429"), { retryAfterMs: 30_000 }))
    .mockRejectedValueOnce(Object.assign(new Error("429"), { retryAfterMs: 90_000 }))
    .mockResolvedValue("ok");
  const jobs = [gate.run(request, controller.signal), gate.run(request, controller.signal)];
  await vi.advanceTimersByTimeAsync(0);
  expect(state).toEqual({ retryAt: Date.now() + 90_000, concurrency: 1, rounds: 1 });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(request).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(await Promise.all(jobs)).toEqual(["ok", "ok"]);
});

it("第2轮失败后暂停或更换实例不重置轮数，第3轮失败即暂停", async () => {
  const previous = { retryAt: Date.now() + 60_000, concurrency: 1, rounds: 2 };
  const save = vi.fn();
  const gate = new AnalysisRateLimit(10, previous, save);
  const request = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));
  const job = gate.run(request, new AbortController().signal);
  const rejected = expect(job).rejects.toThrow("持续限流");
  expect(save).toHaveBeenLastCalledWith(previous);
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(request).toHaveBeenCalledOnce();
  expect(save.mock.lastCall?.[0].rounds).toBe(3);
});

it.each([
  [3, 120_000],
  [1, 600_000],
  [1, 2 ** 31 + 60_000],
])("恢复既有第%s轮、冷却%s毫秒时保持暂停，不耗尽请求超时预算", async (rounds, delay) => {
  const gate = new AnalysisRateLimit(
    10,
    { retryAt: Date.now() + delay, concurrency: 1, rounds },
    vi.fn(),
  );
  const request = vi.fn();
  await expect(gate.run(request, new AbortController().signal)).rejects.toThrow("冷却");
  expect(request).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("失败轮数已用尽时，冷却结束后的显式继续才开启新的恢复周期", async () => {
  const save = vi.fn();
  const gate = new AnalysisRateLimit(
    10,
    { retryAt: Date.now() - 1, concurrency: 1, rounds: 3 },
    save,
  );
  const request = vi.fn().mockResolvedValue("ok");
  await expect(gate.run(request, new AbortController().signal)).resolves.toBe("ok");
  expect(request).toHaveBeenCalledOnce();
  expect(save.mock.calls[0][0].rounds).toBe(0);
});
