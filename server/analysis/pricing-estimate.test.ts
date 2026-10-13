import { expect, it } from "vite-plus/test";
import { buildEquipmentEstimate, buildSimilarEstimate } from "./pricing-estimate";
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
it("少样本与分散报价计算实际均价并披露限制", () => {
  expect(buildEquipmentEstimate([sample(388.88, 1), sample(400.8, 2)])).toMatchObject({
    status: "range",
    sampleCount: 2,
    average: 394.84,
    range: { min: 388.88, max: 400.8 },
  });
  const dispersed = buildEquipmentEstimate([sample(330.3, 1), sample(501.7, 2), sample(666, 3)]);
  expect(dispersed).toMatchObject({
    status: "range",
    average: 499.33,
    range: { min: 330.3, max: 666 },
  });
  expect(dispersed.issues.join("；")).toContain("1.5倍");
});
it("装备与宝宝取官网顺序前十件，重复、坏证据及第十一件不能替换样本", () => {
  const prices = [100, 110, 120, 130, 140, 150, 160, 170, 180, 1000, 1];
  const rows = prices.map((price, index) => sample(price, index));
  rows.splice(1, 0, sample(100, 0), { ...sample(1, 99), verified: false });
  for (const estimate of [buildEquipmentEstimate(rows), buildSimilarEstimate(rows)]) {
    expect(estimate).toMatchObject({
      status: "range",
      sampleCount: 10,
      average: 226,
      median: 145,
      range: { min: 100, max: 1000 },
    });
  }
});
it("过期、伪造价格、无独立官方身份的来源不能计价", () => {
  const good = sample(400, 1);
  const bad = [
    { ...sample(700, 3), fetchedAt: new Date(Date.now() - 25 * 3600_000).toISOString() },
    { ...sample(800, 4), quote: "挂牌价：¥1" },
    { ...sample(900, 5), url: "https://example.com/equip/1/5" },
  ];
  expect(buildEquipmentEstimate([good, good, ...bad])).toMatchObject({
    sampleCount: 1,
    average: 400,
  });
  expect(buildEquipmentEstimate(bad)).toMatchObject({
    sampleCount: 0,
    status: "insufficient",
    range: null,
  });
});
it("宝宝平均值与审计中位数分开，不能以价格重新排序挑样本", () => {
  const estimate = buildSimilarEstimate([sample(900, 1), sample(1000, 2), sample(2100, 3)]);
  expect(estimate).toMatchObject({
    average: 1333.33,
    median: 1000,
    sampleCount: 3,
    status: "range",
  });
  expect(estimate.issues.join("；")).toContain("算术平均价");
});
it("同商品报价冲突不能取更低价或计算均价", () => {
  expect(buildSimilarEstimate([sample(900, 1), sample(1000, 1)])).toMatchObject({
    status: "insufficient",
    range: null,
  });
});
