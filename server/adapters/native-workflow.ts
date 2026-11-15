import { AsyncLocalStorage } from "node:async_hooks";
import type { AccessContext, CrawlLease } from "../access";
import type { ActionPlan } from "./contracts";
import type { NativeActivityDriver, NativeActivityHandle } from "./native-activity";

export interface NativeWorkflowScope {
  context: (plan?: ActionPlan) => AccessContext | undefined;
  crawlLease?: CrawlLease;
  activity?: NativeActivityDriver;
}
const scopeStorage = new AsyncLocalStorage<NativeWorkflowScope>();
const activityStorage = new AsyncLocalStorage<{
  driver: NativeActivityDriver;
  handle: NativeActivityHandle;
}>();
export const nativeWorkflowActivity = () => activityStorage.getStore();
export async function withNativeActivity<T>(
  driver: NativeActivityDriver,
  signal: AbortSignal,
  work: () => Promise<T>,
): Promise<T> {
  const existing = activityStorage.getStore();
  if (existing?.driver === driver) {
    existing.handle.signal.throwIfAborted();
    return work();
  }
  const handle = await driver.begin(signal);
  const combined = AbortSignal.any([signal, handle.signal]);
  let abort!: () => void;
  try {
    combined.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(combined.reason || new Error("原生活动已停止"));
      combined.addEventListener("abort", abort, { once: true });
    });
    return await activityStorage.run({ driver, handle }, () =>
      Promise.race([Promise.resolve().then(work), cancelled]),
    );
  } finally {
    if (abort) combined.removeEventListener("abort", abort);
    await handle.close();
  }
}
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
    signal.throwIfAborted();
    return await scopeStorage.run(scope ?? { context: () => undefined }, () =>
      scope?.activity ? withNativeActivity(scope.activity, signal, work) : work(),
    );
  } finally {
    signal.removeEventListener("abort", abort);
    release();
  }
}
