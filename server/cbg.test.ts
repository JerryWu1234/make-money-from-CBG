import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildPageState, disconnectedState, type PageSnapshot } from "./page-state";

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
  Reflect.deleteProperty(globalThis, Symbol.for("cbg.workflow-state.v1"));
  vi.resetModules();
  vi.clearAllMocks();
  const page = { isClosed: () => false };
  mocks.getBrowser.mockResolvedValue({});
  mocks.getCbgPage.mockReturnValue(page);
  mocks.createBackgroundPage.mockResolvedValue(page);
  mocks.readStableSnapshot.mockResolvedValue(snapshot);
  mocks.runFixedWorkflow.mockImplementation(async () => completed());
});
afterEach(() => {
  Reflect.deleteProperty(globalThis, Symbol.for("cbg.workflow-state.v1"));
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

// All browser operations are mocked; this fixture never contacts the target site.
const snapshot: PageSnapshot = {
  url: "https://xyq.cbg.163.com/cgi-bin/equipquery.py?act=show_overall_search_role",
  title: "模拟角色列表",
  ready: true,
  serverAuthenticated: true,
  hasLogout: true,
  hasLogin: false,
  hasQr: false,
  hasRoles: false,
  hasDialog: false,
  serverName: "模拟区服",
};
const completed = () => ({
  ...buildPageState(snapshot),
  running: false,
  workflowStep: "completed" as const,
  message: "模拟列表已就绪",
});

const finishWorkflow = async () => {
  const first = await import("./cbg");
  first.openCbg();
  await vi.waitFor(async () => {
    expect(await first.checkCbgStatus()).toMatchObject({
      workflowStep: "completed",
      isLoggedIn: true,
    });
  });
  return first;
};

describe("开发服务重载后的流程复用", () => {
  it("切换后晚到的旧状态不能回填旧账号或角色列表", async () => {
    const workflow = await finishWorkflow();
    let finish!: (value: PageSnapshot) => void;
    mocks.readStableSnapshot.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const reading = workflow.checkCbgStatus();
    workflow.resetBrowserWorkflow();
    finish(snapshot);
    expect(await reading).toMatchObject({ workflowStep: "idle", isLoggedIn: false });
    expect((await workflow.checkCbgStatus()).roleList).toBeUndefined();
  });

  it("旧状态读取失败不能覆盖切换后新开始的查询", async () => {
    const workflow = await finishWorkflow();
    let reject!: (error: Error) => void;
    mocks.readStableSnapshot.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const reading = workflow.checkCbgStatus();
    workflow.resetBrowserWorkflow();
    let finish!: (value: ReturnType<typeof completed>) => void;
    mocks.runFixedWorkflow.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    workflow.openCbg();
    reject(new Error("旧工作页已关闭"));
    expect(await reading).toMatchObject({ workflowStep: "connecting", running: true });
    await vi.waitFor(() => expect(mocks.runFixedWorkflow).toHaveBeenCalledTimes(2));
    finish(completed());
    await workflow.finishBrowserWorkflow();
    expect(await workflow.checkCbgStatus()).toMatchObject({
      workflowStep: "completed",
      isLoggedIn: true,
    });
  });

  it("已登录的角色列表保留状态，轮询不重新执行登录流程", async () => {
    await finishWorkflow();
    vi.resetModules();
    const reloaded = await import("./cbg");
    expect(await reloaded.checkCbgStatus()).toMatchObject({
      workflowStep: "completed",
      isLoggedIn: true,
      message: "模拟列表已就绪",
    });
    expect(mocks.getBrowser).toHaveBeenCalledOnce();
    expect(mocks.createBackgroundPage).toHaveBeenCalledOnce();
    expect(mocks.runFixedWorkflow).toHaveBeenCalledOnce();
    expect(mocks.readStableSnapshot).toHaveBeenCalled();
  });
  it("扫码或确认正在进行时重载继续原流程，不创建第二个工作页", async () => {
    let finish!: (value: ReturnType<typeof completed>) => void;
    mocks.runFixedWorkflow.mockImplementation((_page, publish) => {
      publish({ ...completed(), workflowStep: "logging_in", running: true, isLoggedIn: false });
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const first = await import("./cbg");
    first.openCbg();
    await vi.waitFor(() => expect(mocks.runFixedWorkflow).toHaveBeenCalledOnce());
    vi.resetModules();
    const reloaded = await import("./cbg");
    try {
      expect(reloaded.openCbg()).toMatchObject({ workflowStep: "logging_in", running: true });
      expect(await reloaded.checkCbgStatus()).toMatchObject({ workflowStep: "logging_in" });
      expect(mocks.createBackgroundPage).toHaveBeenCalledOnce();
      expect(mocks.runFixedWorkflow).toHaveBeenCalledOnce();
    } finally {
      finish(completed());
    }
    await vi.waitFor(async () => {
      expect(await reloaded.checkCbgStatus()).toMatchObject({
        workflowStep: "completed",
        isLoggedIn: true,
      });
    });
  });
  it("复用后仍重新检查真实登录，失效时保留登录失效提示", async () => {
    await finishWorkflow();
    vi.resetModules();
    const reloaded = await import("./cbg");
    mocks.readStableSnapshot.mockResolvedValue({
      ...snapshot,
      serverAuthenticated: false,
      hasLogin: true,
    });
    expect(await reloaded.checkCbgStatus()).toMatchObject({
      workflowStep: "idle",
      isLoggedIn: false,
      message: "登录已失效，请重新开始。",
    });
    expect(mocks.getBrowser).toHaveBeenCalledOnce();
  });
  it("自有工作页确实关闭后显示未连接，不继续展示已登录", async () => {
    await finishWorkflow();
    vi.resetModules();
    const reloaded = await import("./cbg");
    mocks.getCbgPage.mockReturnValue(null);
    expect(await reloaded.checkCbgStatus()).toMatchObject({
      workflowStep: "idle",
      isLoggedIn: false,
      message: "后台工作页已关闭，请重新开始。",
    });
    expect(mocks.runFixedWorkflow).toHaveBeenCalledOnce();
  });
});
