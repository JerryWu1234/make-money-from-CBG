import { expect, it } from "vite-plus/test";
import { CAPTURE_VERSION, itemFromAttributes } from "./compact";
import { captureIssues } from "./capture-readiness";
import { MAIN_TABS } from "./detail-tabs";
import { equipmentCaptureSummary } from "./equipment-capture";
import { fieldEvidence } from "./field-evidence";
import { petCaptureSummary } from "./pet-capture-summary";
import { normalizeValuationSource } from "./valuation-source";
import type { RoleDetail, TabSnapshot } from "./types";

const listing = { serverId: "367", eid: "independent-field-evidence" };
const collectedAt = "2026-11-15T14:00:00.000Z";
const revision = "a".repeat(64);

function tab(name: string, contentText: string): TabSnapshot {
  return {
    name,
    contentText,
    text: contentText,
    fields: [],
    tables: [],
    elements: [],
    tooltips: [],
    items: [],
  };
}

function source(
  riders: Record<string, unknown> = { one: { iGrow: 230, exgrow: 0, mattrib: "力量" } },
) {
  return normalizeValuationSource({
    ...listing,
    riders,
    advancedMount: { isJinJie: 0 },
    hasArtifact: false,
    artifact: null,
    idEffects: [],
    goldIdFlag: false,
    allSkills: { 230: 40, 237: 20 },
    holyLevel: 0,
    assets: { iCash: 0, iSaving: 0, iLearnCash: 0, xianyu: 0 },
  });
}

function refreshEvidence(detail: RoleDetail): RoleDetail {
  detail.sourceEvidence = {
    version: 1,
    ...listing,
    initialRevision: revision,
    finalRevision: revision,
    stable: true,
    fields: fieldEvidence(detail.tabs, detail.valuation),
  };
  return detail;
}

function complete(): RoleDetail {
  const person = tab("人物/修炼", "名称：独立字段样本\n等级：175\n攻击修炼：25/25");
  person.fields = [
    { name: "名称", value: "独立字段样本" },
    { name: "等级", value: "175" },
    { name: "攻击修炼", value: "25/25" },
  ];
  const skills = tab("技能", "师门技能\n生活技能\n辅助技能");
  skills.items = ["甲", "乙", "丙", "丁", "戊", "己", "庚"].map((name, index) => ({
    index,
    name: "独立师门" + name,
    level: "150",
    kind: "skill",
    category: "师门技能",
  }));
  skills.items.push(
    { index: 7, name: "强身术", level: "140", kind: "skill", category: "技能" },
    { index: 8, name: "烹饪技巧", level: "140", kind: "skill", category: "技能" },
  );
  const equipment = tab("道具/法宝", "暂无道具");
  equipment.equipmentEmptyProof = "official-containers";
  equipment.equipmentContainers = ["RoleUsingEquips", "RoleStoreEquips"].map((id) => ({
    id,
    present: true,
    visible: true,
    icons: [],
  }));
  const pets = tab("召唤兽/孩子", "召唤兽(0/10)\n无召唤兽");
  pets.petCount = 0;
  pets.pets = [];
  const mounts = tab("坐骑", "名称：仙鹿\n坐骑成长：2.3");
  mounts.fields = [
    { name: "名称", value: "仙鹿" },
    { name: "坐骑成长", value: "2.3" },
  ];
  const clothes = tab("锦衣/外观", "锦衣：青花瓷\n祥瑞：浪淘沙");
  clothes.fields = [
    { name: "锦衣", value: "青花瓷" },
    { name: "祥瑞", value: "浪淘沙" },
  ];
  const home = tab("玩家之家", "房屋：豪宅\n庭院：大型庭院");
  home.fields = [
    { name: "房屋", value: "豪宅" },
    { name: "庭院", value: "大型庭院" },
  ];
  const tabs = [person, skills, equipment, pets, mounts, clothes, home];
  return refreshEvidence({
    captureMode: "all",
    captureVersion: CAPTURE_VERSION,
    url: "https://xyq.cbg.163.com/equip?s=367&eid=independent-field-evidence",
    collectedAt,
    tabs,
    raw: {},
    valuation: source(),
    equipmentCapture: equipmentCaptureSummary(tabs, collectedAt),
    petCapture: petCaptureSummary(0, [], collectedAt),
  });
}

function contentEvidence(detail: RoleDetail, name: string) {
  return detail.sourceEvidence?.fields.find((field) => field.path === `tabs.${name}.content`);
}

