import { Worker } from "node:worker_threads";
import path from "node:path";
import type { AnalysisOverview } from "./types";
import type { AnalysisStore } from "./store";

type Options = Parameters<AnalysisStore["overview"]>[0];
class OverviewWorker {
  private readonly worker: Worker;
  private next = 0;
  private closed = false;
  private readonly requests = new Map<
    number,
    { resolve: (value: AnalysisOverview) => void; reject: (error: Error) => void }
  >();
  constructor(filename: string, retired: () => void) {
    this.worker = new Worker(path.resolve("server/analysis/overview-worker-entry.mjs"), {
      workerData: { filename, root: process.cwd() },
    });
    this.worker.unref();
    this.worker.on(
      "message",
      (reply: { id: number; result?: AnalysisOverview; error?: string }) => {
        const request = this.requests.get(reply.id);
        if (!request) return;
        this.requests.delete(reply.id);
        if (reply.result) request.resolve(reply.result);
        else request.reject(new Error(reply.error || "读取商品记录失败"));
      },
    );
    const failed = (error: Error) => {
      if (this.closed) return;
      this.closed = true;
      for (const request of this.requests.values()) request.reject(error);
      this.requests.clear();
      retired();
    };
    this.worker.once("error", failed);
    this.worker.once("exit", () => failed(new Error("商品记录工作线程已退出，请重新读取")));
  }
  async read(options: Options, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("商品记录工作线程已关闭");
    const id = ++this.next;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<AnalysisOverview>((resolve, reject) => {
        this.requests.set(id, { resolve, reject });
        abort = () => {
          this.requests.delete(id);
          this.worker.postMessage({ type: "cancel", id });
          reject(signal!.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        this.worker.postMessage({ type: "read", id, options });
        if (signal?.aborted) abort();
      });
    } finally {
      if (abort) signal?.removeEventListener("abort", abort);
      this.requests.delete(id);
    }
  }
  async close() {
    this.closed = true;
    for (const request of this.requests.values()) request.reject(new Error("本地服务正在关闭"));
    this.requests.clear();
    await this.worker.terminate();
  }
}
const key = Symbol.for("cbg.analysis-overview-workers.v1");
const runtime = globalThis as typeof globalThis & { [key]?: Map<string, OverviewWorker> };
const workers = (runtime[key] ??= new Map());

export function overviewOffThread(filename: string, options: Options, signal?: AbortSignal) {
  signal?.throwIfAborted();
  let worker = workers.get(filename);
  if (!worker) {
    worker = new OverviewWorker(filename, () => workers.delete(filename));
    workers.set(filename, worker);
  }
  return worker.read(options, signal);
}
export async function shutdownOverviewWorkers() {
  const current = [...workers.values()];
  workers.clear();
  await Promise.all(current.map((worker) => worker.close()));
}
