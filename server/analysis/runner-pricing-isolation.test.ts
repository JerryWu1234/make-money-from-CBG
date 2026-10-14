import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { CrawlStore } from "../crawler/store";
import type { SavedRoleRecord } from "../crawler/types";
import { AnalysisStore } from "./store";
import {
  AnalysisRunner,
  MAX_PRICING_ROUNDS,
  pricingUntilAborted,
  type AnalysisClient,
} from "./runner";
import { createProfile, DEFAULT_SETTINGS, PROMPT_FILE } from "./profile";
import { equipmentPricingPlan } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";
import { assertPetUIArguments } from "./browser-pet-source";
import { finishPricingSearch } from "./pricing-progress";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks();
});
function setup(petSearch = false) {
  const crawl = new CrawlStore(":memory:");
  for (const key of ["a", "b"]) {
    const record = valuationRecord(key);
    record.detail!.equipmentCapture = {
      version: 1,
      complete: true,
      issues: [],
      collectedAt: record.detail!.collectedAt,
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
    if (petSearch) {
      record.detail!.petCapture = { ...record.detail!.equipmentCapture };
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
    }
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
  }
  const store = new AnalysisStore(crawl.db);
  const profile = createProfile(
    readFileSync(PROMPT_FILE, "utf8"),
    DEFAULT_SETTINGS,
    true,
    petSearch,
  );
  const analyze = vi.fn<AnalysisClient["analyze"]>().mockResolvedValue({
    text: JSON.stringify({
      decision: "NEED_INFO",
      reason: "保留缺项，不生成完整估值",
      extracted_facts: [],
    }),
  });
  const search = vi
    .fn<NonNullable<AnalysisClient["searchEquipment"]>>()
    .mockImplementation(async (record) => ({
      ...equipmentPricingPlan(record),
      searchComplete: true,
    }));
  const searchPets = vi
    .fn<NonNullable<AnalysisClient["searchPets"]>>()
    .mockImplementation(async (record) => ({
      ...equipmentPricingPlan(record),
      ...petInventory(record),
      searchComplete: true,
    }));
  const runner = new AnalysisRunner(store, async () => ({
    model: "test",
    analyze,
    searchEquipment: search,
    searchPets,
  }));
  cleanup.push(async () => {
    await runner.shutdown();
    crawl.db.close();
  });
  return { crawl, store, runner, profile, analyze, search, searchPets };
}
it("宝宝成长表单误差隔离当前角色，后续角色继续且不生成错误报价", async () => {
  const c = setup(true);
  c.searchPets.mockImplementationOnce(async () => {
    assertPetUIArguments({ growth: 1009 }, { growth: 1008 });
    throw new Error("应当先拒绝成长误差");
  });
  const id = await c.runner.start("codex", true, c.profile);
  await c.runner.settled();
  expect(c.store.run(id)).toMatchObject({
    status: "completed",
    completed: 1,
    waitingPricing: 1,
    failed: 0,
    queued: 0,
  });
  expect(c.searchPets).toHaveBeenCalledTimes(2);
  expect(c.analyze).toHaveBeenCalledOnce();
  const task = c.store
    .overview({ runId: id })
    .records.items.find((x) => x.state === "waiting_pricing")!;
  expect(c.store.detail(task.taskId!)?.error).toContain("growth (expected: 1009, actual: 1008)");
  expect(c.store.detail(task.taskId!)?.result).toBeNull();
});
it.each(["宝宝官网表单实际条件与计划不一致：level_min", "藏宝阁登录已失效，请扫码登录"])(
  "其他条件或登录错误仍暂停整个批次：%s",
  async (message) => {
    const c = setup(true);
    c.searchPets.mockRejectedValueOnce(new Error(message));
    const id = await c.runner.start("codex", true, c.profile);
    await c.runner.settled();
    expect(c.store.run(id)).toMatchObject({ status: "paused", queued: 2, waitingPricing: 0 });
    expect(c.searchPets).toHaveBeenCalledOnce();
    expect(c.analyze).not.toHaveBeenCalled();
  },
);
it.each([false, true])("宝宝页面等待20秒超时隔离当前角色，错误保留名称%s", async (keepName) => {
  const c = setup(true);
  const error = new Error("page.waitForFunction: Timeout 20000ms exceeded.");
  if (keepName) error.name = "TimeoutError";
  c.searchPets.mockRejectedValueOnce(error);
  const id = await c.runner.start("codex", true, c.profile);
  await c.runner.settled();
  expect(c.store.run(id)).toMatchObject({
    status: "completed",
    completed: 1,
    waitingPricing: 1,
    queued: 0,
  });
  expect(c.searchPets).toHaveBeenCalledTimes(2);
  expect(c.analyze).toHaveBeenCalledOnce();
});
it("单角色读取失败保留待补齐，下一角色完成；继续不重试，显式重试不重复成功角色", async () => {
  const c = setup();
  c.search.mockImplementationOnce(async (record, _signal, _settings, _previous, report) => {
    report?.({ assetName: "兽王腰带", page: 2, validSamples: 0, retryCount: 2 });
    expect(c.store.activeRun()?.pricingProgress).toMatchObject({
      assetName: "兽王腰带",
      page: 2,
      retryCount: 2,
    });
    return { ...equipmentPricingPlan(record), searchComplete: false };
  });
  const id = await c.runner.start("codex", true, c.profile);
  await c.runner.settled();
  expect(c.store.run(id)).toMatchObject({
    status: "completed",
    completed: 1,
    waitingPricing: 1,
    queued: 0,
    failed: 0,
  });
  expect(c.analyze).toHaveBeenCalledOnce();
  const item = c.store
    .overview({ runId: id })
    .records.items.find((item) => item.state === "waiting_pricing")!;
  const detail = c.store.detail(item.taskId!)!;
  expect(detail.result).toBeNull();
  expect(detail.attempts).toEqual([]);
  expect(detail.equipmentPricing).toMatchObject({ searchComplete: false, total: null });
  expect(detail.error).toContain("单独重试待补齐项");
  const reloaded = new AnalysisRunner(new AnalysisStore(c.crawl.db), async () => ({
    model: "test",
    analyze: c.analyze,
    searchEquipment: c.search,
  }));
  await reloaded.resume(id);
  await reloaded.settled();
  expect(c.search).toHaveBeenCalledTimes(2);
  await reloaded.resume(id, true);
  await reloaded.settled();
  expect(c.store.run(id)).toMatchObject({ completed: 2, waitingPricing: 0 });
  expect(c.search).toHaveBeenCalledTimes(3);
  expect(c.search.mock.calls[2][3]?.searchComplete).toBe(false);
  expect(c.analyze).toHaveBeenCalledTimes(2);
  await reloaded.shutdown();
});
it("登录失效暂停整个批次，不越过访问限制处理下一角色", async () => {
  const c = setup();
  c.search.mockRejectedValueOnce(new Error("藏宝阁登录已失效"));
  const id = await c.runner.start("codex", true, c.profile);
  await c.runner.settled();
  expect(c.store.run(id)).toMatchObject({ status: "paused", queued: 2, waitingPricing: 0 });
  expect(c.search).toHaveBeenCalledOnce();
  expect(c.analyze).not.toHaveBeenCalled();
});
it("未知页面结构只隔离当前角色，不生成半成品AI结果", async () => {
  const c = setup();
  c.search.mockRejectedValueOnce(new Error("商品页结构不支持：无法定位主商品容器"));
  const id = await c.runner.start("codex", true, c.profile);
  await c.runner.settled();
  expect(c.store.run(id)).toMatchObject({ completed: 1, waitingPricing: 1, queued: 0 });
  expect(c.analyze).toHaveBeenCalledOnce();
});
it("即使游标持续变化也在自动轮数上限停止，后续角色继续", async () => {
  const c = setup();
  c.search.mockImplementation(async (record) =>
    record.listing.key === "a"
      ? {
          ...equipmentPricingPlan(record),
          searchComplete: false,
          items: [
            {
              key: "test",
              name: "测试装备",
              category: "装备",
              level: 100,
              description: "等级100",
              status: "no_match",
              referencePrice: null,
              query: "",
              candidates: [],
              issues: [],
              searchState: "pending",
              searchCursor: {
                version: 1,
                planHash: "plan",
                modeIndex: 0,
                pageNumber: c.search.mock.calls.length,
                rowIndex: 0,
                pageRowsHash: "rows",
                seen: [],
                failed: [],
              },
            },
          ],
        }
      : { ...equipmentPricingPlan(record), searchComplete: true },
  );
  const id = await c.runner.start("codex", true, c.profile);
  await c.runner.settled();
  expect(c.search).toHaveBeenCalledTimes(MAX_PRICING_ROUNDS + 1);
  expect(c.store.run(id)).toMatchObject({ completed: 1, waitingPricing: 1 });
  const item = c.store
    .overview({ runId: id })
    .records.items.find((item) => item.state === "waiting_pricing")!;
  expect(c.store.detail(item.taskId!)?.error).toContain("自动查价上限");
});
it("调用忽略取消时暂停仍立即结束，不留running任务", async () => {
  const c = setup();
  c.search.mockImplementationOnce(() => new Promise(() => {}));
  const id = await c.runner.start("codex", true, c.profile);
  await vi.waitFor(() => expect(c.search).toHaveBeenCalledOnce());
  await c.runner.pause(id);
  expect(c.store.run(id)).toMatchObject({ status: "paused", queued: 2, waitingPricing: 0 });
  expect(
    c.store.db.prepare("select count(*) n from analysis_tasks where status='running'").get()!.n,
  ).toBe(0);
});
it("超时取消不依赖提供方结束promise，迟到结果不会改变已结束调用", async () => {
  const controller = new AbortController();
  let finish!: (value: number) => void;
  const pending = pricingUntilAborted(
    new Promise<number>((resolve) => {
      finish = resolve;
    }),
    controller.signal,
  );
  const assertion = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
  controller.abort(new DOMException("查价超时", "TimeoutError"));
  await assertion;
  finish(42);
});

it("查价累计时间到上限时隔离当前角色，即使仍有翻页进展", async () => {
  const c = setup();
  const start = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  let firstRoleRounds = 0;
  c.search.mockImplementation(async (record) => {
    if (record.listing.key !== "a")
      return { ...equipmentPricingPlan(record), searchComplete: true };
    firstRoleRounds++;
    clock.mockReturnValue(start + firstRoleRounds * 8 * 60_000);
    const owner = String(c.store.db.prepare("SELECT owner FROM analysis_lock").get()!.owner);
    expect(c.store.acquire(owner)).toBe(true);
    return {
      ...equipmentPricingPlan(record),
      searchComplete: false,
      items: [
        {
          key: "test",
          name: "测试装备",
          category: "装备",
          level: 100,
          description: "等级100",
          status: "no_match",
          referencePrice: null,
          query: "",
          candidates: [],
          issues: [],
          searchState: "pending",
          searchCursor: {
            version: 1,
            planHash: "plan",
            modeIndex: 0,
            pageNumber: firstRoleRounds,
            rowIndex: 0,
            pageRowsHash: "rows",
            seen: [],
            failed: [],
          },
        },
      ],
    };
  });
  const id = await c.runner.start("codex", true, c.profile);
  await c.runner.settled();
  expect(firstRoleRounds).toBe(2);
  expect(c.store.run(id)).toMatchObject({ completed: 1, waitingPricing: 1 });
  clock.mockRestore();
});

it("单次查价超时推进下一角色，忽略迟到的快照", async () => {
  const c = setup();
  const timeout = new AbortController();
  vi.spyOn(AbortSignal, "timeout").mockImplementationOnce(() => timeout.signal);
  let release!: (
    value: Awaited<ReturnType<NonNullable<AnalysisClient["searchEquipment"]>>>,
  ) => void;
  c.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const id = await c.runner.start("codex", true, c.profile);
  await vi.waitFor(() => expect(c.search).toHaveBeenCalledOnce());
  timeout.abort(new DOMException("查价超时", "TimeoutError"));
  await c.runner.settled();
  expect(c.store.run(id)).toMatchObject({ completed: 1, waitingPricing: 1, queued: 0 });
  const item = c.store
    .overview({ runId: id })
    .records.items.find((item) => item.state === "waiting_pricing")!;
  const record = c.crawl.detail(item.key) as SavedRoleRecord;
  release({ ...equipmentPricingPlan(record), searchComplete: true });
  await Promise.resolve();
  expect(c.store.detail(item.taskId!)?.equipmentPricing).toBeNull();
  expect(c.store.detail(item.taskId!)?.result).toBeNull();
  expect(c.analyze).toHaveBeenCalledOnce();
});

it("首屏无样本跳过单件后继续AI分析和下一角色", async () => {
  const c = setup();
  const record = c.crawl.detail("a") as SavedRoleRecord;
  record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items = [
    {
      index: 0,
      kind: "equipment",
      category: "腰带",
      name: "测试腰带",
      description: "等级100\n气血200\n防御50",
    },
  ];
  c.crawl.save(record.listing, record.detail!);
  c.search.mockImplementationOnce(async (record) =>
    finishPricingSearch({
      ...equipmentPricingPlan(record),
      searchComplete: false,
      items: equipmentPricingPlan(record).items.map((item) => ({
        ...item,
        searchState: "pending",
        samplingStopped: true,
        searchCursor: {
          version: 1,
          planHash: "plan",
          modeIndex: 4,
          pageNumber: 1,
          rowIndex: 0,
          pageRowsHash: "",
          seen: [],
          failed: [],
          emptyFirstPageModes: [0, 1, 2, 3],
        },
      })),
    }),
  );
  const id = await c.runner.start("codex", true, c.profile);
  await c.runner.settled();
  expect(c.search).toHaveBeenCalledTimes(2);
  expect(c.store.run(id)).toMatchObject({ completed: 2, waitingPricing: 0, queued: 0 });
  expect(c.analyze).toHaveBeenCalledTimes(2);
  const completed = c.store.overview({ runId: id }).records.items.find((item) => item.key === "a")!;
  const detail = c.store.detail(completed.taskId!)!;
  expect(detail.error).toBeNull();
  expect(detail.equipmentPricing?.total).toBeNull();
  expect(detail.equipmentPricing?.items[0].samplingStopped).toBe(true);
  expect(detail.equipmentPricing?.items[0].searchState).toBe("skipped");
  expect(detail.result).not.toBeNull();
});

it("主动暂停只显示通知，忽略取消的AI调用也能结束；继续复用报价完成队列", async () => {
  const c = setup();
  c.analyze.mockImplementationOnce(() => new Promise(() => {}));
  const id = await c.runner.start("codex", true, c.profile);
  await vi.waitFor(() => expect(c.analyze).toHaveBeenCalledOnce());
  await c.runner.pause(id);
  expect(c.store.run(id)).toMatchObject({
    status: "paused",
    error: null,
    pauseNotice: "已暂停，继续时先处理这件商品",
    queued: 2,
  });
  const a = c.store.overview({ runId: id }).records.items.find((item) => item.key === "a")!;
  expect(c.store.detail(a.taskId!)?.attempts[0].state).toBe("interrupted");
  await c.runner.resume(id);
  await c.runner.settled();
  expect(c.store.run(id)).toMatchObject({ status: "completed", completed: 2 });
  expect(c.search).toHaveBeenCalledTimes(2);
  expect(c.analyze).toHaveBeenCalledTimes(3);
  expect(c.analyze.mock.calls[1][0]).not.toContain("上次输出校验未通过：已暂停");
});

it("真实登录失败仍显示错误，不被主动暂停通知掩盖", async () => {
  const c = setup();
  c.search.mockRejectedValueOnce(new Error("藏宝阁登录已失效"));
  const id = await c.runner.start("codex", true, c.profile);
  await c.runner.settled();
  expect(c.store.run(id)).toMatchObject({
    status: "paused",
    error: "藏宝阁登录已失效",
    pauseNotice: null,
  });
});

it("查价接近时限后，AI分析仍拥有独立的五分钟超时", async () => {
  const c = setup();
  const start = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  const timeouts = vi.spyOn(AbortSignal, "timeout");
  c.search.mockImplementationOnce(async (record) => {
    clock.mockReturnValue(start + 15 * 60_000 - 1000);
    const owner = String(c.store.db.prepare("SELECT owner FROM analysis_lock").get()!.owner);
    expect(c.store.acquire(owner)).toBe(true);
    return { ...equipmentPricingPlan(record), searchComplete: true };
  });
  const id = await c.runner.start("codex", true, c.profile);
  await c.runner.settled();
  expect(timeouts.mock.calls[1][0]).toBe(300_000);
  expect(c.store.run(id)).toMatchObject({ completed: 2, waitingPricing: 0 });
  clock.mockRestore();
});
