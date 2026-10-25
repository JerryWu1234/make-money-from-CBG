import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import { clickInWorkPage, completeLogin, readStableSnapshot, runFixedWorkflow } from "./workflow";
import { captureBrowserStep } from "./browser-evidence";

vi.mock("./browser-evidence", () => ({ captureBrowserStep: vi.fn().mockResolvedValue(undefined) }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

// 跳转已经发生时不重放点击，也不把短暂的旧执行上下文错误当成登录失败。
describe("登录跳转恢复", () => {
  it("等待新页面上下文后重新读取", async () => {
    const evaluate = vi
      .fn()
      .mockRejectedValueOnce(
        new Error("Execution context was destroyed, most likely because of a navigation"),
      )
      .mockResolvedValue({ ready: true, serverAuthenticated: true });
    const page = { evaluate, isClosed: () => false } as unknown as Page;
    await expect(readStableSnapshot(page)).resolves.toMatchObject({ serverAuthenticated: true });
    expect(evaluate).toHaveBeenCalledTimes(2);
  });
  it("真实页面错误立即返回，不无限重试", async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error("Cannot read properties of undefined"));
    await expect(
      readStableSnapshot({ evaluate, isClosed: () => false } as unknown as Page),
    ).rejects.toThrow("Cannot read properties");
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it("点击触发页面跳转后，不重复提交角色", async () => {
    const evaluate = vi.fn().mockRejectedValue(new Error("Execution context was destroyed"));
    const element = { waitFor: vi.fn(), evaluate };
    const page = { locator: () => ({ first: () => element }) } as unknown as Page;
    await expect(clickInWorkPage(page, "#login_btn")).resolves.toBeUndefined();
    expect(evaluate).toHaveBeenCalledOnce();
  });
  it("按钮未出现的超时保留为错误", async () => {
    const page = {
      locator: () => ({
        first: () => ({
          waitFor: vi.fn().mockRejectedValue(new Error("Timeout 30000ms exceeded")),
        }),
      }),
    } as unknown as Page;
    await expect(clickInWorkPage(page, "#login_btn")).rejects.toThrow("Timeout");
  });
});

describe("业务步骤截图", () => {
  const loggedIn = {
    url: "https://xyq.cbg.163.com/cgi-bin/xyq_overall_search.py",
    title: "藏宝阁",
    ready: true,
    hasLogout: true,
    serverAuthenticated: true,
    hasLogin: false,
    hasQr: false,
    hasRoles: false,
    hasDialog: false,
    serverName: "测试服务器",
  };
  it("在页面打开、查询条件完成和列表读取完成后依次留痕", async () => {
    const roleList = { rows: [["角色"]], columns: ["名称"], serverAge: "3年以上服" };
    const evaluate = vi
      .fn()
      .mockResolvedValueOnce(loggedIn)
      .mockResolvedValueOnce(roleList)
      .mockResolvedValueOnce(loggedIn);
    const element = {
      waitFor: vi.fn(),
      evaluate: vi.fn().mockResolvedValue(true),
      isVisible: vi.fn().mockResolvedValue(true),
    };
    const locator = {
      ...element,
      first: () => element,
      filter: () => locator,
      all: async () => [],
    };
    const page = {
      goto: vi.fn(),
      locator: () => locator,
      evaluate,
      waitForFunction: vi.fn(),
    } as unknown as Page;
    await expect(runFixedWorkflow(page, vi.fn())).resolves.toMatchObject({
      workflowStep: "completed",
      roleList,
    });
    expect(vi.mocked(captureBrowserStep).mock.calls.map((call) => call[1].stage)).toEqual([
      "跨服购买页面读取完成",
      "开服时间选择完成",
      "角色搜索页面打开完成",
      "角色搜索条件准备完成",
      "角色查询列表读取完成",
    ]);
    expect(evaluate.mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(captureBrowserStep).mock.invocationCallOrder.at(-1)!,
    );
  });
  it("页面打开失败记录当前流程和原错误，保持原始异常", async () => {
    const error = new Error("页面打开超时");
    const page = { goto: vi.fn().mockRejectedValue(error) } as unknown as Page;
    await expect(runFixedWorkflow(page, vi.fn())).rejects.toBe(error);
    expect(captureBrowserStep).toHaveBeenCalledWith(page, {
      flow: "query",
      stage: "logging_in失败",
      error,
    });
  });
  it("二维码显示与登录完成均留痕，相同轮询状态不重复截图", async () => {
    vi.useFakeTimers();
    const qr = {
      ...loggedIn,
      hasLogout: false,
      serverAuthenticated: false,
      hasLogin: true,
      hasQr: true,
    };
    const page = {
      evaluate: vi
        .fn()
        .mockResolvedValueOnce(qr)
        .mockResolvedValueOnce(qr)
        .mockResolvedValueOnce(loggedIn),
    } as unknown as Page;
    const pending = completeLogin(page, vi.fn());
    await vi.advanceTimersByTimeAsync(1500);
    await pending;
    expect(captureBrowserStep).toHaveBeenCalledTimes(2);
    expect(captureBrowserStep).toHaveBeenCalledWith(
      page,
      expect.objectContaining({
        flow: "query",
        stage: expect.stringContaining("登录页面读取完成"),
      }),
    );
  });
});
