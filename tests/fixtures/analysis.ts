import type { SavedRoleRecord } from "../../server/crawler/types";
import type { Dimension, ProductAnalysis } from "../../server/analysis/types";
import { buildProductDocument } from "../../server/analysis/product-document";
import { roleRecord } from "./saved-role";

export function analysisRecord(key = "a"): SavedRoleRecord {
  const record = roleRecord(key, true);
  return {
    ...record,
    status: "complete",
    listing: {
      ...record.listing,
      ordersn: `test-${key}`,
      createdTime: null,
      orderTime: null,
      attrs: {},
    },
    detail: { ...record.detail!, url: record.listing.url, formatVersion: 3, captureVersion: 4 },
  } as SavedRoleRecord;
}
export function valuationRecord(key = "a"): SavedRoleRecord {
  const record = analysisRecord(key);
  record.listing.price = "500.00";
  record.listing.summary = { iCash: 0, iSaving: 0, xianyu: 0 };
  const fields = {
    "飞升/渡劫/化圣": "未飞升",
    级别: "109",
    攻击修炼: "20/25",
    法术修炼: "0/25",
    防御修炼: "17/25",
    抗法修炼: "10/25",
    攻击控制力: "20",
    法术控制力: "20",
    防御控制力: "20",
    抗法控制力: "20",
    靓号特效: "否",
    月饼粽子机缘: "40/69",
    神器套数: "0",
    坐骑总数: "0",
    储备金: "0",
  };
  record.detail!.tabs = [
    {
      name: "人物/修炼",
      text: "",
      fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
      tables: [],
      elements: [],
      tooltips: [],
    },
    {
      name: "技能",
      text: "",
      fields: [],
      tables: [],
      elements: [],
      tooltips: [],
      items: [
        ...Array.from({ length: 7 }, (_, i) => ({
          index: i,
          kind: "skill" as const,
          category: "师门技能",
          name: "师门" + i,
          level: "119",
        })),
        { index: 7, kind: "skill", category: "技能", name: "强壮", level: "0" },
        { index: 8, kind: "skill", category: "技能", name: "神速", level: "0" },
      ],
    },
  ];
  return record;
}
export function analysisResponse(
  record: SavedRoleRecord,
  score = 80,
): Omit<ProductAnalysis, "score"> {
  const document = buildProductDocument(record);
  const dimension = (path: string, value: string): Dimension => ({
    score,
    reason: "根据已采集配置作参考判断，仍需核对具体属性。",
    evidence: [{ path, value, reason: "原文包含该配置字段。" }],
  });
  return {
    productKey: document.productKey,
    inputHash: document.contentHash,
    summary: "已采集资料可用于配置核对，不代表成交价格或收益。",
    highlights: ["已保存八只召唤兽"],
    risks: ["缺少市场对比资料"],
    missingData: [],
    dimensions: {
      foundation: dimension("/listing/summary/iGrade", "175"),
      equipment: dimension("/detail/tabs/2/items/0/description", "伤害：500\n特技：罗汉金钟"),
      pets: dimension("/detail/tabs/3/pets/0/name", "宝宝1"),
    },
  };
}
