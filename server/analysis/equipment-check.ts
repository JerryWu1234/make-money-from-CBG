import { savedDetail } from "../crawler/controller";
import type { SavedRoleRecord } from "../crawler/types";
import { createEquipmentSource } from "./browser-equipment-source";
import { equipmentInventory } from "./equipment-pricing";

/** Check one saved equipment item in the app's browser session without creating an analysis run. */
export async function checkEquipment(input: Record<string, unknown>, requestSignal: AbortSignal) {
  requestSignal.throwIfAborted();
  const identifier = (key: string) => {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || value.length > 100)
      throw new Error(key + " 必须是非空字符串，且不超过100字");
    return value.trim();
  };
  const productKey = identifier("productKey"),
    equipmentKey = identifier("equipmentKey");
  const record = savedDetail(productKey) as SavedRoleRecord | null;
  if (!record) throw new Error("已保存商品不存在");
  if (record.listing.key !== productKey) throw new Error("商品 ID 与保存记录不一致");
  if (record.status !== "complete" || !record.detail)
    throw new Error("商品详情尚未采集完整，请先补采");
  const inventory = equipmentInventory(record);
  if (!inventory.captureComplete)
    throw new Error("装备资料尚未采集完整：" + inventory.issues.join("；"));
  const item = inventory.items.find((value) => value.key === equipmentKey);
  if (!item) throw new Error("指定装备不在该商品的已保存装备中");
  if (item.status !== "no_match") throw new Error("该装备暂不能查价：" + item.issues.join("；"));
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(300_000)]);
  signal.throwIfAborted();
  const source = await createEquipmentSource(signal);
  try {
    signal.throwIfAborted();
    const result = await source.findCandidates([item], signal);
    signal.throwIfAborted();
    return {
      target: { productKey, equipmentKey, name: item.name, level: item.level },
      ...result,
    };
  } finally {
    await source.close();
  }
}
