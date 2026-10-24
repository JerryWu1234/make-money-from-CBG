import { describe, expect, it } from "vite-plus/test";
import {
  coreEquipmentDescription,
  itemFromAttributes,
  jewelryDescriptionSections,
  preserveJewelryTooltipSections,
  observedEquipmentCategory,
  equipmentEmptyProof,
} from "./compact";
import type { TabSnapshot } from "./types";

it.each([
  "confirmed",
  "missing-worn",
  "hidden-store",
  "unread-object",
  "wrong-name",
  "wrong-model",
  "unknown-icon",
])("人物空装备证据与随身宝宝装备逐件绑定：%s", (kind) => {
  const tab: TabSnapshot = {
    name: "道具/法宝",
    text: "现金100",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [
      {
        index: 0,
        name: kind === "wrong-name" ? "另一件" : "嵌宝金环",
        modelId: kind === "wrong-model" ? "9999" : "9210",
        kind: "equipment",
        attributes: kind === "unread-object" ? {} : { 装备对象: "召唤兽" },
      },
    ],
    equipmentContainers: [
      { id: "RoleUsingEquips", present: kind !== "missing-worn", visible: true, icons: [] },
      {
        id: "RoleStoreEquips",
        present: true,
        visible: kind !== "hidden-store",
        icons: [
          { name: "嵌宝金环", modelId: "9210" },
          ...(kind === "unknown-icon" ? [{ name: "未知", modelId: "123" }] : []),
        ],
      },
    ],
  };
  expect(equipmentEmptyProof([tab])).toBe(kind === "confirmed" ? "official-containers" : undefined);
});

