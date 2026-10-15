import { expect, it } from "vite-plus/test";
import {
  pricingSearchAdvanced,
  resetPricingCursor,
  resumePricingItems,
  rememberPricingPage,
  validPricingPageHistory,
  finishPricingSearch,
} from "./pricing-progress";
import type { EquipmentSearchCursor } from "./equipment-pricing";

it("已读完前页的身份指纹也保留，后续当前页不变时仍发现前页重排", () => {
  const cursor: EquipmentSearchCursor = {
    version: 1,
    planHash: "plan",
    modeIndex: 0,
    pageNumber: 2,
    rowIndex: 1,
    pageRowsHash: "second",
    seen: [],
    failed: [],
  };
  expect(rememberPricingPage(cursor, 0, 1, "first")).toBe(true);
  expect(rememberPricingPage(cursor, 0, 2, "second")).toBe(true);
  expect(validPricingPageHistory(cursor)).toBe(true);
  expect(rememberPricingPage(cursor, 0, 1, "first-reordered")).toBe(false);
  resetPricingCursor(cursor);
  expect(cursor.pageHistory).toEqual([]);
  expect(cursor.historyIndex).toBe(0);
});
import type { EquipmentPricingSnapshot } from "./equipment-pricing";

it("清单有未采齐单件时，完整装备仍进入查价队列", () => {
  const snapshot: EquipmentPricingSnapshot = {
    version: 1,
    inputHash: "partial",
    searchedAt: new Date().toISOString(),
    provider: "browser",
    model: "browser",
    captureComplete: false,
    total: null,
    knownTotal: 0,
    queries: [],
    rawResponse: null,
    issues: ["第二件未采齐"],
    items: ["no_match", "incomplete"].map((status, index) => ({
      key: String(index),
      name: "装备",
      level: 70,
      category: "腰带",
      description: "等级70",
      query: "",
      status: status as "no_match" | "incomplete",
      referencePrice: null,
      candidates: [],
      issues: [],
    })),
  };
  expect(resumePricingItems(structuredClone(snapshot)).items[0].searchState).toBeUndefined();
  const ready = resumePricingItems(snapshot, undefined, true);
  expect(ready.items[0].searchState).toBe("pending");
  expect(ready.items[1].searchState).toBeUndefined();
  expect(ready.captureComplete).toBe(false);
});

it("自动续查需要游标确实前进，读取失败和未前进不会自动循环", () => {
  const current = {
    items: [
      {
        key: "a",
        searchState: "pending",
        searchCursor: {
          version: 1,
          planHash: "plan",
          modeIndex: 0,
          pageNumber: 1,
          rowIndex: 10,
          pageRowsHash: "page",
          seen: ["1:item"],
          failed: [],
        },
      },
    ],
  } as unknown as EquipmentPricingSnapshot;
  expect(pricingSearchAdvanced(undefined, current)).toBe(true);
  expect(pricingSearchAdvanced(structuredClone(current), current)).toBe(false);
  const next = structuredClone(current);
  next.items[0].searchCursor!.rowIndex = 11;
  expect(pricingSearchAdvanced(current, next)).toBe(true);
  next.items[0].searchState = "read_failed";
  expect(pricingSearchAdvanced(current, next)).toBe(false);
});

