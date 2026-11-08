import { afterEach, expect, it, vi } from "vite-plus/test";
import { createDetailOpenQueue } from "./detail-open-queue";

afterEach(() => vi.useRealTimers());

it("六个详情错开五秒开始，前面的读取未完成也允许后面的打开", async () => {
  vi.useFakeTimers();
  const wait = createDetailOpenQueue();
  const starts: number[] = [];
  const signal = new AbortController().signal;
  const beginning = Date.now();
  let finish!: () => void;
  const reading = new Promise<void>((resolve) => (finish = resolve));
  const captures = Array.from({ length: 6 }, async () => {
    await wait(signal);
    starts.push(Date.now() - beginning);
    await reading;
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([0]);
    for (let index = 1; index < 6; index++) {
      await vi.advanceTimersByTimeAsync(4999);
      expect(starts).toHaveLength(index);
      await vi.advanceTimersByTimeAsync(1);
      expect(starts).toHaveLength(index + 1);
    }
    expect(starts).toEqual([0, 5000, 10000, 15000, 20000, 25000]);
  } finally {
    finish();
    await Promise.all(captures);
  }
});

it("后续补位和重试也排队，空闲一段时间后不会积攒出同时打开的额度", async () => {
  vi.useFakeTimers();
  const wait = createDetailOpenQueue();
  const signal = new AbortController().signal;
  await wait(signal);
  await vi.advanceTimersByTimeAsync(20000);
  const starts: number[] = [];
  const beginning = Date.now();
  const tasks = Array.from({ length: 3 }, async () => {
    await wait(signal);
    starts.push(Date.now() - beginning);
  });
  await vi.runAllTimersAsync();
  await Promise.all(tasks);
  expect(starts).toEqual([0, 5000, 10000]);
});

it("等待期间取消保留原原因，取消的任务不消耗下一次打开时刻", async () => {
  vi.useFakeTimers();
  const wait = createDetailOpenQueue();
  const signal = new AbortController().signal;
  await wait(signal);
  const controller = new AbortController();
  const reason = new Error("用户暂停采集");
  const canceled = expect(wait(controller.signal)).rejects.toBe(reason);
  let nextStarted = false;
  const next = wait(signal).then(() => (nextStarted = true));
  await vi.advanceTimersByTimeAsync(1000);
  controller.abort(reason);
  await canceled;
  await vi.advanceTimersByTimeAsync(3999);
  expect(nextStarted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await next;
  expect(nextStarted).toBe(true);
});