describe("有官网证据的角色装备分类", () => {
  it("保存原档确认的4002太阳石按材料保留等级，不凭名称或相邻编号跳过装备检查", () => {
    const attrs = {
      data_equip_name: "太阳石",
      data_equip_type: "4002",
      data_equip_desc: "等级 6  ",
      data_equip_location: "saved-item-location",
    };
    expect(itemFromAttributes(attrs, 5)).toMatchObject({
      name: "太阳石",
      modelId: "4002",
      category: "材料 · 太阳石",
      description: "等级 6",
      location: "saved-item-location",
    });
    for (const modelId of ["", "4003", "04002", "31301"])
      expect(
        itemFromAttributes({ ...attrs, data_equip_type: modelId }, 5).category,
      ).toBeUndefined();
    expect(observedEquipmentCategory("武器", "仓库", "31301")).toBe("武器");
    expect(
      itemFromAttributes(
        { data_equip_name: "未知武器", data_equip_type: "31301", data_equip_desc: "伤害 +750" },
        0,
      ).attributes?.等级,
    ).toBeUndefined();
  });
  it("官网型号4034的点化石保留附加技能，同名未知型号仍须核对", () => {
    const attrs = {
      data_equip_name: "点化石",
      data_equip_type: "4034",
      data_equip_desc: "附加技能：高级幸运",
    };
    expect(itemFromAttributes(attrs, 9)).toMatchObject({
      name: "点化石",
      modelId: "4034",
      category: "材料 · 点化石",
      description: "附加技能：高级幸运",
    });
    for (const modelId of ["", "4035"])
      expect(
        itemFromAttributes({ ...attrs, data_equip_type: modelId }, 9).category,
      ).toBeUndefined();
  });
  it("官网型号612的制造指南书按材料保存说明，不凭同名或相邻型号推断", () => {
    expect(
      itemFromAttributes(
        {
          data_equip_name: "制造指南书",
          data_equip_type: "612",
          data_equip_desc: "制造指南书#r种类：头盔#r可制造等级：150",
        },
        0,
      ),
    ).toMatchObject({
      modelId: "612",
      category: "材料 · 制造指南书",
      description: "制造指南书\n种类：头盔\n可制造等级：150",
    });
    expect(itemFromAttributes({ data_equip_name: "制造指南书" }, 0).category).toBeUndefined();
    expect(observedEquipmentCategory("人物装备", "仓库", "613")).toBe("人物装备");
  });
  it.each(["4221", "4223", "4233", "4246", "63232"])(
    "官方元身模型%s与普通装备分开分类，旧材料类别和位置不改变型号",
    (modelId) => {
      expect(observedEquipmentCategory("人物装备", "仓库", modelId)).toBe("元身");
      expect(observedEquipmentCategory("材料", "role_using_equip_6", modelId)).toBe("元身");
      expect(
        itemFromAttributes({ data_equip_name: "已观察元身", data_equip_type: modelId }, 0),
      ).toMatchObject({ category: "元身", modelId });
    },
  );
  it("元身目录未观察的型号及缺型号的名称不能凭范围或文字推断", () => {
    expect(observedEquipmentCategory("人物装备", "仓库", "4243")).toBe("人物装备");
    expect(itemFromAttributes({ data_equip_name: "剑·元身" }, 0).category).toBeUndefined();
  });
  it("保留技能官方ID、原类别与可见区块，cifu类别本身不代表未来或赐福", () => {
    const current = itemFromAttributes(
      {
        data_store_name: "高级冥思",
        data_skill_type: "cifu",
        data_skill_id: "315",
        data_cbg_skill_section: "技能",
      },
      0,
    );
    expect(current).toMatchObject({
      name: "高级冥思",
      kind: "skill",
      skillObservation: {
        rawName: "高级冥思",
        type: "cifu",
        id: "315",
        section: "技能",
        state: "current",
      },
    });
    const future = itemFromAttributes(
      {
        data_store_name: "超级冥思（进化后获得）",
        data_skill_type: "cifu",
        data_skill_id: "900",
        data_cbg_skill_section: "技能",
      },
      1,
    );
    expect(future.name).toBe("超级冥思（进化后获得）");
    expect(future.skillObservation?.state).toBe("future");
    expect(
      itemFromAttributes({ data_store_name: "高级冥思", data_skill_type: "cifu" }, 0)
        .skillObservation?.state,
    ).toBe("unknown");
    expect(
      itemFromAttributes(
        {
          data_store_name: "高级冥思",
          data_skill_type: "cifu",
          data_cbg_skill_section: "赐福技能",
        },
        0,
      ).skillObservation?.state,
    ).toBe("conditional");
  });
  it("官网宝宝饰品保留纯外观说明，不要求含战斗属性", () => {
    expect(
      itemFromAttributes(
        {
          data_equip_name: "测试饰品",
          data_equip_location: "RolePetShipin",
          data_equip_desc: "#r可爱的外观装饰，装扮你的召唤兽。#r不增加战斗属性。",
        },
        0,
      ).description,
    ).toBe("可爱的外观装饰，装扮你的召唤兽。\n不增加战斗属性。");
  });
  it.each([
    [1, "头盔"],
    [2, "衣服"],
    [6, "武器"],
    [187, "戒指"],
    [188, "耳饰"],
    [189, "手镯"],
    [190, "佩饰"],
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

  it.each([
    [187, "戒指"],
    [188, "耳饰"],
    [189, "手镯"],
    [190, "佩饰"],
  ])("保存记录的泛灵饰类别按官网槽位%s补充为%s", (slot, label) => {
    expect(observedEquipmentCategory("灵饰", "role_using_equip_" + slot)).toBe(
      "人物装备 · " + label,
    );
  });

  it.each([7, 8, 191])("未知slot %s不猜装备类别", (slot) => {
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

  it.each(["61717", "61718"])(
    "官方玉魄模型 %s 独立分类且保留完整特殊描述，不推算 kindid",
    (modelId) => {
      const item = itemFromAttributes(
        {
          data_equip_name: "官方物品",
          data_equip_type: modelId,
          data_equip_location: "store_equip_tips1",
          data_equip_desc:
            "#r气血 +67#r耐久度 102#r效形：坚如磐石#r奇袭法术：弱点击破#r有效期：2026年10月",
        },
        0,
      );
      expect(item).toMatchObject({ category: "上古玉魄", modelId });
      expect(item.kindId).toBeUndefined();
      expect(item.description).toContain("效形：坚如磐石\n奇袭法术：弱点击破\n有效期：2026年10月");
      expect(observedEquipmentCategory("人物装备", "仓库", modelId)).toBe("上古玉魄");
    },
  );

  it("只有官网玉魄容器可以补类别，名字相同但缺模型及容器仍保持未知", () => {
    expect(
      itemFromAttributes({ data_equip_name: "上古玉魄·阳", data_equip_location: "RoleYuHun" }, 0)
        .category,
    ).toBe("上古玉魄");
    expect(
      itemFromAttributes({ data_equip_name: "上古玉魄·阳", data_equip_location: "仓库" }, 0)
        .category,
    ).toBeUndefined();
  });

  it.each(["611", "18521", "56870"])(
    "官网物品模型 %s 的技能书不要求人物装备等级，技能命名空间不混用",
    (modelId) => {
      const item = itemFromAttributes(
        {
          data_equip_name: "官方物品",
          data_equip_type: modelId,
          data_equip_desc: "召唤兽技能：高级反震",
        },
        0,
      );
      expect(item).toMatchObject({
        category: "道具 · 召唤兽技能书",
        modelId,
        description: "召唤兽技能：高级反震",
      });
      expect(itemFromAttributes({ data_equip_name: "魔兽要诀" }, 0).category).toBeUndefined();
      expect(
        itemFromAttributes(
          { data_equip_name: "坐骑技能", data_equip_type: modelId, data_skill_type: "riderSkill" },
          0,
        ),
      ).toMatchObject({ kind: "skill", category: "坐骑技能" });
    },
  );
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

it("装备背景说明不是镶嵌属性，镶嵌宝石、效果和等级仍保留", () => {
  const attributes =
    "等级 95\n速度 +29 伤害 +45\n耐久度 307 修理失败 1次\n镶嵌宝石 红玛瑙\n镶嵌效果\n+30速度 镶嵌等级：5\n镶嵌等级 5";
  expect(coreEquipmentDescription("镶嵌着宝物的金环，可以提高速度。\n" + attributes)).toBe(
    attributes,
  );
});

describe("已核实零精炼灵饰的真实色码分段", () => {
  const raw =
    "等级 100#r速度 +16#r耐久度 498#r#G法术防御 +21#r#G气血 +79#r#G抵抗封印等级 +20#r#c4DBAF4特效：锐不可当（2级）#r#c4DBAF4固定伤害 +2";
  const tooltip =
    "莲音玦\n【类型】佩饰\n等级 100\n速度 +16\n耐久度 498\n法术防御 +21\n气血 +79\n抵抗封印等级 +20\n特效：锐不可当（2级）\n固定伤害 +2";
  const observed = () =>
    itemFromAttributes(
      {
        data_equip_name: "莲音玦",
        data_equip_type: "27303",
        data_equip_location: "role_using_equip_190",
        data_equip_desc: raw,
      },
      2,
    );
  it("官网佩饰身份和3条绿字足以保留分段，无需虚构精炼等级", () => {
    const item = observed();
    expect(jewelryDescriptionSections(item.description!)?.added).toEqual([
      "法术防御 +21",
      "气血 +79",
      "抵抗封印等级 +20",
    ]);
    expect(item.description).not.toContain("精炼等级");
  });
  it.each(["data_kindid", "data-kindid"])("包内零精炼灵饰沿用官网明确的%s分类证据", (key) => {
    const item = itemFromAttributes(
      {
        data_equip_name: "莲音玦",
        data_equip_type: "27303",
        data_equip_location: "store_equip_tips1",
        data_equip_desc: raw,
        [key]: "64",
      },
      2,
    );
    expect(item.kindId).toBe("64");
    expect(jewelryDescriptionSections(item.description!)?.added).toEqual([
      "法术防御 +21",
      "气血 +79",
      "抵抗封印等级 +20",
    ]);
    expect(item.description).not.toContain("精炼等级");
  });
  it("实际提示中连续唯一匹配原始附加段，覆盖描述时保留标题", () => {
    const restored = preserveJewelryTooltipSections(tooltip, observed().description!);
    expect(jewelryDescriptionSections(coreEquipmentDescription(restored))?.added).toHaveLength(3);
    expect(restored).toContain("耐久度 498\n附加属性：\n法术防御 +21");
  });
  it("原始段与实际提示不符或出现多个位置，不恢复标题", () => {
    expect(
      preserveJewelryTooltipSections(
        tooltip.replace("气血 +79", "气血 +80"),
        observed().description!,
      ),
    ).not.toContain("附加属性：");
    expect(
      preserveJewelryTooltipSections(
        tooltip + "\n法术防御 +21\n气血 +79\n抵抗封印等级 +20",
        observed().description!,
      ),
    ).not.toContain("附加属性：");
  });
  it("无官方灵饰身份的普通绿字装备不按零精炼灵饰分段", () => {
    expect(
      itemFromAttributes({ data_equip_name: "未知物品", data_equip_desc: raw }, 0).description,
    ).not.toContain("附加属性：");
  });
});
