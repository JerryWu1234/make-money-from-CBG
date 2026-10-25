import type { Page } from "playwright-core";
import { CrawlAccessError, crawlAccessFailure } from "./types";

const checked = new WeakSet<Error>();
function loginAddress(address: string) {
  try {
    const url = new URL(address);
    return (
      url.origin === "https://xyq.cbg.163.com" &&
      /^\/(?:cgi-bin\/)?(?:show_login|login)(?:\.py)?\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** Classify an observed login redirect; never navigate or retry a failed read here. */
export async function accessNavigationFailure(
  page: Page,
  error: unknown,
  signal?: AbortSignal,
): Promise<CrawlAccessError | undefined> {
  signal?.throwIfAborted();
  const known = crawlAccessFailure(error);
  if (known) return known;
  if (page.isClosed()) return undefined;
  if (loginAddress(page.url())) return new CrawlAccessError("login", error);
  if (
    error instanceof Error &&
    /Execution context was destroyed|Cannot find context with specified id|Navigation .*interrupted by another navigation/.test(
      error.message,
    ) &&
    !checked.has(error)
  ) {
    checked.add(error);
    try {
      await page.waitForURL((url) => loginAddress(url.href), {
        timeout: 1500,
        waitUntil: "domcontentloaded",
      });
    } catch {
      // A different/unknown navigation is not evidence of login or a safe retry.
    }
    signal?.throwIfAborted();
    if (!page.isClosed() && loginAddress(page.url())) return new CrawlAccessError("login", error);
  }
  return undefined;
}
