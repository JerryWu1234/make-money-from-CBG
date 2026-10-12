import { ordinarySlot } from "./equipment-baseline";
import type { EquipmentPricingItem } from "./equipment-pricing";

export const EQUIPMENT_EXCLUSION_POLICY = "exhausted-plain-equipment-up-to-80-v1";
export type EquipmentExclusion = {
  policy: typeof EQUIPMENT_EXCLUSION_POLICY;
  label: "无匹配，未计入参考合计";
  stages: Array<{ mode: string; args: Record<string, string | number> }>;
};

/** A narrow accounting exclusion requires actual exact AND similar market exhaustion. */
export function equipmentExclusion(
  item: EquipmentPricingItem,
  records: unknown[],
): EquipmentExclusion | undefined {
  if (
    item.status !== "no_match" ||
    item.referencePrice !== null ||
    item.searchState !== "completed" ||
    item.level === null ||
    item.level > 80 ||
    item.level < 60 ||
    item.candidates.some((candidate) => candidate.verified) ||
    !ordinarySlot({ ...item, candidates: [] })
  )
    return undefined;
  const evidence = records.filter(
    (entry): entry is Record<string, any> =>
      !!entry && typeof entry === "object" && "key" in entry && entry.key === item.key,
  );
  const changed = evidence.reduce(
    (last, entry, index) => (entry.reason === "result_order_changed" ? index : last),
    -1,
  );
  const stages = new Map<string, EquipmentExclusion["stages"][number]>();
  for (const record of evidence.slice(changed + 1)) {
    if (
      record.searchUrl?.startsWith("https://xyq.cbg.163.com/") !== true ||
      record.serverAge !== "3年以上服" ||
      !Array.isArray(record.scopeEvidence) ||
      !Array.isArray(record.modes)
    )
      continue;
    for (const stage of record.modes) {
      if (
        !stage?.exhausted ||
        !["exact", "similar"].includes(stage.mode) ||
        String(stage.args?.server_type) !== "3"
      )
        continue;
      const requests = record.scopeEvidence.filter(
        (entry: any) => entry.mode === stage.mode && !entry.replay,
      );
      if (
        !requests.length ||
        requests.some(
          (entry: any) =>
            entry.request?.serverType !== "3" ||
            !entry.request.restrictions ||
            Object.values(entry.request.restrictions).some(Boolean),
        )
      )
        continue;
      stages.set(stage.mode, { mode: stage.mode, args: stage.args });
    }
  }
  if (!stages.has("exact") || !stages.has("similar")) return undefined;
  return {
    policy: EQUIPMENT_EXCLUSION_POLICY,
    label: "无匹配，未计入参考合计",
    stages: [stages.get("exact")!, stages.get("similar")!],
  };
}

export function validEquipmentExclusion(item: EquipmentPricingItem, records: unknown[] = []) {
  const derived = equipmentExclusion(item, records);
  return !!derived && JSON.stringify(item.exclusion) === JSON.stringify(derived);
}
