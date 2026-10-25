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
    setViewportSize: vi.fn(),
    mouse: { move: vi.fn() },
    evaluate: vi.fn().mockResolvedValue(1440),
  };
  const element = { evaluateAll: vi.fn(), hover: vi.fn().mockResolvedValue(undefined) };
  return {
    page,
    element,
    run: () => hoverForInspection(page as unknown as Page, element as unknown as Locator),
  };
}

it("可见性检查已通过后的偶发鼠标动作超时，仅重试一次", async () => {
  const x = setup();
  x.element.hover.mockRejectedValueOnce(timeout());
  await x.run();
  expect(x.element.hover).toHaveBeenCalledTimes(2);
  expect(x.element.hover).toHaveBeenLastCalledWith({ timeout: 5000 });
});

it("鼠标动作持续超时仍向上报告，不能无限重试或当作成功", async () => {
  const x = setup();
  x.element.hover.mockRejectedValue(timeout());
  await expect(x.run()).rejects.toThrow("performing hover action");
  expect(x.element.hover).toHaveBeenCalledTimes(2);
});

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

it("视口越界仍按原有方式修正后只重试一次", async () => {
  const x = setup();
  x.element.hover.mockRejectedValueOnce(new Error("Element is outside of the viewport"));
  await x.run();
  expect(x.page.setViewportSize).toHaveBeenCalledWith({ width: 1440, height: 1080 });
  expect(x.element.hover).toHaveBeenCalledTimes(2);
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
