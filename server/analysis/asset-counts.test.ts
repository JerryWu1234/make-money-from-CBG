import { expect, it } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { capturedAssetCounts, capturedAssetSummary } from "./asset-counts";
import { CrawlStore } from "../crawler/store";
import { AnalysisStore } from "./store";
import { createProfile } from "./profile";

function recordWithAssets() {
  const record = valuationRecord();
  record.detail!.captureMode = "all";
  const helmet = {
    index: 0,
    name: "测试头盔",
    kind: "equipment" as const,
    category: "人物装备 · 头盔",
    location: "role_using_equip_1",
    description:
      "等级 80\n防御 +50\n锻炼等级 6\n特技：破甲术\n特效：永不磨损\n套装效果：变身术之鬼将",
  };
  record.detail!.tabs.push({
    name: "道具/法宝",
    text: "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [
      helmet,
      {
        index: 1,
        name: "测试戒指",
        kind: "equipment",
        category: "灵饰 · 戒指",
        kindId: "61",
        description: "等级 80\n伤害 +16\n精炼等级 3",
      },
      { index: 2, name: "测试法宝", kind: "equipment", category: "法宝", description: "等级 1" },
      { index: 3, name: "玉魄", kind: "equipment", category: "上古玉魄", description: "上古玉魄" },
    ],
  });
  record.detail!.tabs.push({
    name: "道具/法宝 / 其他页",
    text: "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [helmet],
  });
  record.detail!.equipmentCapture = { version: 1, collectedAt: "now", complete: true, issues: [] };
  record.detail!.petCapture = { version: 1, collectedAt: "now", complete: true, issues: [] };
  record.detail!.tabs.push({
    name: "召唤兽/孩子",
    text: "",
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    petCount: 1,
    pets: [
      {
        index: 0,
        name: "画魂",
        fields: [{ name: "类型", value: "画魂" }],
        skills: [],
        equipment: [],
        innerSkills: [],
      },
    ],
  });
  return record;
}

it("装备、灵饰、宝宝按已采库存分别计数，装备重复容器去重且简要属性来自原文", () => {
  const record = recordWithAssets();
  expect(capturedAssetCounts(record)).toEqual({
    equipment: 1,
    jewelry: 1,
    pets: 1,
    equipmentItems: [
      {
        name: "测试头盔",
        level: 80,
        gemLevel: 6,
        specialSkills: ["破甲术"],
        specialEffects: ["永不磨损"],
        sets: ["变身术之鬼将"],
      },
    ],
  });
  record.detail!.equipmentCapture!.complete = false;
  expect(capturedAssetCounts(record)).toBeNull();
  record.detail!.equipmentCapture!.complete = true;
  record.detail!.tabs.find((t) => t.name === "召唤兽/孩子")!.petCount = 2;
  expect(capturedAssetCounts(record)).toBeNull();
});

it("分析中和详情的数量绑定任务冻结原文，不读取后来改变的库存", () => {
  const crawl = new CrawlStore(":memory:");
  try {
    const record = recordWithAssets();
    crawl.observe(record.listing);
    crawl.save(record.listing, record.detail!);
    const store = new AnalysisStore(crawl.db),
      id = store.createRun("codex", "test", true, createProfile("fixture"), true);
    const row = crawl.db.prepare("SELECT id FROM analysis_tasks WHERE run_id=?").get(id)!;
    crawl.db.prepare("UPDATE analysis_tasks SET status='running' WHERE id=?").run(row.id);
    record.detail!.tabs.find((t) => t.name === "道具/法宝")!.items = [];
    crawl.save(record.listing, record.detail!);
    expect(store.run(id)?.assetCounts).toMatchObject({ equipment: 1, jewelry: 1, pets: 1 });
    expect(store.detail(String(row.id))?.assetCounts).toMatchObject({
      equipment: 1,
      jewelry: 1,
      pets: 1,
    });
  } finally {
    crawl.close();
  }
});

