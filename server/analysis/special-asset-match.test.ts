import { describe, expect, it } from "vite-plus/test";
import { matchSpecialAsset } from "./special-asset-match";

const jade = {
  category: "上古玉魄",
  name: "上古玉魄·阴",
  description:
    "防御 +25\n奇袭法术 +0.5%\n耐久度 102\n灵尘等级 4 [+1]\n抵抗封印等级 +13 [+48]\n气血 +67 [+168]\n奇袭道具: 金香玉\n奇袭道具: [空]\n有效期: 2026-12-01",
};
const yuan = {
  category: "元身",
  name: "剑·元身",
  description: "伤害 +500 命中 +600\n附加属性: 力量 +20\n附加特技概率 12%\n附加特效概率 8%",
};

describe("元身和玉魄专用相近匹配", () => {
  it("基础数值小幅变化逐槽列出差异，不改变灵尘加成", () => {
    expect(
      matchSpecialAsset(jade, jade.description.replace("+13 [+48]", "+15 [+48]")),
    ).toMatchObject({
      matchType: "similar",
      reason: null,
      differences: [expect.stringContaining("抵抗封印等级")],
    });
    expect(matchSpecialAsset(jade, jade.description.replace("102", "200"))).toMatchObject({
      matchType: "exact",
    });
  });
  it.each([
    ["+48", "+49"],
    ["等级 4", "等级 5"],
    ["+0.5%", "+0.6%"],
    ["金香玉", "十香返生丸"],
    ["[空]", "金香玉"],
    ["2026-12-01", "2026-11-01"],
    ["防御 +25", "气血 +25"],
    ["+25", "+40"],
  ])("保护玉魄条件 %s", (from, to) => {
    expect(matchSpecialAsset(jade, jade.description.replace(from, to)).matchType).toBeNull();
  });
  it("保持两个附加槽位次序与未知行，不通过合并数值制造匹配", () => {
    const swapped = jade.description.replace(
      "抵抗封印等级 +13 [+48]\n气血 +67 [+168]",
      "气血 +67 [+168]\n抵抗封印等级 +13 [+48]",
    );
    expect(matchSpecialAsset(jade, swapped).matchType).toBeNull();
    expect(matchSpecialAsset(jade, jade.description + "\n未知效形限制").matchType).toBeNull();
  });
  it("元身仅放宽主属性，保留附加属性与概率", () => {
    expect(matchSpecialAsset(yuan, yuan.description.replace("500", "450"))).toMatchObject({
      matchType: "similar",
    });
    for (const [from, to] of [
      ["500", "399"],
      ["12%", "13%"],
      ["力量 +20", "力量 +21"],
    ])
      expect(matchSpecialAsset(yuan, yuan.description.replace(from, to)).matchType).toBeNull();
  });
});
