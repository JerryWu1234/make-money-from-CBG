import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { searchPetGearPricing } from "./pet-gear-search";
import type { SavedRoleRecord } from "../crawler/types";
import type { PetGearPricingItem } from "./pet-gear-inventory";
import type { EquipmentSearchCursor } from "./equipment-pricing";
import type { PetPricingItem, PetPricingSnapshot } from "./pet-pricing";

const mocks = vi.hoisted(() => ({
  petGearInventory: vi.fn(),
  createPetGearSource: vi.fn(),
  findCandidates: vi.fn(),
  close: vi.fn(),
}));
vi.mock("./browser-pet-gear-source", () => ({ createPetGearSource: mocks.createPetGearSource }));
vi.mock("./pet-gear-inventory", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pet-gear-inventory")>()),
  petGearInventory: mocks.petGearInventory,
}));
const item = (key: string): PetGearPricingItem => ({
  key,
  petKey: "pet:1",
  petName: "画魂",
  name: "宝宝装备",
  level: 25,
  category: "召唤兽装备",
  accessory: false,
  description: "等级25\n速度+10\n耐久100",
  status: "no_match",
  referencePrice: null,
  candidates: [],
  issues: [],
  query: "",
});
const record = {} as SavedRoleRecord;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.petGearInventory.mockReturnValue({
    inputHash: "hash-current",
    captureComplete: true,
    issues: [],
    items: [item("first"), item("second")],
  });
  mocks.findCandidates.mockImplementation(async (items: PetGearPricingItem[]) => ({
    queries: ["【模拟测试】官网界面全服25级"],
    searchItems: [{ simulated: true }],
    items: items.map((item) => ({
      key: item.key,
      candidates: [],
      searchStatus: "completed",
      scopeEvidence: [],
      query: "【模拟测试】",
    })),
  }));
  mocks.close.mockResolvedValue(undefined);
  mocks.createPetGearSource.mockResolvedValue({
    findCandidates: mocks.findCandidates,
    close: mocks.close,
  });
});

