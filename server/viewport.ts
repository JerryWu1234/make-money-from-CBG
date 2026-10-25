import type { Locator, Page } from "playwright-core";

const WORK_VIEWPORT = { width: 1440, height: 1080 };
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
export async function hoverForInspection(
  page: Page,
  element: Locator,
  recoveredActionability?: (stage: "scroll" | "visibility") => void,
) {
  await ensureWorkViewport(page);
  // 移出上一个图标，触发网站自己的 mouseout；仅让提示框不拦截后续鼠标。
  // 不隐藏提示内容，不对验证码、登录框或其他遮罩使用 force。
  await page.mouse.move(1, 1);
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
  await element.evaluate((el) =>
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }),
  );
  try {
    await element.hover({ timeout: 5000 });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const actionabilityTimeout =
      error.name === "TimeoutError" &&
      (error.message.includes("waiting for element to be visible and stable") ||
        (error.message.includes("element is visible and stable") &&
          error.message.includes("scrolling into view if needed"))) &&
      !error.message.includes("performing hover action");
    if (actionabilityTimeout) {
      // 隐藏工作页的帧等待或 CDP 滚动可能停滞。先核对当前 DOM 的可见性、
      // 稳定几何和鼠标命中，再发一次原生鼠标动作；真实遮挡或不可见仍然失败。
      const point = () =>
        element.evaluate((el) => {
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
        });
      const before = await point();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const after = await point();
      if (!before || !after || JSON.stringify(before) !== JSON.stringify(after)) throw error;
      await page.mouse.move(after.x, after.y);
      if (
        !(await element.evaluate(
          (el, { x, y }) => el.isConnected && el.contains(document.elementFromPoint(x, y)),
          after,
        ))
      )
        throw error;
      recoveredActionability?.(
        error.message.includes("scrolling into view if needed") ? "scroll" : "visibility",
      );
      return;
    }
    const outside = error.message.includes("outside of the viewport");
    // Visible/stable/hit-target checks already passed. Retry a stalled native
    // mouse action once; invisible elements and intercepting dialogs still fail.
    const pointerTimeout =
      error.name === "TimeoutError" &&
      error.message.includes("performing hover action") &&
      !error.message.includes("hover action done");
    if (!outside && !pointerTimeout) throw error;
    // 老工作页或网站固定宽度布局可能使可视区域与文档不同步，重新设定后仅重试一次。
    if (outside) {
      const width = await page.evaluate(() =>
        Math.min(4096, Math.max(1440, document.documentElement.scrollWidth)),
      );
      await page.setViewportSize({ width, height: 1080 });
    }
    await element.evaluate((el) =>
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }),
    );
    await element.hover({ timeout: 5000 });
  }
}
