import { expect, it } from "vite-plus/test";
import { buildEquipmentEstimate } from "./pricing-estimate";
import type { EquipmentCandidate } from "./equipment-pricing";
const sample = (price: number, index: number): EquipmentCandidate => ({
  url: `https://xyq.cbg.163.com/equip/1/comparable-${index}`,
  title: "装备",
  price,
  priceType: "listing",
  quote: `挂牌价：¥${price}`,
  verified: true,
  matchType: "similar",
  reason: "完整来源核验",
  sourceHash: `hash-${index}`,
  fetchedAt: new Date().toISOString(),
  differences: ["宝石等级相近"],
});
it("少样本和分散样本保留核实挂牌范围，但不形成可加总的估价", () => {
  const few = buildEquipmentEstimate([sample(388.88, 1), sample(400.8, 2)]);
  expect(few).toMatchObject({
    status: "insufficient",
    range: null,
    sampleCount: 2,
    observedRange: { min: 388.88, max: 400.8 },
  });
  const dispersed = buildEquipmentEstimate([sample(330.3, 1), sample(501.7, 2), sample(666, 3)]);
  expect(dispersed).toMatchObject({
    status: "dispersed",
    range: null,
    observedRange: { min: 330.3, max: 666 },
  });
  expect(dispersed.median).toBeUndefined();
  expect(buildEquipmentEstimate([sample(400, 1), sample(410, 2), sample(420, 3)])).toMatchObject({
    status: "range",
    range: { min: 400, max: 420 },
    median: 410,
  });
});
it("未经核验、重复商品、过期的报价不能提高样本数量", () => {
  const old = sample(700, 3);
  old.fetchedAt = new Date(Date.now() - 25 * 3600_000).toISOString();
  const forged = sample(800, 4);
  forged.quote = "挂牌价：¥1";
  const estimate = buildEquipmentEstimate([sample(400, 1), sample(400, 1), old, forged]);
  expect(estimate).toMatchObject({
    sampleCount: 1,
    range: null,
    observedRange: { min: 400, max: 400 },
  });
});