it("无分类元数据且无精炼等级的仓库物品只显示装备/灵饰合计，不猜成确定的人物装备", () => {
  const record = recordWithAssets();
  record.detail!.tabs = record.detail!.tabs.filter((tab) => !tab.name.startsWith("道具/法宝 /"));
  record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items = [
    {
      index: 0,
      name: "枫华戒",
      modelId: "27001",
      location: "store_equip_tips1",
      kind: "equipment",
      description: "等级 60\n防御 +14",
    },
  ];
  expect(capturedAssetCounts(record)).toEqual({
    equipment: null,
    jewelry: null,
    equipmentTotal: 1,
    pets: 1,
    equipmentItems: [],
  });
});

// Failure cases: duplicate gear inflates counts, wild/zero pets look usable, future skills
// appear as current skills, long inventories flood cards, or partial capture becomes zero.
it("榜单摘要显示实际特技、套装和星辉石，区分野生、0级及未核实类型，并限制预览数量", () => {
  const record = recordWithAssets();
  const tab = record.detail!.tabs.find((t) => t.name === "召唤兽/孩子")!;
  const baby = {
    index: 0,
    name: "画魂",
    fields: [
      { name: "类型", value: "画魂" },
      { name: "等级", value: "165" },
      { name: "是否宝宝", value: "是" },
    ],
    skills: [
      { index: 0, name: "高级魔之心" },
      { index: 1, name: "须弥真言" },
      { index: 2, name: "高级法术连击" },
      {
        index: 3,
        name: "进化技能",
        skillObservation: {
          rawName: "进化技能",
          type: "evolution",
          state: "future" as const,
        },
      },
    ],
    equipment: [],
    innerSkills: [],
  };
  tab.pets = [
    baby,
    {
      ...baby,
      index: 1,
      fields: baby.fields.map((f) => (f.name === "是否宝宝" ? { ...f, value: "否" } : f)),
    },
    {
      ...baby,
      index: 2,
      fields: baby.fields.map((f) => (f.name === "等级" ? { ...f, value: "0" } : f)),
    },
    { ...baby, index: 3, fields: baby.fields.filter((f) => f.name !== "是否宝宝") },
    { ...baby, index: 4 },
    {
      ...baby,
      index: 5,
      name: "隐藏预览宠",
      fields: baby.fields.map((f) => (f.name === "类型" ? { ...f, value: "隐藏预览宠" } : f)),
    },
  ];
  tab.petCount = tab.pets.length;
  const summary = capturedAssetSummary(record)!;
  expect(summary.equipment).toContain("装备 1件 · 灵饰 1件 · 带宝石/星辉石 2件");
  expect(summary.equipment).toContain("测试头盔 / 80级 / 宝石6段");
  expect(summary.equipment).toContain("特技：破甲术");
  expect(summary.equipment).toContain("套装：变身术之鬼将");
  expect(summary.equipment).toContain("测试戒指 / 80级 / 星辉石3段");
  expect(summary.equipment).not.toContain("测试法宝");
  expect(summary.pets).toContain("非野生宝宝 3只");
  expect(summary.pets).toContain("画魂 / 165级 / 3技能：");
  expect(summary.pets).toContain("须弥真言");
  expect(summary.pets).toContain("另有1只");
  expect(summary.pets).toContain("野生1只（不计入）");
  expect(summary.pets).toContain("0级1只（不计入）");
  expect(summary.pets).toContain("类型未核实1只");
  expect(summary.pets).not.toMatch(/进化技能|隐藏预览宠/);
  const gear = record.detail!.tabs.find((t) => t.name === "道具/法宝")!;
  for (let index = 4; index < 8; index++)
    gear.items!.push({
      index,
      name: "额外装备" + index,
      kind: "equipment",
      category: "人物装备 · 头盔",
      description: "等级 80\n防御 +50\n锻炼等级 4",
    });
  expect(capturedAssetSummary(record)!.equipment).toContain("另有3件，详情可查看");
  expect(capturedAssetSummary(record)!.equipment).not.toContain("额外装备7");
});

it("榜单摘要不把未采齐资料或旧裸号采集当成空库存", () => {
  const record = recordWithAssets();
  record.detail!.petCapture!.complete = false;
  expect(capturedAssetSummary(record)).toBeNull();
  record.detail!.petCapture!.complete = true;
  record.detail!.captureMode = "body";
  expect(capturedAssetSummary(record)).toBeNull();
});
