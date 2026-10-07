import { expect, it } from "vite-plus/test";
import { resumePricingItems } from "./pricing-progress";
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

import { equipmentSearchAdvanced } from "./pricing-progress";
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
  expect(equipmentSearchAdvanced(undefined, current)).toBe(true);
  expect(equipmentSearchAdvanced(structuredClone(current), current)).toBe(false);
  const next = structuredClone(current);
  next.items[0].searchCursor!.rowIndex = 11;
  expect(equipmentSearchAdvanced(current, next)).toBe(true);
  next.items[0].searchState = "read_failed";
  expect(equipmentSearchAdvanced(current, next)).toBe(false);
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
  expect(equipmentSearchAdvanced(previous, current)).toBe(true);
  expect(equipmentSearchAdvanced(current, structuredClone(current))).toBe(false);
  current.items[1].searchState = "read_failed";
  expect(equipmentSearchAdvanced(previous, current)).toBe(false);
});
