import { expect, it } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import { capturedAssetCounts } from "./asset-counts";
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
