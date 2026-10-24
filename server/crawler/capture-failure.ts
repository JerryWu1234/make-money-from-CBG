import type { Page } from "playwright-core";
import { captureBrowserStep } from "../browser-evidence";

interface FailureContext {
  key: string;
  attempt: number;
  stage: string;
  error?: unknown;
  issues?: string[];
}

/** Failure evidence shares the same timeline and directory as successful browser steps. */
export async function saveCaptureFailure(
  page: Page,
  signal: AbortSignal,
  context: FailureContext,
  log: (event: string, data?: Record<string, unknown>) => void,
) {
  if (signal.aborted) return;
  await captureBrowserStep(
    page,
    {
      flow: "collection",
      key: context.key,
      stage: `${context.stage}：第 ${context.attempt} 次读取失败`,
      error: context.error ?? new Error((context.issues || []).join("；")),
    },
    signal,
  );
  try {
    log("detail.capture_failure", { ...context });
  } catch {
    // A diagnostic write must not replace the original collection error.
  }
}
