import { AsyncLocalStorage } from "node:async_hooks";
import { cleanActiveCodexRuntime } from "../../scripts/codex-runtime.mjs";

type Token = { active: boolean; cleanupAfter: boolean };
type CleanupOptions = { cleanupAfter?: boolean };
type CleanupRequestOptions = { whenIdle?: boolean };
export type CodexBatch = {
  run<T>(work: () => Promise<T>): Promise<T>;
  finish(): Promise<void>;
};
export class CodexCleanupError extends Error {
  readonly code = "CODEX_CLEANUP_FAILED";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexCleanupError";
  }
}

type Cleanup = {
  promise: Promise<void>;
  resolve(): void;
  reject(error: CodexCleanupError): void;
};

/** Readers share Codex until a cleanup is requested; an existing batch may keep draining. */
export class CodexLifecycle {
  private readonly context = new AsyncLocalStorage<Token>();
  private readonly shutdown = new Set<() => Promise<void>>();
  private readonly idle = new Set<() => void>();
  private readers = 0;
  private pending?: Cleanup;
  private deferredCleanup = false;
  constructor(
    private readonly options: {
      cleanup: () => Promise<void>;
      shutdown?: () => Promise<void>;
      onCleanupError?: (error: CodexCleanupError) => void;
    },
  ) {
    if (options.shutdown) this.shutdown.add(options.shutdown);
  }
  registerShutdown(callback: () => Promise<void>) {
    this.shutdown.add(callback);
    return () => {
      this.shutdown.delete(callback);
    };
  }
  private report(error: CodexCleanupError) {
    try {
      if (this.options.onCleanupError) this.options.onCleanupError(error);
      else console.warn("Codex 运行文件清理失败", error);
    } catch {
      /* Reporting cannot replace a successful analysis result. */
    }
  }
  private async enter() {
    if (!this.context.getStore()?.active)
      while (this.pending) await this.pending.promise.catch(() => {});
    this.readers++;
  }
  private leave() {
    this.readers--;
    if (!this.readers) {
      for (const resolve of this.idle) resolve();
      this.idle.clear();
      if (this.deferredCleanup) {
        const cleanup = this.scheduleCleanup();
        void cleanup.catch((error: CodexCleanupError) => this.report(error));
        return cleanup;
      }
    }
  }
  private async clean(pending: Cleanup) {
    if (this.readers) await new Promise<void>((resolve) => this.idle.add(resolve));
    let error: CodexCleanupError | undefined;
    try {
      // Close every module generation's auth server before removing generated files.
      const results = await Promise.allSettled(
        [...this.shutdown].map((close) => Promise.resolve().then(close)),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) throw new AggregateError(failures, "Codex 后台服务未能全部关闭");
      await this.options.cleanup();
    } catch (cause) {
      error = new CodexCleanupError("Codex 运行文件清理失败", { cause });
    }
    // Wake queued readers only after the exclusive work has ended, even on failure.
    if (this.pending === pending) this.pending = undefined;
    if (error) pending.reject(error);
    else pending.resolve();
  }
  private scheduleCleanup() {
    this.deferredCleanup = false;
    if (!this.pending) {
      let resolve!: () => void;
      let reject!: (error: CodexCleanupError) => void;
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      const pending = { promise, resolve, reject };
      this.pending = pending;
      void promise.catch(() => {});
      void this.clean(pending);
    }
    return this.pending.promise;
  }
  requestCleanup(options: CleanupRequestOptions = {}) {
    const token = this.context.getStore();
    if (token?.active) {
      // Waiting here would wait on our own read lease. The outer owner will await it.
      token.cleanupAfter = true;
      return Promise.resolve();
    }
    if (options.whenIdle && this.readers) {
      this.deferredCleanup = true;
      return Promise.resolve();
    }
    return this.scheduleCleanup();
  }
  async withOperation<T>(work: () => Promise<T>, options: CleanupOptions = {}): Promise<T> {
    const inherited = this.context.getStore();
    if (inherited?.active) {
      inherited.cleanupAfter ||= options.cleanupAfter === true;
      return await work();
    }
    await this.enter();
    const token: Token = { active: true, cleanupAfter: options.cleanupAfter === true };
    try {
      return await this.context.run(token, work);
    } finally {
      token.active = false;
      const cleanup = this.leave();
      // Independent READY/SDK results must not wait on another long batch or login.
      if (token.cleanupAfter) {
        if (cleanup)
          await cleanup.catch(() => {}); // Already reported by the last reader.
        else
          await this.requestCleanup({ whenIdle: true }).catch((error: CodexCleanupError) =>
            this.report(error),
          );
      }
    }
  }
  async beginBatch(options: CleanupOptions = {}): Promise<CodexBatch> {
    await this.enter();
    const token: Token = { active: true, cleanupAfter: options.cleanupAfter !== false };
    const running = new Set<Promise<unknown>>();
    let closing = false;
    let finishing: Promise<void> | undefined;
    return {
      run: <T>(work: () => Promise<T>) => {
        if (closing) return Promise.reject(new Error("Codex 批次已结束，不能继续提交请求"));
        // Register the promise before running user code, including a nested finish().
        const result = Promise.resolve().then(() => this.context.run(token, work));
        running.add(result);
        void result.then(
          () => running.delete(result),
          () => running.delete(result),
        );
        return result;
      },
      finish: () => {
        const inherited = this.context.getStore();
        closing = true;
        finishing ||= (async () => {
          const cleanup = token.cleanupAfter ? this.scheduleCleanup() : undefined;
          await Promise.allSettled(running);
          token.active = false;
          void this.leave();
          if (inherited?.active) {
            inherited.cleanupAfter ||= token.cleanupAfter;
            return;
          }
          if (cleanup) await cleanup;
        })();
        if (inherited?.active) {
          // A finish inside a reader must let that reader return before cleanup can run.
          inherited.cleanupAfter ||= token.cleanupAfter;
          void finishing.catch((error: CodexCleanupError) => this.report(error));
          return Promise.resolve();
        }
        return finishing;
      },
    };
  }
}

const lifecycleKey = Symbol.for("cbg.codex-lifecycle.v1");
const globals = globalThis as typeof globalThis & { [key: symbol]: CodexLifecycle | undefined };
const lifecycle = (globals[lifecycleKey] ||= new CodexLifecycle({
  cleanup: async () => {
    await cleanActiveCodexRuntime();
  },
}));

export function withCodexOperation<T>(work: () => Promise<T>, options?: CleanupOptions) {
  return lifecycle.withOperation(work, options);
}
export function beginCodexBatch(options?: CleanupOptions) {
  return lifecycle.beginBatch(options);
}
export function registerCodexShutdown(callback: () => Promise<void>) {
  return lifecycle.registerShutdown(callback);
}
export function requestCodexCleanup(options?: CleanupRequestOptions) {
  return lifecycle.requestCleanup(options);
}
