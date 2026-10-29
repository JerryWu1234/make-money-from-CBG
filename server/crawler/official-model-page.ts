import type { Page } from "playwright-core";

declare const CBG_GAME_CONFIG: { equip_info?: Record<string, unknown> } | undefined;
declare const RoleNameConf: (new () => { get_equip_info?: (model: number) => unknown }) | undefined;

/** Read only the requested public model records; isolate optional metadata failures. */
export async function readOfficialModels(page: Page, modelIds: string[]) {
  if (!modelIds.length)
    return {
      models: {} as Record<string, string>,
      issues: [] as Array<{ modelId: string; source: string; message: string }>,
    };
  return page.evaluate((ids) => {
    const models: Record<string, string> = {};
    const issues: Array<{ modelId: string; source: string; message: string }> = [];
    let resolver: InstanceType<NonNullable<typeof RoleNameConf>> | undefined;
    let resolverAttempted = false;
    for (const modelId of new Set(ids)) {
      if (!/^[1-9]\d*$/.test(modelId) || !Number.isSafeInteger(Number(modelId))) continue;
      const records: Array<{ name?: string; desc?: string; category?: string }> = [];
      for (const source of ["CBG_GAME_CONFIG", "RoleNameConf"]) {
        try {
          let value: unknown;
          if (source === "CBG_GAME_CONFIG") {
            if (typeof CBG_GAME_CONFIG !== "undefined")
              value = CBG_GAME_CONFIG?.equip_info?.[modelId];
          } else {
            if (!resolverAttempted) {
              resolverAttempted = true;
              if (typeof RoleNameConf === "function") resolver = new RoleNameConf();
            }
            if (typeof resolver?.get_equip_info === "function")
              value = resolver.get_equip_info(Number(modelId));
          }
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const data = value as Record<string, unknown>;
          // Getters and non-string fields are part of this optional source too.
          // Convert atomically to plain strings before merging with another source.
          const name = data.name,
            desc = data.desc;
          const categories = [data.category, data.category_name, data.type_name];
          const plain = {
            ...(typeof name === "string" ? { name } : {}),
            ...(typeof desc === "string" ? { desc } : {}),
          };
          records.push(
            plain,
            ...categories.flatMap((category) =>
              typeof category === "string" ? [{ category }] : [],
            ),
          );
        } catch (error) {
          issues.push({
            modelId,
            source,
            message:
              error instanceof Error ? error.message.slice(0, 600) : "官方物品元数据暂不可用",
          });
        }
      }
      if (records.length) models[modelId] = JSON.stringify({ modelId, records });
    }
    return { models, issues };
  }, modelIds);
}
