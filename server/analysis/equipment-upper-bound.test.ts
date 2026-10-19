import { describe, expect, it } from "vite-plus/test";
import { parseEquipmentAttributes } from "./equip-attributes";
import { matchComparableEquipmentAttributes } from "./equipment-match";
const match = (target: string, source: string, partial = false) =>
  matchComparableEquipmentAttributes(
    parseEquipmentAttributes(target),
    parseEquipmentAttributes(source),
    partial,
  );

describe("参考装备基础值不高于目标", () => {
  it.each([500, 400, 100])("允许未镶嵌基础伤害%s不高于500，不设旧20%%下限", (damage) => {
    expect(match("等级100\n伤害500", `等级100\n伤害${damage}`).matchType).not.toBeNull();
  });
  it("更高的基础伤害即使显示值更低也拒绝", () => {
    expect(
      match(
        "等级100\n伤害500\n锻炼等级5\n宝石：太阳石",
        "等级100\n伤害480\n锻炼等级1\n宝石：太阳石",
      ).matchType,
    ).toBeNull();
  });
  it("扣除宝石后更低的基础防御，即使显示值更高也允许", () => {
    const result = match(
      "等级100\n防御500\n锻炼等级5\n宝石：月亮石",
      "等级100\n防御600\n锻炼等级15\n宝石：月亮石",
    );
    expect(result.matchType, result.reason || "").not.toBeNull();
  });
  it("相同显示值不能绕过不同宝石段数后的基础值上限", () => {
    expect(
      match(
        "等级100\n伤害500\n锻炼等级5\n宝石：太阳石",
        "等级100\n伤害500\n锻炼等级1\n宝石：太阳石",
      ).matchType,
    ).toBeNull();
  });
  it("混合宝石无法可靠还原初伤时，相同描述也不作为报价", () => {
    const text = "等级100\n伤害500\n锻炼等级5\n宝石：太阳石 红玛瑙";
    expect(match(text, text).matchType).toBeNull();
  });
  it("其它基础属性同样不能更高，特技仍须匹配", () => {
    expect(
      match("等级100\n伤害500\n力量20\n特技：罗汉金钟", "等级100\n伤害400\n力量21\n特技：罗汉金钟")
        .matchType,
    ).toBeNull();
    expect(
      match("等级100\n伤害500\n特技：罗汉金钟", "等级100\n伤害400\n特技：晶清诀").matchType,
    ).toBeNull();
  });
  it("躲避扣除神秘石后也接受较低基础值，拒绝更高值", () => {
    const target = "等级100\n防御50\n躲避200\n锻炼等级5\n宝石：神秘石";
    expect(
      match(target, "等级100\n防御50\n躲避140\n锻炼等级3\n宝石：神秘石").matchType,
    ).not.toBeNull();
    expect(match(target, "等级100\n防御50\n躲避161\n锻炼等级3\n宝石：神秘石").matchType).toBeNull();
  });
  it("灵饰基础值按主附分段且扣除方括号加成，不参考更高附加值", () => {
    const target = "等级100\n防御20\n精炼等级6\n附加属性：\n防御+20 [+24]\n气血+100 [+168]";
    const lower = "等级100\n防御20\n精炼等级8\n附加属性：\n防御+19 [+32]\n气血+90 [+224]";
    expect(match(target, lower).matchType).not.toBeNull();
    expect(match(target, lower.replace("防御+19", "防御+21")).matchType).toBeNull();
  });
});
