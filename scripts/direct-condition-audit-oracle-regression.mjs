import assert from "node:assert/strict";
import { test } from "node:test";
import {
  directConditionOracle,
  expectedDirectAuditChecks,
  expectedDirectAuditResults,
} from "./direct-condition-audit-oracle.mjs";

const fixture = () => ({
  listing: { key: "source", name: "46957901" },
  detail: {
    equipmentCapture: { complete: true, issues: [] },
    tabs: [
      {
        name: "人物/修炼",
        fields: [],
        tables: [
          [
            ["攻击修炼：", "12/20"],
            ["防御修炼：", "7/20"],
            ["法术修炼：", "0/20"],
            ["抗法修炼：", "7/20"],
            ["猎术修炼：", "100"],
            ["攻击控制力：", "25"],
          ],
        ],
      },
      {
        name: "道具/法宝",
        items: [
          ...[7, 5, 6, 4, 4, 4].map((level, index) => ({
            index,
            name: `装备${index}`,
            location: `role_using_equip_${index + 1}`,
            description: `等级100\n锻炼等级 ${level}  镶嵌宝石 黑宝石`,
          })),
          {
            index: 8,
            name: "戒指",
            category: "人物装备 · 戒指",
            location: "role_using_equip_187",
            description: "精炼等级3",
          },
          { index: 9, name: "法宝", category: "法宝", description: "锻炼等级99" },
        ],
      },
    ],
  },
});

await test("四项当前修炼相加为26，分母上限不混入，普通宝石段数30不混入星辉石", () => {
  const oracle = directConditionOracle(fixture());
  assert.equal(oracle.trainingTotal, 26);
  assert.equal(oracle.trainingCapTotal, 80);
  assert.equal(oracle.gemTotal, 30);
  assert.deepEqual(expectedDirectAuditResults(oracle), {
    C1: true,
    C2: false,
    C3: true,
    C4: true,
    C5: true,
    C6: true,
  });
  assert.deepEqual(expectedDirectAuditChecks(oracle).C2, {
    actual: 26,
    target: 27,
    operator: "gte",
    matched: false,
    boundType: "exact",
  });
});
await test("缺少或冲突的修炼不补零，缺少宝石段数不误判低于阈值", () => {
  const record = fixture();
  record.detail.tabs[0].tables[0].pop();
  record.detail.tabs[0].tables[0].pop();
  record.detail.tabs[0].tables[0].pop();
  record.detail.tabs[1].items[0].description = "等级100";
  const oracle = directConditionOracle(record);
  assert.equal(oracle.trainingTotal, null);
  assert.equal(oracle.gemTotal, null);
  assert.equal(expectedDirectAuditChecks(oracle).C1.boundType, "lower-bound");
  assert.equal(expectedDirectAuditChecks(oracle).C1.matched, true);
  assert.equal(expectedDirectAuditChecks(oracle).C5.matched, null);
  record.detail.tabs[0].fields.push({ name: "攻击修炼", value: "13/20" });
  assert.equal(directConditionOracle(record).training["攻击修炼"].current, null);
});
await test("精确阈值27满足且当前等级与上限分别读取", () => {
  const record = fixture();
  record.detail.tabs[0].tables[0][0][1] = "13/25";
  const oracle = directConditionOracle(record);
  assert.equal(oracle.trainingTotal, 27);
  assert.equal(oracle.trainingCapTotal, 85);
  assert.equal(expectedDirectAuditResults(oracle).C2, true);
});

await test("六件背包装备没有category时仍按官方装备条件和镶嵌证据合计21段", () => {
  const record = fixture();
  record.detail.tabs[1].items = [2, 2, 2, 4, 5, 6].map((gemLevel, index) => ({
    index,
    name: `匿名装备${index}`,
    kind: "equipment",
    location: `store_equip_tips${index + 5}`,
    description: `等级100\n锻炼等级 ${gemLevel}  镶嵌宝石 红玛瑙`,
    attributes: { 装备条件: "等级100" },
  }));
  record.detail.tabs[1].items.push({
    index: 8,
    kind: "equipment",
    location: "store_equip_tips1",
    officialModel: { description: "官方物品说明#r【类型】戒指#r【装备条件】等级80" },
    description: "等级80\n伤害17",
  });
  const oracle = directConditionOracle(record);
  assert.equal(oracle.equipment.length, 6);
  assert.equal(oracle.gemTotal, 21);
  assert.equal(expectedDirectAuditResults(oracle).C1, true);
});

await test("穿戴47段另有背包武器7段时合计54，不因同名或存放位置漏计", () => {
  const record = fixture();
  record.detail.tabs[1].items = [10, 9, 7, 5, 9, 7].map((gemLevel, index) => ({
    index,
    name: index === 1 ? "同名武器" : `装备${index}`,
    location: `role_using_equip_${index + 1}`,
    description: `锻炼等级 ${gemLevel}  镶嵌宝石 月亮石`,
  }));
  record.detail.tabs[1].items.push({
    index: 12,
    name: "同名武器",
    kind: "equipment",
    location: "store_equip_tips1",
    attributes: { 装备角色: "角色甲，角色乙" },
    description: "锻炼等级 7  镶嵌宝石 太阳石",
  });
  assert.equal(directConditionOracle(record).gemTotal, 54);
});

await test("穿戴34段加独立背包铠甲11段合计45，类别不明时保留未知", () => {
  const record = fixture();
  record.detail.tabs[1].items = [7, 6, 7, 6, 8].map((gemLevel, index) => ({
    index,
    location: `role_using_equip_${index + 1}`,
    description: `锻炼等级 ${gemLevel}  镶嵌宝石 黑宝石`,
  }));
  const stored = {
    index: 12,
    kind: "equipment",
    location: "202610141000113-212-TEST",
    description: "锻炼等级 11  镶嵌宝石 月亮石",
    officialModel: { description: "可穿戴铠甲#r【装备角色】男" },
  };
  record.detail.tabs[1].items.push(stored);
  assert.equal(directConditionOracle(record).gemTotal, 45);
  delete stored.officialModel;
  assert.equal(directConditionOracle(record).gemTotal, null);
  assert.equal(
    expectedDirectAuditChecks(directConditionOracle(record)).C5.boundType,
    "lower-bound",
  );
});

await test("完整无宝石按0，18+0低于20；标签存在但未读取数值仍未知", () => {
  const record = fixture();
  record.detail.tabs[1].items = [
    {
      index: 0,
      location: "role_using_equip_1",
      description: "锻炼等级18 镶嵌宝石月亮石",
    },
    {
      index: 1,
      kind: "equipment",
      attributes: { 装备角色: "男" },
      description: "等级100\n防御200",
    },
  ];
  const zero = directConditionOracle(record);
  assert.equal(zero.gemTotal, 18);
  assert.equal(zero.gemUnknownCount, 0);
  assert.equal(expectedDirectAuditChecks(zero).C1.matched, false);
  record.detail.tabs[1].items[1].description += "\n锻炼等级 未读取";
  const oracle = directConditionOracle(record);
  assert.equal(oracle.gemKnownLowerBound, 18);
  assert.equal(oracle.gemUnknownCount, 1);
  assert.equal(oracle.gemTotal, null);
  assert.deepEqual(expectedDirectAuditChecks(oracle).C1, {
    actual: null,
    target: 20,
    operator: "gte",
    matched: null,
    boundType: "unknown",
    knownMinimum: 18,
  });
});
