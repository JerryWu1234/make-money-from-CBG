import { describe, expect, it, vi } from "vite-plus/test";
import { CodexCleanupError, CodexLifecycle } from "./codex-lifecycle";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// Cleanup must exclude new writers while existing batches drain and must never
// hide an answer or a provider error when filesystem cleanup itself fails.
describe("Codex lifecycle", () => {
  it("合并并发批次清理，等待在途调用并允许旧批次嵌套请求，新poll排队", async () => {
    const events: string[] = [];
    const cleanup = vi.fn(async () => {
      events.push("clean");
    });
    const gate = new CodexLifecycle({ cleanup });
    gate.registerShutdown(async () => {
      events.push("shutdown");
    });
    const first = await gate.beginBatch();
    const second = await gate.beginBatch();
    const active = deferred();
    const started = deferred();
    const operation = gate.withOperation(async () => {
      started.resolve();
      await active.promise;
      events.push("old-poll");
    });
    await started.promise;
    const firstFinished = first.finish();
    const next = gate.withOperation(async () => {
      events.push("new-poll");
    });
    await second.run(() =>
      gate.withOperation(async () => {
        events.push("nested");
      }),
    );
    expect(events).toEqual(["nested"]);
    active.resolve();
    await operation;
    expect(cleanup).not.toHaveBeenCalled();
    await Promise.all([firstFinished, second.finish()]);
    await next;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(events).toEqual(["nested", "old-poll", "shutdown", "clean", "new-poll"]);
  });

  it("独立READY完成不等长批次或阻塞metadata，批结束合并清一次", async () => {
    const cleanup = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const gate = new CodexLifecycle({ cleanup, shutdown: close });
    const batch = await gate.beginBatch();
    expect(await gate.withOperation(async () => "READY", { cleanupAfter: true })).toBe("READY");
    expect(await gate.withOperation(async () => "models-list")).toBe("models-list");
    expect(cleanup).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    await batch.run(() => gate.withOperation(async () => "existing-batch"));
    await batch.finish();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(await gate.withOperation(async () => "after-cleanup")).toBe("after-cleanup");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("独立READY清理延期到登录hold释放，后台失败单独报告且不丢响应", async () => {
    const cleanup = vi.fn(async () => {
      throw new Error("busy writer");
    });
    const report = vi.fn();
    const gate = new CodexLifecycle({ cleanup, onCleanupError: report });
    const login = await gate.beginBatch({ cleanupAfter: false });
    expect(await gate.withOperation(async () => "READY", { cleanupAfter: true })).toBe("READY");
    expect(await gate.withOperation(async () => "account")).toBe("account");
    expect(cleanup).not.toHaveBeenCalled();
    await login.finish();
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(cleanup).toHaveBeenCalledOnce();
    expect(report.mock.calls[0]![0]).toMatchObject({ code: "CODEX_CLEANUP_FAILED" });
  });

  it("finish等待本批次仍在执行的请求，终态前不关闭后台或删除文件", async () => {
    const cleanup = vi.fn(async () => {});
    const close = vi.fn(async () => {});
    const gate = new CodexLifecycle({ cleanup, shutdown: close });
    const batch = await gate.beginBatch();
    const terminal = deferred();
    const started = deferred();
    const run = batch.run(async () => {
      started.resolve();
      await terminal.promise;
      return "answer";
    });
    await started.promise;
    const finish = batch.finish();
    await Promise.resolve();
    expect(close).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
    terminal.resolve();
    expect(await run).toBe("answer");
    await finish;
    expect(close).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(batch.run(async () => "late")).rejects.toThrow("批次已结束");
    await batch.finish();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("单次请求主动清理不覆盖成功答案，也不覆盖原始AI错误", async () => {
    const cleanupFailure = new Error("filesystem busy");
    const cleanup = vi.fn(async () => {
      throw cleanupFailure;
    });
    const report = vi.fn();
    const gate = new CodexLifecycle({ cleanup, onCleanupError: report });
    expect(await gate.withOperation(async () => "saved-answer", { cleanupAfter: true })).toBe(
      "saved-answer",
    );
    const providerFailure = new Error("provider 429");
    await expect(
      gate.withOperation(
        async () => {
          throw providerFailure;
        },
        { cleanupAfter: true },
      ),
    ).rejects.toBe(providerFailure);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report.mock.calls[0]![0]).toMatchObject({
      code: "CODEX_CLEANUP_FAILED",
      cause: cleanupFailure,
    });
    await expect(gate.withOperation(async () => "retry")).resolves.toBe("retry");
  });

  it("批次清理失败单独抛出cleanup错误并重新打开调用门", async () => {
    const failure = new Error("writer remains");
    const gate = new CodexLifecycle({
      cleanup: async () => {
        throw failure;
      },
    });
    const batch = await gate.beginBatch();
    expect(await batch.run(async () => "business-result")).toBe("business-result");
    const rejected = expect(batch.finish()).rejects.toMatchObject({
      code: "CODEX_CLEANUP_FAILED",
      cause: failure,
    });
    const next = gate.withOperation(async () => "next");
    await rejected;
    expect(await next).toBe("next");
  });

  it("清理时等待所有旧模块后台关闭；任一关闭失败都不删除文件", async () => {
    const cleanup = vi.fn(async () => {});
    const closed = deferred();
    const gate = new CodexLifecycle({ cleanup });
    gate.registerShutdown(async () => {
      throw new Error("auth close failed");
    });
    gate.registerShutdown(() => closed.promise);
    let finished = false;
    const result = gate.requestCleanup().catch((error: unknown) => {
      finished = true;
      return error;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    closed.resolve();
    const error = await result;
    expect(error).toBeInstanceOf(CodexCleanupError);
    expect(error).toMatchObject({
      code: "CODEX_CLEANUP_FAILED",
      cause: expect.any(AggregateError),
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("批次内请求cleanupAfter不会等待自己的lease，批结束才清理", async () => {
    const cleanup = vi.fn(async () => {});
    const gate = new CodexLifecycle({ cleanup });
    const batch = await gate.beginBatch();
    expect(
      await batch.run(() => gate.withOperation(async () => "answer", { cleanupAfter: true })),
    ).toBe("answer");
    expect(cleanup).not.toHaveBeenCalled();
    await batch.finish();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("在活跃reader内部请求cleanup或结束batch不会自锁", async () => {
    const cleanup = vi.fn(async () => {});
    const gate = new CodexLifecycle({ cleanup });
    expect(
      await gate.withOperation(async () => {
        const batch = await gate.beginBatch();
        await batch.run(async () => {
          await gate.requestCleanup();
        });
        await batch.finish();
        return "answer";
      }),
    ).toBe("answer");
    expect(cleanup).toHaveBeenCalledOnce();
    const second = await gate.beginBatch();
    await second.run(async () => {
      await second.finish();
    });
    await second.finish();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("登录hold阻止清理，取消可在旧hold内穿过pending门完成", async () => {
    const cleanup = vi.fn(async () => {});
    const gate = new CodexLifecycle({ cleanup });
    const login = await gate.beginBatch({ cleanupAfter: false });
    const batch = await gate.beginBatch();
    const finish = batch.finish();
    const polled = vi.fn(async () => {});
    const poll = gate.withOperation(polled);
    await login.run(() => gate.withOperation(async () => "login canceled"));
    expect(cleanup).not.toHaveBeenCalled();
    expect(polled).not.toHaveBeenCalled();
    await login.finish();
    await Promise.all([finish, poll]);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(polled).toHaveBeenCalledOnce();
  });

  it("正在实际删除时新请求排队，每批可重复清理", async () => {
    const removing = deferred();
    const started = deferred();
    const cleanup = vi.fn(async () => {
      started.resolve();
      await removing.promise;
    });
    const gate = new CodexLifecycle({ cleanup });
    const batch = await gate.beginBatch();
    const finish = batch.finish();
    await started.promise;
    const work = vi.fn(async () => "new");
    const waiting = gate.withOperation(work);
    expect(work).not.toHaveBeenCalled();
    removing.resolve();
    await finish;
    expect(await waiting).toBe("new");
    await (await gate.beginBatch()).finish();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
});
