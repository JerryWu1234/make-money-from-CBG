import { expect, it } from "vite-plus/test";
import type { Page } from "playwright-core";
import {
  BrowserConnectionError,
  browserConnectionFailure,
  classifyBrowserFailure,
} from "./browser-connection";

it("区分整路断连、单页关闭和主动取消，页面仍存活的未知错误保持原样", () => {
  let connected = true,
    closed = false;
  const page = {
    isClosed: () => closed,
    context: () => ({ browser: () => ({ isConnected: () => connected }) }),
  } as unknown as Page;
  const original = new Error("page.evaluate: Target page, context or browser has been closed");
  expect(classifyBrowserFailure(page, original)).toBe(original);
  closed = true;
  expect(classifyBrowserFailure(page, original)).toMatchObject({
    kind: "page_closed",
    cause: original,
  });
  connected = false;
  expect(classifyBrowserFailure(page, original)).toMatchObject({
    kind: "disconnected",
    cause: original,
  });
  expect(
    classifyBrowserFailure(page, original, AbortSignal.abort(new Error("intentional stop"))),
  ).toBe(original);
  const known = new BrowserConnectionError("disconnected", original);
  const wrapper = new Error("partial", { cause: known });
  expect(classifyBrowserFailure(page, wrapper)).toBe(wrapper);
  expect(browserConnectionFailure(wrapper)).toBe(known);
});
