import { createHash } from "node:crypto";
import type { SavedRoleRecord } from "../crawler/types";

export type ProductDocument = {
  formatVersion: 1;
  productKey: string;
  collectedAt: string;
  contentHash: string;
  text: string;
};

// Keep array order and every stored value; object key order must not change the snapshot ID.
function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, ordered(child)]),
    );
  }
  return value;
}

/** Acquisition times do not change the reviewed facts; the full archive hash still includes them. */
export function analysisDataHash(record: SavedRoleRecord): string {
  function data(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(data);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => key !== "collectedAt" && key !== "itemsCollectedAt")
          .map(([key, child]) => [key, data(child)]),
      );
    return value;
  }
  return createHash("sha256")
    .update(JSON.stringify(ordered(data({ listing: record.listing, detail: record.detail }))))
    .digest("hex");
}

/** Preserve the complete source and its hash, independently of the AI request's scope. */
export function buildProductDocument(record: SavedRoleRecord): ProductDocument {
  if (record.status !== "complete" || !record.detail)
    throw new Error("商品详情尚未完整采集，不能生成分析资料");
  if (!record.listing.key || !record.detail.collectedAt)
    throw new Error("商品 ID 或采集时间缺失，不能生成可追溯资料");

  const text = [
    "【一件商品的完整资料】",
    "资料格式版本：1",
    `商品 ID：${record.listing.key}`,
    `详情采集时间：${record.detail.collectedAt}`,
    "来源：SQLite listings.listing_json 与 listings.detail_json",
    "下方 listing 与 detail 属于同一件商品，包含数据库已保存的全部列表和详情字段。",
    "【商品资料开始】",
    JSON.stringify(ordered({ listing: record.listing, detail: record.detail }), null, 2),
    "【商品资料结束】",
    "",
  ].join("\n");

  return {
    formatVersion: 1,
    productKey: record.listing.key,
    collectedAt: record.detail.collectedAt,
    contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
    text,
  };
}
