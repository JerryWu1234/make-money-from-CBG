import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { analysisRecord, analysisResponse, valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import type { SavedRoleRecord } from "../crawler/types";
import { buildProductDocument } from "./product-document";
import { AnalysisStore } from "./store";
import { AnalysisRunner, type AnalysisClient } from "./runner";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { calculateValuation } from "./valuation-calculator";
import { searchEquipmentPrices } from "./equipment-pricing";
import { searchPetPricing } from "./pet-pricing";
import { beginServiceShutdown, resetServiceLifecycle } from "../service-lifecycle";

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => resetServiceLifecycle());
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
function setup(keys = ["a", "b"], recordFactory = analysisRecord) {
  const crawl = new CrawlStore(":memory:");
  for (const key of keys) {
    const record = recordFactory(key);
    record.detail!.equipmentCapture ||= {
      version: 1,
      collectedAt: record.detail!.collectedAt,
      complete: true,
      issues: [],
    };
    record.detail!.petCapture ||= {
      version: 1,
      collectedAt: record.detail!.collectedAt,
      complete: true,
      issues: [],
    };
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
  }
  const store = new AnalysisStore(crawl.db);
  // Keep finite-batch assertions here; continuous waiting is covered in runner-streaming.test.ts.
  vi.spyOn(store, "followsCapture").mockReturnValue(false);
  const analyze = vi.fn<AnalysisClient["analyze"]>().mockImplementation(async (prompt) => {
    const key = keys.find((key) => prompt.includes(`商品 ID：${key}。`))!;
    return {
      text: JSON.stringify(analysisResponse(crawl.detail(key) as SavedRoleRecord)),
      usage: { input_tokens: 100, output_tokens: 20 },
    };
  });
  const connect = vi.fn<(_provider: unknown, model?: string) => Promise<AnalysisClient>>(
    async (_provider, model) => ({
      model: model || "test-model",
      analyze,
    }),
  );
  const runner = new AnalysisRunner(store, connect);
  cleanups.push(async () => {
    await runner.shutdown();
    crawl.db.close();
  });
  return { crawl, store, runner, analyze, connect };
}
async function valuationSetup() {
  const context = setup(["a"], (key) => {
    const record = valuationRecord(key);
    record.detail!.equipmentCapture = {
      version: 1,
      collectedAt: record.detail!.collectedAt,
      complete: true,
      issues: [],
      emptyProof: "explicit-text",
    };
    record.detail!.tabs.push({
      name: "道具/法宝",
      text: "没有装备",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [],
    });
    record.detail!.tabs.push({
      name: "召唤兽/孩子",
      text: "没有召唤兽",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      pets: [],
      petCount: 0,
    });
    return record;
  });
  const record = context.crawl.detail("a") as SavedRoleRecord;
  const profile = createProfile(
    readFileSync(PROMPT_FILE, "utf8"),
    {
      ...DEFAULT_SETTINGS,
      servers: [{ serverId: record.listing.serverId, age: "three", rank: 10 }],
    },
    true,
    true,
  );
  const noNetwork = vi.fn().mockRejectedValue(new Error("empty equipment must not search"));
  const pricing = await searchEquipmentPrices(record, new AbortController().signal, {
    findCandidates: noNetwork,
    readSource: noNetwork,
  });
  expect(noNetwork).not.toHaveBeenCalled();
  const searchEquipment = vi
    .fn<NonNullable<AnalysisClient["searchEquipment"]>>()
    .mockResolvedValue(pricing);
  const petPricing = await searchPetPricing(record, new AbortController().signal, {
    findCandidates: noNetwork,
    readSource: noNetwork,
  });
  const searchPets = vi
    .fn<NonNullable<AnalysisClient["searchPets"]>>()
    .mockResolvedValue(petPricing);
  context.connect.mockImplementation(async (_provider, model) => ({
    model: model || "test-model",
    analyze: context.analyze,
    searchEquipment,
    searchPets,
  }));
  context.analyze.mockResolvedValue({
    text: JSON.stringify({
      decision: calculateValuation(record, profile).decision,
      reason: "按采集资料和当前挂牌价核对差额。",
      extracted_facts: [],
    }),
  });
  return { ...context, profile, pricing, petPricing, searchEquipment, searchPets };
}
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("持久化的商品分析队列", () => {
  it("已入队角色确认不存在后继续分析时跳过，不发模型且不进入失败统计", async () => {
    const { crawl, store, runner, analyze } = setup(["a"]);
    const id = store.createRun("codex", "test-model");
    crawl.markUnavailable("a", "官网商品已不存在，无法补齐，已跳过且不再重试：HTTP 404");
    await runner.resume(id);
    await runner.settled();
    expect(analyze).not.toHaveBeenCalled();
    expect(store.run(id)).toMatchObject({ status: "completed", total: 0, queued: 0, failed: 0 });
    expect(
      crawl.db.prepare("SELECT status,error FROM analysis_tasks WHERE run_id=?").get(id),
    ).toMatchObject({ status: "skipped", error: expect.stringContaining("不再重试") });
  });
  it("异步查价期间确认不存在，返回后在发模型前跳过并保留已保存查价证据", async () => {
    const { crawl, store, runner, analyze, profile, pricing, searchEquipment } =
      await valuationSetup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    searchEquipment.mockImplementationOnce(async () => {
      await gate;
      return pricing;
    });
    const id = await runner.start("codex", true, profile);
    await vi.waitFor(() => expect(searchEquipment).toHaveBeenCalledOnce());
    crawl.markUnavailable("a", "官网商品已不存在，无法补齐，已跳过且不再重试：HTTP 410");
    release();
    await runner.settled();
    expect(analyze).not.toHaveBeenCalled();
    expect(store.run(id)).toMatchObject({ status: "completed", total: 0, queued: 0, failed: 0 });
    expect(
      crawl.db
        .prepare("SELECT status,equipment_pricing_json FROM analysis_tasks WHERE run_id=?")
        .get(id),
    ).toMatchObject({ status: "skipped", equipment_pricing_json: JSON.stringify(pricing) });
    expect(crawl.db.prepare("SELECT count(*) n FROM analysis_attempts").get()?.n).toBe(0);
  });
  it.each(["failed", "waiting_pricing"])(
    "暂停批次的%s商品确认不存在后，默认继续即可清理且不要求重试",
    async (state) => {
      const { crawl, store, runner, analyze } = setup(["a"]);
      const id = store.createRun("codex", "test-model");
      crawl.db
        .prepare("UPDATE analysis_tasks SET status=?,error='历史失败或待查价' WHERE run_id=?")
        .run(state, id);
      crawl.db.prepare("UPDATE analysis_runs SET status='paused' WHERE id=?").run(id);
      crawl.markUnavailable("a", "官网商品已不存在，无法补齐，已跳过且不再重试：HTTP 410");
      await expect(runner.resume(id)).resolves.toBe(id);
      await runner.settled();
      expect(analyze).not.toHaveBeenCalled();
      expect(store.run(id)).toMatchObject({
        status: "completed",
        total: 0,
        queued: 0,
        failed: 0,
        waitingPricing: 0,
      });
      expect(
        crawl.db.prepare("SELECT status FROM analysis_tasks WHERE run_id=?").get(id),
      ).toMatchObject({ status: "skipped" });
    },
  );
  it("查价期间商品确认不存在但同时发生登录失效，仍暂停整批而不吞掉访问错误", async () => {
    const { crawl, store, runner, analyze, profile, searchEquipment } = await valuationSetup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    searchEquipment.mockImplementationOnce(async () => {
      await gate;
      throw new Error("网站登录已失效，请扫码登录");
    });
    const id = await runner.start("codex", true, profile);
    await vi.waitFor(() => expect(searchEquipment).toHaveBeenCalledOnce());
    crawl.markUnavailable("a", "官网商品已不存在，无法补齐，已跳过且不再重试：HTTP 410");
    release();
    await runner.settled();
    expect(analyze).not.toHaveBeenCalled();
    expect(store.run(id)).toMatchObject({
      status: "paused",
      error: expect.stringContaining("登录已失效"),
    });
  });
  it("已发出的模型请求在确认不存在后保留历史attempt，商品不再发布或重试", async () => {
    const { crawl, store, runner, analyze } = setup(["a"]);
    const original = analyze.getMockImplementation()!;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    analyze.mockImplementationOnce(async (...args) => {
      const response = await original(...args);
      await gate;
      return response;
    });
    const id = await runner.start("codex", true);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    crawl.markUnavailable("a", "官网商品已不存在，无法补齐，已跳过且不再重试：HTTP 404");
    release();
    await runner.settled();
    expect(crawl.records(1, 20, "complete").items).toEqual([]);
    expect(crawl.retryItems()).toEqual([]);
    expect(
      crawl.db.prepare("SELECT state,raw_response FROM analysis_attempts").get(),
    ).toMatchObject({ state: "completed", raw_response: expect.any(String) });
    expect(store.run(id)).toMatchObject({ queued: 0, failed: 0 });
  });
  it.each(["start", "resume"] as const)(
    "%s 连接 AI 期间开始关停，连接返回后不启动分析或获取租约",
    async (operation) => {
      const { store, runner, connect, analyze } = setup();
      const id = operation === "resume" ? store.createRun("codex", "test-model") : undefined;
      const acquire = vi.spyOn(store, "acquire");
      connect.mockImplementation(async () => {
        beginServiceShutdown();
        return { model: "test-model", analyze };
      });
      await expect(id ? runner.resume(id) : runner.start("codex")).rejects.toThrow("正在关闭");
      expect(analyze).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    },
  );

  it("仅上次实际返回错误输出时附加校验反馈，后续无输出超时不沿用旧反馈", async () => {
    const { store, runner, analyze, profile } = await valuationSetup();
    analyze
      .mockResolvedValueOnce({ text: "not-json" })
      .mockRejectedValueOnce(new Error("分析超时，请重试"));
    const id = await runner.start("codex", false, profile);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ status: "paused", completed: 0 });
    await runner.resume(id, true);
    await runner.settled();
    expect(analyze.mock.calls[1][0]).toContain("上次输出校验未通过");
    expect(store.run(id)).toMatchObject({ status: "paused", completed: 0 });
    await runner.resume(id, true);
    await runner.settled();
    expect(analyze.mock.calls[2][0]).toBe(analyze.mock.calls[0][0]);
    expect(store.run(id)).toMatchObject({ status: "completed", completed: 1 });
  });
  it("同输入只更新查价时复用已验证本体，不再次调用AI；输入变化则仍调用AI", async () => {
    const context = await valuationSetup();
    const id = await context.runner.start("codex", false, context.profile);
    await context.runner.settled();
    const row = context.store.db
      .prepare("SELECT id,result_json FROM analysis_tasks WHERE run_id=?")
      .get(id)!;
    expect(context.analyze).toHaveBeenCalledTimes(1);
    context.store.db.prepare("UPDATE analysis_tasks SET status='queued' WHERE id=?").run(row.id);
    await context.runner.resume(id);
    await context.runner.settled();
    expect(context.store.run(id)?.completed).toBe(1);
    expect(context.analyze).toHaveBeenCalledTimes(1);
    const attempt = context.store.db
      .prepare(
        "SELECT raw_response,usage_json,request_text FROM analysis_attempts ORDER BY rowid DESC LIMIT 1",
      )
      .get()!;
    expect(attempt.raw_response).toBeNull();
    expect(String(attempt.request_text)).toContain("本次未调用AI");
    expect(JSON.parse(String(attempt.usage_json)).source).toBe("validated-body-recalculation");
    context.store.db
      .prepare("UPDATE analysis_tasks SET status='queued',input_hash='changed-input' WHERE id=?")
      .run(row.id);
    await context.runner.resume(id);
    await context.runner.settled();
    expect(context.analyze).toHaveBeenCalledTimes(2);
  });
  it("非跟随采集的空队列继续仍不连接AI或重算已完成角色", async () => {
    const { store, runner, analyze, connect } = setup(["a"]);
    const id = await runner.start("codex", false, undefined, true);
    await runner.settled();
    expect(store.followsCapture(id)).toBe(false);
    expect(store.run(id)).toMatchObject({ status: "completed", completed: 1, queued: 0 });
    await runner.resume(id, true);
    await runner.settled();
    expect(connect).toHaveBeenCalledOnce();
    expect(analyze).toHaveBeenCalledOnce();
    expect(store.run(id)).toMatchObject({ status: "completed", completed: 1, queued: 0 });
  });

  it("列表摘要保留报价，详情仍返回完整证据，读取不改写保存结果", async () => {
    const { store, runner, profile } = await valuationSetup();
    await runner.start("codex", false, profile);
    await runner.settled();
    const taskId = store.overview().records.items[0].taskId!;
    const result = store.detail(taskId)!.result!;
    const evidence = "真实查价证据".repeat(10000);
    result.valuation!.equipment_pricing!.rawResponse = evidence;
    result.valuation!.pet_pricing!.rawResponse = evidence;
    store.db
      .prepare("UPDATE analysis_tasks SET result_json=? WHERE id=?")
      .run(JSON.stringify(result), taskId);
    const full = store.overview().results.items[0].result;
    const summary = store.overview({ summary: true }).results.items[0].result!;
    expect(summary.valuation!.estimated_value).toBe(full!.valuation!.estimated_value);
    expect(summary.summary).toEqual(full!.summary);
    expect(summary.valuation!.equipment_pricing!.rawResponse).toBe("");
    expect(summary.valuation!.pet_pricing!.rawResponse).toBe("");
    expect(JSON.stringify(summary).length).toBeLessThan(JSON.stringify(full).length / 10);
    expect(store.detail(taskId)!.result).toEqual(result);
    expect(store.overview().results.items[0].result).toEqual(full);
  });
  it("联网查价结果有效时再次开始不创建任务，也不重复查价或 AI", async () => {
    const { store, runner, analyze, profile, searchEquipment, searchPets } = await valuationSetup();
    const first = await runner.start("codex", false, profile);
    await runner.settled();
    const taskId = store.overview().records.items[0].taskId!;
    const original = store.detail(taskId)!;
    const again = await runner.start("codex", false, profile);
    await runner.settled();
    expect(again).toBe(first);
    expect(store.db.prepare("SELECT count(*) AS n FROM analysis_runs").get()!.n).toBe(1);
    expect(searchEquipment).toHaveBeenCalledTimes(1);
    expect(searchPets).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(store.detail(taskId)).toEqual(original);
  });
  it("新增无关区服不重复分析；本角色计价参数变化仍重新分析", async () => {
    const { store, runner, analyze, profile, searchEquipment } = await valuationSetup();
    const first = await runner.start("codex", false, profile);
    await runner.settled();
    const otherServer = createProfile(
      profile.template,
      {
        ...profile.settings,
        servers: [...profile.settings.servers, { serverId: "999999", age: "older", rank: 50 }],
      },
      true,
      true,
    );
    const savedTask = store.overview().results.items[0].taskId;
    expect(otherServer.hash).not.toBe(profile.hash);
    expect(store.overview({ currentProfile: otherServer }).results.items[0]).toMatchObject({
      profileHash: profile.hash,
      profileChanged: false,
    });
    expect(store.overview({ currentProfile: otherServer }).records.items[0].profileChanged).toBe(
      false,
    );
    expect(store.detail(savedTask, otherServer)?.profileChanged).toBe(false);
    const waiting = await runner.start("codex", false, otherServer);
    expect(waiting).not.toBe(first);
    await runner.settled();
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(store.detail(savedTask, otherServer)?.profileChanged).toBe(false);
    const changed = createProfile(
      profile.template,
      {
        ...otherServer.settings,
        servers: otherServer.settings.servers.map((server) =>
          server.serverId === profile.settings.servers[0].serverId
            ? { ...server, rank: 100 }
            : server,
        ),
      },
      true,
      true,
    );
    expect(changed.calculationVersion).toBe(profile.calculationVersion);
    expect(store.overview({ currentProfile: changed }).results.items[0].profileChanged).toBe(true);
    expect(store.overview({ currentProfile: changed }).records.items[0]).toMatchObject({
      state: "completed",
      profileChanged: true,
      valuation: store.detail(savedTask)!.result!.valuation,
    });
    expect(store.overview({ currentProfile: changed }).ranking).toHaveLength(0);
    expect(store.detail(savedTask, changed)?.profileChanged).toBe(true);
    for (const changedSettings of [
      createProfile(profile.template + "\n请补充价格说明。", profile.settings, true, true),
      createProfile(profile.template, profile.settings, false, true),
      createProfile(profile.template, profile.settings, true, false),
    ]) {
      expect(changedSettings.calculationVersion).toBe(profile.calculationVersion);
      expect(
        store.overview({ currentProfile: changedSettings }).results.items[0].profileChanged,
      ).toBe(true);
      expect(store.detail(savedTask, changedSettings)?.profileChanged).toBe(true);
    }
    const next = await runner.start("codex", false, changed);
    await runner.settled();
    expect(next).not.toBe(first);
    expect(searchEquipment).toHaveBeenCalledTimes(2);
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(store.detail(store.overview().records.items[0].taskId!)!.profile!.hash).toBe(
      changed.hash,
    );
    expect(store.overview({ currentProfile: changed }).results.items[0].profileChanged).toBe(false);
    expect(store.overview({ currentProfile: changed }).records.items[0].profileChanged).toBe(false);
    expect(store.detail(savedTask, changed)?.profileChanged).toBe(true);
  });
  it("增量任务只处理新增商品；新任务排队时保留之前的完整结果", async () => {
    const { store, runner, analyze } = setup();
    const first = await runner.start("codex", true, undefined, true, undefined, 1);
    await runner.settled();
    const firstTask = store
      .overview({ runId: first })
      .records.items.find((item) => item.key === "a")!.taskId;
    analyze.mockImplementation(async (prompt, _schema, signal) => {
      if (prompt.includes("商品 ID：b。")) await untilAborted(signal);
      throw new Error("already analysed product must not run");
    });
    const next = await runner.start("codex");
    expect(store.run(next)!.total).toBe(1);
    expect(store.overview().records.items.find((item) => item.key === "a")).toMatchObject({
      taskId: firstTask,
      state: "completed",
      summary: expect.any(String),
    });
    expect(store.overview().results.items).toHaveLength(1);
    expect(store.overview().results.items[0]).toMatchObject({
      taskId: firstTask,
      name: "角色a",
      result: { productKey: "a", summary: expect.any(String) },
    });
    expect(analyze).toHaveBeenCalledTimes(2);
    await runner.pause(next);
  });
  it("报价快照过期仍重新查价，不能复用过期估值", async () => {
    const { store, runner, profile, searchEquipment, searchPets, analyze } = await valuationSetup();
    const first = await runner.start("codex", false, profile);
    await runner.settled();
    const taskId = store.overview().records.items[0].taskId!;
    const result = store.detail(taskId)!.result!;
    result.valuation!.equipment_pricing!.searchedAt = new Date(
      Date.now() - 25 * 3600_000,
    ).toISOString();
    store.db
      .prepare("UPDATE analysis_tasks SET result_json=? WHERE id=?")
      .run(JSON.stringify(result), taskId);
    const next = await runner.start("codex", false, profile);
    await runner.settled();
    expect(next).not.toBe(first);
    expect(searchEquipment).toHaveBeenCalledTimes(2);
    expect(searchPets).toHaveBeenCalledTimes(2);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("全部已完成但结果分散在多个任务时，不新建任务且两个商品都仍展示", async () => {
    const { store, runner, analyze } = setup();
    const first = await runner.start("codex", true, undefined, true, undefined, 1);
    await runner.settled();
    store.db
      .prepare("UPDATE analysis_runs SET created_at=? WHERE id=?")
      .run(new Date(Date.now() - 1000).toISOString(), first);
    const second = await runner.start("codex");
    await runner.settled();
    expect(first).not.toBe(second);
    expect(store.run(second)).toMatchObject({ total: 1, completed: 1 });
    const noop = await runner.start("codex");
    await runner.settled();
    expect(noop).toBe(second);
    expect(store.overview().runs).toHaveLength(2);
    expect(store.overview().records.items.map((item) => [item.key, item.state])).toEqual([
      ["a", "completed"],
      ["b", "completed"],
    ]);
    expect(store.overview().results.total).toBe(2);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("结果按商品去重并分页，重分析后仍保留完整依据和旧调用", async () => {
    const keys = Array.from({ length: 23 }, (_, index) => `product-${index}`);
    const { store, runner, analyze } = setup(keys);
    const first = await runner.start("codex");
    await runner.settled();
    const oldTask = store.overview({ runId: first }).results.items[0].taskId;
    expect(store.overview().results).toMatchObject({ page: 1, total: 23, totalPages: 2 });
    expect(store.overview().results.items).toHaveLength(20);
    expect(store.overview({ resultsPage: 2 }).results.items).toHaveLength(3);
    const updatedKey = store.detail(oldTask)!.result!.productKey;
    await runner.start("codex", true, undefined, true, undefined, 1, [updatedKey]);
    await runner.settled();
    const results = store.overview().results;
    expect(results.total).toBe(23);
    expect(results.items.filter((item) => item.result.productKey === updatedKey)).toHaveLength(1);
    expect(results.items[0]).toMatchObject({
      name: `角色${updatedKey}`,
      result: {
        productKey: updatedKey,
        summary: expect.any(String),
        dimensions: {
          foundation: { evidence: expect.any(Array) },
          equipment: { evidence: expect.any(Array) },
          pets: { evidence: expect.any(Array) },
        },
      },
    });
    expect(store.detail(oldTask)!.attempts).toHaveLength(1);
    expect(analyze).toHaveBeenCalledTimes(24);
  });

  it("指定商品试分析只分析所选商品，保留选择顺序", async () => {
    const { crawl, store, runner, analyze } = setup(["a", "b", "c"]);
    const id = await runner.start("codex", true, undefined, true, undefined, 2, ["c", "b"]);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ total: 2, completed: 2, failed: 0 });
    expect(
      crawl.db
        .prepare("SELECT listing_key FROM analysis_tasks WHERE run_id=? ORDER BY ordinal")
        .all(id)
        .map((t) => t.listing_key),
    ).toEqual(["c", "b"]);
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it.each(["missing", "pending"])(
    "指定商品%s不存在或未采齐时回滚整批，不分析其它商品",
    async (key) => {
      const { crawl, runner, analyze } = setup(["a"]);
      crawl.observe(analysisRecord("pending").listing);
      await expect(
        runner.start("codex", true, undefined, true, undefined, 2, ["a", key]),
      ).rejects.toThrow("指定商品不存在或详情未完成");
      expect(crawl.db.prepare("SELECT COUNT(*) n FROM analysis_runs").get()?.n).toBe(0);
      expect(analyze).not.toHaveBeenCalled();
      expect(crawl.db.prepare("SELECT COUNT(*) n FROM analysis_tasks").get()?.n).toBe(0);
      expect(crawl.db.prepare("SELECT COUNT(*) n FROM analysis_lock").get()?.n).toBe(0);
    },
  );

  it("重复或与试分析数量不符的选择在连接AI前被拒绝", async () => {
    const { runner, connect } = setup(["a", "b"]);
    await expect(
      runner.start("codex", true, undefined, true, undefined, 2, ["a", "a"]),
    ).rejects.toThrow("不同的商品 ID");
    await expect(runner.start("codex", true, undefined, true, undefined, 2, ["a"])).rejects.toThrow(
      "数量一致",
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it("当前任务执行中拒绝指定商品试分析，不把现有批次当作选择结果", async () => {
    const { runner, analyze } = setup(["a", "b"]);
    analyze.mockImplementation((_prompt, _schema, signal) => untilAborted(signal));
    await runner.start("codex", true, undefined, true);
    await expect(runner.start("codex", true, undefined, true, undefined, 1, ["b"])).rejects.toThrow(
      "请先暂停当前分析",
    );
    expect(analyze).toHaveBeenCalledOnce();
    await runner.pause();
  });

  it("完成后宝宝行情过期会标记过时，原价格和证据仍能在历史查看", async () => {
    const { store, runner, profile } = await valuationSetup();
    const id = await runner.start("codex", true, profile);
    await runner.settled();
    expect(store.overview({ runId: id }).records.items[0].state).toBe("completed");
    const taskId = store.overview({ runId: id }).records.items[0].taskId!;
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    store.db
      .prepare(
        "UPDATE analysis_tasks SET result_json=json_set(result_json,'$.valuation.pet_pricing.searchedAt',?) WHERE id=?",
      )
      .run(oldTime, taskId);
    expect(store.overview({ runId: id }).ranking).toHaveLength(0);
    expect(store.overview({ runId: id }).records.items[0].state).toBe("stale");
    expect(store.detail(taskId)?.result?.valuation).toMatchObject({
      decision: "BUY",
      pet_pricing: { searchedAt: oldTime },
    });
  });
  it("装备成功后宝宝查价暂停，恢复复用装备快照并把宝宝价格接入结论", async () => {
    const { store, runner, analyze, profile, pricing, petPricing, searchEquipment, searchPets } =
      await valuationSetup();
    searchPets.mockImplementationOnce((_record, signal) => untilAborted(signal));
    const id = await runner.start("codex", true, profile);
    await vi.waitFor(() => expect(searchPets).toHaveBeenCalledOnce());
    expect(store.run(id)?.phase).toBe("pet_search");
    expect(analyze).not.toHaveBeenCalled();
    await runner.pause(id);
    expect(store.run(id)).toMatchObject({ status: "paused", queued: 1, completed: 0 });
    const taskId = store.overview({ runId: id }).records.items[0].taskId!;
    expect(store.detail(taskId)).toMatchObject({
      equipmentPricing: pricing,
      petPricing: null,
      attempts: [],
    });
    await runner.resume(id);
    await runner.settled();
    expect(searchEquipment).toHaveBeenCalledOnce();
    expect(searchPets).toHaveBeenCalledTimes(2);
    expect(store.run(id)).toMatchObject({ completed: 1, failed: 0 });
    expect(store.detail(taskId)?.result?.valuation).toMatchObject({
      pet_value: 0,
      pet_pricing: petPricing,
    });
    expect(analyze.mock.calls[0][0]).toContain(petPricing.inputHash);
  });

  it("联网宝宝快照的资料哈希不一致时暂停，不能把另一角色报价用于当前任务", async () => {
    const { store, runner, analyze, profile, petPricing, searchPets } = await valuationSetup();
    searchPets.mockResolvedValueOnce({ ...petPricing, inputHash: "another-role" });
    const id = await runner.start("codex", true, profile);
    await runner.settled();
    expect(store.run(id)).toMatchObject({
      status: "paused",
      queued: 1,
      error: "宝宝查价资料与当前任务不匹配",
    });
    expect(analyze).not.toHaveBeenCalled();
  });

  it("先完成装备查价并持久化快照，才开始当前商品分析", async () => {
    const { crawl, store, runner, analyze, profile, pricing, searchEquipment } =
      await valuationSetup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    searchEquipment.mockImplementationOnce(async () => {
      await gate;
      return pricing;
    });
    const id = await runner.start("codex", true, profile);
    await vi.waitFor(() => expect(searchEquipment).toHaveBeenCalledOnce());
    expect(analyze).not.toHaveBeenCalled();
    expect(
      crawl.db.prepare("SELECT status,attempt_count FROM analysis_tasks WHERE run_id=?").get(id),
    ).toMatchObject({ status: "running", attempt_count: 0 });
    release();
    await runner.settled();
    expect(store.run(id)).toMatchObject({ completed: 1, failed: 0 });
    const taskId = store.overview({ runId: id }).records.items[0].taskId!;
    expect(store.detail(taskId)?.result?.valuation?.equipment_pricing).toEqual(pricing);
    expect(analyze).toHaveBeenCalledOnce();
    expect(analyze.mock.calls[0][0]).toContain(pricing.inputHash);
  });

  it("装备和宝宝多轮查价原文保留在数据库，但不进入AI输入", async () => {
    const { store, runner, analyze, profile, pricing, petPricing } = await valuationSetup();
    for (const [kind, snapshot] of [
      ["equipment", pricing],
      ["pet", petPricing],
    ] as const) {
      const internal = "internal-search-" + kind;
      snapshot.queries = [kind + "-verified-filters"];
      snapshot.requestText = internal + "-current-request";
      snapshot.rawResponse = internal + "-current-response";
      snapshot.searchItems = [{ id: internal + "-current-items" }];
      snapshot.searchAttempts = [1, 2].map((attempt) => ({
        searchedAt: snapshot.searchedAt,
        queries: snapshot.queries,
        requestText: internal + "-request-" + attempt,
        requestHash: internal + "-hash-" + attempt,
        rawResponse: internal + "-response-" + attempt,
        searchItems: [{ id: internal + "-items-" + attempt }],
      }));
    }
    const id = await runner.start("codex", true, profile);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ completed: 1, failed: 0 });
    expect(analyze).toHaveBeenCalledOnce();
    const prompt = analyze.mock.calls[0][0];
    expect(prompt).not.toContain('"searchAttempts"');
    for (const [kind, snapshot] of [
      ["equipment", pricing],
      ["pet", petPricing],
    ] as const) {
      expect(prompt).not.toContain("internal-search-" + kind);
      expect(prompt).toContain(snapshot.inputHash);
      expect(prompt).toContain(JSON.stringify(snapshot.queries));
    }
    const taskId = store.overview({ runId: id }).records.items[0].taskId!;
    expect(store.detail(taskId)).toMatchObject({ equipmentPricing: pricing, petPricing });
    expect(store.detail(taskId)?.result?.valuation).toMatchObject({
      equipment_pricing: pricing,
      pet_pricing: petPricing,
    });
  });

  it("分析校验失败暂停，显式重试复用查价快照，不重复联网搜索", async () => {
    const { store, runner, analyze, profile, pricing, searchEquipment } = await valuationSetup();
    analyze.mockResolvedValueOnce({ text: "invalid-json" });
    const id = await runner.start("codex", true, profile);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ status: "paused", completed: 0, failed: 1 });
    expect(analyze).toHaveBeenCalledOnce();
    await runner.resume(id, true);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ completed: 1, failed: 0 });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(searchEquipment).toHaveBeenCalledOnce();
    const taskId = store.overview({ runId: id }).records.items[0].taskId!;
    const detail = store.detail(taskId)!;
    expect(detail.result?.valuation?.equipment_pricing).toEqual(pricing);
    expect(detail.attempts).toHaveLength(2);
    for (const attempt of detail.attempts) expect(attempt.requestText).toContain(pricing.inputHash);
  });

  it("恢复时重查旧比较规则的装备快照，保留宝宝快照", async () => {
    const { store, runner, analyze, profile, pricing, searchEquipment, searchPets } =
      await valuationSetup();
    analyze.mockResolvedValueOnce({ text: "invalid-json" });
    const id = await runner.start("codex", true, profile);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ status: "paused", failed: 1 });
    const taskId = store.overview({ runId: id }).records.items[0].taskId!;
    store.db
      .prepare(
        "UPDATE analysis_tasks SET equipment_pricing_json=json_set(equipment_pricing_json,'$.inputHash',?) WHERE id=?",
      )
      .run("previous-comparison-policy", taskId);
    await runner.resume(id, true);
    await runner.settled();
    expect(searchEquipment).toHaveBeenCalledTimes(2);
    expect(searchPets).toHaveBeenCalledOnce();
    expect(store.run(id)).toMatchObject({ completed: 1, failed: 0 });
    expect(store.detail(taskId)?.result?.valuation?.equipment_pricing).toEqual(pricing);
  });

  it("查价中暂停保留当前队列，恢复后重新查价，不创建半成品分析尝试", async () => {
    const { crawl, store, runner, analyze, profile, pricing, searchEquipment } =
      await valuationSetup();
    searchEquipment.mockImplementationOnce((_record, signal) => untilAborted(signal));
    const id = await runner.start("codex", true, profile);
    await vi.waitFor(() => expect(searchEquipment).toHaveBeenCalledOnce());
    await runner.pause(id);
    expect(store.run(id)).toMatchObject({ status: "paused", completed: 0, queued: 1 });
    expect(
      crawl.db.prepare("SELECT status,attempt_count FROM analysis_tasks WHERE run_id=?").get(id),
    ).toMatchObject({ status: "queued", attempt_count: 0 });
    expect(crawl.db.prepare("SELECT count(*) total FROM analysis_attempts").get()?.total).toBe(0);
    expect(analyze).not.toHaveBeenCalled();
    await runner.resume(id);
    await runner.settled();
    expect(searchEquipment).toHaveBeenCalledTimes(2);
    expect(analyze).toHaveBeenCalledOnce();
    expect(store.run(id)).toMatchObject({ completed: 1, failed: 0 });
    const taskId = store.overview({ runId: id }).records.items[0].taskId!;
    expect(store.detail(taskId)?.result?.valuation?.equipment_pricing).toEqual(pricing);
  });

  it("查价成功后分析中断，恢复继续使用原快照", async () => {
    const { store, runner, analyze, profile, pricing, searchEquipment } = await valuationSetup();
    analyze.mockImplementationOnce((_prompt, _schema, signal) => untilAborted(signal));
    const id = await runner.start("codex", true, profile);
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledOnce());
    await runner.pause(id);
    expect(store.run(id)).toMatchObject({ status: "paused", queued: 1 });
    await runner.resume(id);
    await runner.settled();
    expect(searchEquipment).toHaveBeenCalledOnce();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(store.run(id)).toMatchObject({ completed: 1, failed: 0 });
    const taskId = store.overview({ runId: id }).records.items[0].taskId!;
    expect(store.detail(taskId)?.result?.valuation?.equipment_pricing).toEqual(pricing);
  });
  it.each(["equipment", "pet"] as const)(
    "%s未完成快照进入待补齐，不调用AI；显式重试传递原进度并覆盖快照",
    async (module) => {
      const { store, runner, analyze, profile, pricing, petPricing, searchEquipment, searchPets } =
        await valuationSetup();
      const search = module === "equipment" ? searchEquipment : searchPets;
      const snapshot = module === "equipment" ? pricing : petPricing;
      const partial = { ...snapshot, searchComplete: false };
      if (module === "equipment")
        searchEquipment.mockResolvedValueOnce({ ...pricing, searchComplete: false });
      else searchPets.mockResolvedValueOnce({ ...petPricing, searchComplete: false });
      const id = await runner.start("codex", true, profile);
      await runner.settled();
      expect(store.run(id)).toMatchObject({
        status: "paused",
        completed: 0,
        queued: 0,
        waitingPricing: 1,
      });
      expect(analyze).not.toHaveBeenCalled();
      await expect(runner.resume(id)).rejects.toThrow("先重试");
      expect(
        store.detail(store.overview({ runId: id }).records.items[0].taskId!)![
          module === "equipment" ? "equipmentPricing" : "petPricing"
        ],
      ).toEqual(partial);
      let release!: () => void;
      const resumedSearch = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (module === "equipment")
        searchEquipment.mockImplementationOnce(async (_record, signal) => {
          await Promise.race([resumedSearch, untilAborted(signal)]);
          return pricing;
        });
      else
        searchPets.mockImplementationOnce(async (_record, signal) => {
          await Promise.race([resumedSearch, untilAborted(signal)]);
          return petPricing;
        });
      await runner.resume(id, true);
      await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(2));
      expect(store.run(id)?.phase).toBe(module === "equipment" ? "equipment_search" : "pet_search");
      expect(analyze).not.toHaveBeenCalled();
      release();
      await runner.settled();
      expect(search).toHaveBeenCalledTimes(2);
      expect(search.mock.calls[1][module === "equipment" ? 3 : 2]).toEqual(partial);
      expect(analyze).toHaveBeenCalledOnce();
      expect(store.run(id)).toMatchObject({ status: "completed", completed: 1, failed: 0 });
    },
  );

  it("未提供联网查价客户端时暂停队列，显示可识别错误", async () => {
    const { store, runner, analyze, connect, profile } = await valuationSetup();
    connect.mockResolvedValue({ model: "test-model", analyze });
    const id = await runner.start("codex", true, profile);
    await runner.settled();
    expect(store.run(id)).toMatchObject({
      status: "paused",
      queued: 1,
      error: "装备联网查价尚未连接",
    });
    expect(analyze).not.toHaveBeenCalled();
  });
  it("先分析一件选择列表首个完整商品，而不是最早入库的商品", async () => {
    const { crawl, store, runner, analyze } = setup(["b", "a"]);
    crawl.db.prepare("UPDATE listings SET first_seen_at=? WHERE key=?").run("2020-01-01", "b");
    crawl.db.prepare("UPDATE listings SET first_seen_at=? WHERE key=?").run("2021-01-01", "a");
    const firstVisible = store.overview().records.items[0];
    const id = await runner.start("codex", true, undefined, true, "gpt-6-luna");
    await runner.settled();
    const detail = store.detail(store.overview({ runId: id }).records.items[0].taskId!)!;
    expect(detail.listing.key).toBe(firstVisible.key);
    expect(detail.listing.key).toBe("a");
    expect(detail.model).toBe("gpt-6-luna");
    expect(store.run(id)).toMatchObject({ total: 1, completed: 1 });
    expect(analyze).toHaveBeenCalledOnce();
  });

  it("模型选择写入批次并用于调用，更换模型不复用其他模型的结果", async () => {
    const { store, runner, connect, analyze } = setup(["a"]);
    const original = await runner.start("codex");
    await runner.settled();
    const selected = await runner.start("codex", false, undefined, false, "other-model");
    await runner.settled();
    expect(connect).toHaveBeenLastCalledWith("codex", "other-model");
    expect(store.run(selected)).toMatchObject({ model: "other-model", completed: 1, reused: 0 });
    expect(store.run(original)?.model).toBe("test-model");
    expect(analyze).toHaveBeenCalledTimes(2);
  });

  it("并发1时试分析3件按列表顺序逐件入库，排除第4件与待补采商品", async () => {
    const { crawl, store, runner, analyze, connect } = setup(["d", "c", "b", "a"]);
    crawl.observe(analysisRecord("pending").listing);
    const original = analyze.getMockImplementation()!;
    analyze.mockImplementation(async (prompt, schema, signal) => {
      expect(store.run(store.activeRun()!.id)?.completed).toBe(analyze.mock.calls.length - 1);
      return original(prompt, schema, signal);
    });
    const id = await runner.start("codex", true, undefined, true, "gpt-6-luna", 3, undefined, 1);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ total: 3, completed: 3, failed: 0, model: "gpt-6-luna" });
    expect(analyze).toHaveBeenCalledTimes(3);
    const tasks = crawl.db
      .prepare("SELECT listing_key FROM analysis_tasks WHERE run_id=? ORDER BY ordinal")
      .all(id);
    expect(tasks.map((task) => task.listing_key)).toEqual(["a", "b", "c"]);
    await expect(runner.start("codex", true, undefined, true, "gpt-6-luna", 4)).rejects.toThrow(
      "1 到 3 件",
    );
    expect(connect).toHaveBeenCalledTimes(1);
    expect(analyze).toHaveBeenCalledTimes(3);
  });

  it("并发1时每件完整原文只发送一次，结果提交后才发下一件，未补采商品不入队", async () => {
    const { crawl, store, runner, analyze } = setup();
    crawl.observe(analysisRecord("pending").listing);
    let release!: () => void;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const defaultAnalyze = analyze.getMockImplementation()!;
    analyze.mockImplementation(async (prompt, schema, signal) => {
      if (analyze.mock.calls.length === 1) await first;
      else expect(store.run(store.activeRun()!.id)?.completed).toBe(1);
      return defaultAnalyze(prompt, schema, signal);
    });
    const id = await runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(store.run(id)).toMatchObject({ status: "running", total: 2, completed: 0 });
    expect(() => crawl.clear()).toThrow("分析任务仍在执行");
    release();
    await runner.settled();
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(store.run(id)).toMatchObject({ status: "completed", total: 2, completed: 2 });
    const overview = store.overview({ runId: id });
    expect(overview.counts).toEqual({
      total: 3,
      complete: 2,
      waitingDetail: 1,
      pendingDetail: 1,
      failedDetail: 0,
    });
    const detail = store.detail(overview.records.items[0].taskId!)!;
    expect(detail.inputText).toBe(buildProductDocument(crawl.detail("a") as SavedRoleRecord).text);
    expect(analyze.mock.calls[0][0]).toContain(detail.inputText);
    expect(detail.attempts[0]).toMatchObject({
      state: "completed",
      rawResponse: expect.any(String),
      usage: { input_tokens: 100, output_tokens: 20 },
    });
  });
  it("连续点击与另一个服务不会重复调用；其他提供方不能挤占当前队列", async () => {
    const { store, runner, analyze, connect } = setup(["a"]);
    analyze.mockImplementation((_prompt, _schema, signal) => untilAborted(signal));
    const [one, two] = await Promise.all([runner.start("codex"), runner.start("codex")]);
    expect(one).toBe(two);
    expect(analyze).toHaveBeenCalledTimes(1);
    const other = new AnalysisRunner(new AnalysisStore(store.db), connect);
    expect(await other.start("codex")).toBe(one);
    await expect(other.start("deepseek")).rejects.toThrow("另一个本机服务");
    await expect(runner.start("deepseek")).rejects.toThrow("暂停");
    await other.shutdown();
    expect(store.run(one)?.status).toBe("running");
    await runner.pause(one);
  });
  it("暂停中断当前件，已完成结果保留，继续使用原提供方和模型", async () => {
    const { store, runner, analyze, connect } = setup();
    const defaultAnalyze = analyze.getMockImplementation()!;
    analyze
      .mockImplementationOnce(defaultAnalyze)
      .mockImplementationOnce((_p, _s, signal) => untilAborted(signal));
    const id = await runner.start("deepseek");
    await vi.waitFor(() => expect(analyze).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(store.run(id)?.completed).toBe(1));
    await runner.pause(id);
    expect(store.run(id)).toMatchObject({ status: "paused", completed: 1, queued: 1 });
    const interrupted = store
      .overview({ runId: id })
      .history.find((entry) => entry.state === "interrupted");
    expect(interrupted).toBeDefined();
    await runner.resume(id);
    await runner.settled();
    expect(connect).toHaveBeenLastCalledWith("deepseek", "test-model");
    expect(store.run(id)).toMatchObject({ status: "completed", completed: 2 });
    expect(analyze).toHaveBeenCalledTimes(3);
  });
  it("服务中断后的执行中记录恢复为暂停，不把半成品计为成功", () => {
    const { store } = setup(["a"]);
    store.acquire("crashed-process");
    const id = store.createRun("codex", "test-model");
    store.begin(store.next(id)!, "crashed-process");
    store.db.prepare("UPDATE analysis_lock SET expires_at=?").run(Date.now() - 1);
    const reopened = new AnalysisStore(store.db);
    expect(reopened.run(id)).toMatchObject({ status: "paused", queued: 1, completed: 0 });
    expect(reopened.overview({ runId: id }).history[0].state).toBe("interrupted");
  });
  it("失去执行锁的旧进程不能覆盖接管后的商品或批次状态", () => {
    const { store } = setup(["a"]);
    store.acquire("old-process");
    const id = store.createRun("codex", "test-model");
    const task = store.next(id)!;
    const oldAttempt = store.begin(task, "old-process");
    store.db.prepare("UPDATE analysis_lock SET expires_at=?").run(Date.now() - 1);
    store.recover();
    store.acquire("new-process");
    store.setRun(id, "running", null, "new-process");
    store.begin(store.next(id)!, "new-process");
    expect(() =>
      store.finish(task, oldAttempt, "old-process", { state: "failed", raw: "late reply" }),
    ).toThrow("分析锁已失效");
    store.setRun(id, "completed", null, "old-process");
    expect(store.run(id)).toMatchObject({ status: "running", completed: 0 });
    const attempts = store.detail(task.id)!.attempts;
    expect(attempts[0]).toMatchObject({ state: "interrupted", rawResponse: null });
    expect(attempts[1].state).toBe("running");
    store.release("new-process");
    store.recover();
  });
  it("相同输入复用，变化后旧结果标为过时；原文和原始回复仍可追溯", async () => {
    const { crawl, store, runner, analyze } = setup(["a"]);
    const first = await runner.start("codex");
    await runner.settled();
    const original = store.detail(store.overview({ runId: first }).records.items[0].taskId!)!;
    const reused = await runner.start("codex");
    await runner.settled();
    expect(reused).toBe(first);
    expect(store.run(reused)).toMatchObject({ completed: 1, reused: 0 });
    expect(store.db.prepare("SELECT count(*) n FROM analysis_runs").get()!.n).toBe(1);
    const reusedDetail = store.detail(store.overview({ runId: reused }).records.items[0].taskId!)!;
    expect(reusedDetail.taskId).toBe(original.taskId);
    expect(reusedDetail.attempts).toEqual(original.attempts);
    expect(analyze).toHaveBeenCalledTimes(1);
    const changed = crawl.detail("a") as SavedRoleRecord;
    changed.listing.price = "333";
    crawl.observe(changed.listing);
    expect(store.overview({ runId: first }).records.items[0].state).toBe("stale");
    expect(store.overview({ runId: first }).ranking).toHaveLength(0);
    expect(store.detail(original.taskId)?.inputText).toBe(original.inputText);
    const next = await runner.start("codex");
    await runner.settled();
    expect(store.run(next)).toMatchObject({ completed: 1, reused: 0 });
    expect(analyze).toHaveBeenCalledTimes(2);
    await runner.start("codex", true);
    await runner.settled();
    expect(analyze).toHaveBeenCalledTimes(3);
    await runner.start("deepseek");
    await runner.settled();
    expect(analyze).toHaveBeenCalledTimes(4);
  });
  it("格式或依据错误每次立即暂停，保留原始回复，显式重试后按顺序完成", async () => {
    const { store, runner, analyze } = setup();
    analyze
      .mockResolvedValueOnce({ text: "not-json" })
      .mockResolvedValueOnce({ text: "still-invalid" });
    const id = await runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ status: "paused", failed: 1, completed: 0, queued: 1 });
    expect(analyze).toHaveBeenCalledOnce();
    await expect(runner.resume(id)).rejects.toThrow("先重试");
    const failed = store
      .overview({ runId: id })
      .records.items.find((item) => item.state === "failed")!;
    expect(store.detail(failed.taskId!)?.attempts.map((attempt) => attempt.rawResponse)).toEqual([
      "not-json",
    ]);
    await runner.resume(id, true);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ status: "paused", failed: 1, completed: 0, queued: 1 });
    expect(analyze).toHaveBeenCalledTimes(2);
    expect(store.detail(failed.taskId!)?.attempts.map((attempt) => attempt.rawResponse)).toEqual([
      "not-json",
      "still-invalid",
    ]);
    await runner.resume(id, true);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ failed: 0, completed: 2 });
    expect(analyze).toHaveBeenCalledTimes(4);
  });
  it("额度或登录错误暂停整批，不继续消耗后面的调用；过长原文保留但不截断发送", async () => {
    const { store, runner, analyze } = setup();
    analyze.mockRejectedValueOnce(new Error("429 quota exceeded"));
    const id = await runner.start("codex", false, undefined, false, undefined, 1, undefined, 1);
    await runner.settled();
    expect(store.run(id)).toMatchObject({ status: "paused", completed: 0, queued: 2 });
    expect(analyze).toHaveBeenCalledTimes(1);
    await runner.resume(id);
    await runner.settled();
    expect(store.run(id)?.completed).toBe(2);
    store.db
      .prepare(
        "UPDATE listings SET detail_json=json_set(detail_json,'$.raw.large',?) WHERE key='a'",
      )
      .run("大".repeat(100_000));
    const large = await runner.start("codex");
    await runner.settled();
    expect(store.run(large)).toMatchObject({ failed: 1, completed: 0, total: 1 });
    expect(analyze).toHaveBeenCalledTimes(3);
    const item = store
      .overview({ runId: large })
      .records.items.find((item) => item.state === "failed")!;
    expect(store.detail(item.taskId!)?.inputText).toContain("大".repeat(100_000));
  });
  it("空库试分析不连接 AI，分页查询覆盖全部记录，暂停后清空同时删除分析历史", async () => {
    const { crawl, store, runner, connect } = setup([]);
    await expect(runner.start("codex", false, undefined, true)).rejects.toThrow("暂无详情完整");
    expect(connect).not.toHaveBeenCalled();
    for (let i = 0; i < 25; i++) crawl.observe(analysisRecord(String(i)).listing);
    expect(store.overview({ page: 2 }).records).toMatchObject({
      page: 2,
      totalPages: 2,
      total: 25,
      items: expect.any(Array),
    });
    expect(store.overview({ page: 2 }).records.items).toHaveLength(5);
    expect(store.overview({ search: "角色24" }).records.total).toBe(1);
    expect(store.overview({ filter: "waiting_detail" }).records.total).toBe(25);
    crawl.clear();
    expect(store.overview().counts.total).toBe(0);
  });
});
