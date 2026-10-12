import { savedDetail } from "../crawler/controller";
import type { SavedRoleRecord } from "../crawler/types";
import {
  createRoleSource,
  currentRoleAuthentication,
  readPublicRoleNavigation,
  type RoleSearchSelections,
} from "./browser-role-source";

/** Discover the official role form in a program-owned page before choosing query fields. */
export async function checkRole(input: Record<string, unknown>, requestSignal: AbortSignal) {
  requestSignal.throwIfAborted();
  const productKey = input.productKey;
  if (typeof productKey !== "string" || !productKey.trim() || productKey.length > 100)
    throw new Error("productKey 必须是非空字符串，且不超过100字");
  if (!["authentication", "navigation", "discover", "search"].includes(String(input.mode)))
    throw new Error("角色检查 mode 必须为 authentication、navigation、discover 或 search");
  const record = savedDetail(productKey.trim()) as SavedRoleRecord | null;
  if (!record) throw new Error("已保存商品不存在");
  if (record.listing.key !== productKey.trim()) throw new Error("商品 ID 与保存记录不一致");
  if (record.status !== "complete" || !record.detail)
    throw new Error("商品详情尚未采集完整，请先补采");
  if (input.mode === "authentication")
    return { mode: "authentication", diagnostic: await currentRoleAuthentication() };
  if (input.mode === "navigation")
    return { mode: "navigation", navigation: await readPublicRoleNavigation() };
  const suppliedSelections = input.controls !== undefined || input.menus !== undefined;
  if (
    input.mode === "search" &&
    suppliedSelections &&
    (!Array.isArray(input.controls) || !Array.isArray(input.menus))
  )
    throw new Error("显式搜索筛选必须同时提供 controls 和 menus 数组");
  const signal = AbortSignal.any([
    requestSignal,
    AbortSignal.timeout(input.mode === "search" ? 900_000 : 150_000),
  ]);
  const source = await createRoleSource(signal);
  try {
    if (input.mode === "search") {
      const selections = suppliedSelections
        ? ({ controls: input.controls, menus: input.menus } as RoleSearchSelections)
        : undefined;
      return { mode: "search", ...(await source.search(record, selections)) };
    }
    const form = await source.discover();
    signal.throwIfAborted();
    return {
      target: {
        productKey: record.listing.key,
        url: record.listing.url,
        name: record.listing.name,
      },
      mode: "discover",
      form,
    };
  } finally {
    await source.close();
  }
}
