import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { CrawlStore } from "../crawler/store";
import { analysisRecord, valuationRecord } from "../../tests/fixtures/analysis";
import { createProfile } from "./profile";
import { CAPTURE_VERSION } from "../crawler/compact";
import { equipmentPricingPlan } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";
import type { AnalysisClient } from "./runner";
import { collectCompleteCapture } from "../crawler/capture-readiness";

const mocks = vi.hoisted(() => ({
  database: vi.fn(),
  connect: vi.fn(),
  profile: vi.fn(),
  retries: vi.fn(),
  startCrawl: vi.fn(),
  activity: vi.fn(),
  status: vi.fn(),
  crawling: vi.fn(),
  stopCrawl: vi.fn(),
}));
vi.mock("../crawler/controller", () => ({
  crawlDatabase: mocks.database,
  captureRetryItems: mocks.retries,
  startCrawl: mocks.startCrawl,
  crawlActivity: mocks.activity,
  crawlStatus: mocks.status,
  isCrawling: mocks.crawling,
  stopCrawl: mocks.stopCrawl,
}));
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
  mocks.retries.mockImplementation((keys?: string[]) => crawl.retryItems(keys));
  mocks.crawling.mockReturnValue(false);
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

function captureFixture() {
  const record = valuationRecord("a");
  record.detail!.captureVersion = CAPTURE_VERSION;
  record.detail!.valuation = { version: 1, fields: [], issues: [], source: {} };
  record.detail!.equipmentCapture = {
    version: 1,
    collectedAt: "now",
    complete: true,
    issues: [],
    emptyProof: "explicit-text",
  };
  record.detail!.petCapture = { version: 1, collectedAt: "now", complete: true, issues: [] };
  record.detail!.tabs.push({
    name: "道具/法宝",
    text: "无装备",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [],
  });
  record.detail!.tabs.push({
    name: "召唤兽/孩子",
    text: "无召唤兽",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    pets: [],
    petCount: 0,
  });
  const analyze = vi.fn<AnalysisClient["analyze"]>(
    (_prompt: string, _schema: unknown, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
  mocks.profile.mockReturnValue(createProfile("capture first", undefined, true, true));
  mocks.connect.mockResolvedValue({
    model: "test-model",
    analyze,
    searchEquipment: async (r: typeof record) => ({
      ...equipmentPricingPlan(r),
      searchComplete: true,
    }),
    searchPets: async (r: typeof record) => ({
      ...equipmentPricingPlan(r),
      ...petInventory(r),
      searchComplete: true,
    }),
  });
  return { record, analyze };
}
it("完整采集完成前不冻结任务、不调用AI；完成后从最新资料自动进入分析", async () => {
  const { record, analyze } = captureFixture();
  const incomplete = structuredClone(record.detail!);
  incomplete.equipmentCapture!.complete = false;
  incomplete.equipmentCapture!.issues = ["装备属性未完整读取"];
  crawl.save(record.listing, incomplete);
  let finish!: (value: unknown) => void;
  const completion = new Promise((resolve) => {
    finish = resolve;
  });
  mocks.startCrawl.mockResolvedValue({ started: true, activity: { completion } });
  mocks.status.mockReturnValue({ retryCompleted: 0, message: "正在采集装备" });
  const controller = await import("./controller");
  const starting = controller.startAnalysis("codex");
  await vi.waitFor(() => expect(mocks.startCrawl).toHaveBeenCalledOnce());
  expect(controller.analysisOverview({})).toMatchObject({
    activeRun: null,
    capturePreparation: { total: 1, completed: 0 },
  });
  expect(crawl.db.prepare("SELECT count(*) n FROM analysis_runs").get()!.n).toBe(0);
  expect(mocks.connect).not.toHaveBeenCalled();
  vi.resetModules();
  const reloaded = await import("./controller");
  expect(reloaded.analysisOverview({}).capturePreparation).toMatchObject({
    total: 1,
    completed: 0,
  });
  record.detail!.collectedAt = "2026-10-13T01:00:00Z";
  crawl.save(record.listing, record.detail!);
  finish({ phase: "completed", retryCompleted: 1 });
  const run = await starting;
  await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
  expect(run?.status).toBe("running");
  expect(crawl.db.prepare("SELECT collected_at FROM analysis_tasks").get()!.collected_at).toBe(
    record.detail!.collectedAt,
  );
  expect(controller.analysisOverview({}).capturePreparation).toBeUndefined();
});
it("采集重读仍有缺项时不启动AI，也不创建半成品分析批次", async () => {
  const { record } = captureFixture();
  record.detail!.petCapture!.complete = false;
  record.detail!.petCapture!.issues = ["宝宝装备图标未完整读取"];
  crawl.save(record.listing, record.detail!);
  mocks.startCrawl.mockResolvedValue({
    started: true,
    activity: {
      completion: Promise.resolve({ phase: "completed", lastItemError: "宝宝装备未读全" }),
    },
  });
  await expect((await import("./controller")).startAnalysis("codex")).rejects.toThrow(
    "还有 1 个角色资料待补采：角色a",
  );
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(crawl.db.prepare("SELECT count(*) n FROM analysis_runs").get()!.n).toBe(0);
});
it("继续旧批次先重采并更新冻结输入，保留原设置，旧资料和报价不送入AI", async () => {
  const { record, analyze } = captureFixture();
  crawl.save(record.listing, record.detail!);
  const controller = await import("./controller");
  const run = (await controller.startAnalysis("codex"))!;
  await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
  await controller.pauseAnalysis(run.id);
  const originalProfile = String(
    crawl.db.prepare("SELECT profile_json FROM analysis_runs WHERE id=?").get(run.id)!.profile_json,
  );
  const incomplete = structuredClone(record.detail!);
  incomplete.equipmentCapture!.complete = false;
  incomplete.equipmentCapture!.issues = ["武器属性未完整读取"];
  crawl.save(record.listing, incomplete);
  record.detail!.collectedAt = "2026-10-13T02:00:00Z";
  record.detail!.tabs[0].fields.push({ name: "采集验证", value: "本次新资料" });
  mocks.profile.mockReturnValue(createProfile("后改的设置不进入旧批次", undefined, false));
  mocks.startCrawl.mockImplementation(async () => {
    crawl.save(record.listing, record.detail!);
    return { started: true, activity: { completion: Promise.resolve({ phase: "completed" }) } };
  });
  await controller.resumeAnalysis(run.id);
  await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
  const task = crawl.db
    .prepare(
      "SELECT collected_at,prompt_text,source_detail_json FROM analysis_tasks WHERE run_id=?",
    )
    .get(run.id)!;
  expect(task.collected_at).toBe(record.detail!.collectedAt);
  expect(task.prompt_text).toContain("本次新资料");
  expect(task.source_detail_json).toBe(
    crawl.db.prepare("SELECT detail_json FROM listings WHERE key=?").get(record.listing.key)!
      .detail_json,
  );
  expect(
    crawl.db.prepare("SELECT profile_json FROM analysis_runs WHERE id=?").get(run.id)!.profile_json,
  ).toBe(originalProfile);
});
it("采集准备可以暂停，暂停后不会继续连接AI或创建分析批次", async () => {
  const { record } = captureFixture();
  record.detail!.equipmentCapture!.complete = false;
  record.detail!.equipmentCapture!.issues = ["武器属性未完整读取"];
  crawl.save(record.listing, record.detail!);
  let finish!: (value: unknown) => void;
  const activity = {
    completion: new Promise((resolve) => {
      finish = resolve;
    }),
  };
  mocks.activity.mockReturnValue(activity);
  mocks.startCrawl.mockResolvedValue({ started: true, activity });
  mocks.stopCrawl.mockImplementation(() => finish({ phase: "paused", message: "采集已暂停" }));
  const controller = await import("./controller");
  const starting = controller.startAnalysis("codex");
  const stopped = expect(starting).rejects.toThrow("已暂停完整资料采集准备");
  await vi.waitFor(() => expect(mocks.startCrawl).toHaveBeenCalledOnce());
  await controller.pauseAnalysis();
  await stopped;
  expect(mocks.stopCrawl).toHaveBeenCalledOnce();
  expect(mocks.connect).not.toHaveBeenCalled();
  expect(controller.analysisOverview({}).capturePreparation).toBeUndefined();
});
it("完整流程：采集发现缺项、自动重读、保存完整资料、查价、AI分析并保存一次结果", async () => {
  const { record, analyze } = captureFixture();
  const partial = structuredClone(record.detail!);
  partial.equipmentCapture!.complete = false;
  partial.equipmentCapture!.issues = ["武器属性未完整读取"];
  crawl.save(record.listing, partial);
  const read = vi.fn().mockResolvedValueOnce(partial).mockResolvedValueOnce(record.detail!);
  mocks.startCrawl.mockImplementation(async () => {
    const detail = await collectCompleteCapture(read, new AbortController().signal, vi.fn());
    expect(crawl.save(record.listing, detail)).toBe(true);
    return { started: true, activity: { completion: Promise.resolve({ phase: "completed" }) } };
  });
  analyze.mockResolvedValueOnce({
    text: JSON.stringify({
      decision: "NEED_INFO",
      reason: "模拟市场报价不足；角色采集资料已核验完整",
      extracted_facts: [],
    }),
  });
  const controller = await import("./controller");
  const run = (await controller.startAnalysis("codex"))!;
  await vi.waitFor(() =>
    expect(controller.analysisOverview({}).activeRun).toMatchObject({
      id: run.id,
      status: "running",
      completed: 1,
      phase: "waiting_capture",
    }),
  );
  const task = crawl.db
    .prepare(
      "SELECT status,equipment_pricing_json,pet_pricing_json,result_json FROM analysis_tasks WHERE run_id=?",
    )
    .get(run.id)!;
  expect(task.status).toBe("completed");
  expect(JSON.parse(String(task.equipment_pricing_json)).searchComplete).toBe(true);
  expect(JSON.parse(String(task.pet_pricing_json)).searchComplete).toBe(true);
  expect(task.result_json).not.toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
  expect(analyze).toHaveBeenCalledOnce();
});

it("普通分析在采集仍进行时立即处理已采齐角色，不等待后续补采", async () => {
  const { record } = captureFixture();
  crawl.save(record.listing, record.detail!);
  crawl.observe(analysisRecord("pending-later").listing);
  mocks.crawling.mockReturnValue(true);
  mocks.activity.mockReturnValue({
    completion: new Promise(() => {}),
    origin: "manual",
    startedAt: Date.now(),
  });
  const controller = await import("./controller");
  const run = await controller.startAnalysis("codex");
  expect(run).toMatchObject({ total: 1, status: "running" });
  expect(mocks.startCrawl).not.toHaveBeenCalled();
  expect(mocks.activity).not.toHaveBeenCalled();
  expect(controller.analysisOverview({}).capturePreparation).toBeUndefined();
  expect(controller.appendCapturedAnalysis()).toBe(0);
});
