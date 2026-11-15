import { AsyncLocalStorage } from "node:async_hooks";
import type { AccessContext, CrawlLease } from "../access";
import type { ActionPlan } from "./contracts";

export interface NativeWorkflowScope {
  context: (plan?: ActionPlan) => AccessContext | undefined;
  crawlLease?: CrawlLease;
}
const scopeStorage = new AsyncLocalStorage<NativeWorkflowScope>();
export const nativeWorkflowScope = () => scopeStorage.getStore();
let tail: Promise<void> = Promise.resolve();
/** One selected native tab cannot interleave two form/detail workflows. */
export async function withNativeWorkflow<T>(
  signal: AbortSignal,
  work: () => Promise<T>,
  scope?: NativeWorkflowScope,
): Promise<T> {
  const previous = tail;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  tail = previous.then(() => hold);
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason || new Error("原生官网操作已取消"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    await Promise.race([previous, cancelled]);
    signal.throwIfAborted();
    return await scopeStorage.run(scope ?? { context: () => undefined }, work);
  } finally {
    signal.removeEventListener("abort", abort);
    release();
  }
}
