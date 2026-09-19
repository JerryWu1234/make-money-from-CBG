import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { disconnectedState } from "./page-state";

const mocks = vi.hoisted(() => ({
  getBrowser: vi.fn(),
  createBackgroundPage: vi.fn(),
  getCbgPage: vi.fn(),
  runFixedWorkflow: vi.fn(),
  readStableSnapshot: vi.fn(),
  record: vi.fn(),
}));
vi.mock("./session", () => mocks);
vi.mock("./diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./diagnostics")>()),
  diagnostics: { record: mocks.record },
  watchWorkPage: vi.fn(),
}));
vi.mock("./workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workflow")>()),
  ...mocks,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("后台流程与状态查询", () => {
  it("扫码未完成时开始接口立即返回，轮询不阻塞、重复开始不再建窗口", async () => {
    const { openCbg, checkCbgStatus } = await import("./cbg");
    let finish!: (value: ReturnType<typeof disconnectedState>) => void;
    mocks.getBrowser.mockResolvedValue({});
    mocks.createBackgroundPage.mockResolvedValue({});
    mocks.runFixedWorkflow.mockImplementation(async (_page, publish) => {
      publish({
        ...disconnectedState("请扫码"),
        connected: true,
        workflowStep: "logging_in",
        running: true,
        qrCodeUrl: "data:image/png;base64,test",
      });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    expect(openCbg()).toMatchObject({ running: true, workflowStep: "connecting" });
    await vi.waitFor(() => expect(mocks.runFixedWorkflow).toHaveBeenCalledOnce());
    expect(await checkCbgStatus()).toMatchObject({
      running: true,
      qrCodeUrl: "data:image/png;base64,test",
    });
    expect(openCbg().running).toBe(true);
    expect(mocks.getBrowser).toHaveBeenCalledOnce();
    finish(disconnectedState("已完成测试"));
  });
  it("错误保留原步骤编号，轮询不会覆盖；重试能恢复", async () => {
    const { openCbg, checkCbgStatus } = await import("./cbg");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getBrowser.mockResolvedValue({});
    mocks.createBackgroundPage.mockResolvedValue({});
    mocks.runFixedWorkflow.mockImplementation(async (_page, publish) => {
      publish({ workflowStep: "server_age" });
      throw new Error("筛选条件未生效");
    });
    openCbg();
    await vi.waitFor(async () => expect((await checkCbgStatus()).workflowStep).toBe("error"));
    expect(await checkCbgStatus()).toMatchObject({
      running: false,
      error: { code: "CBG_SERVER_AGE", message: "筛选条件未生效" },
    });
    expect(mocks.record).toHaveBeenCalledWith(
      "workflow.error",
      expect.objectContaining({
        code: "CBG_SERVER_AGE",
        error: expect.any(Error),
        durationMs: expect.any(Number),
      }),
    );
    const recorded = mocks.record.mock.calls.length;
    expect(await checkCbgStatus()).toMatchObject({ error: { code: "CBG_SERVER_AGE" } });
    expect(mocks.record).toHaveBeenCalledTimes(recorded);
    mocks.runFixedWorkflow.mockResolvedValue({
      ...disconnectedState("重新开始成功"),
      workflowStep: "idle",
    });
    expect(openCbg()).toMatchObject({ workflowStep: "connecting", running: true });
    await vi.waitFor(async () => expect((await checkCbgStatus()).message).toBe("重新开始成功"));
    expect((await checkCbgStatus()).error).toBeUndefined();
    log.mockRestore();
  });
});