describe("分析自动宝宝装备查价与增量复用", () => {
  const parents = (items: Partial<PetPricingItem>[]) => ({ items }) as PetPricingSnapshot;

  it("所属宝宝已跳过时保留全部装备与原因，不打开浏览器，也不保留旧报价", async () => {
    const previous = await searchPetGearPricing(record, new AbortController().signal);
    previous.items[0].referencePrice = 200;
    previous.items[0].status = "priced";
    previous.items[0].baselineEstimate = { amount: 200 } as never;
    previous.items[0].candidates = [{ verified: true, price: 200 } as never];
    mocks.createPetGearSource.mockClear();
    const result = await searchPetGearPricing(
      record,
      new AbortController().signal,
      previous,
      parents([
        { key: "pet:1", name: "画魂", searchState: "skipped", skipReason: "前5条无有效样本" },
      ]),
    );
    expect(mocks.createPetGearSource).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      inputHash: previous.inputHash,
      searchComplete: true,
      total: null,
      knownTotal: 0,
      queries: previous.queries,
      searchItems: previous.searchItems,
    });
    expect(result.items.map((value) => value.key)).toEqual(["first", "second"]);
    for (const value of result.items) {
      expect(value).toMatchObject({
        status: "no_match",
        searchStatus: "skipped",
        searchState: "skipped",
        skippedWithPet: true,
        referencePrice: null,
        candidates: [],
        skipReason: expect.stringContaining("前5条无有效样本"),
        reason: expect.stringContaining("市场售价未知"),
      });
      expect(value.baselineEstimate).toBeUndefined();
    }
  });

  it.each(["pending", "read_failed", "unsupported", "completed", undefined] as const)(
    "仅跳过明确已跳过宝宝的装备，其他宝宝状态 %s 继续核验",
    async (state) => {
      mocks.petGearInventory.mockReturnValue({
        inputHash: "mixed",
        captureComplete: true,
        issues: [],
        items: [item("first"), { ...item("second"), petKey: "pet:2" }],
      });
      const result = await searchPetGearPricing(
        record,
        new AbortController().signal,
        undefined,
        parents([
          { key: "pet:1", name: "画魂", searchState: "skipped" },
          { key: "pet:2", name: "鬼将", searchState: state },
        ]),
      );
      expect(
        mocks.findCandidates.mock.calls[0][0].map((value: PetGearPricingItem) => value.key),
      ).toEqual(["second"]);
      expect(result.items[0].skipReason).toContain("无样本，未计入参考合计");
      expect(result.items[1].skippedWithPet).toBeUndefined();
    },
  );

  it("宝宝重新参与计价时恢复装备核验，不复用旧的关联跳过状态", async () => {
    const first = await searchPetGearPricing(
      record,
      new AbortController().signal,
      undefined,
      parents([{ key: "pet:1", name: "画魂", searchState: "skipped" }]),
    );
    const resumed = await searchPetGearPricing(
      record,
      new AbortController().signal,
      first,
      parents([{ key: "pet:1", name: "画魂", searchState: "completed" }]),
    );
    expect(mocks.findCandidates.mock.calls[0][0]).toHaveLength(2);
    expect(resumed.items.every((value) => !value.skippedWithPet && !value.skipReason)).toBe(true);
  });

  it("已核验各筛选第一页无样本则跳过，未知价格保持null并在续跑时复用", async () => {
    mocks.findCandidates.mockImplementationOnce(async (items: PetGearPricingItem[]) => ({
      queries: ["【模拟测试】严格与相近第一页"],
      searchItems: [{ simulated: true }],
      items: items.map((value) => ({
        key: value.key,
        candidates: [],
        searchStatus: "pending",
        samplingStopped: true,
        scopeEvidence: [],
        note: "第一页无样本，市场售价未知",
        searchCursor: {
          version: 1,
          planHash: "fixture-plan",
          modeIndex: 2,
          pageNumber: 1,
          rowIndex: 0,
          pageRowsHash: "",
          seen: [],
          failed: [],
        },
      })),
    }));
    const first = await searchPetGearPricing(record, new AbortController().signal);
    expect(first.searchComplete).toBe(true);
    expect(
      first.items.every(
        (value) =>
          value.searchStatus === "skipped" &&
          value.searchState === "skipped" &&
          value.referencePrice === null,
      ),
    ).toBe(true);
    expect(first.total).toBeNull();
    mocks.findCandidates.mockClear();
    const resumed = await searchPetGearPricing(record, new AbortController().signal, first);
    expect(resumed.searchComplete).toBe(true);
    expect(mocks.findCandidates).not.toHaveBeenCalled();
  });

  it.each(["pending", "read_failed"] as const)(
    "%s保存筛选游标与候选，下一轮交给来源重新核验",
    async (searchStatus) => {
      const cursor: EquipmentSearchCursor = {
        version: 1,
        planHash: "fixture-plan",
        modeIndex: 1,
        pageNumber: 3,
        rowIndex: 4,
        pageRowsHash: "fixture-rows",
        seen: ["33:fixture"],
        failed: [],
      };
      const candidate = {
        url: "https://xyq.cbg.163.com/equip?s=33&eid=fixture",
        title: "模拟测试宝宝装备",
        price: 200,
        priceType: "listing" as const,
        quote: "【模拟测试】在售\n挂牌价：¥200",
        verified: true,
        reason: "模拟测试",
        matchType: "exact" as const,
        fetchedAt: new Date().toISOString(),
        sourceHash: "fixture-hash",
      };
      mocks.findCandidates.mockResolvedValueOnce({
        queries: ["【模拟测试】已扫描"],
        searchItems: [],
        items: [
          {
            key: "first",
            candidates: [candidate],
            searchStatus,
            searchCursor: cursor,
            scopeEvidence: [],
          },
          { key: "second", candidates: [], searchStatus: "completed", scopeEvidence: [] },
        ],
      });
      const first = await searchPetGearPricing(record, new AbortController().signal);
      expect(first.searchComplete).toBe(false);
      expect(first.items[0].searchCursor).toEqual(cursor);
      mocks.findCandidates.mockClear();
      const findCandidates = mocks.findCandidates.getMockImplementation()!;
      let resumedItems: PetGearPricingItem[] = [];
      mocks.findCandidates.mockImplementationOnce(async (...args) => {
        resumedItems = structuredClone(args[0]);
        return findCandidates(...args);
      });
      const second = await searchPetGearPricing(record, new AbortController().signal, first);
      expect(resumedItems).toMatchObject([
        { key: "first", searchCursor: cursor, candidates: [candidate] },
      ]);
      expect(second.searchComplete).toBe(true);
      expect(second.items[0].searchCursor).toBeUndefined();
    },
  );
  it("同配置中位数保存为查价参考，宝宝装备仍不重复加入总价", async () => {
    mocks.findCandidates.mockImplementation(async (items: PetGearPricingItem[]) => ({
      queries: ["【模拟测试】同配置官网界面全服"],
      searchItems: [],
      items: items.map((item) => ({
        key: item.key,
        candidates: [300, 100, 200].map((price, index) => ({
          url: "https://xyq.cbg.163.com/equip?s=33&eid=fixture-" + index,
          title: "模拟测试宝宝装备",
          price,
          priceType: "listing",
          quote: "【模拟测试】在售\n挂牌价：¥" + price,
          verified: true,
          reason: "模拟测试",
          matchType: "exact",
          fetchedAt: new Date().toISOString(),
          sourceHash: "fixture-hash",
        })),
        searchStatus: "completed",
        scopeEvidence: [],
        query: "【模拟测试】",
      })),
    }));
    const result = await searchPetGearPricing(record, new AbortController().signal);
    expect(result).toMatchObject({
      total: null,
      knownTotal: 0,
      accounting: expect.stringContaining("不重复相加"),
      items: [{ referencePrice: 200 }, { referencePrice: 200 }],
    });
  });
  it("未采齐不打开浏览器，并保留缺项而不生成零报价", async () => {
    mocks.petGearInventory.mockReturnValue({
      inputHash: "partial",
      captureComplete: false,
      issues: ["宝宝装备漏采"],
      items: [item("unknown")],
    });
    const result = await searchPetGearPricing(record, new AbortController().signal);
    expect(result).toMatchObject({
      searchComplete: true,
      total: null,
      items: [{ referencePrice: null }],
      issues: expect.arrayContaining(["宝宝装备漏采", expect.stringContaining("先补采")]),
    });
    expect(mocks.createPetGearSource).not.toHaveBeenCalled();
  });
  it("完整结果不会重复查；未完成只查剩余装备，父宝宝包价不相加", async () => {
    const first = await searchPetGearPricing(record, new AbortController().signal);
    expect(first).toMatchObject({
      searchComplete: true,
      total: null,
      knownTotal: 0,
      accounting: expect.stringContaining("不重复相加"),
    });
    mocks.findCandidates.mockClear();
    mocks.createPetGearSource.mockClear();
    await searchPetGearPricing(record, new AbortController().signal, first);
    expect(mocks.createPetGearSource).not.toHaveBeenCalled();
    first.items[1].searchStatus = "read_failed";
    await searchPetGearPricing(record, new AbortController().signal, first);
    expect(
      mocks.findCandidates.mock.calls[0][0].map((value: PetGearPricingItem) => value.key),
    ).toEqual(["second"]);
    expect(mocks.close).toHaveBeenCalledTimes(2);
  });
  it("同key属性更改导致输入hash变化、过期查询不复用", async () => {
    const first = await searchPetGearPricing(record, new AbortController().signal);
    mocks.findCandidates.mockClear();
    mocks.petGearInventory.mockReturnValue({
      inputHash: "hash-changed-stats",
      captureComplete: true,
      issues: [],
      items: [{ ...item("first"), description: "等级25\n速度+20\n耐久100" }, item("second")],
    });
    await searchPetGearPricing(record, new AbortController().signal, first);
    expect(mocks.findCandidates.mock.calls[0][0]).toHaveLength(2);
    mocks.findCandidates.mockClear();
    first.inputHash = "hash-changed-stats";
    first.items[0].queriedAt = first.items[1].queriedAt = "2000-01-01T00:00:00Z";
    await searchPetGearPricing(record, new AbortController().signal, first);
    expect(mocks.findCandidates.mock.calls[0][0]).toHaveLength(2);
  });
  it("来源失败仍关闭自有页，取消不启动查询", async () => {
    mocks.findCandidates.mockRejectedValue(new Error("网站要求登录"));
    await expect(searchPetGearPricing(record, new AbortController().signal)).rejects.toThrow(
      "要求登录",
    );
    expect(mocks.close).toHaveBeenCalledOnce();
    mocks.createPetGearSource.mockClear();
    await expect(
      searchPetGearPricing(record, AbortSignal.abort(new Error("取消"))),
    ).rejects.toThrow("取消");
    expect(mocks.createPetGearSource).not.toHaveBeenCalled();
  });
  it("先完成后登录失效，保存partial并恢复只查当前与未查询gear", async () => {
    mocks.petGearInventory.mockReturnValue({
      inputHash: "partial-progress",
      captureComplete: true,
      issues: [],
      items: [item("first"), item("second"), item("third")],
    });
    mocks.findCandidates.mockResolvedValueOnce({
      queries: ["【模拟测试】first已查询"],
      searchItems: [],
      items: [
        { key: "first", candidates: [], searchStatus: "completed", scopeEvidence: [] },
        {
          key: "second",
          candidates: [],
          searchStatus: "read_failed",
          note: "网站登录失效，已保存进度",
          scopeEvidence: [],
        },
        {
          key: "third",
          candidates: [],
          searchStatus: "pending",
          note: "尚未查询；请恢复登录",
          scopeEvidence: [],
        },
      ],
    });
    const first = await searchPetGearPricing(record, new AbortController().signal);
    expect(first).toMatchObject({
      searchComplete: false,
      items: [
        { searchState: "completed" },
        {
          searchState: "read_failed",
          issues: expect.arrayContaining([expect.stringContaining("登录失效")]),
        },
        { searchState: "pending" },
      ],
      issues: expect.arrayContaining([expect.stringContaining("登录失效")]),
    });
    mocks.findCandidates.mockClear();
    const resumed = await searchPetGearPricing(record, new AbortController().signal, first);
    expect(
      mocks.findCandidates.mock.calls[0][0].map((value: PetGearPricingItem) => value.key),
    ).toEqual(["second", "third"]);
    expect(resumed.searchComplete).toBe(true);
  });
});
