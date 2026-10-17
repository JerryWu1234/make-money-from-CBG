import type { DatabaseSync } from "node:sqlite";
import type { RoleDetail } from "../crawler/types";
import { observedEquipmentCategory } from "../crawler/compact";

type CapturedRole = { key: string; detail: RoleDetail };
const wornSlot = /^role_using_equip_(?:[1-6]|18[7-9]|190)$/;
const generic = /^(?:人物装备|装备|武器|灵饰)?$/;

/** Bind a warehouse model to an actual worn slot, never to a guessed model-number range. */
export function resolveCapturedEquipmentCategories(records: CapturedRole[]) {
  const evidence = new Map<
    string,
    Array<{ category: string; roleKey: string; location: string; collectedAt: string }>
  >();
  for (const { key, detail } of records) {
    if (detail.equipmentCapture?.complete !== true) continue;
    for (const item of detail.tabs.flatMap((tab) => tab.items || [])) {
      if (
        !item.modelId ||
        !/^[1-9]\d*$/.test(item.modelId) ||
        !item.name ||
        !item.location ||
        !wornSlot.test(item.location)
      )
        continue;
      const category = observedEquipmentCategory("", item.location, item.modelId);
      if (!category) continue;
      const identity = item.modelId + ":" + item.name;
      const matches = evidence.get(identity) || [];
      matches.push({
        category,
        roleKey: key,
        location: item.location,
        collectedAt: detail.collectedAt,
      });
      evidence.set(identity, matches);
    }
  }
  return records.map(({ key, detail }) => {
    let changed = false;
    const tabs = detail.tabs.map((tab) => ({
      ...tab,
      items: tab.items?.map((item) => {
        if (!item.modelId || !generic.test(item.category?.trim() || "")) return item;
        const matches = evidence.get(item.modelId + ":" + item.name);
        if (!matches?.length || new Set(matches.map((entry) => entry.category)).size !== 1)
          return item;
        changed = true;
        const source = matches[0];
        return {
          ...item,
          category: source.category,
          categoryEvidence: {
            version: 1 as const,
            modelId: item.modelId,
            name: item.name,
            ...source,
          },
        };
      }),
    }));
    return { key, detail: changed ? { ...detail, tabs } : detail, changed };
  });
}

/** Preserve original source archives and capture status; only add proven category facts. */
export function reconcileCapturedEquipmentCategories(db: DatabaseSync, keys?: string[]) {
  const rows = db
    .prepare(
      "SELECT key,detail_json FROM listings WHERE status='complete' AND detail_json IS NOT NULL ORDER BY key",
    )
    .all();
  const records = rows.map((row) => ({
    key: String(row.key),
    detail: JSON.parse(String(row.detail_json)) as RoleDetail,
  }));
  const allowed = keys ? new Set(keys) : undefined;
  const original = new Map(rows.map((row) => [String(row.key), String(row.detail_json)]));
  const update = db.prepare(
    "UPDATE listings SET detail_json=? WHERE key=? AND detail_json=? AND status='complete'",
  );
  let count = 0;
  for (const record of resolveCapturedEquipmentCategories(records)) {
    if (!record.changed || (allowed && !allowed.has(record.key))) continue;
    count += Number(
      update.run(JSON.stringify(record.detail), record.key, original.get(record.key)!).changes,
    );
  }
  return count;
}