it("只有同计划的查询位置前进才自动续查，seen、页面指纹或倒退不制造进展", () => {
  const current = {
    items: [
      {
        key: "a",
        searchState: "pending",
        searchCursor: {
          version: 1,
          planHash: "plan",
          modeIndex: 1,
          pageNumber: 2,
          rowIndex: 10,
          pageRowsHash: "page",
          seen: ["1:one"],
          failed: [],
        },
      },
    ],
  } as unknown as EquipmentPricingSnapshot;
  for (const change of [
    { seen: ["1:one", "1:two"] },
    { pageRowsHash: "new-page-fingerprint" },
    { rowIndex: 9 },
    { pageNumber: 1, rowIndex: 30 },
    { modeIndex: 0, pageNumber: 10, rowIndex: 30 },
    { planHash: "changed-plan", rowIndex: 11 },
  ]) {
    const next = structuredClone(current);
    Object.assign(next.items[0].searchCursor!, change);
    expect(pricingSearchAdvanced(current, next), JSON.stringify(change)).toBe(false);
  }
  for (const change of [
    { rowIndex: 11 },
    { pageNumber: 3, rowIndex: 0 },
    { modeIndex: 2, pageNumber: 1, rowIndex: 0 },
  ]) {
    const next = structuredClone(current);
    Object.assign(next.items[0].searchCursor!, change);
    expect(pricingSearchAdvanced(current, next), JSON.stringify(change)).toBe(true);
  }
});

it("一件完成且其余装备尚未轮到时也属于真实进展，不要求后件游标变化", () => {
  const previous = {
    items: [
      { key: "first", searchState: "pending" },
      { key: "later", searchState: "pending" },
    ],
  } as EquipmentPricingSnapshot;
  const current = structuredClone(previous);
  current.items[0].searchState = "completed";
  expect(pricingSearchAdvanced(previous, current)).toBe(true);
  expect(pricingSearchAdvanced(current, structuredClone(current))).toBe(false);
  current.items[1].searchState = "read_failed";
  expect(pricingSearchAdvanced(previous, current)).toBe(false);
});

it("结果变化清空旧取样位置，只允许一次自动重建，避免行情变动造成无限循环", () => {
  const previous = {
    items: [
      {
        key: "a",
        searchState: "pending",
        searchCursor: {
          version: 1,
          planHash: "same-plan",
          modeIndex: 2,
          pageNumber: 3,
          rowIndex: 8,
          pageRowsHash: "old-page",
          seen: ["1:old"],
          failed: [{ url: "https://xyq.cbg.163.com/equip/1/failed", modeIndex: 2 }],
        },
      },
    ],
  } as EquipmentPricingSnapshot;
  const current = structuredClone(previous);
  resetPricingCursor(current.items[0].searchCursor!);
  expect(current.items[0].searchCursor).toEqual({
    version: 1,
    planHash: "same-plan",
    modeIndex: 0,
    pageNumber: 1,
    rowIndex: 0,
    pageRowsHash: "",
    pageHistory: [],
    historyIndex: 0,
    seen: [],
    failed: [],
    restartCount: 1,
  });
  expect(pricingSearchAdvanced(previous, current)).toBe(true);
  const repeated = structuredClone(current);
  resetPricingCursor(repeated.items[0].searchCursor!);
  expect(pricingSearchAdvanced(current, repeated)).toBe(false);
});

it("首屏无样本跳过单件，旧进度恢复后也不重查；价格仍未知", () => {
  const initial: EquipmentPricingSnapshot = {
    version: 1,
    inputHash: "first-page",
    searchedAt: new Date().toISOString(),
    provider: "browser",
    model: "browser",
    captureComplete: true,
    total: null,
    knownTotal: 0,
    queries: [],
    rawResponse: null,
    issues: [],
    searchComplete: false,
    items: [
      {
        key: "a",
        name: "测试腰带",
        category: "腰带",
        level: 100,
        description: "等级100",
        query: "",
        status: "no_match",
        referencePrice: null,
        candidates: [],
        issues: [],
        searchState: "pending",
      },
    ],
  };
  const stopped = structuredClone(initial);
  stopped.items[0].samplingStopped = true;
  stopped.items[0].searchCursor = {
    version: 1,
    planHash: "plan",
    modeIndex: 2,
    pageNumber: 1,
    rowIndex: 0,
    pageRowsHash: "",
    seen: [],
    failed: [],
    emptyFirstPageModes: [0, 1],
  };
  const oldProgress = structuredClone(stopped);
  finishPricingSearch(stopped);
  expect(stopped.items[0].searchState).toBe("skipped");
  expect(stopped.searchComplete).toBe(true);
  expect(stopped.total).toBeNull();
  expect(stopped.knownTotal).toBe(0);
  expect(pricingSearchAdvanced(initial, stopped)).toBe(true);
  const retried = resumePricingItems(structuredClone(initial), stopped);
  expect(retried.items[0].searchState).toBe("skipped");
  expect(retried.items[0].referencePrice).toBeNull();
  expect(resumePricingItems(structuredClone(initial), oldProgress).items[0].searchState).toBe(
    "skipped",
  );
  resetPricingCursor(stopped.items[0].searchCursor!);
  expect(stopped.items[0].searchCursor!.emptyFirstPageModes).toBeUndefined();
});

