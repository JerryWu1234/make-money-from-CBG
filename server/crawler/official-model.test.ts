import { describe, expect, it } from "vite-plus/test";
import { itemFromAttributes, isNonRoleEquipment, equipmentEmptyProof } from "./compact";

const attrs = (records: unknown[], modelId = "90001") => ({
  data_equip_type: modelId,
  data_official_model_metadata: JSON.stringify({ modelId, records }),
});
describe("官网精确型号元数据", () => {
  it.each(["道具", "宝石", "召唤兽技能书"])(
    "明确类别%s保留名称及完整描述，不套人物装备属性",
    (category) => {
      const item = itemFromAttributes(
        {
          ...attrs([
            { name: "官网物品", category, desc: "【类型】" + category + "#r完整用途说明" },
          ]),
          data_equip_desc: "等级 5",
        },
        0,
      );
      expect(item.name).toBe("官网物品");
      expect(item.nameSource).toBe("official-model");
      expect(item.categorySource).toBe("official-model");
      expect(item.description).toContain("完整用途说明");
      expect(item.description).toContain("等级 5");
      expect(isNonRoleEquipment(item)).toBe(true);
      expect(
        equipmentEmptyProof([
          {
            name: "道具/法宝",
            text: "",
            fields: [],
            tables: [],
            elements: [],
            tooltips: [],
            items: [item],
            equipmentContainers: [
              { id: "RoleUsingEquips", present: true, visible: true, icons: [] },
              {
                id: "RoleStoreEquips",
                present: true,
                visible: true,
                icons: [{ name: "", modelId: "90001" }],
              },
            ],
          },
        ]),
      ).toBe("official-containers");
    },
  );
  it.each([
    attrs([{ name: "未知物品" }]),
    { ...attrs([{ name: "光芒石", desc: "等级 9" }]), data_equip_name: "光芒石" },
    { ...attrs([{ name: "物品", category: "道具" }]), data_equip_type: "90002" },
    attrs([
      { name: "冲突甲", category: "道具" },
      { name: "冲突乙", category: "人物装备" },
    ]),
    attrs([
      { name: "冲突甲", category: "道具" },
      { name: "冲突乙", category: "道具" },
    ]),
    attrs([{ name: "物品", category: "道具" }], "090001"),
  ])("未知、错型号、冲突和名称相似均不能免除人物装备校验", (value) => {
    expect(isNonRoleEquipment(itemFromAttributes(value, 0))).toBe(false);
  });
  it("穿戴人物装备的真实位置不能被元数据道具类别覆盖", () => {
    const item = itemFromAttributes(
      {
        ...attrs([{ name: "穿戴武器", category: "道具" }]),
        data_equip_location: "role_using_equip_6",
        data_equip_desc: "等级 30#r伤害 +100",
      },
      0,
    );
    expect(isNonRoleEquipment(item)).toBe(false);
    expect(item.category).toBe("人物装备 · 武器");
  });
});
