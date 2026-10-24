import { gunzipSync } from "node:zlib";
import { expect, it } from "vite-plus/test";
import { analysisRecord } from "../../tests/fixtures/analysis";
import {
  equipmentNameUnresolved,
  mergeWornEquipmentLevel,
  type WornEquipmentSource,
} from "./compact";
import { equipmentCaptureSummary } from "./detail";
import { CrawlStore } from "./store";
import { collectCompleteCapture } from "./capture-readiness";

const listing = { serverId: "750", eid: "isolated-role" };
const description = "五行 土#r伤害 +15 命中 +20#r耐久度 100#Y  ";
const observed = () => ({
  data_equip_name: "模拟已核对武器",
  data_equip_type: "31301",
  data_equip_location: "role_using_equip_6",
  data_equip_desc: description,
});
const evidence = (raw: Record<string, unknown> = {}): WornEquipmentSource => ({
  ...listing,
  allEquip: { 6: { iType: 31301, cDesc: description, obj_level: 0, ...raw } },
});

it.each([0, 30])("同角色槽位、型号和描述明确一致时保留原档显式等级 %s，输入不被改写", (level) => {
  const attrs = observed(),
    source = evidence({ obj_level: level });
  const before = structuredClone({ attrs, source });
  expect(mergeWornEquipmentLevel(attrs, listing, source)).toEqual({
    attrs: { ...attrs, data_equip_level: String(level) },
    rawLevel: String(level),
  });
  expect({ attrs, source }).toEqual(before);
});

it.each([
  "server",
  "eid",
  "slot",
  "model",
  "description",
  "missing",
  "null",
  "negative",
  "fraction",
  "string",
  "too-large",
  "non-worn",
  "inherited-slot",
])("原档等级绑定不成立时不补值、不默认0：%s", (kind) => {
  const attrs = observed(),
    source = evidence();
  const raw = source.allEquip[6] as Record<string, unknown>;
  if (kind === "server") source.serverId = "another-server";
  if (kind === "eid") source.eid = "another-role";
  if (kind === "slot") {
    source.allEquip[5] = raw;
    delete source.allEquip[6];
  }
  if (kind === "model") raw.iType = 31302;
  if (kind === "description") raw.cDesc = "其他商品属性";
  if (kind === "missing") delete raw.obj_level;
  if (kind === "null") raw.obj_level = null;
  if (kind === "negative") raw.obj_level = -1;
  if (kind === "fraction") raw.obj_level = 0.5;
  if (kind === "string") raw.obj_level = "0";
  if (kind === "too-large") raw.obj_level = 1000;
  if (kind === "non-worn") attrs.data_equip_location = "store-item-eid";
  if (kind === "inherited-slot") {
    delete source.allEquip[6];
    Object.setPrototypeOf(source.allEquip, { 6: raw });
  }
  expect(mergeWornEquipmentLevel(attrs, listing, source)).toEqual({ attrs });
});

it.each(["attribute", "description"])("原档与页面等级矛盾时保留原值并标失败：%s", (kind) => {
  const attrs: Record<string, string> = observed(),
    source = evidence();
  if (kind === "attribute") attrs.data_equip_level = "1";
  else {
    attrs.data_equip_desc = "等级 1#r" + description;
    (source.allEquip[6] as Record<string, unknown>).cDesc = attrs.data_equip_desc;
  }
  expect(mergeWornEquipmentLevel(attrs, listing, source)).toEqual({
    attrs,
    issue: "原始穿戴装备等级与页面等级不一致",
  });
});

it.each(["", "图标 1", "五行 土", "五行：金", "等级 0", "伤害 +15 命中 +20", "耐久度 100"])(
  "装备属性行和未知图标不能充当名称：%s",
  (name) => {
    expect(equipmentNameUnresolved(name)).toBe(true);
    expect(equipmentNameUnresolved("模拟已核对武器")).toBe(false);
  },
);

it.each(
  [
    "命中",
    "伤害",
    "防御",
    "气血",
    "魔法",
    "魔力",
    "灵力",
    "速度",
    "敏捷",
    "力量",
    "体质",
    "耐力",
    "法术伤害",
    "法术防御",
    "法术暴击",
    "物理暴击",
    "封印命中",
    "抵抗封印",
    "抗物理暴击",
    "抗法术暴击",
    "抗固伤",
    "固伤暴击",
    "穿刺",
    "狂暴",
    "治疗能力",
    "格挡",
    "抵抗",
    "固定伤害",
    "法术伤害结果",
    "气血回复效果",
    "回复",
    "固伤",
    "法伤结果",
    "法伤",
    "法防",
    "封印",
    "抗封",
    "治疗",
    "抗封印",
  ].flatMap((label) => [label + " +15", label + "等级 +15", label + "值：15"]),
)("现有装备数值标签及后缀不能被读作真实名称：%s", (name) => {
  expect(equipmentNameUnresolved(name)).toBe(true);
});

it("显式0级仍缺真实名称时三次有界重读后隔离保存原始来源，不占完整角色额度或推进断点", async () => {
  const record = analysisRecord("unresolved-name"),
    store = new CrawlStore(":memory:");
  try {
    record.detail!.raw = { encodedRoleData: "isolated raw evidence with explicit obj_level:0" };
    record.detail!.tabs.find((tab) => tab.name === "道具/法宝")!.items = [
      {
        index: 0,
        kind: "equipment",
        category: "人物装备 · 武器",
        name: "五行 土",
        modelId: "31301",
        location: "role_using_equip_6",
        attributes: { 等级: "0" },
        description: "五行 土\n伤害 +15 命中 +20\n耐久度 100",
      },
    ];
    record.detail!.equipmentCapture = equipmentCaptureSummary(
      record.detail!.tabs,
      record.detail!.collectedAt,
    );
    expect(record.detail!.equipmentCapture).toMatchObject({
      complete: false,
      issues: ["道具/法宝：型号 31301 的装备名称未完整读取"],
    });
    let reads = 0;
    await expect(
      collectCompleteCapture(
        async () => {
          reads++;
          return record.detail!;
        },
        new AbortController().signal,
        () => {},
      ),
    ).rejects.toMatchObject({
      name: "IncompleteDetailError",
      detail: expect.objectContaining({ raw: record.detail!.raw }),
    });
    expect(reads).toBe(3);
    store.observe(record.listing);
    expect(store.save(record.listing, record.detail!)).toBe(false);
    expect(store.count()).toBe(0);
    expect(store.checkpoint()).toBeUndefined();
    expect(store.retryItems().map((item) => item.key)).toEqual([record.listing.key]);
    const archived = store.db
      .prepare("SELECT source_gzip FROM role_sources WHERE listing_key=?")
      .get(record.listing.key)!;
    expect(JSON.parse(gunzipSync(archived.source_gzip as Uint8Array).toString()).raw).toEqual(
      record.detail!.raw,
    );
  } finally {
    store.close();
  }
});
