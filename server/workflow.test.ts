import { describe, expect, it, vi } from "vite-plus/test";
import type { Page } from "playwright-core";
import { clickInWorkPage, readStableSnapshot } from "./workflow";

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
