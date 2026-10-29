import type { Page } from "playwright-core";

export type BrowserIssue = "disconnected" | "page_closed";
export class BrowserConnectionError extends Error {
  constructor(
    readonly kind: BrowserIssue,
    cause?: unknown,
  ) {
    super(
      kind === "disconnected"
        ? "Chrome 调试连接已断开，采集已暂停；请重新连接并核对登录后继续，断点和已读资料已保留。"
        : "采集工作页已关闭，采集已暂停；请重新查询角色列表后继续，断点和已读资料已保留。",
      { cause },
    );
    this.name = "BrowserConnectionError";
  }
}
export function browserConnectionFailure(error: unknown): BrowserConnectionError | undefined {
  for (let depth = 0; depth < 5 && error instanceof Error; depth++, error = error.cause)
    if (
      error.name === "BrowserConnectionError" &&
      "kind" in error &&
      ["disconnected", "page_closed"].includes(String(error.kind))
    )
      return error as BrowserConnectionError;
  return undefined;
}
/** An intentional abort keeps its original reason; never reclassify its owned-page cleanup. */
export function classifyBrowserFailure(page: Page, error: unknown, signal?: AbortSignal) {
  if (
    signal?.aborted ||
    browserConnectionFailure(error) ||
    !(error instanceof Error) ||
    !/Target (?:page, context or browser|closed)|Browser (?:has been )?closed|Page closed|Session closed/i.test(
      error.message,
    )
  )
    return error;
  const browser = page.context().browser();
  if (browser?.isConnected() === false) return new BrowserConnectionError("disconnected", error);
  return page.isClosed() ? new BrowserConnectionError("page_closed", error) : error;
}
