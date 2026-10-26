import type { DetailItem } from "./types";

function nonRoleCategory(value: string) {
  const text = value.trim();
  if (/^(?:法宝|灵宝|神器|道具|材料|消耗品|召唤兽装备)(?:$|\s*·)/.test(text)) return text;
  if (/^(?:宝石|打造材料|合成材料|强化材料)$/.test(text)) return `材料 · ${text}`;
  if (/^(?:技能书|召唤兽技能书|召唤兽内丹)$/.test(text)) return `道具 · ${text}`;
  return undefined;
}

/** Exact official model records only; names never imply a non-equipment category. */
export function officialModelFromAttributes(
  attrs: Record<string, string>,
): DetailItem["officialModel"] {
  const modelId = attrs.data_equip_type || "";
  if (!/^[1-9]\d*$/.test(modelId) || !Number.isSafeInteger(Number(modelId))) return undefined;
  try {
    const value = JSON.parse(attrs.data_official_model_metadata || "null");
    if (
      !value ||
      value.modelId !== modelId ||
      !Array.isArray(value.records) ||
      !value.records.length
    )
      return undefined;
    const records = value.records.filter(
      (record: unknown): record is Record<string, unknown> =>
        !!record && typeof record === "object" && !Array.isArray(record),
    );
    if (records.length !== value.records.length) return undefined;
    const strings = (key: string): string[] => [
      ...new Set<string>(
        records.flatMap((record: Record<string, unknown>) =>
          typeof record[key] === "string" && record[key].trim() ? [record[key].trim()] : [],
        ),
      ),
    ];
    const names = strings("name");
    if (names.length > 1) return undefined;
    const descriptions = strings("desc");
    const declared = strings("category");
    // Only labelled static type evidence is a category; free prose is retained verbatim.
    for (const desc of descriptions) {
      for (const match of desc.matchAll(/【(?:物品类型|类别|类型)】\s*([^#\r\n<]+)/g))
        declared.push(match[1].trim());
    }
    const categories = [...new Set(declared)];
    const category = categories.length === 1 ? nonRoleCategory(categories[0]) : undefined;
    return {
      modelId,
      ...(names.length === 1 ? { name: names[0] } : {}),
      ...(descriptions.length ? { description: descriptions.join("\n") } : {}),
      ...(category ? { category } : {}),
    };
  } catch {
    return undefined;
  }
}
