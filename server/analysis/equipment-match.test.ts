import { describe, expect, it } from "vite-plus/test";
import { parseEquipmentAttributes } from "./equip-attributes";
import { matchComparableEquipmentAttributes, matchEquipmentAttributes } from "./equipment-match";
const gear =
  "等级 100\n五行 水\n防御 +100\n气血 +400\n耐久度 300\n修理失败 0\n宝石 黑宝石\n锻炼等级 8\n特效 愤怒\n套装 变身术之葫芦宝贝";
const match = (source: string, target = gear) =>
  matchEquipmentAttributes(parseEquipmentAttributes(target), parseEquipmentAttributes(source));
describe("有界同配置与相近装备匹配", () => {
  it("同配属性顺序/格式不影响，正常耐久差异保持可采用", () => {
    expect(match(gear.replace("耐久度 300", "耐久度 180"))).toMatchObject({
      matchType: "exact",
      similarityScore: 0,
    });
  });
  it("五行与5%内数值差明确标相近，原值都保留", () => {
    const result = match(gear.replace("五行 水", "五行 金").replace("防御 +100", "防御 +105"));
    expect(result.matchType).toBe("similar");
    expect(result.differences).toEqual(
      expect.arrayContaining(["五行：水 → 金", "防御：100 → 105（最大差异5.00%）"]),
    );
  });
  it.each(["修理失败 1", "宝石 光芒石", "锻炼等级 9", "特效 永不磨损", "套装 变身术之净瓶女娲"])(
    "%s不能作为相近同配",
    (line) => {
      const original = line.startsWith("修理")
        ? "修理失败 0"
        : line.startsWith("宝石")
          ? "宝石 黑宝石"
          : line.startsWith("锻炼")
            ? "锻炼等级 8"
            : line.startsWith("特效")
              ? "特效 愤怒"
              : "套装 变身术之葫芦宝贝";
      expect(match(gear.replace(original, line)).matchType).toBeNull();
    },
  );
  it("超过5%、缺属性、零值和附加条目缺失都拒绝，不能估折扣", () => {
    for (const source of [
      gear.replace("防御 +100", "防御 +106"),
      gear.replace("气血 +400\n", ""),
      gear.replace("防御 +100", "防御 +1"),
    ])
      expect(match(source).matchType).toBeNull();
    expect(
      match(gear.replace("防御 +100", "防御 +1"), gear.replace("防御 +100", "防御 +0")).matchType,
    ).toBeNull();
    expect(
      match("等级80\n法术伤害 +16\n法术伤害 +8", "等级80\n法术伤害 +16\n法术伤害 +8\n法术伤害 +8")
        .matchType,
    ).toBeNull();
  });
  it("未知属性、熔炼、附加效果及专用限制保持硬核验", () => {
    for (const extra of [
      "\n抗未知属性 +1",
      "\n熔炼效果：\n+3防御",
      "\n玩家123专用",
      "\n特技 晶清诀",
    ])
      expect(match(gear + extra).matchType).toBeNull();
  });
  it("列表残缺字段不当缺失，已有明确冲突才排除", () => {
    const target = parseEquipmentAttributes(gear);
    expect(
      matchEquipmentAttributes(target, parseEquipmentAttributes("等级100\n防御104"), true)
        .matchType,
    ).toBe("similar");
    expect(
      matchEquipmentAttributes(target, parseEquipmentAttributes("等级100\n锻炼等级9"), true)
        .matchType,
    ).toBeNull();
  });
});

describe("同核心装备粗略参考价匹配", () => {
  const comparable = (source: string, target = gear) =>
    matchComparableEquipmentAttributes(
      parseEquipmentAttributes(target),
      parseEquipmentAttributes(source),
    );
  it("套装、宝石、熔炼和双加差异保留为相近配置，不能冒充同配置", () => {
    const result = comparable(
      gear
        .replace("防御 +100", "防御 +120")
        .replace("锻炼等级 8", "锻炼等级 7")
        .replace("葫芦宝贝", "净瓶女娲") + "\n熔炼效果：+3防御\n力量 +10\n符石: 防御 +3",
    );
    expect(result.matchType).toBe("similar");
    for (const field of ["防御", "锻炼等级", "套装", "熔炼", "力量", "符石"])
      expect(result.differences.some((difference) => difference.startsWith(field))).toBe(true);
  });
  it.each([
    gear.replace("防御 +100", "防御 +121"),
    gear.replace("等级 100", "等级 90"),
    gear.replace("特效 愤怒", "特效 愤怒 简易"),
    gear + "\n特技 晶清诀",
    gear + "\n玩家123专用",
    gear + "\n抗未知属性 +1",
    gear.replace("气血 +400\n", ""),
  ])("核心属性、未知属性和限制不符仍排除：%s", (source) => {
    expect(comparable(source).matchType).toBeNull();
  });
  it("灵饰相近数值和精炼差异可用，但完整详情不能漏词条", () => {
    const target = "等级80\n精炼等级7\n法术伤害16\n法术伤害8[+28]\n法术伤害9[+28]";
    expect(
      comparable("等级80\n精炼等级6\n法术伤害16\n法术伤害9[+24]\n法术伤害10[+24]", target)
        .matchType,
    ).toBe("similar");
    expect(
      comparable("等级80\n精炼等级7\n法术伤害16\n法术伤害8[+28]", target).matchType,
    ).toBeNull();
    expect(
      matchComparableEquipmentAttributes(
        parseEquipmentAttributes(target),
        parseEquipmentAttributes("等级80\n法术伤害10[+24]"),
        true,
      ).reason,
    ).toBeNull();
  });
});
