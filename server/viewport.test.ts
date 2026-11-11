import { expect, it, vi } from "vite-plus/test";
import type { Locator, Page } from "playwright-core";
import { clickForInspection, hoverForInspection } from "./viewport";

vi.mock("./inspection-input", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./inspection-input")>()),
  observeInspectionInput: vi.fn(async () => ({
    read: async () => ({ events: ["mousedown", "mouseup", "click"], clicked: true }),
    recover: vi.fn(),
    dispose: async () => {},
  })),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const clickPoint = { x: 50, y: 30, left: 0, top: 0, width: 100, height: 60 };
function clickTarget() {
  const mouse = {
    move: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
  };
  const page = { viewportSize: () => ({ width: 1440, height: 1080 }), mouse };
  const target = { page: () => page, evaluateAll: vi.fn().mockResolvedValue(clickPoint) };
  return { mouse, target, locator: target as unknown as Locator };
}

it.each([2, 6, 10])("%s 个页面的鼠标点击按调用顺序执行，同时最多执行一次", async (count) => {
  const entered = Array.from({ length: count }, deferred);
  const release = Array.from({ length: count }, deferred);
  const order: number[] = [];
  let active = 0;
  let maximum = 0;
  const targets = release.map((gate, index) => {
    const target = clickTarget();
    target.mouse.click.mockImplementation(async () => {
      order.push(index);
      maximum = Math.max(maximum, ++active);
      entered[index].resolve();
      await gate.promise;
      active--;
    });
    return target;
  });
  const clicks = targets.map(({ locator }) => clickForInspection(locator));
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
  targets.forEach(({ mouse }) => expect(mouse.click).toHaveBeenCalledOnce());
});

it("鼠标点击失败不重放，后续页面仍可点击", async () => {
  const error = new Error("页面已关闭");
  const failed = clickTarget(),
    next = clickTarget();
  failed.mouse.click.mockRejectedValue(error);
  const first = clickForInspection(failed.locator);
  const second = clickForInspection(next.locator);
  await expect(first).rejects.toBe(error);
  await second;
  expect(failed.mouse.click).toHaveBeenCalledOnce();
  expect(next.mouse.click).toHaveBeenCalledOnce();
});

it("排队期间取消的点击不再求值，也不阻塞后续点击", async () => {
  const entered = deferred(),
    release = deferred();
  const first = clickTarget(),
    canceled = clickTarget(),
    next = clickTarget();
  first.mouse.click.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
  });
  const controller = new AbortController();
  const error = new Error("已停止采集");
  const running = clickForInspection(first.locator);
  await entered.promise;
  const pending = clickForInspection(canceled.locator, controller.signal);
  const last = clickForInspection(next.locator);
  const rejection = expect(pending).rejects.toBe(error);
  controller.abort(error);
  release.resolve();
  await Promise.all([running, rejection, last]);
  expect(canceled.target.evaluateAll).not.toHaveBeenCalled();
  expect(canceled.mouse.click).not.toHaveBeenCalled();
  expect(next.mouse.click).toHaveBeenCalledOnce();
});

it("定位校验失败时不发送鼠标输入", async () => {
  const target = clickTarget();
  target.target.evaluateAll.mockResolvedValue(null);
  await expect(clickForInspection(target.locator)).rejects.toMatchObject({
    name: "IncompleteDetailError",
  });
  expect(target.mouse.move).not.toHaveBeenCalled();
  expect(target.mouse.click).not.toHaveBeenCalled();
});

it("鼠标移入导致目标改变时不点击", async () => {
  const target = clickTarget();
  target.target.evaluateAll
    .mockResolvedValueOnce(clickPoint)
    .mockResolvedValueOnce(clickPoint)
    .mockResolvedValueOnce(null);
  await expect(clickForInspection(target.locator)).rejects.toMatchObject({
    name: "IncompleteDetailError",
  });
  expect(target.mouse.move).toHaveBeenCalledWith(50, 30);
  expect(target.mouse.click).not.toHaveBeenCalled();
});

it("稳定等待期间取消的点击不再发送鼠标输入", async () => {
  const target = clickTarget();
  const controller = new AbortController();
  const reason = new Error("暂停");
  target.target.evaluateAll.mockImplementation(async () => {
    controller.abort(reason);
    return clickPoint;
  });
  await expect(clickForInspection(target.locator, controller.signal)).rejects.toBe(reason);
  expect(target.mouse.click).not.toHaveBeenCalled();
});

it("点击后的业务等待不占住全局点击队列", async () => {
  const waiting = deferred(),
    release = deferred();
  let completed = false;
  const first = clickTarget(),
    next = clickTarget();
  const capture = (async () => {
    await clickForInspection(first.locator);
    waiting.resolve();
    await release.promise;
    completed = true;
  })();
  await waiting.promise;
  try {
    await clickForInspection(next.locator);
    expect(next.mouse.click).toHaveBeenCalledOnce();
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
