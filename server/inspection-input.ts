import type { Page } from "playwright-core";
import { BrowserConnectionError } from "./browser-connection";

/** Observe delivery, rather than treating a successful CDP command as a DOM click. */
export async function observeInspectionInput(
  page: Page,
  token: string,
  point: { x: number; y: number; left: number; top: number; width: number; height: number },
) {
  const { x, y } = point;
  await page.evaluate(
    ({ token, x, y }) => {
      const key = Symbol.for("cbg.inspection-input");
      const previous = Reflect.get(window, key) as { stop(): void } | undefined;
      previous?.stop();
      let target = document.elementFromPoint(x, y);
      while (target && Reflect.get(target, Symbol.for("cbg.inspection-click-target")) !== token)
        target = target.parentElement;
      if (!target) throw new Error("点击目标已变化，未发送输入");
      const state = {
        token,
        target,
        events: [] as string[],
        clicked: false,
        stop: () => {
          for (const type of types) window.removeEventListener(type, receive, true);
        },
      };
      const types = ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"];
      const receive = (event: Event) => {
        state.events.push(event.type);
        if (
          event.isTrusted &&
          event.type === "click" &&
          event.composedPath().includes(state.target)
        )
          state.clicked = true;
      };
      for (const type of types) window.addEventListener(type, receive, true);
      Reflect.set(window, key, state);
    },
    { token, x, y },
  );
  return {
    read: () =>
      page.evaluate((token) => {
        const state = Reflect.get(window, Symbol.for("cbg.inspection-input")) as
          | { token: string; events: string[]; clicked: boolean }
          | undefined;
        return state?.token === token ? { events: state.events, clicked: state.clicked } : null;
      }, token),
    // Recheck delivery and identity in the same JS task as the fallback. Never replay
    // partial delivery, an unknown outcome, or a click on a changed/covered control.
    recover: () =>
      page.evaluate(
        ({ token, point }) => {
          const { x, y } = point;
          const state = Reflect.get(window, Symbol.for("cbg.inspection-input")) as
            | { token: string; target: Element; events: string[] }
            | undefined;
          if (!state || state.token !== token || state.events.length) return false;
          const target = state.target;
          if (
            !(target instanceof HTMLElement) ||
            !target.isConnected ||
            Reflect.get(target, Symbol.for("cbg.inspection-click-target")) !== token ||
            !target.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) ||
            target.closest(':disabled, [aria-disabled="true"], [inert]') ||
            !target.contains(document.elementFromPoint(x, y))
          )
            return false;
          const rect = target.getBoundingClientRect();
          if (
            rect.left !== point.left ||
            rect.top !== point.top ||
            rect.width !== point.width ||
            rect.height !== point.height
          )
            return false;
          target.click();
          return true;
        },
        { token, point },
      ),
    dispose: () =>
      page
        .evaluate((token) => {
          const key = Symbol.for("cbg.inspection-input");
          const state = Reflect.get(window, key) as { token: string; stop(): void } | undefined;
          if (state?.token !== token) return;
          state.stop();
          Reflect.deleteProperty(window, key);
        }, token)
        .catch(() => {}),
  };
}

export const inputDeliveryError = () => new BrowserConnectionError("input_unavailable");
