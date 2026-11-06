import { expect, it, vi } from "vite-plus/test";
import type { Locator, Page } from "playwright-core";
import { clickForInspection, hoverForInspection } from "./viewport";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([2, 6, 10])("%s 个页面的点击按调用顺序执行，同时最多执行一次", async (count) => {
  const entered = Array.from({ length: count }, deferred);
  const release = Array.from({ length: count }, deferred);
  const order: number[] = [];
  let active = 0;
  let maximum = 0;
  const targets = release.map((gate, index) => ({
    evaluateAll: vi.fn(async () => {
      order.push(index);
      maximum = Math.max(maximum, ++active);
      entered[index].resolve();
      await gate.promise;
      active--;
      return true;
    }),
  }));
  const clicks = targets.map((target) => clickForInspection(target as unknown as Locator));
  try {
    for (let index = 0; index < targets.length; index++) {
      await entered[index].promise;
      expect(order).toEqual(Array.from({ length: index + 1 }, (_, value) => value));
      expect(active).toBe(1);
      release[index].resolve();
    }
  } finally {
    release.forEach((gate) => gate.resolve());
    await Promise.all(clicks);
  }
  expect(maximum).toBe(1);
  targets.forEach((target) => expect(target.evaluateAll).toHaveBeenCalledOnce());
});

it("点击失败保留原错误，后续点击仍可执行", async () => {
  const error = new Error("页面已关闭");
  const failed = { evaluateAll: vi.fn().mockRejectedValue(error) };
  const next = { evaluateAll: vi.fn().mockResolvedValue(true) };
  const first = clickForInspection(failed as unknown as Locator);
  const second = clickForInspection(next as unknown as Locator);
  await expect(first).rejects.toBe(error);
  await second;
  expect(next.evaluateAll).toHaveBeenCalledOnce();
});

it("排队期间取消的点击不再求值，也不阻塞后续点击", async () => {
  const entered = deferred();
  const release = deferred();
  const first = {
    evaluateAll: vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return true;
    }),
  };
  const canceled = { evaluateAll: vi.fn().mockResolvedValue(true) };
  const next = { evaluateAll: vi.fn().mockResolvedValue(true) };
  const controller = new AbortController();
  const error = new Error("已停止采集");
  const running = clickForInspection(first as unknown as Locator);
  await entered.promise;
  const pending = clickForInspection(canceled as unknown as Locator, controller.signal);
  const last = clickForInspection(next as unknown as Locator);
  const rejection = expect(pending).rejects.toBe(error);
  controller.abort(error);
  release.resolve();
  await Promise.all([running, rejection, last]);
  expect(canceled.evaluateAll).not.toHaveBeenCalled();
  expect(next.evaluateAll).toHaveBeenCalledOnce();
});

it.each([0, 2])("点击目标数量为 %s 时保留原校验和错误，不点击任何目标", async (count) => {
  const click = vi.fn();
  const target = {
    evaluateAll: vi.fn((evaluate: (elements: Element[]) => boolean) =>
      evaluate(Array.from({ length: count }, () => ({ click }) as unknown as Element)),
    ),
  };
  await expect(clickForInspection(target as unknown as Locator)).rejects.toMatchObject({
    name: "IncompleteDetailError",
    message: "待读取标签或分页目标已变化，未执行点击",
  });
  expect(click).not.toHaveBeenCalled();
});

it("唯一点击目标仍执行一次点击", async () => {
  const click = vi.fn();
  const target = {
    evaluateAll: vi.fn((evaluate: (elements: Element[]) => boolean) =>
      evaluate([{ click } as unknown as Element]),
    ),
  };
  await clickForInspection(target as unknown as Locator);
  expect(click).toHaveBeenCalledOnce();
});

it("点击后的业务等待不占住全局点击队列", async () => {
  const waiting = deferred();
  const release = deferred();
  let completed = false;
  const first = { evaluateAll: vi.fn().mockResolvedValue(true) };
  const next = { evaluateAll: vi.fn().mockResolvedValue(true) };
  const capture = (async () => {
    await clickForInspection(first as unknown as Locator);
    waiting.resolve();
    await release.promise;
    completed = true;
  })();
  await waiting.promise;
  try {
    await clickForInspection(next as unknown as Locator);
    expect(next.evaluateAll).toHaveBeenCalledOnce();
    expect(completed).toBe(false);
  } finally {
    release.resolve();
    await capture;
  }
});

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
