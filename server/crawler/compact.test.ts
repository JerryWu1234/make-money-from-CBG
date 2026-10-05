import { describe, expect, it } from "vite-plus/test";
import {
  coreEquipmentDescription,
  itemFromAttributes,
  jewelryDescriptionSections,
  observedEquipmentCategory,
} from "./compact";

describe("有官网证据的角色装备分类", () => {
  it.each([
    [3, "鞋子"],
    [4, "饰品"],
    [5, "腰带"],
  ])("slot %s只补明确的%s类别，不推算kind ID", (slot, label) => {
    const item = itemFromAttributes(
      {
        data_equip_name: "公开商品",
        data_equip_location: "role_using_equip_" + slot,
        data_equip_type: "2912",
      },
      0,
    );
    expect(item.category).toBe("人物装备 · " + label);
    expect(item.kindId).toBeUndefined();
    expect(observedEquipmentCategory("19", "role_using_equip_" + slot)).toBe(item.category);
  });

  it.each([1, 2, 6, 187, 188, 189, 190])("未知slot %s不猜头部、男女衣、武器或灵饰类型", (slot) => {
    expect(observedEquipmentCategory("人物装备", "role_using_equip_" + slot)).toBe("人物装备");
  });

  it("明确细分类及非法人物装备类别不被槽位覆盖，未知数字类别清空", () => {
    for (const category of ["灵宝", "法宝", "神器", "召唤兽装备", "人物装备 · 戒指"])
      expect(observedEquipmentCategory(category, "role_using_equip_5")).toBe(category);
    expect(observedEquipmentCategory("19", "仓库1")).toBe("");
    expect(
      itemFromAttributes(
        {
          data_equip_name: "法宝",
          data_storage_type: "fabao",
          data_equip_location: "role_using_equip_5",
        },
        0,
      ).category,
    ).toBe("法宝");
  });
});

describe("灵饰主属性和附加属性分段", () => {
  const raw =
    "#r等级 80#r法术伤害 +16#r耐久度 450#r精炼等级 7#r#G法术伤害 +8[+28]#r#G法术伤害 +9[+28]#r#G速度 +8[+21]#r制造者：测试";

  it("官网色码规则区分主法伤与双附加法伤，保留数值和重复条目", () => {
    const description = coreEquipmentDescription(raw);
    expect(description).toContain("法术伤害 +16\n耐久度 450\n精炼等级 7\n附加属性：");
    expect(jewelryDescriptionSections(description)).toEqual({
      main: "等级 80\n法术伤害 +16\n耐久度 450\n精炼等级 7",
      added: ["法术伤害 +8[+28]", "法术伤害 +9[+28]", "速度 +8[+21]"],
    });
    expect(jewelryDescriptionSections(raw)?.added).toHaveLength(3);
  });

  it("主属性绿色也不计入附加条数，前两行遵循官网边界", () => {
    expect(
      jewelryDescriptionSections(raw.replace("#r法术伤害 +16", "#r#G法术伤害 +16"))?.added,
    ).toHaveLength(3);
  });

  it("旧无码描述不从字段出现次数猜双法伤或三法伤", () => {
    expect(jewelryDescriptionSections(raw.replace(/#G/g, "").replace(/#r/g, "\n"))).toBeNull();
  });

  it.each(["#G未知属性 +10", "#G特效：超级简易", "#G法术伤害 +8.5"])(
    "绿色行%s没有完整已识别附加属性时不生成分段",
    (line) => {
      const input = "#r等级 80#r法术傷害 +16#r精炼等级 7#r#G法术伤害 +8#r#G速度 +8#r" + line;
      expect(coreEquipmentDescription(input)).not.toContain("附加属性：");
      expect(jewelryDescriptionSections(input)).toBeNull();
    },
  );

  it("保留官方灵饰词条，而非在精简描述时丢掉固定伤害、抗暴击等", () => {
    const input =
      "#r等级 80#r防御 +16#r精炼等级 7#r#G固定伤害 +8#r#G抗物理暴击等级 +9#r#G气血回复效果 +8";
    expect(jewelryDescriptionSections(coreEquipmentDescription(input))?.added).toEqual([
      "固定伤害 +8",
      "抗物理暴击等级 +9",
      "气血回复效果 +8",
    ]);
  });

  it("明确分段中出现无法识别的第三条数值属性，不能误当完整双属性", () => {
    expect(
      jewelryDescriptionSections(
        "等级80\n法术伤害16\n附加属性：\n法术伤害 +8\n速度 +8\n未知词条 +10",
      ),
    ).toBeNull();
  });
});
