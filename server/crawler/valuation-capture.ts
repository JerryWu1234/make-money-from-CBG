import type { Page } from "playwright-core";
import type { ValuationCapture } from "./types";
import { roleIdentityIssues } from "./role-identity";
import { readDetailIdentity } from "./detail-identity";

export { normalizeValuationSource } from "./valuation-source";
import { normalizeValuationSource } from "./valuation-source";

export async function captureValuation(page: Page): Promise<ValuationCapture> {
  const identity = await readDetailIdentity(page);
  const source = await page.evaluate(
    ({ serverId, eid }) => {
      const globals = window as unknown as Record<string, unknown>;
      const decode = globals.decode_desc;
      const Parser = globals.RoleInfoParser as new (
        text: string,
        options: Record<string, unknown>,
      ) => {
        raw_info: Record<string, unknown>;
        conf?: { skill?: { school_skill?: Record<string, { name?: unknown; pos?: unknown }> } };
        result: { shenqi?: unknown; basic_info?: Record<string, unknown> };
      };
      const encoded = document.querySelector<HTMLTextAreaElement>("#equip_desc_value")?.value;
      if (typeof decode !== "function" || typeof Parser !== "function" || !encoded) return null;
      const parser = new Parser(decode(encoded), {
        resUrl: globals.ResUrl,
        serverId,
      });
      const raw = parser.raw_info;
      const schoolConfig = parser.conf?.skill?.school_skill;
      const allSkills = raw.all_skills;
      // The official renderer starts with seven empty slots, then fills only learned skills.
      // Preserve its ID/name/slot mapping independently of the DOM we are checking.
      const schoolSkills =
        schoolConfig &&
        typeof schoolConfig === "object" &&
        !Array.isArray(schoolConfig) &&
        Object.keys(schoolConfig).length &&
        allSkills &&
        typeof allSkills === "object" &&
        !Array.isArray(allSkills)
          ? Object.entries(allSkills)
              .filter(([id]) => Object.hasOwn(schoolConfig, id))
              .map(([id, level]) => ({
                id,
                level,
                name: schoolConfig[id]?.name,
                slot: schoolConfig[id]?.pos,
              }))
          : undefined;
      return {
        riders: raw.AllRider ?? {},
        advancedMount: raw.jinjie_rider_info ?? { isJinJie: 0 },
        artifact: raw.shenqi ?? null,
        hasArtifact: parser.result.shenqi !== false,
        idEffects: raw.idbid_desc ?? null,
        goldIdFlag: parser.result.basic_info?.is_gold_id,
        assets: {
          iCash: raw.iCash,
          iSaving: raw.iSaving,
          iLearnCash: raw.iLearnCash,
          xianyu: raw.xianyu,
        },
        allSkills: raw.all_skills,
        ...(schoolSkills === undefined ? {} : { schoolSkills }),
        holyLevel: raw.i3FlyLv,
        serverId,
        eid,
        askingPrice: document
          .querySelector<HTMLElement>("[data-cbg-detail-root]")
          ?.innerText.match(/价格[：:]\s*[￥¥]\s*([\d,.]+)/)?.[1]
          ?.replaceAll(",", ""),
      };
    },
    { serverId: identity.serverId, eid: identity.eid },
  );
  const after = await readDetailIdentity(page);
  if (after.serverId !== identity.serverId || after.eid !== identity.eid)
    identity.issues.push("详情读取期间商品身份发生变化");
  identity.issues.push(...after.issues);
  if (!source)
    return {
      version: 1,
      fields: [],
      source: {},
      issues: ["网页没有可读取的角色解析数据，需补采坐骑和神器"],
    };
  const capture = normalizeValuationSource({ ...source, collectedAt: new Date().toISOString() });
  return {
    ...capture,
    source: { ...capture.source, identityObservations: identity.observations },
    issues: [
      ...new Set([...capture.issues, ...identity.issues, ...roleIdentityIssues(capture.source)]),
    ],
  };
}
