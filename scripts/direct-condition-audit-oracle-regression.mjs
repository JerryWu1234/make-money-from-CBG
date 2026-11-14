import assert from "node:assert/strict";
import { test } from "node:test";
import {
  directConditionOracle,
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