it("无样本跳过规则不隐藏读取失败、未查完、有样本或未采齐的项目", () => {
  const item = {
    key: "a",
    name: "装备",
    category: "腰带",
    level: 100,
    description: "等级100",
    query: "query",
    status: "no_match" as const,
    referencePrice: null,
    candidates: [],
    issues: [],
    searchState: "completed" as const,
  };
  const snapshot = {
    version: 1,
    inputHash: "skip",
    searchedAt: new Date().toISOString(),
    provider: "browser",
    model: "browser",
    captureComplete: true,
    total: null,
    knownTotal: 0,
    queries: ["query"],
    rawResponse: null,
    issues: [],
    items: [item],
  } as EquipmentPricingSnapshot;
  expect(finishPricingSearch(structuredClone(snapshot)).items[0].searchState).toBe("skipped");
  for (const change of [
    { searchState: "pending" },
    { searchState: "read_failed", samplingStopped: true },
    { status: "incomplete" },
    { candidates: [{ verified: true }] },
  ]) {
    const value = structuredClone(snapshot);
    Object.assign(value.items[0], change);
    expect(finishPricingSearch(value).items[0].searchState).not.toBe("skipped");
  }
  const unfinished = structuredClone(snapshot);
  unfinished.searchItems = [{ key: "a", modes: [{ mode: "exact", exhausted: false }] }];
  expect(finishPricingSearch(unfinished).items[0].searchState).toBe("pending");
});

it("新汇总时间不能让过期相近样本在续查中复用，其余已完成项保留", () => {
  const inventory: EquipmentPricingSnapshot = {
    version: 1,
    inputHash: "candidate-expiry",
    searchedAt: new Date().toISOString(),
    provider: "browser",
    model: "browser",
    queries: [],
    rawResponse: null,
    captureComplete: true,
    total: null,
    knownTotal: 0,
    issues: [],
    items: ["old", "fresh"].map((key) => ({
      key,
      name: key,
      level: 100,
      category: "耳饰",
      description: "等级100",
      query: "",
      status: "no_match",
      referencePrice: null,
      candidates: [],
      issues: [],
    })),
  };
  const previous = structuredClone(inventory);
  previous.items = previous.items.map((item, index) => ({
    ...item,
    searchState: "completed",
    candidates: [
      {
        url: `https://xyq.cbg.163.com/equip/1/${item.key}`,
        title: item.name,
        price: 100,
        priceType: "listing",
        quote: "挂牌价100",
        verified: true,
        reason: "已核验相近商品",
        matchType: "similar",
        sourceHash: item.key,
        fetchedAt: new Date(Date.now() - (index ? 1000 : 24 * 3600_000)).toISOString(),
      },
    ],
  }));
  previous.searchItems = previous.items.map((item) => ({
    key: item.key,
    matchType: "similar",
    exhausted: true,
  }));
  const resumed = resumePricingItems(inventory, previous);
  expect(resumed.items[0]).toMatchObject({ searchState: "pending", candidates: [] });
  expect(resumed.items[1]).toEqual(previous.items[1]);
  expect(resumed.searchItems).toEqual(previous.searchItems);
});
