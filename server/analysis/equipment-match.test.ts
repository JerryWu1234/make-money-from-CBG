import { describe, expect, it } from "vite-plus/test";
import { parseEquipmentAttributes } from "./equip-attributes";
import {
  equipmentEnhancementMismatch,
  matchComparableEquipmentAttributes,
  matchEquipmentAttributes,
} from "./equipment-match";
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
  it("真实灵饰的空标题不制造未知属性，特效加成不混入基础速度", () => {
    const description =
      "等级 60\n速度 +12\n耐久度 23 修理失败 2次\n精炼等级 4\n附加属性：\n防御 +12 [+32]\n气血 +44 [+112]\n特效：健步如飞（2级）\n速度 +2\n速度+7（已生效）\n装备条件：等级60";
    const target = parseEquipmentAttributes(description);
    expect(target.unknownLines).toEqual([]);
    expect(target.fields.速度).toEqual(["+12"]);
    expect(target.fields.特效加成).toEqual(["速度:+2"]);
    expect(target.fields.已生效套装加成).toEqual(["速度:+7"]);
    const source = parseEquipmentAttributes(description.replace("附加属性：\n", ""));
    expect(matchEquipmentAttributes(target, source).matchType).toBe("exact");
    expect(
      matchComparableEquipmentAttributes(target, parseEquipmentAttributes("等级60\n速度12"), true)
        .reason,
    ).toBeNull();
    for (const changed of [
      description.replace("健步如飞（2级）", "宿敌·无底洞（2级）"),
      description.replace("速度+7（已生效）", "速度+7"),
      description + "\n抵抗未知属性+1",
    ])
      expect(
        matchComparableEquipmentAttributes(target, parseEquipmentAttributes(changed)).matchType,
      ).toBeNull();
  });
});

describe("角色上下文不会阻塞独立灵饰参考", () => {
  const description =
    "等级 80\n防御 +21\n耐久度 84\n精炼等级 5\n附加属性：\n法术伤害结果 +8 [+15]\n法术伤害 +8 [+20]\n法术暴击等级 +10 [+20]\n特效：健步如飞（2级）\n速度 +2\n速度+7（已生效）\n装备条件：等级80";
  it("目标46377146芙蓉戒独立挂牌没有整套已生效速度时保留为相近差异", () => {
    const target = parseEquipmentAttributes(description);
    const source = parseEquipmentAttributes(description.replace("速度+7（已生效）\n", ""));
    expect(matchEquipmentAttributes(target, source).matchType).toBeNull();
    const result = matchComparableEquipmentAttributes(target, source);
    expect(result.matchType).toBe("similar");
    expect(result.differences).toContain("已生效套装加成：速度:+7 → 未标明");
    expect(target.fields.速度).toBeUndefined();
    expect(target.fields.特效加成).toEqual(["速度:+2"]);
    expect(
      matchComparableEquipmentAttributes(
        target,
        parseEquipmentAttributes(description.replace("速度+7（已生效）", "速度+6（已生效）")),
      ).matchType,
    ).toBe("similar");
  });
  it.each([
    description.replace("健步如飞（2级）", "健步如飞（1级）"),
    description.replace("速度 +2", "速度 +1"),
    description.replace("速度 +2\n", ""),
    description.replace("健步如飞（2级）", "血气方刚（2级）"),
  ])("单件特效等级或加成不符仍拒绝", (source) => {
    expect(
      matchComparableEquipmentAttributes(
        parseEquipmentAttributes(description),
        parseEquipmentAttributes(source),
      ).matchType,
    ).toBeNull();
  });
});

describe("宝石及精炼逐级相近筛选", () => {
  const target = parseEquipmentAttributes(
    "等级70\n防御41 魔法73\n锻炼等级4 镶嵌宝石 太阳石\n伤害32",
  );
  const mismatch = (source: string, mode: "same-gems" | "near-gems", partial = false) =>
    equipmentEnhancementMismatch(target, parseEquipmentAttributes(source), mode, partial);
  it("保存的乾坤帽4段与6段差异不会冒充相邻段数，更不换算基础价格", () => {
    const source = "等级70\n防御40 魔法75\n锻炼等级6 镶嵌宝石 太阳石\n伤害48";
    expect(mismatch(source, "same-gems")).toContain("同段或相邻一段");
    expect(mismatch(source, "near-gems")).toContain("同段或相邻一段");
    expect(target.fields.伤害).toEqual(["32"]);
    expect(parseEquipmentAttributes(source).fields.伤害).toEqual(["48"]);
  });
  it("同宝石相邻一段可搜索，不同种类和缺失段数不当同段证据", () => {
    const same = "等级70\n锻炼等级4 镶嵌宝石 太阳石";
    expect(mismatch(same, "same-gems")).toBeNull();
    expect(mismatch(same.replace("等级4", "等级3"), "near-gems")).toBeNull();
    expect(mismatch(same.replace("等级4", "等级5"), "near-gems")).toBeNull();
    expect(mismatch(same.replace("太阳石", "月亮石"), "near-gems")).toContain("宝石种类");
    expect(mismatch("等级70\n镶嵌宝石 太阳石", "near-gems")).toContain("完整证据");
    expect(mismatch("等级70\n防御41", "near-gems", true)).toBeNull();
  });
  it("目标89级角色的灵饰5精炼仅允许4至6段，特效仍交给核心匹配核验", () => {
    const jewelry = parseEquipmentAttributes(
      "等级80\n精炼等级5\n防御21\n特效：健步如飞（2级）\n速度2",
    );
    const source = parseEquipmentAttributes(
      "等级80\n精炼等级4\n防御21\n特效：健步如飞（2级）\n速度2",
    );
    expect(equipmentEnhancementMismatch(jewelry, source, "near-gems")).toBeNull();
    expect(equipmentEnhancementMismatch(jewelry, source, "same-gems")).toContain("同段或相邻一段");
    expect(matchComparableEquipmentAttributes(jewelry, source).matchType).toBe("similar");
    source.fields.特效 = ["宿敌·神木林（2级）"];
    expect(matchComparableEquipmentAttributes(jewelry, source).matchType).toBeNull();
  });
  it("相近样本优先邻近段数，保留所有实际宝石差异", () => {
    const target = parseEquipmentAttributes(gear);
    const nearby = matchComparableEquipmentAttributes(
      target,
      parseEquipmentAttributes(gear.replace("锻炼等级 8", "锻炼等级 7")),
    );
    const distant = matchComparableEquipmentAttributes(
      target,
      parseEquipmentAttributes(gear.replace("锻炼等级 8", "锻炼等级 12")),
    );
    expect(nearby.similarityScore).toBeLessThan(distant.similarityScore);
    expect(distant.differences).toContain("锻炼等级：8 → 12");
  });
});
