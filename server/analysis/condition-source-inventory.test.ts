import { expect, it } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import type { DetailItem } from "../crawler/types";
import { conditionSourceInventory } from "./condition-source-inventory";

function fixture(items: DetailItem[]) {
  const record = analysisRecord("source-inventory-fixture");
  const tab = record.detail!.tabs.find((value) => value.name === "道具/法宝")!;
  tab.items = items;
  tab.text = items.length ? "已经读取全部随身和仓库物品" : "没有装备";
  record.detail!.equipmentCapture!.emptyProof = "explicit-text";
  return record;
}
function character(index: number, gem: number | null, patch: Partial<DetailItem> = {}): DetailItem {
  return {
    index,
    name: `合成测试装备${index}`,
    kind: "equipment",
    location: `store_equip_tips${index}`,
    attributes: { 装备角色: "测试角色", 装备条件: "等级70" },
    description: `等级70\n伤害100\n${gem === null ? "" : `锻炼等级 ${gem} 镶嵌宝石 测试宝石`}`,
    ...patch,
  };
}

it("官方类别证明的背包灵饰不会误当成人物装备缺少宝石，六件背包装备合计21", () => {
  const jewelry: DetailItem[] = ["戒指", "耳饰", "佩饰", "手镯"].map((type, index) => ({
    index,
    name: `未鉴定测试灵饰${index}`,
    kind: "equipment",
    location: `store_equip_tips${index}`,
    description: "等级60\n防御10\n未鉴定物品",
    officialModel: { modelId: String(1000 + index), description: `测试元数据#r【类型】${type}#r` },
  }));
  const record = fixture([
    ...jewelry,
    ...[2, 2, 2, 4, 5, 6].map((stage, index) => character(index + 4, stage)),
  ]);
  const original = JSON.stringify(record);
  const inventory = conditionSourceInventory(record);
  expect(JSON.stringify(record)).toBe(original);
  expect(inventory.jewelry).toHaveLength(4);
  expect(inventory.equipment).toHaveLength(6);
  expect(inventory.gemSummary).toMatchObject({ knownSum: 21, total: 21, missingItems: [] });
  expect(inventory.jewelry[0].classificationEvidence).toContainEqual({
    path: "/detail/tabs/2/items/0/officialModel/description",
    quote: "【类型】戒指",
  });
  expect(inventory.equipment[0].gemEvidence[0]).toEqual({
    path: "/detail/tabs/2/items/4/description",
    quote: "锻炼等级 2",
  });
});

it("穿戴47段和同名背包7段分别保留，绑定和不受交易支持的等级不影响实物清单", () => {
  const items = [10, 9, 7, 5, 9, 7].map((value, index) =>
    character(index, value, { name: "相同名称", location: `role_using_equip_${index + 1}` }),
  );
  items.push(
    character(6, 7, {
      name: "相同名称",
      description: "等级0\n伤害100\n玩家123专用\n锻炼等级 7 镶嵌宝石 测试宝石",
    }),
  );
  const inventory = conditionSourceInventory(fixture(items));
  expect(inventory.equipment).toHaveLength(7);
  expect(inventory.gemSummary).toMatchObject({ knownSum: 54, total: 54 });
});

it("完整详情未显示宝石按0段，明确0参与清单，法宝和宝石材料不混入", () => {
  const record = fixture([
    character(0, 6),
    character(1, null),
    character(2, 0),
    character(3, 99, { category: "法宝" }),
    character(4, 99, { modelId: "4003", category: "" }),
  ]);
  const inventory = conditionSourceInventory(record);
  expect(inventory.equipment).toHaveLength(3);
  expect(inventory.gemSummary).toMatchObject({ knownSum: 6, total: 6, missingItems: [] });
  expect(inventory.equipment[1].gemLevel).toBe(0);
  expect(inventory.equipment[1].gemEvidence[0]).toMatchObject({
    path: "/detail/tabs/2/items/1/description",
  });
  expect(inventory.equipment[2].gemLevel).toBe(0);
});

it.each([
  { description: undefined, tooltip: undefined },
  { description: "只有物品名称" },
  { description: "等级70\n伤害100\n锻炼等级 未读取" },
  { description: "等级70\n伤害100\n镶嵌宝石 未读取" },
])("真正未读取或有宝石标签但无数值，不补0：%j", (patch) => {
  const record = fixture([character(0, null, patch)]);
  expect(conditionSourceInventory(record).equipment[0].gemLevel).toBeNull();
});

it("整体采集不完整时，缺少宝石信息仍保留未知", () => {
  const record = fixture([character(0, null)]);
  record.detail!.equipmentCapture!.complete = false;
  expect(conditionSourceInventory(record).equipment[0].gemLevel).toBeNull();
});

it("类别未确认不猜类型，但完整详情明确无宝石时贡献0段", () => {
  const record = fixture([
    character(0, null, { attributes: {}, name: "名字看似头盔", category: undefined }),
  ]);
  const inventory = conditionSourceInventory(record);
  expect(inventory.equipment).toHaveLength(0);
  expect(inventory.unclassified).toHaveLength(1);
  expect(inventory.gemSummary).toMatchObject({ total: 0, classificationComplete: false });
});

it("原文冲突与未采齐均不会提供准确总数", () => {
  const record = fixture([character(0, 7, { tooltip: "等级70\n锻炼等级8" })]);
  const inventory = conditionSourceInventory(record);
  expect(inventory.equipment[0].gemLevel).toBeNull();
  expect(inventory.gemSummary.total).toBeNull();
  expect(inventory.issues).toContain("合成测试装备0的宝石段数原文冲突");
  record.detail!.captureMode = "body";
  expect(conditionSourceInventory(record).equipmentCaptureComplete).toBe(false);
  expect(conditionSourceInventory(record).gemSummary.total).toBeNull();
});

it("零级野生宝宝及其穿戴装备仍在实物清单中，饰品单独排除", () => {
  const record = fixture([
    character(0, null, {
      category: "召唤兽装备",
      attributes: { 装备对象: "召唤兽" },
      location: "RolePetEquips",
    }),
  ]);
  const tab = record.detail!.tabs.find((value) => value.name === "召唤兽/孩子")!;
  tab.pets = [
    {
      index: 0,
      name: "测试野生零级宝宝",
      fields: [
        { name: "等级", value: "0" },
        { name: "是否宝宝", value: "否" },
      ],
      skills: [],
      innerSkills: [],
      equipment: [
        character(0, null, { category: "召唤兽装备", location: "RolePetEquips" }),
        character(1, null, { category: "宝宝饰品", location: "RolePetShipin" }),
      ],
    },
  ];
  tab.petCount = 1;
  const inventory = conditionSourceInventory(record);
  expect(inventory.pets).toHaveLength(1);
  expect(inventory.petEquipment).toHaveLength(2);
  expect(inventory.petEquipment.map((item) => item.path)).toContain(
    "/detail/tabs/3/pets/0/equipment/0",
  );
});

it("只按明确物品ID去重，名称和DOM位置重复不合并实物", () => {
  const sameId = "202611141234567-100-ABCDEFG";
  const record = fixture([
    character(0, 3, { location: sameId }),
    character(1, 3, { location: sameId, name: "合成测试装备0" }),
    character(2, 3, { location: "store_equip_tips0", name: "合成测试装备0" }),
    character(3, 3, { location: "store_equip_tips0", name: "合成测试装备0" }),
  ]);
  expect(conditionSourceInventory(record).equipment).toHaveLength(3);
  expect(conditionSourceInventory(record).gemSummary.total).toBe(9);
});
