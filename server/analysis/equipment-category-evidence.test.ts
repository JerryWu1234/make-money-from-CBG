import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { valuationRecord } from "../../tests/fixtures/analysis";
import {
  resolveCapturedEquipmentCategories,
  reconcileCapturedEquipmentCategories,
} from "./equipment-category-evidence";
import { equipmentInventory } from "./equipment-pricing";
import { DEFAULT_SETTINGS } from "./profile";
import type { DetailItem } from "../crawler/types";

function captured(key: string, items: DetailItem[]) {
  const detail = valuationRecord(key).detail!;
  detail.tabs = [
    { name: "道具/法宝", text: "", fields: [], tables: [], elements: [], tooltips: [], items },
  ];
  return { key, detail };
}
const worn = (location = "role_using_equip_188"): DetailItem => ({
  index: 0,
  name: "翠叶环",
  modelId: "27101",
  location,
  kind: "equipment",
  description: "等级60\n法术伤害13\n固定伤害7\n物理暴击等级6",
});

it("仓库同模型同名装备从实测穿戴槽位取得分类和来源，灵饰按本轮范围待查", () => {
  const source = captured("source", [worn()]),
    target = captured("target", [{ ...worn("store_equip_tips2") }]);
  const before = JSON.stringify([source, target]);
  const result = resolveCapturedEquipmentCategories([source, target])[1];
  expect(JSON.stringify([source, target])).toBe(before);
  expect(result.detail.tabs[0].items![0]).toMatchObject({
    category: "人物装备 · 耳饰",
    categoryEvidence: {
      modelId: "27101",
      name: "翠叶环",
      roleKey: "source",
      location: "role_using_equip_188",
    },
  });
  const inventory = equipmentInventory(
    { ...valuationRecord("target"), detail: result.detail },
    { ...DEFAULT_SETTINGS, pricingScope: "equipment" },
  );
  expect(inventory.items[0]).toMatchObject({
    searchState: "skipped",
    skipReason: expect.stringContaining("灵饰待查"),
  });
});

it("不同模型或名字、冲突穿戴槽位、无穿戴证据均不推断分类", () => {
  const unknown = captured("target", [worn("store_equip_tips2")]);
  const partial = captured("partial", [worn()]);
  partial.detail.equipmentCapture!.complete = false;
  for (const source of [
    partial,
    captured("source", [{ ...worn(), modelId: "27102" }]),
    captured("source", [{ ...worn(), name: "别的耳饰" }]),
    captured("source", [{ ...worn("store_equip_tips1"), category: "人物装备 · 耳饰" }]),
    captured("source", [worn(), worn("role_using_equip_1")]),
  ])
    expect(resolveCapturedEquipmentCategories([source, unknown])[1].changed).toBe(false);
});

it("只补选定角色的类别，保留采集状态、时间和原始归档，重复执行不改写", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE listings(key TEXT,detail_json TEXT,status TEXT); CREATE TABLE role_sources(listing_key TEXT, source_gzip BLOB)",
  );
  const source = captured("source", [worn()]),
    b = captured("b", [worn("store_equip_tips1")]),
    c = captured("c", [worn("store_equip_tips2")]);
  for (const r of [source, b, c])
    db.prepare("INSERT INTO listings VALUES(?,?,'complete')").run(r.key, JSON.stringify(r.detail));
  db.prepare("INSERT INTO role_sources VALUES('b',?)").run(Buffer.from("original"));
  expect(reconcileCapturedEquipmentCategories(db, ["b"])).toBe(1);
  const row = db.prepare("SELECT * FROM listings WHERE key='b'").get()!;
  expect(row.status).toBe("complete");
  expect(JSON.parse(String(row.detail_json)).collectedAt).toBe(b.detail.collectedAt);
  expect(db.prepare("SELECT detail_json FROM listings WHERE key='c'").get()!.detail_json).toBe(
    JSON.stringify(c.detail),
  );
  expect(
    Buffer.from(
      db.prepare("SELECT source_gzip FROM role_sources WHERE listing_key='b'").get()!
        .source_gzip as Uint8Array,
    ).toString(),
  ).toBe("original");
  expect(reconcileCapturedEquipmentCategories(db, ["b"])).toBe(0);
  db.close();
});
