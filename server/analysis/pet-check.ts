import { savedDetail } from "../crawler/controller";
import type { SavedRoleRecord } from "../crawler/types";
import { createPetSource } from "./browser-pet-source";
import { petInventory } from "./pet-pricing";

/** Verify one pet through the app session without calling AI or saving an analysis result. */
export async function checkPet(input: Record<string, unknown>, requestSignal: AbortSignal) {
  requestSignal.throwIfAborted();
  const identifier = (key: string) => {
    const value = input[key];
    if (typeof value !== "string" || !value.trim() || value.length > 100)
      throw new Error(key + " 必须是非空字符串，且不超过100字");
    return value.trim();
  };
  const productKey = identifier("productKey"),
    petKey = identifier("petKey");
  const record = savedDetail(productKey) as SavedRoleRecord | null;
  if (!record) throw new Error("已保存商品不存在");
  if (record.listing.key !== productKey) throw new Error("商品 ID 与保存记录不一致");
  if (record.status !== "complete" || !record.detail)
    throw new Error("商品详情尚未采集完整，请先补采");
  const inventory = petInventory(record);
  if (!inventory.captureComplete)
    throw new Error("宝宝资料尚未采集完整：" + inventory.issues.join("；"));
  const item = inventory.items.find((value) => value.key === petKey);
  if (!item) throw new Error("指定宝宝不在该商品的已保存宝宝中");
  if (item.status !== "no_match") throw new Error("该宝宝暂不能查价：" + item.issues.join("；"));
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(300_000)]);
  signal.throwIfAborted();
  const source = await createPetSource(signal);
  try {
    signal.throwIfAborted();
    const result = await source.findCandidates([item], signal);
    signal.throwIfAborted();
    return { target: { productKey, petKey, name: item.name, level: item.level }, ...result };
  } finally {
    await source.close();
  }
}
