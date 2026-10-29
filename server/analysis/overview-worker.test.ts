import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { overviewOffThread, shutdownOverviewWorkers } from "./overview-worker";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await shutdownOverviewWorkers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "cbg-overview-worker-"));
  const filename = path.join(directory, "fixture.sqlite"),
    crawl = new CrawlStore(filename);
  cleanups.push(async () => {
    crawl.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (let index = 0; index < 24; index++) {
    const record = analysisRecord(`worker-${index}`);
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
  }
  const store = new AnalysisStore(crawl.db),
    runId = store.createRun("codex", "worker-fixture", true);
  crawl.db
    .prepare("UPDATE analysis_tasks SET status='completed',result_json=?")
    .run(JSON.stringify({ valuation: { bare_role_value: 100, decision: "PASS" } }));
  return { filename, crawl, store, runId };
}
it("独立线程读取真实SQLite，主线程仍可更新和读取进度，工作线程不写入业务库", async () => {
  const x = await fixture();
  const before = Number(x.crawl.db.prepare("PRAGMA data_version").get()!.data_version);
  const pending = overviewOffThread(x.filename, { runId: x.runId, summary: true });
  x.crawl.db
    .prepare("UPDATE analysis_tasks SET status='failed' WHERE listing_key='worker-0'")
    .run();
  expect(x.store.progress({ runId: x.runId }).run).toMatchObject({ completed: 23, failed: 1 });
  expect((await pending).run).toMatchObject({ completed: 23, failed: 1 });
  expect(Number(x.crawl.db.prepare("PRAGMA data_version").get()!.data_version)).toBe(before);
}, 20_000);

it("取消和关闭会结束对应请求，不阻塞后续读取或保留后台计算", async () => {
  const x = await fixture(),
    controller = new AbortController(),
    reason = new Error("client left");
  const cancelled = overviewOffThread(
    x.filename,
    { runId: x.runId, summary: true },
    controller.signal,
  ).catch((error: unknown) => error);
  controller.abort(reason);
  expect(await cancelled).toBe(reason);
  expect(
    (await overviewOffThread(x.filename, { runId: x.runId, summary: true })).records.total,
  ).toBe(24);
  const stopped = overviewOffThread(x.filename, { runId: x.runId }).catch(
    (error: unknown) => error,
  );
  await shutdownOverviewWorkers();
  expect(await stopped).toMatchObject({ message: "本地服务正在关闭" });
}, 20_000);
