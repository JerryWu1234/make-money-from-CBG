import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright-core";
import { cleanDiagnostic, diagnostics } from "./diagnostics";

export interface BrowserStep {
  flow: "browser" | "query" | "collection" | "analysis";
  stage: string;
  key?: string;
  error?: unknown;
}

// Register only pages created by this project, never the user's other Chrome tabs.
const pages = new WeakMap<Page, { id: string; key?: string }>();
let sequence = 0;
// Ten collectors can reach the same boundary together. Keep screenshot work bounded
// while each caller holds its own page at that boundary until its capture finishes.
const screenshotLanes = [Promise.resolve(), Promise.resolve()];
let nextLane = 0;
const pageLanes = new WeakMap<Page, number>();
function queueScreenshot<T>(page: Page, take: () => Promise<T>): Promise<T> {
  // Keep all captures of a page on one lane, including native timeout/abort cleanup.
  let lane = pageLanes.get(page);
  if (lane === undefined) {
    lane = nextLane++ % screenshotLanes.length;
    pageLanes.set(page, lane);
  }
  const result = screenshotLanes[lane].then(take);
  screenshotLanes[lane] = result.then(
    () => {},
    () => {},
  );
  return result;
}
export function registerBrowserEvidence(page: Page) {
  if (!pages.has(page)) pages.set(page, { id: randomUUID() });
}

/** Await at business boundaries, before the next action changes the page. */
export async function captureBrowserStep(page: Page, step: BrowserStep, signal?: AbortSignal) {
  const context = pages.get(page);
  if (!context || signal?.aborted) return;
  if (step.key) context.key = step.key;
  const key = step.key ?? context.key;
  const number = ++sequence;
  const startedAt = new Date().toISOString();
  const label = String(cleanDiagnostic(step.stage));
  const stem = `${String(number).padStart(6, "0")}-${step.flow}-${label.replace(/[^\p{L}\p{N}_-]/gu, "_").slice(0, 60)}-${randomUUID().slice(0, 8)}`;
  const directory = diagnostics.evidenceDirectory();
  const screenshot = path.join(directory, stem + ".png");
  const metadata = path.join(directory, stem + ".json");
  let screenshotError: unknown;
  let savedScreenshot: string | undefined;
  let captureStartedAt: string | undefined;
  let url = "";
  try {
    url = page.url();
    // Do not store login tokens, query strings or browser credentials in metadata.
    const parsed = new URL(url);
    url = `${parsed.origin === "null" ? parsed.protocol : parsed.origin}${parsed.pathname}`;
  } catch {
    url = "unavailable";
  }
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const bytes = await queueScreenshot(page, async () => {
      if (signal?.aborted) return undefined;
      captureStartedAt = new Date().toISOString();
      // Playwright 1.63 forwards AbortSignal to its server-side progress controller.
      // Await its native timeout/abort result so cleanup finishes before the next step;
      // an outer Promise.race would leave screenshot preparation running on this page.
      return page.screenshot({ fullPage: true, timeout: 15000, signal });
    });
    if (signal?.aborted) return;
    if (!bytes) return;
    await writeFile(screenshot, bytes, { mode: 0o600 });
    savedScreenshot = screenshot;
  } catch (error) {
    screenshotError = error;
  }
  if (signal?.aborted) return;
  const entry = cleanDiagnostic({
    sequence: number,
    pageId: context.id,
    ...step,
    key,
    startedAt,
    captureStartedAt,
    queueWaitMs: captureStartedAt
      ? Date.parse(captureStartedAt) - Date.parse(startedAt)
      : undefined,
    finishedAt: new Date().toISOString(),
    url,
    screenshot: savedScreenshot,
    screenshotError,
    metadata,
  });
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(metadata, JSON.stringify(entry, null, 2) + "\n", { mode: 0o600 });
    await appendFile(path.join(directory, "index.jsonl"), JSON.stringify(entry) + "\n", {
      mode: 0o600,
    });
    diagnostics.record("browser.step", entry as Record<string, unknown>);
  } catch (error) {
    // Evidence failure must never replace the original page action's result/error.
    try {
      diagnostics.record("browser.step_write_failed", { ...step, sequence: number, error });
    } catch {
      // A failing logger must not interrupt collection or analysis either.
    }
  }
}
