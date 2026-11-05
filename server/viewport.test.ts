import { expect, it, vi } from "vite-plus/test";
import type { Locator, Page } from "playwright-core";
import { hoverForInspection } from "./viewport";

const timeout = () =>
  Object.assign(
    new Error(
      "locator.hover: Timeout 5000ms exceeded.\n  element is visible and stable\n  performing hover action",
    ),
    { name: "TimeoutError" },
  );
function setup() {
  const page = {
    viewportSize: () => ({ width: 1440, height: 1080 }),
    isClosed: vi.fn().mockReturnValue(false),
    setViewportSize: vi.fn(),
    mouse: { move: vi.fn() },
    evaluate: vi.fn().mockResolvedValue(1440),
  };
  const element = { evaluateAll: vi.fn(), hover: vi.fn().mockResolvedValue(undefined) };
  const recovered = vi.fn();
  return {
    page,
    element,
    recovered,
    run: () =>
      hoverForInspection(page as unknown as Page, element as unknown as Locator, recovered),
  };
}

const point = { x: 10, y: 10, width: 20, height: 20 };
it("鼠标动作超时后验证DOM并执行一次原生移动，不重复同一hover", async () => {
  const x = setup();
  x.element.hover.mockRejectedValueOnce(timeout());
  x.element.evaluateAll
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(point)
    .mockResolvedValueOnce(point)
    .mockResolvedValueOnce(true);
  await x.run();
  expect(x.element.hover).toHaveBeenCalledTimes(1);
  expect(x.page.mouse.move).toHaveBeenCalledTimes(2);
  expect(x.page.mouse.move).toHaveBeenLastCalledWith(point.x, point.y);
  expect(x.recovered).toHaveBeenCalledWith("pointer");
});

it.each(["missing", "moving", "intercepted-after-move", "closed"])(
  "鼠标恢复无法确认目标时保留原错误，不能重复hover：%s",
  async (kind) => {
    const x = setup();
    const error = timeout();
    x.element.hover.mockRejectedValue(error);
    x.page.isClosed.mockReturnValue(kind === "closed");
    x.element.evaluateAll
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(kind === "missing" ? null : point)
      .mockResolvedValueOnce(kind === "moving" ? { ...point, x: 11 } : point)
      .mockResolvedValueOnce(false);
    await expect(x.run()).rejects.toBe(error);
    expect(x.element.hover).toHaveBeenCalledTimes(1);
    expect(x.recovered).not.toHaveBeenCalled();
    expect(x.page.mouse.move).toHaveBeenCalledTimes(kind === "intercepted-after-move" ? 2 : 1);
  },
);

it.each([
  "locator.hover: Timeout 5000ms exceeded. waiting for element to be visible and stable",
  "locator.hover: Timeout 5000ms exceeded. dialog intercepts pointer events",
  "locator.hover: Target page, context or browser has been closed",
])("不重试遮罩、不可见或页面关闭错误：%s", async (message) => {
  const x = setup();
  x.element.hover.mockRejectedValue(Object.assign(new Error(message), { name: "TimeoutError" }));
  await expect(x.run()).rejects.toThrow(message);
  expect(x.element.hover).toHaveBeenCalledTimes(1);
});

it.each([
  "Element is outside of the viewport",
  "locator.hover: Timeout 5000ms exceeded. performing hover action: outside of the viewport",
])("视口越界仍按原有方式修正后只重试一次：%s", async (message) => {
  const x = setup();
  x.element.hover.mockRejectedValueOnce(
    Object.assign(new Error(message), { name: "TimeoutError" }),
  );
  await x.run();
  expect(x.page.setViewportSize).toHaveBeenCalledWith({ width: 1440, height: 1080 });
  expect(x.element.hover).toHaveBeenCalledTimes(2);
});

it("已经完成鼠标动作后的异常不重复移动或当作恢复成功", async () => {
  const x = setup();
  const error = Object.assign(
    new Error("locator.hover: performing hover action\nhover action done"),
    {
      name: "TimeoutError",
    },
  );
  x.element.hover.mockRejectedValueOnce(error);
  await expect(x.run()).rejects.toBe(error);
  expect(x.element.hover).toHaveBeenCalledOnce();
  expect(x.page.mouse.move).toHaveBeenCalledTimes(1);
  expect(x.recovered).not.toHaveBeenCalled();
});

it("可见性等待超时后几何仍变化，不能把悬停当作成功", async () => {
  const x = setup();
  x.element.hover.mockRejectedValue(
    Object.assign(
      new Error(
        "locator.hover: Timeout 5000ms exceeded. waiting for element to be visible and stable",
      ),
      { name: "TimeoutError" },
    ),
  );
  x.element.evaluateAll
    .mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce({ x: 10, y: 10, width: 20, height: 20 })
    .mockResolvedValueOnce({ x: 11, y: 10, width: 20, height: 20 });
  await expect(x.run()).rejects.toThrow("visible and stable");
  expect(x.page.mouse.move).toHaveBeenCalledTimes(1);
  expect(x.page.mouse.move).toHaveBeenCalledWith(1, 1);
});
