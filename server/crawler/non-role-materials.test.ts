import { describe, expect, it } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import { equipmentInventory } from "../analysis/equipment-pricing";
import { itemFromAttributes, isNonRoleEquipment } from "./compact";
import { equipmentCaptureSummary } from "./detail";
import type { DetailItem, TabSnapshot } from "./types";

// Exact model/name/level pairs retained by failed project captures.
const materials = [
  { model: "3995", name: "附魔宝珠", description: "等级：140", category: "材料 · 附魔宝珠" },
  { model: "4004", name: "光芒石", description: "等级 5", category: "材料 · 光芒石" },
  { model: "4003", name: "月亮石", description: "等级 5", category: "材料 · 月亮石" },
  { model: "61719", name: "五色灵尘", description: "等级 6", category: "材料 · 五色灵尘" },
  { model: "56973", name: "玄灵珠·回春", description: "等级6", category: "道具 · 坐骑玄灵珠" },
];
const weapon = () =>
  itemFromAttributes(
    {
      data_equip_name: "已读武器",
      data_equip_type: "31301",
      data_equip_category: "武器",
      data_equip_location: "role_using_equip_6",
      data_equip_desc: "等级 100\n伤害 +420",
    },
    0,
  );
const tab = (items: DetailItem[]): TabSnapshot => ({
  name: "道具/法宝",
  text: "人物穿戴与随身道具",
  fields: [],
  tables: [],
  elements: [],
  tooltips: [],
  items,
});

describe("归档中精确确认的非人物装备型号", () => {
  it.each(["61717", "61718"])("五色灵尘分类不放过相邻的真实玉魄型号%s", (model) => {
    const item = itemFromAttributes(
      {
        data_equip_name: "上古玉魄",
        data_equip_type: model,
        data_equip_desc: "等级 6",
      },
      1,
    );
    expect(item.category).toBe("上古玉魄");
    expect(isNonRoleEquipment(item)).toBe(false);
    expect(equipmentCaptureSummary([tab([weapon(), item])], "saved-capture").complete).toBe(false);
  });

  it.each(materials)("$name 保留等级，不要求人物装备属性，不进入装备查价", (material) => {
    const item = itemFromAttributes(
      {
        data_equip_name: material.name,
        data_equip_type: material.model,
        data_equip_desc: material.description,
      },
      1,
    );
    expect(item).toMatchObject({
      modelId: material.model,
      name: material.name,
      category: material.category,
      description: material.description,
    });
    expect(isNonRoleEquipment(item)).toBe(true);
    const snapshot = tab([weapon(), item]);
    expect(equipmentCaptureSummary([snapshot], "saved-capture")).toMatchObject({
      complete: true,
      issues: [],
    });
    const saved = analysisRecord("material-model");
    saved.detail!.tabs = [snapshot];
    expect(equipmentInventory(saved).items.map(({ name }) => name)).toEqual(["已读武器"]);
  });

  it.each(materials)("同名但无精确型号的$name仍须核对，普通装备也不被放过", (material) => {
    for (const model of ["", "0" + material.model, "999999"]) {
      const unknown = itemFromAttributes(
        {
          data_equip_name: material.name,
          data_equip_type: model,
          data_equip_desc: material.description,
        },
        1,
      );
      expect(isNonRoleEquipment(unknown)).toBe(false);
      expect(equipmentCaptureSummary([tab([weapon(), unknown])], "saved-capture").complete).toBe(
        false,
      );
    }
    const incompleteWeapon = weapon();
    incompleteWeapon.description = "等级 100";
    const known = itemFromAttributes(
      {
        data_equip_name: material.name,
        data_equip_type: material.model,
        data_equip_desc: material.description,
      },
      1,
    );
    expect(
      equipmentCaptureSummary([tab([incompleteWeapon, known])], "saved-capture").issues.join("；"),
    ).toContain("已读武器 的装备属性未完整读取");
  });
});
