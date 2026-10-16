import { describe, expect, it } from "vite-plus/test";
import { parseEquipmentAttributes } from "./equip-attributes";
import {
  EQUIPMENT_ATTRIBUTE_ABSOLUTE_TOLERANCES,
  equipmentAttributeLowerBound,
  equipmentAttributeTolerance,
  matchComparableEquipmentAttributes,
  matchEquipmentAttributes,
} from "./equipment-match";
const gear =
  "等级 100\n五行 水\n防御 +100\n气血 +400\n耐久度 300\n修理失败 0\n宝石 黑宝石\n锻炼等级 8\n特效 愤怒\n套装 变身术之葫芦宝贝";
const match = (source: string, target = gear) =>
  matchEquipmentAttributes(parseEquipmentAttributes(target), parseEquipmentAttributes(source));
describe("价格属性的有界查询与匹配容差", () => {
  it.each([
    ["附加属性·法术伤害", 8, 2, 6],
    ["主属性·法术伤害", 16, 3.2, 12.8],
    ["防御", 10, 3, 7],
    ["气血", 30, 10, 20],
    ["气血", 400, 80, 320],
    ["灵力", 180, 36, 144],
    ["魔法", 10, 5, 5],
    ["命中", 20, 5, 15],
    ["速度", 8, 2, 6],
    ["法术伤害", 0, 0, 0],
  ] as const)("%s的%s点使用容差%s与搜索下界%s", (field, value, tolerance, lowerBound) => {
    expect(equipmentAttributeTolerance(field, value)).toBe(tolerance);
    expect(equipmentAttributeLowerBound(field, value)).toBe(lowerBound);
  });
  it("仅明确列出的数值价格属性可放宽，绝对差上限保持有限", () => {
    for (const [field, value] of Object.entries(EQUIPMENT_ATTRIBUTE_ABSOLUTE_TOLERANCES)) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(10);
      expect(equipmentAttributeTolerance(field, 1)).toBe(value);
    }
    for (const field of [
      "等级",
      "精炼等级",
      "锻炼等级",
      "特效",
      "特效加成",
      "未知属性",
      "__proto__",
    ])
      expect(equipmentAttributeLowerBound(field, 8)).toBeNull();
    expect(equipmentAttributeTolerance("法术伤害", NaN)).toBeNull();
    expect(equipmentAttributeTolerance("法术伤害", Infinity)).toBeNull();
  });
});
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
  it.each(["变身术之鬼将", "附加状态杀气诀", "附加状态变身术", ""])(
    "完整套装附加状态变身不能用%s替代或缺失",
    (suit) => {
      for (const base of ["等级100\n防御50", "等级100\n精炼等级6\n防御50"]) {
        const target = base + "\n套装效果：附加状态变身\n特技：晶清诀";
        const source = base + (suit ? "\n套装效果：" + suit : "") + "\n特技：晶清诀";
        expect(comparable(source, target).matchType).toBeNull();
        expect(comparable(target, source).matchType).toBeNull();
      }
    },
  );
  it("完整类型与名称相同的套装可比较，列表缺省留完整详情核验", () => {
    const target = parseEquipmentAttributes(
      "等级100\n防御50\n套装效果：附加状态变身\n特技：晶清诀",
    );
    expect(matchComparableEquipmentAttributes(target, target).matchType).toBe("exact");
    expect(
      matchComparableEquipmentAttributes(target, parseEquipmentAttributes("等级100\n防御49"), true)
        .reason,
    ).toBeNull();
    expect(
      matchComparableEquipmentAttributes(
        target,
        parseEquipmentAttributes("等级100\n防御49\n套装效果：变身术之鬼将"),
        true,
      ).matchType,
    ).toBeNull();
  });
  it.each(["晶清", "晶清诀·另一技", "四海升平", ""])(
    "特技实际名字不一致或缺失仍拒绝：%s",
    (skill) => {
      const target = "等级100\n防御50\n特技：晶清诀";
      expect(
        comparable("等级100\n防御49" + (skill ? "\n特技：" + skill : ""), target).matchType,
      ).toBeNull();
    },
  );
  it.each(["", "\n锻炼等级4\n宝石：月亮石"])(
    "纯黑宝石可靠扣到速度0可与完整候选缺速度比较：%s",
    (gems) => {
      const target = "等级100\n敏捷40\n速度32\n锻炼等级4\n宝石：黑宝石";
      const source = "等级100\n敏捷40" + gems;
      expect(comparable(source, target).reason).toBeNull();
      expect(comparable(target, source).reason).toBeNull();
    },
  );
  it("列表初筛允许候选已可靠扣成0的宝石速度，正初速仍拒绝", () => {
    const target = parseEquipmentAttributes("等级100\n敏捷40");
    const zero = "等级100\n敏捷40\n速度32\n锻炼等级4\n宝石：黑宝石";
    expect(
      matchComparableEquipmentAttributes(target, parseEquipmentAttributes(zero), true).reason,
    ).toBeNull();
    expect(
      matchComparableEquipmentAttributes(
        target,
        parseEquipmentAttributes(zero.replace("速度32", "速度33")),
        true,
      ).matchType,
    ).toBeNull();
  });
  it.each([
    "速度33\n锻炼等级4\n宝石：黑宝石",
    "速度32\n宝石：黑宝石",
    "速度32\n锻炼等级4\n宝石：黑宝石 月亮石",
    "速度32\n锻炼等级4\n宝石：未知宝石",
    "速度100001\n初始速度0\n锻炼等级4\n宝石：黑宝石",
    "初始速度0",
    "灵力0",
  ])("正值、未知、混合和其他缺失字段不能当作宝石速度0：%s", (stats) => {
    expect(comparable("等级100\n敏捷40", "等级100\n敏捷40\n" + stats).matchType).toBeNull();
  });
  it.each(["黑宝石", "黑宝石 月亮石", "未知宝石"])(
    "候选缺速度但宝石%s不能证明无速度加成时不补0",
    (gem) => {
      const target = "等级100\n敏捷40\n速度32\n锻炼等级4\n宝石：黑宝石";
      expect(comparable("等级100\n敏捷40\n锻炼等级4\n宝石：" + gem, target).matchType).toBeNull();
    },
  );
  it("宝石、熔炼和双加差异保留为相近配置，不能冒充同配置", () => {
    const result = comparable(
      gear.replace("防御 +100", "防御 +90").replace("锻炼等级 8", "锻炼等级 7") +
        "\n熔炼效果：+3防御\n力量 +10\n符石: 防御 +3",
      gear + "\n力量 +20",
    );
    expect(result.matchType).toBe("similar");
    for (const field of ["初始防御", "锻炼等级", "熔炼", "力量", "符石"])
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
      comparable("等级80\n精炼等级6\n法术伤害16\n法术伤害7[+24]\n法术伤害8[+24]", target).matchType,
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
  it("芙蓉戒8到6点法伤保留为相近报价，完整和列表都不能采用更高基础值", () => {
    const target = parseEquipmentAttributes(description);
    const source = parseEquipmentAttributes(description.replace("法术伤害 +8", "法术伤害 +6"));
    const result = matchComparableEquipmentAttributes(target, source);
    expect(result.matchType).toBe("similar");
    expect(result.differences).toContain("法术伤害：+8 [+20] → +6 [+20]");
    expect(matchEquipmentAttributes(target, source).matchType).toBeNull();
    expect(
      matchComparableEquipmentAttributes(
        target,
        parseEquipmentAttributes("法术伤害 +6 [+20]"),
        true,
      ).reason,
    ).toBeNull();
  });
  it.each([11, 16, 80])("8点法伤与%s点的差异不能放宽为参考", (value) => {
    const result = matchComparableEquipmentAttributes(
      parseEquipmentAttributes(description),
      parseEquipmentAttributes(description.replace("法术伤害 +8", "法术伤害 +" + value)),
    );
    expect(result.matchType).toBeNull();
    expect(result.reason).toContain("法术伤害");
  });
  it("基础值上限不绕过词条数量、特效和等级", () => {
    const changed = description.replace("法术伤害 +8", "法术伤害 +6");
    for (const source of [
      changed.replace("等级 80", "等级 60"),
      changed.replace("法术暴击等级 +10 [+20]\n", ""),
      changed.replace("健步如飞（2级）", "健步如飞（1级）"),
      changed + "\n特技：罗汉金钟",
      changed + "\n玩家46377146专用",
    ])
      expect(
        matchComparableEquipmentAttributes(
          parseEquipmentAttributes(description),
          parseEquipmentAttributes(source),
        ).matchType,
      ).toBeNull();
    expect(
      matchComparableEquipmentAttributes(
        parseEquipmentAttributes(description.replace("法术伤害 +8", "法术伤害 +0")),
        parseEquipmentAttributes(description.replace("法术伤害 +8", "法术伤害 +1")),
      ).matchType,
    ).toBeNull();
    for (const value of [0, -1])
      expect(
        matchComparableEquipmentAttributes(
          parseEquipmentAttributes(description.replace("法术伤害 +8", "法术伤害 +1")),
          parseEquipmentAttributes(description.replace("法术伤害 +8", "法术伤害 " + value)),
        ).matchType,
      ).not.toBeNull();
  });
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

describe("真实明月珰主副同名法伤分段", () => {
  const target =
    "等级 80\n法术伤害 +16\n耐久度 47\n精炼等级 5\n附加属性：\n法术伤害 +12 [+20]\n法术暴击等级 +8 [+20]\n特效：健步如飞（2级）\n速度 +2\n速度+7（已生效）\n装备条件：等级80";
  const matching = (source: string) =>
    matchComparableEquipmentAttributes(
      parseEquipmentAttributes(target),
      parseEquipmentAttributes(source),
    );
  it("主副数值互换不能绕过各段基础值上限", () => {
    const source = target
      .replace("法术伤害 +16", "法术伤害 +12")
      .replace("法术伤害 +12 [+20]", "法术伤害 +16 [+20]");
    expect(matching(source).reason).toMatch(/附加属性.*法术伤害.*高于目标/);
    expect(
      matchEquipmentAttributes(parseEquipmentAttributes(target), parseEquipmentAttributes(source))
        .matchType,
    ).toBeNull();
  });
  it("每一段基础值均不高于目标才采纳，并显示各自差异", () => {
    const source = target
      .replace("法术伤害 +16", "法术伤害 +14")
      .replace("法术伤害 +12 [+20]", "法术伤害 +11 [+20]");
    const result = matching(source);
    expect(result.matchType).toBe("similar");
    expect(result.differences).toEqual(
      expect.arrayContaining([
        "主属性·法术伤害：+16 → +14",
        "附加属性·法术伤害：+12 [+20] → +11 [+20]",
      ]),
    );
  });
  it("独立页面省略附加标题但保留连续精炼加成原文时仍能识别分段", () => {
    const standalone = target.replace("附加属性：\n", "").replace("速度+7（已生效）\n", "");
    expect(matching(standalone).matchType).toBe("similar");
    const swapped = standalone
      .replace("法术伤害 +16", "法术伤害 +12")
      .replace("法术伤害 +12 [+20]", "法术伤害 +16 [+20]");
    expect(matching(swapped).matchType).toBeNull();
  });
  it("0精炼无加成括号仍以明确附加标题保护主副位置", () => {
    const zero = target.replace("精炼等级 5", "精炼等级 0").replaceAll(" [+20]", "");
    const source = zero
      .replace("法术伤害 +16", "法术伤害 +12")
      .replace("附加属性：\n法术伤害 +12", "附加属性：\n法术伤害 +16");
    expect(
      matchComparableEquipmentAttributes(
        parseEquipmentAttributes(zero),
        parseEquipmentAttributes(source),
      ).matchType,
    ).toBeNull();
  });
  it("全详情无法确定分段时不把同名词条排序后采纳，列表残缺仍可进入详情", () => {
    const uncertain = target.replace("附加属性：\n", "").replaceAll(" [+20]", "");
    expect(matching(uncertain).reason).toContain("分段证据");
    const partial = matchComparableEquipmentAttributes(
      parseEquipmentAttributes(target),
      parseEquipmentAttributes("法术伤害 +16"),
      true,
    );
    expect(partial.matchType).not.toBeNull();
  });
});
