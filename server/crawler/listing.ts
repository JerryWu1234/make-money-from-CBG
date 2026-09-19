import type { Listing } from "./types";

// 时间统一为中国时区的 ISO 字符串；不猜测 eid、推荐请求 ID 或悬停时间。
export function timestamp(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value !== "string" || !value.trim()) return null;
  if (/^\d{10}(?:\d{3})?$/.test(value)) return timestamp(Number(value));
  const text = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/.test(text))
    return null;
  const date = new Date(
    text.replace(" ", "T") + (/(?:Z|[+-]\d{2}:\d{2})$/.test(text) ? "" : "+08:00"),
  );
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
export function parseListing(
  href: string,
  attrs: Record<string, string>,
  summary: unknown,
  order: string,
  raw: Record<string, unknown> = {},
): Listing {
  const source = new URL(href.replaceAll("&amp;", "&"), "https://xyq.cbg.163.com");
  if (source.origin !== "https://xyq.cbg.163.com" || source.pathname !== "/equip")
    throw new Error("商品链接不是藏宝阁详情页");
  const serverId = source.searchParams.get("s") || attrs.data_serverid;
  const eid = source.searchParams.get("eid");
  if (!serverId || !/^\d+$/.test(serverId) || !eid || !/^[\w-]+$/.test(eid))
    throw new Error("商品缺少稳定的服务器编号或 eid，不能安全去重");
  const sellingTime = timestamp(attrs.data_selling_time || raw.selling_time);
  const createdTime = timestamp(attrs.data_create_time || raw.create_time);
  const orderTime =
    order === "selling_time DESC"
      ? sellingTime
      : order === "expire_time DESC"
        ? timestamp(raw.expire_time)
        : null;
  return {
    key: `${serverId}:${eid}`,
    serverId,
    serverName:
      typeof raw.server_name === "string" ? raw.server_name : attrs.data_server_name || "",
    eid,
    ordersn: attrs.data_ordersn || attrs.data_game_ordersn || "",
    url: `https://xyq.cbg.163.com/equip?s=${serverId}&eid=${encodeURIComponent(eid)}`,
    sellingTime,
    createdTime,
    orderTime,
    name: attrs.data_equip_name || "",
    price: attrs.data_price || "",
    attrs,
    summary,
  };
}
