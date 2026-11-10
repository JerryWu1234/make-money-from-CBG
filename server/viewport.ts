import type { Locator, Page } from "playwright-core";
import { collectionPageSignal } from "./crawler/login-dialog";

const WORK_VIEWPORT = { width: 1440, height: 1080 };
let inspectionClickTail = Promise.resolve();
// CDP 连接日常浏览器时没有 Playwright 默认视口；隐藏 target 可能是 0×0。
// 只调整本程序的隐藏页，不调整用户的浏览器窗口。
export async function ensureWorkViewport(page: Page) {
  const configured = page.viewportSize();
  if (
    !configured ||
    configured.width < WORK_VIEWPORT.width ||
    configured.height < WORK_VIEWPORT.height
  ) {
    await page.setViewportSize(WORK_VIEWPORT);
  }
}
/** Check the target in the main world, then send browser mouse input without a node handle. */
export async function clickForInspection(element: Locator, signal?: AbortSignal) {
  const page = element.page();
  const collectionSignal = collectionPageSignal(page);
  const check = () => {
    signal?.throwIfAborted();
    collectionSignal?.throwIfAborted();
  };
  // Keep page loading and data reads outside this shared click queue.
  const click = inspectionClickTail.then(async () => {
    check();
    await ensureWorkViewport(page);
    check();
    const token = `${Date.now()}:${Math.random()}`;
    const point = (mark: boolean) =>
      element.evaluateAll(
        (elements, { token, mark }) => {
          if (elements.length !== 1) return null;
          const el = elements[0];
          const marker = Symbol.for("cbg.inspection-click-target");
          if (
            !el.isConnected ||
            !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
            el.closest(':disabled, [aria-disabled="true"], [inert]')
          )
            return null;
          if (mark) {
            Reflect.set(el, marker, token);
            el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          } else if (Reflect.get(el, marker) !== token) return null;
          const rect = el.getBoundingClientRect();
          const left = Math.max(0, rect.left),
            right = Math.min(window.innerWidth, rect.right),
            top = Math.max(0, rect.top),
            bottom = Math.min(window.innerHeight, rect.bottom);
          if (right <= left || bottom <= top) return null;
          const x = (left + right) / 2,
            y = (top + bottom) / 2;
          if (!el.contains(document.elementFromPoint(x, y))) return null;
          return { x, y, left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        },
        { token, mark },
      );
    const changed = () =>
      Object.assign(new Error("待读取标签或分页目标不可点击或已变化，未执行点击"), {
        name: "IncompleteDetailError",
      });
    const before = await point(true);
    if (!before) throw changed();
    await new Promise((resolve) => setTimeout(resolve, 100));
    check();
    const stable = await point(false);
    check();
    if (!stable || JSON.stringify(before) !== JSON.stringify(stable)) throw changed();
    await page.mouse.move(stable.x, stable.y);
    check();
    const afterHover = await point(false);
    if (!afterHover || JSON.stringify(stable) !== JSON.stringify(afterHover)) throw changed();
    check();
    // A failure after input may already have changed the page: never replay the click here.
    await page.mouse.click(afterHover.x, afterHover.y);
  });
  inspectionClickTail = click.then(
    () => {},
    () => {},
  );
  await click;
}
export async function hoverForInspection(
  page: Page,
  element: Locator,
  recoveredActionability?: (stage: "scroll" | "visibility" | "handle" | "pointer") => void,
) {
  const signal = collectionPageSignal(page);
  signal?.throwIfAborted();
  await ensureWorkViewport(page);
  signal?.throwIfAborted();
  // 移出上一个图标，触发网站自己的 mouseout；仅让提示框不拦截后续鼠标。
  // 不隐藏提示内容，不对验证码、登录框或其他遮罩使用 force。
  await page.mouse.move(1, 1);
  signal?.throwIfAborted();
  await page.evaluate(() => {
    const boxes = new Set<Element>(document.querySelectorAll('[role="tooltip"], [id$="TipsBox"]'));
    for (const el of document.querySelectorAll("[data_tip_box], [data-tip-box]")) {
      const id = el.getAttribute("data_tip_box") || el.getAttribute("data-tip-box");
      const box = id && document.getElementById(id);
      if (box) boxes.add(box);
    }
    for (const box of boxes) {
      box.setAttribute("data-cbg-hover-tip", "true");
    }
    if (!document.getElementById("cbg-hover-style")) {
      const style = document.createElement("style");
      style.id = "cbg-hover-style";
      style.textContent =
        '[data-cbg-hover-tip], [data-cbg-hover-tip] *, [id$="TipsBox"], [id$="TipsBox"] * { pointer-events: none !important; }';
      document.head.appendChild(style);
    }
  });
  // Locator.evaluate 会先把节点从隔离上下文转换到主上下文，额外等待
  // DOM.resolveNode；受控复现中，节点已可见仍会卡在这一步。
  // evaluateAll 在主上下文按当前定位器求值，不传回单个元素句柄。
  // 节点已消失时交给下面的原生 hover 正常定位，不能把滚动成功当作悬停成功。
  signal?.throwIfAborted();
  await element.evaluateAll((elements) => {
    if (elements.length > 1) throw new Error("待悬停目标不唯一，已停止以免读取错误商品");
    elements[0]?.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  });
  signal?.throwIfAborted();
  try {
    await element.hover({ timeout: 5000 });
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if (!(error instanceof Error)) throw error;
    const pointerTimeout =
      error.name === "TimeoutError" &&
      error.message.includes("performing hover action") &&
      !error.message.includes("outside of the viewport") &&
      !error.message.includes("hover action done");
    const actionabilityTimeout =
      error.name === "TimeoutError" &&
      (error.message.includes("waiting for element to be visible and stable") ||
        (error.message.includes("element is visible and stable") &&
          error.message.includes("scrolling into view if needed"))) &&
      !error.message.includes("performing hover action");
    const handleTimeout =
      error.name === "TimeoutError" &&
      error.message.startsWith("locator.hover:") &&
      error.message.includes("locator resolved to") &&
      !/attempting hover action|waiting for element|visible and stable|not visible|not stable|intercepts pointer events|performing hover action|hover action done|scrolling into view if needed/.test(
        error.message,
      );
    if (actionabilityTimeout || handleTimeout || pointerTimeout) {
      if (page.isClosed()) throw error;
      // 原生 hover 可能停在已解析节点后的句柄读取或鼠标动作阶段。
      // 不重新请求句柄；先核对当前 DOM 的可见性、
      // 稳定几何和鼠标命中，再发一次原生鼠标动作；真实遮挡或不可见仍然失败。
      const token = `${Date.now()}:${Math.random()}`;
      const point = (mark: boolean) =>
        element.evaluateAll(
          (elements, { token, mark }) => {
            if (elements.length !== 1) return null;
            const el = elements[0];
            const marker = Symbol.for("cbg.inspection-hover-target");
            if (mark) Reflect.set(el, marker, token);
            else if (Reflect.get(el, marker) !== token) return null;
            if (
              !el.isConnected ||
              !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            )
              return null;
            const rect = el.getBoundingClientRect();
            const left = Math.max(0, rect.left),
              right = Math.min(window.innerWidth, rect.right),
              top = Math.max(0, rect.top),
              bottom = Math.min(window.innerHeight, rect.bottom);
            if (right <= left || bottom <= top) return null;
            const x = (left + right) / 2,
              y = (top + bottom) / 2;
            if (!el.contains(document.elementFromPoint(x, y))) return null;
            return { x, y, width: rect.width, height: rect.height };
          },
          { token, mark },
        );
      const before = await point(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      signal?.throwIfAborted();
      const after = await point(false);
      signal?.throwIfAborted();
      if (!before || !after || JSON.stringify(before) !== JSON.stringify(after)) throw error;
      await page.mouse.move(after.x, after.y);
      signal?.throwIfAborted();
      if (
        !(await element.evaluateAll(
          (elements, { x, y, token }) =>
            elements.length === 1 &&
            elements[0].isConnected &&
            Reflect.get(elements[0], Symbol.for("cbg.inspection-hover-target")) === token &&
            elements[0].contains(document.elementFromPoint(x, y)),
          { ...after, token },
        ))
      )
        throw error;
      recoveredActionability?.(
        pointerTimeout
          ? "pointer"
          : handleTimeout
            ? "handle"
            : error.message.includes("scrolling into view if needed")
              ? "scroll"
              : "visibility",
      );
      return;
    }
    const outside = error.message.includes("outside of the viewport");
    if (!outside) throw error;
    // 老工作页或网站固定宽度布局可能使可视区域与文档不同步，重新设定后仅重试一次。
    if (outside) {
      const width = await page.evaluate(() =>
        Math.min(4096, Math.max(1440, document.documentElement.scrollWidth)),
      );
      signal?.throwIfAborted();
      await page.setViewportSize({ width, height: 1080 });
    }
    signal?.throwIfAborted();
    await element.evaluateAll((elements) => {
      if (elements.length > 1) throw new Error("待悬停目标不唯一，已停止以免读取错误商品");
      elements[0]?.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    });
    signal?.throwIfAborted();
    await element.hover({ timeout: 5000 });
  }
}
