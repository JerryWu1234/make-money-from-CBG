import { describe, expect, it } from "vite-plus/test";
import { equipmentInitialDefense, parseEquipmentAttributes } from "./equip-attributes";
import { matchComparableEquipmentAttributes } from "./equipment-match";

const armor = (defense: number, grade: number, gem = "月亮石") =>
  `等级100\n防御${defense}\n耐久300\n锻炼等级${grade}\n镶嵌宝石 ${gem}`;
const initial = (description: string) =>
  equipmentInitialDefense(parseEquipmentAttributes(description));

describe("装备初始防御", () => {
  it("月亮石逐段扣除，正负熔炼单列，不再次扣减主防御", () => {
    for (const melting of ["", "\n熔炼效果：\n+10防御", "\n熔炼效果：\n-10防御"])
      expect(initial(armor(296, 8) + melting)).toBe(200);
    expect(initial(armor(284, 7))).toBe(200);
    expect(initial(armor(200, 8, "光芒石"))).toBe(200);
    expect(initial("等级100\n防御200\n耐久300")).toBe(200);
  });
  it("明确初防可用于混打，冲突或重复初防不能猜", () => {
    expect(initial(armor(296, 8, "月亮石、光芒石") + "\n初始防御200")).toBe(200);
    expect(initial(armor(296, 8) + "\n初防201")).toBeNull();
    expect(initial("等级100\n初始防御200\n初防201")).toBeNull();
  });
  it.each([
    "等级100\n防御296\n镶嵌宝石 月亮石",
    "等级100\n防御296\n锻炼等级8",
    armor(296, 8, "月亮石、光芒石"),
    armor(296, 0),
    armor(10, 8),
    armor(296, 8, "未知宝石"),
    armor(296, 8) + "\n防御300",
    armor(296, 8) + "\n锻炼等级7",
    armor(296, 8).replace("等级8", "等级未知"),
    "等级100\n防御296.5\n锻炼等级8\n镶嵌宝石 月亮石",
  ])("无法可靠拆分时保留缺失：%s", (description) => {
    expect(initial(description)).toBeNull();
  });
  it("详情比较初防，不把宝石带来的防御差异当成基础配置差异", () => {
    const target = parseEquipmentAttributes(armor(296, 8));
    const sameBase = matchComparableEquipmentAttributes(
      target,
      parseEquipmentAttributes(armor(284, 7)),
    );
    expect(sameBase).toMatchObject({ matchType: "similar", reason: null });
    const differentBase = matchComparableEquipmentAttributes(
      target,
      parseEquipmentAttributes(armor(296, 1)),
    );
    expect(differentBase.matchType).toBeNull();
    expect(differentBase.reason).toContain("初始防御");
    const missing = matchComparableEquipmentAttributes(
      target,
      parseEquipmentAttributes("等级100\n防御296\n锻炼等级8"),
    );
    expect(missing.matchType).toBeNull();
    expect(missing.reason).toContain("初始防御");
  });
  it("灵饰防御保持主附加属性口径，不推算人物装备初防", () => {
    expect(initial("等级80\n防御21\n精炼等级5\n附加属性：\n防御20[+40]\n防御21[+40]")).toBeNull();
  });
});
