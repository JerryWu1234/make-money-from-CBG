import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "vite-plus";

// This worker only reads the already initialized database. It cannot migrate,
// recover leases, append tasks, invoke models, or touch collection browsers.
const vite = await createServer({
  root: workerData.root,
  configFile: false,
  cacheDir: "data/.overview-worker-cache",
  server: { middlewareMode: true, watch: null, hmr: false, ws: false },
  appType: "custom",
});
const { AnalysisStore } = await vite.ssrLoadModule("/server/analysis/store.ts");
const db = new DatabaseSync(workerData.filename, { readOnly: true });
db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=5000");
const store = new AnalysisStore(db, { readOnly: true });
const requests = new Map();
async function read(id, job) {
  try {
    // The store coalesces equal requests while each reader retains cancellation.
    const result = await store.overviewAsync(job.options, job.controller.signal);
    parentPort.postMessage({ id, result });
  } catch (error) {
    parentPort.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    requests.delete(id);
  }
}
parentPort.on("message", (message) => {
  if (message.type === "cancel")
    requests.get(message.id)?.controller.abort(new Error("商品记录请求已取消"));
  else {
    const job = { options: message.options, controller: new AbortController() };
    requests.set(message.id, job);
    void read(message.id, job);
  }
});
