import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CrawlStore } from "../crawler/store";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { createProfile } from "./profile";

const mocks = vi.hoisted(() => ({ database: vi.fn(), connect: vi.fn(), profile: vi.fn() }));
vi.mock("../crawler/controller", () => ({ crawlDatabase: mocks.database }));
vi.mock("../ai-connection", () => ({ prepareAnalysisClient: mocks.connect }));
vi.mock("./market", () => ({ refreshMarket: vi.fn(), marketServers: () => [] }));
vi.mock("./profile", async (original) => ({
  ...(await original<typeof import("./profile")>()),
  loadProfile: mocks.profile,
}));
const serviceKey = Symbol.for("cbg.analysis-service.v1");
const runtime = globalThis as typeof globalThis & { [serviceKey]?: unknown };
let crawl: CrawlStore;
beforeEach(() => {
  delete runtime[serviceKey];
  vi.resetModules();
  vi.clearAllMocks();
  crawl = new CrawlStore(":memory:");
  const record = analysisRecord("a");
  crawl.observe(record.listing);
  crawl.save(record.listing, record.detail!);
  mocks.database.mockReturnValue(crawl.db);
  mocks.profile.mockReturnValue(createProfile("reload test", undefined, false));
});
afterEach(async () => {
  await (await import("./controller")).shutdownAnalysis();
  delete runtime[serviceKey];
  crawl.close();
});
describe("分析服务刷新恢复", () => {
  it("模块重载保留执行中的队列；刷新状态不连接 AI，手动暂停不会自动重启", async () => {
    const analyze = vi.fn(
      (_prompt: string, _schema: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    mocks.connect.mockResolvedValue({ model: "reload-model", analyze });
    const controller = await import("./controller");
    const run = await controller.startAnalysis("codex");
    expect(analyze).toHaveBeenCalledOnce();
    vi.resetModules();
    const reloaded = await import("./controller");
    expect(reloaded.analysisOverview({}).activeRun).toMatchObject({
      id: run!.id,
      status: "running",
    });
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(analyze).toHaveBeenCalledOnce();
    await reloaded.pauseAnalysis(run!.id);
    vi.resetModules();
    const paused = await import("./controller");
    expect(paused.analysisOverview({})).toMatchObject({
      activeRun: null,
      run: { id: run!.id, status: "paused" },
    });
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(analyze).toHaveBeenCalledOnce();
  });
});
