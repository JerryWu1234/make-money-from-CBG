import type { SavedRoleRecord } from "../crawler/types";
import { savedDetail } from "../crawler/controller";
import { createPetGearSource } from "./browser-pet-gear-source";
import { petGearInventory, petGearReference, PET_GEAR_ACCOUNTING } from "./pet-gear-inventory";
export { petGearInventory } from "./pet-gear-inventory";

/** Inspect the official public controls using the application's existing Chrome session. */
export async function checkPetGear(input: Record<string, unknown>, requestSignal: AbortSignal) {
  requestSignal.throwIfAborted();
  const productKey = input.productKey;
  if (typeof productKey !== "string" || !productKey.trim() || productKey.length > 100)
    throw new Error("productKey 必须是非空字符串，且不超过100字");
  if (input.mode !== undefined && input.mode !== "discover" && input.mode !== "search")
    throw new Error("宝宝装备检查 mode 只支持 discover/search");
  const gearKey = input.mode === "discover" ? undefined : input.gearKey;
  if (
    input.mode !== "discover" &&
    (typeof gearKey !== "string" || !gearKey.trim() || gearKey.length > 100)
  )
    throw new Error("gearKey 必须是非空字符串，且不超过100字");
  const key = productKey.trim();
  const record = savedDetail(key) as SavedRoleRecord | null;
  if (!record) throw new Error("已保存商品不存在");
  if (record.listing.key !== key) throw new Error("商品 ID 与保存记录不一致");
  if (record.status !== "complete" || !record.detail)
    throw new Error("商品详情尚未采集完整，请先补采");
  const inventory = petGearInventory(record);
  const selected =
    input.mode === "discover"
      ? undefined
      : inventory.items.find((item) => item.key === (gearKey as string).trim());
  if (input.mode !== "discover") {
    if (!inventory.captureComplete)
      throw new Error("宝宝装备尚未采集完整：" + inventory.issues.join("；"));
    if (!selected) throw new Error("指定宝宝装备不在该商品的已保存资料中");
    if (selected.status !== "no_match")
      throw new Error("宝宝装备暂不能查询：" + selected.issues.join("；"));
  }
  const signal = AbortSignal.any([
    requestSignal,
    AbortSignal.timeout(input.mode === "discover" ? 150_000 : 300_000),
  ]);
  signal.throwIfAborted();
  const source = await createPetGearSource(signal);
  try {
    if (selected) {
      const result = await source.findCandidates([selected], signal);
      signal.throwIfAborted();
      const reference = petGearReference(result.items[0]?.candidates || []);
      return {
        target: {
          productKey: key,
          gearKey: selected.key,
          petKey: selected.petKey,
          name: selected.name,
          level: selected.level,
        },
        accounting: PET_GEAR_ACCOUNTING,
        reference,
        ...result,
      };
    }
    const form = await source.discover();
    signal.throwIfAborted();
    return {
      mode: "discover",
      target: { productKey: key, name: record.listing.name, url: record.listing.url },
      inventory,
      accounting: PET_GEAR_ACCOUNTING,
      form,
    };
  } finally {
    await source.close();
  }
}
