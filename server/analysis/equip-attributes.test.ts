import { describe, expect, it } from "vite-plus/test";
import {
  compareEquipmentAttributes,
  equipmentInitialAttribute,
  parseEquipmentAttributes,
} from "./equip-attributes";

describe("装备价敏字段的结构化比较", () => {
  it.each([
    ["防御", 296, "月亮石", 8, 200],
    ["伤害", 581, "太阳石", 10, 501],
    ["命中", 750, "红玛瑙", 8, 550],
    ["灵力", 232, "舍利子", 10, 172],
    ["气血", 576, "光芒石", 10, 176],
    ["速度", 80, "黑宝石", 10, 0],
    ["法术防御", 196, "翡翠石", 8, 100],
    ["敏捷", 40, "黑宝石", 10, 40],
  ])("%s扣除对应宝石加成，熔炼独立保留", (field, shown, gem, grade, expected) => {
    const parsed = parseEquipmentAttributes(
      `等级100\n${field}${shown}\n锻炼等级${grade}\n镶嵌宝石 ${gem}\n熔炼效果：\n+10${field}`,
    );
    expect(equipmentInitialAttribute(parsed, field)).toBe(expected);
    expect(parsed.fields.熔炼).toBeDefined();
  });
  it.each([
    "伤害581\n镶嵌宝石 太阳石",
    "伤害581\n锻炼等级10\n宝石 太阳石 红玛瑙",
    "伤害581\n锻炼等级10\n宝石 未知宝石",
    "伤害1\n锻炼等级10\n宝石 太阳石",
    "初始伤害502\n伤害581\n锻炼等级10\n宝石 太阳石",
  ])("证据缺失、混合分配未知或数值冲突时不猜初始伤害：%s", (description) => {
    expect(equipmentInitialAttribute(parseEquipmentAttributes(description), "伤害")).toBeNull();
  });
  it("符石和星相的加成保留在独立字段，不冒充装备基础属性或未知行", () => {
    const attributes = parseEquipmentAttributes(
      "等级60\n防御 +110\n符石: 敏捷 +1 防御 +3\n星相互合：力量 +2\n符石组合: 无懈可击\n门派条件：无\n部位条件：无\n遭受法术攻击时有20%几率抵挡20点伤害",
    );
    expect(attributes.fields.防御).toEqual(["+110"]);
    expect(attributes.fields.符石).toEqual(["敏捷 +1 防御 +3"]);
    expect(attributes.fields.星相互合).toEqual(["力量 +2"]);
    expect(attributes.fields.符石组合).toContain("遭受法术攻击时有20%几率抵挡20点伤害");
    expect(attributes.fields.门派条件).toBeUndefined();
    expect(attributes.unknownLines).toEqual([]);
  });
  it("符石组合的门派限制独立保留，真正的装备门派和角色限制仍识别", () => {
    const attributes = parseEquipmentAttributes(
      "等级70\n符石组合: 气吞山河符石\n门派条件：凌波城\n部位条件：铠甲/女衣/坤斧\n增加门派技能气吞山河等级2级\n【装备角色】男\n【门派条件】大唐官府",
    );
    expect(attributes.fields.符石组合).toContain("门派条件：凌波城");
    expect(attributes.fields.门派条件).toEqual(["大唐官府"]);
    expect(attributes.fields.装备角色).toEqual(["男"]);
  });
  it.each([
    "固定伤害",
    "狂暴等级",
    "穿刺等级",
    "抗物理暴击等级",
    "抗法术暴击等级",
    "气血回复效果",
    "抵抗封印等级",
  ])("完整保留灵饰词条%s及重复数值，报价不能漏项或改值", (name) => {
    const target = parseEquipmentAttributes(`等级80\n${name}+8\n${name}+9`);
    expect(target.fields[name]).toEqual(["+8", "+9"]);
    expect(target.level).toBe(80);
    expect(
      compareEquipmentAttributes(target, parseEquipmentAttributes(`等级80\n${name}+9\n${name}+8`)),
    ).toBeNull();
    expect(
      compareEquipmentAttributes(target, parseEquipmentAttributes(`等级80\n${name}+8`)),
    ).toContain(name);
    expect(
      compareEquipmentAttributes(target, parseEquipmentAttributes(`等级80\n${name}+8\n${name}+10`)),
    ).toContain(name);
  });

  it.each([
    "等级70\n【装备条件】等级70\n【装备角色】女",
    "等级70<br>【装备条件】 等级70<br>【装备角色】女",
    "等级70\n【装备条件】 等级70 【装备角色】 女",
  ])("装备限制内的等级不重复当作基础等级：%s", (description) => {
    const observed = parseEquipmentAttributes(description);
    expect(observed).toMatchObject({
      level: 70,
      fields: { 等级: ["70"], 装备条件: ["等级70"], 装备角色: ["女"] },
    });
    expect(
      compareEquipmentAttributes(
        observed,
        parseEquipmentAttributes("等级：70\n装备条件：等级70\n装备角色：女"),
      ),
    ).toBeNull();
  });
  it("字段顺序、分行和明确别名不同仍匹配同配置", () => {
    const target = parseEquipmentAttributes(
      "等级：100\n防御：50\n力量+20 敏捷+20\n宝石：黑宝石\n锻炼等级：8\n耐久：300",
    );
    const source = parseEquipmentAttributes(
      "敏捷：20 力量：20\n宝石等级 8 镶嵌宝石 黑宝石\n防御 50 等级 100\n耐久度 250",
    );
    expect(compareEquipmentAttributes(target, source)).toBeNull();
    expect(source.level).toBe(100);
  });
  it("灵饰重复属性保留条数与每条数值，不能把双词条当单词条", () => {
    const target = parseEquipmentAttributes("等级80\n防御20\n法术伤害10\n法术伤害11");
    expect(target.fields.法术伤害).toEqual(["10", "11"]);
    expect(
      compareEquipmentAttributes(
        target,
        parseEquipmentAttributes("法术伤害11\n等级80\n法术伤害10\n防御20"),
      ),
    ).toBeNull();
    expect(
      compareEquipmentAttributes(target, parseEquipmentAttributes("等级80\n防御20\n法术伤害10")),
    ).toContain("法术伤害");
  });
  it("熔炼独立核对，不混入基础双加，允许同值换顺序或分行", () => {
    const target = parseEquipmentAttributes("等级100\n力量20\n熔炼效果：\n+5力量\n-2敏捷");
    const source = parseEquipmentAttributes("力量20\n等级100\n熔炼：敏捷-2 力量+5");
    expect(target.fields.力量).toEqual(["20"]);
    expect(compareEquipmentAttributes(target, source)).toBeNull();
    expect(
      compareEquipmentAttributes(target, parseEquipmentAttributes("等级100\n力量25\n敏捷-2")),
    ).toContain("力量");
  });
  it.each(["专用装备", "玩家 123 专用", "不可交易", "不能交易", "绑定", "无法修复", "不能修理"])(
    "额外限制%s不能漏检",
    (restriction) => {
      const target = parseEquipmentAttributes("等级100\n防御50");
      expect(
        compareEquipmentAttributes(
          target,
          parseEquipmentAttributes("等级100\n防御50\n" + restriction),
        ),
      ).toContain("限制");
    },
  );
  it("更高属性和额外长字段不会因数字或字段名前缀相同而误匹配", () => {
    const target = parseEquipmentAttributes("等级100\n防御50");
    expect(
      compareEquipmentAttributes(target, parseEquipmentAttributes("等级100\n防御500")),
    ).toContain("防御");
    const source = parseEquipmentAttributes("等级100\n防御50\n法术暴击等级10");
    expect(source.fields.法术暴击等级).toEqual(["10"]);
    expect(compareEquipmentAttributes(target, source)).toContain("多出");
  });
  it("无法解析的已观察价敏描述保留，不能默认为相同", () => {
    const target = parseEquipmentAttributes("等级100\n防御50\n抵抗特殊效果+10");
    expect(target.unknownLines).toEqual(["抵抗特殊效果+10"]);
    expect(
      compareEquipmentAttributes(target, parseEquipmentAttributes("等级100\n防御50")),
    ).toContain("未识别");
  });
  it("已保存的双字段和灵饰宝石增量完整保留，不把括号数字当新词条", () => {
    const armor = parseEquipmentAttributes("等级 70\n魔法 +70 防御 +30\n耐久度 853");
    expect(armor).toMatchObject({
      level: 70,
      fields: { 魔法: ["+70"], 防御: ["+30"], 耐久: ["853"] },
    });
    const ring = parseEquipmentAttributes(
      "等级 100\n防御 +20\n耐久度 93\n精炼等级 3\n法术暴击等级 +10 [+12]\n速度 +8 [+9]\n特效：宿敌·无底洞（1级）\n气血 +6",
    );
    expect(ring.fields.法术暴击等级).toEqual(["+10 [+12]"]);
    expect(ring.fields.速度).toEqual(["+8 [+9]"]);
    expect(ring.fields.特效).toEqual(["宿敌·无底洞（1级）"]);
    expect(
      compareEquipmentAttributes(
        ring,
        parseEquipmentAttributes(
          "等级100\n防御20\n耐久93\n精炼等级3\n法术暴击等级10\n速度8\n特效：宿敌·无底洞（1级）\n气血6",
        ),
      ),
    ).toContain("法术暴击等级");
  });
  it("等级及修理次数的明确单位不产生假差异", () => {
    expect(
      compareEquipmentAttributes(
        parseEquipmentAttributes("等级100\n防御50\n修理失败0"),
        parseEquipmentAttributes("等级100级\n防御50点\n修理失败0次"),
      ),
    ).toBeNull();
  });
});
