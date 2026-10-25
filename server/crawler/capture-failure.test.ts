import type { Page } from "playwright-core";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { saveCaptureFailure } from "./capture-failure";
import { captureBrowserStep } from "../browser-evidence";

vi.mock("../browser-evidence", () => ({
  captureBrowserStep: vi.fn().mockResolvedValue(undefined),
}));
beforeEach(() => vi.clearAllMocks());
const page = {} as Page;
const context = { key: "367:abc", attempt: 2, stage: "正在读取坐骑" };

it("原错误及重读阶段交给公共截图时间线，不另建日志目录", async () => {
  const signal = new AbortController().signal;
  const error = new Error("坐骑读取超时");
  const log = vi.fn();
  await saveCaptureFailure(page, signal, { ...context, error }, log);
  expect(captureBrowserStep).toHaveBeenCalledWith(
    page,
    {
      flow: "collection",
      key: context.key,
      stage: "正在读取坐骑：第 2 次读取失败",
      error,
    },
    signal,
  );
  expect(log).toHaveBeenCalledWith("detail.capture_failure", { ...context, error });
});

it("完整性缺项也转换为错误现场，暂停时不截屏", async () => {
  const signal = new AbortController().signal;
  await saveCaptureFailure(page, signal, { ...context, issues: ["来源身份缺失"] }, vi.fn());
  expect(captureBrowserStep).toHaveBeenCalledWith(
    page,
    expect.objectContaining({
      error: expect.objectContaining({ message: "来源身份缺失" }),
    }),
    signal,
  );
  vi.clearAllMocks();
  const control = new AbortController();
  control.abort();
  await saveCaptureFailure(page, control.signal, context, vi.fn());
  expect(captureBrowserStep).not.toHaveBeenCalled();
});
