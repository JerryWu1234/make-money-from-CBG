import { beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  activity: vi.fn(),
  stopCapture: vi.fn(),
  stopSchedule: vi.fn(),
  stopAnalysis: vi.fn(),
  cancelAi: vi.fn(),
  closeAi: vi.fn(),
  closeBrowser: vi.fn(),
  finishWorkflow: vi.fn(),
}));
vi.mock("./crawler/controller", () => ({
  crawlActivity: mocks.activity,
  stopCrawl: mocks.stopCapture,
}));
vi.mock("./crawler/schedule", () => ({ shutdownScanSchedule: mocks.stopSchedule }));
vi.mock("./analysis/controller", () => ({ shutdownAnalysis: mocks.stopAnalysis }));
vi.mock("./ai-connection", () => ({
  shutdownAiConnections: mocks.closeAi,
  stopAiConnectionRequests: mocks.cancelAi,
}));
vi.mock("./session", () => ({ shutdownBrowserSession: mocks.closeBrowser }));
vi.mock("./cbg", () => ({ finishBrowserWorkflow: mocks.finishWorkflow }));

import { createLocalServiceShutdown, shutdownLocalService } from "./shutdown";
import { assertServiceOpen, resetServiceLifecycle } from "./service-lifecycle";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}
beforeEach(() => {
  resetServiceLifecycle();
  vi.resetAllMocks();
  mocks.stopSchedule.mockResolvedValue(undefined);
  mocks.stopAnalysis.mockResolvedValue(undefined);
  mocks.cancelAi.mockResolvedValue(undefined);
  mocks.closeAi.mockResolvedValue(undefined);
  mocks.closeBrowser.mockResolvedValue(undefined);
  mocks.finishWorkflow.mockResolvedValue(undefined);
});

it("先取消认证交互并并行暂停分析，等认证、采集和分析退出才关闭 AI 连接", async () => {
  const capture = deferred();
  const analysis = deferred();
  const cancellation = deferred();
  mocks.activity.mockReturnValue({ completion: capture.promise });
  mocks.stopAnalysis.mockReturnValue(analysis.promise);
  mocks.cancelAi.mockReturnValue(cancellation.promise);
  const shutdown = shutdownLocalService();
  expect(mocks.cancelAi.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.stopAnalysis.mock.invocationCallOrder[0],
  );
  expect(mocks.stopAnalysis).toHaveBeenCalledOnce();
  expect(mocks.stopSchedule.mock.invocationCallOrder[0]).toBeLessThan(
    mocks.stopCapture.mock.invocationCallOrder[0],
  );
  capture.resolve();
  await Promise.resolve();
  expect(mocks.closeAi).not.toHaveBeenCalled();
  analysis.resolve();
  await Promise.resolve();
  expect(mocks.closeAi).not.toHaveBeenCalled();
  cancellation.resolve();
  await shutdown;
  expect(mocks.stopCapture).toHaveBeenCalledOnce();
  expect(mocks.closeAi).toHaveBeenCalledOnce();
});

it("取消认证失败仍等待分析和采集退出并关闭 AI，随后保留取消错误", async () => {
  const capture = deferred();
  const analysis = deferred();
  const failure = new Error("取消登录失败");
  mocks.activity.mockReturnValue({ completion: capture.promise });
  mocks.stopAnalysis.mockReturnValue(analysis.promise);
  mocks.cancelAi.mockRejectedValue(failure);
  const result = shutdownLocalService().catch((error: unknown) => error);
  expect(mocks.stopSchedule).toHaveBeenCalledOnce();
  expect(mocks.stopCapture).toHaveBeenCalledOnce();
  expect(mocks.stopAnalysis).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(mocks.closeAi).not.toHaveBeenCalled();
  capture.resolve();
  analysis.resolve();
  const error = await result;
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([failure]);
  expect(mocks.closeAi).toHaveBeenCalledOnce();
});

it("一路关闭失败也等其他任务释放租约、清理 AI，然后报告失败", async () => {
  const capture = deferred();
  mocks.activity.mockReturnValue({ completion: capture.promise });
  const failure = new Error("分析退出失败");
  mocks.stopAnalysis.mockRejectedValue(failure);
  const shutdown = shutdownLocalService();
  const result = shutdown.catch((error: unknown) => error);
  await Promise.resolve();
  expect(mocks.closeAi).not.toHaveBeenCalled();
  capture.resolve();
  const error = await result;
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors).toEqual([failure]);
  expect(mocks.closeAi).toHaveBeenCalledOnce();
});

it("没有手动采集时也等待调度器退出并清理分析连接", async () => {
  const schedule = deferred();
  mocks.stopSchedule.mockReturnValue(schedule.promise);
  const shutdown = shutdownLocalService();
  await Promise.resolve();
  expect(mocks.closeAi).not.toHaveBeenCalled();
  schedule.resolve();
  await shutdown;
  expect(mocks.closeAi).toHaveBeenCalledOnce();
});

it("先阻止新请求，等待已接收请求退出后排空其晚启动的采集", async () => {
  const requests = deferred();
  const lateCapture = deferred();
  const shutdown = createLocalServiceShutdown(() => requests.promise);
  expect(shutdown.started).toBe(false);
  const closing = shutdown.close();
  expect(shutdown.started).toBe(true);
  expect(() => assertServiceOpen()).toThrow("本地服务正在关闭");
  expect(shutdown.close()).toBe(closing);
  await vi.waitFor(() => expect(mocks.closeAi).toHaveBeenCalledOnce());
  expect(mocks.activity).toHaveBeenCalledOnce();
  // 模拟已进入启动检查的 HTTP 请求在第一轮暂停之后创建采集任务。
  mocks.activity.mockReturnValue({ completion: lateCapture.promise });
  requests.resolve();
  await vi.waitFor(() => expect(mocks.stopCapture).toHaveBeenCalledTimes(2));
  expect(mocks.closeAi).toHaveBeenCalledOnce();
  lateCapture.resolve();
  await closing;
  expect(mocks.closeAi).toHaveBeenCalledTimes(2);
  expect(mocks.closeBrowser).toHaveBeenCalledOnce();
  expect(mocks.finishWorkflow).toHaveBeenCalledOnce();
  expect(mocks.closeBrowser.mock.invocationCallOrder[0]).toBeGreaterThan(
    mocks.closeAi.mock.invocationCallOrder[1],
  );
});

it("第一轮清理失败仍排空 HTTP 和晚启动任务，并向稳定入口保留失败", async () => {
  const requests = deferred();
  const failure = new Error("分析退出失败");
  mocks.stopAnalysis.mockRejectedValueOnce(failure);
  const shutdown = createLocalServiceShutdown(() => requests.promise);
  const closing = shutdown.close();
  const result = closing.catch((error: unknown) => error);
  await vi.waitFor(() => expect(mocks.closeAi).toHaveBeenCalledOnce());
  expect(mocks.stopCapture).toHaveBeenCalledOnce();
  requests.resolve();
  const error = await result;
  expect(mocks.stopCapture).toHaveBeenCalledTimes(2);
  expect(mocks.closeAi).toHaveBeenCalledTimes(2);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors[0].errors).toEqual([failure]);
  expect(shutdown.close()).toBe(closing);
});