it("keeps an official model name distinct from an element name in the field ledger", () => {
  const item = itemFromAttributes(
    {
      data_equip_type: "900101",
      data_official_model_metadata: JSON.stringify({
        modelId: "900101",
        records: [{ name: "官方模型物品", category: "材料" }],
      }),
    },
    0,
  );
  expect(item.nameSource).toBe("official-model");
  const snapshot = tab("道具/法宝", "官方模型物品");
  snapshot.items = [item];
  expect(fieldEvidence([snapshot])).toContainEqual({
    path: "tabs.道具/法宝.items[0].name",
    source: "official-model",
    state: "observed",
  });
});

const categoryCases: Array<{
  source: "official-slot" | "description";
  attrs: Record<string, string>;
}> = [
  {
    source: "official-slot",
    attrs: {
      data_equip_name: "明确槽位头盔",
      data_equip_type: "900102",
      data_equip_location: "role_using_equip_1",
    },
  },
  {
    source: "description",
    attrs: {
      data_equip_name: "说明中的法宝",
      data_equip_type: "900103",
      data_equip_desc: "灵气：30#r修炼境界：5",
    },
  },
];
it.each(categoryCases)(
  "preserves the $source category origin in the field ledger",
  ({ source, attrs }) => {
    const item = itemFromAttributes(attrs, 0);
    expect(item.categorySource).toBe(source);
    const snapshot = tab("道具/法宝", item.name);
    snapshot.items = [item];
    expect(fieldEvidence([snapshot])).toContainEqual({
      path: "tabs.道具/法宝.items[0].category",
      source,
      state: "observed",
    });
  },
);

it("accepts the independent complete baseline through actual readiness checks", () => {
  const detail = complete();
  expect(captureIssues(detail, true, true, listing)).toEqual([]);
  for (const name of ["坐骑", "锦衣/外观", "玩家之家"])
    expect(contentEvidence(detail, name)).toMatchObject({ state: "observed" });
});

for (const name of ["坐骑", "锦衣/外观", "玩家之家"]) {
  it.each([undefined, "", " \n\t "])(
    `blocks ${name} when loaded content is missing or blank despite retained navigation: %j`,
    (contentText) => {
      const detail = complete();
      const target = detail.tabs.find((entry) => entry.name === name)!;
      target.contentText = contentText;
      target.text = `价格：￥1000\n${MAIN_TABS.join("\n")}\n已选中：${name}`;
      target.fields = [];
      target.tables = [];
      target.items = [];
      refreshEvidence(detail);
      expect(contentEvidence(detail, name)).toMatchObject({ state: "unknown" });
      expect(captureIssues(detail, true, true, listing).some((issue) => issue.includes(name))).toBe(
        true,
      );
    },
  );
}

it.each([
  ["坐骑", "坐骑：加载中，请稍后"],
  ["锦衣/外观", "锦衣：加载中，请稍后"],
  ["玩家之家", "房屋：加载中，请稍后"],
  ["坐骑", "暂无坐骑信息，请稍后重试"],
  ["锦衣/外观", "暂无锦衣信息\n暂无祥瑞信息，请稍后重试"],
  ["玩家之家", "暂无房屋信息，请稍后重试"],
])("keeps %s partial for a loading or unavailable-data message: %s", (name, contentText) => {
  const detail = complete();
  const target = detail.tabs.find((entry) => entry.name === name)!;
  target.contentText = contentText;
  target.text = `价格：￥1000\n${MAIN_TABS.join("\n")}\n${contentText}`;
  target.fields = [];
  target.tables = [];
  target.items = [];
  refreshEvidence(detail);
  const issues = captureIssues(detail, true, true, listing);
  expect(contentEvidence(detail, name)).toMatchObject({ state: "unknown" });
  expect(issues.some((issue) => issue.includes(name))).toBe(true);
});

it.each([
  ["锦衣/外观", "无锦衣\n无祥瑞"],
  ["玩家之家", "无房屋\n无庭院"],
  ["坐骑", "无坐骑"],
])(
  "accepts explicit absence in %s without treating missing content as zero",
  (name, contentText) => {
    const detail = complete();
    const target = detail.tabs.find((entry) => entry.name === name)!;
    target.contentText = contentText;
    target.text = contentText;
    target.fields = [];
    target.tables = [];
    target.items = [];
    if (name === "坐骑") detail.valuation = source({});
    refreshEvidence(detail);
    expect(contentEvidence(detail, name)).toMatchObject({ state: "explicit-empty" });
    expect(captureIssues(detail, true, true, listing)).toEqual([]);
  },
);
