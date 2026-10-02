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
    detail: { ...record.detail!, url: record.listing.url, formatVersion: 3 },
  } as SavedRoleRecord;
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
