import type { Page } from "playwright-core";
import type { ValuationCapture } from "./types";
import { roleIdentityIssues } from "./role-identity";
import { readDetailIdentity } from "./detail-identity";
import { evaluateDetailRoot, readDetailEncodedRole } from "./detail-root";

export { normalizeValuationSource } from "./valuation-source";
import { normalizeValuationSource } from "./valuation-source";

export async function captureValuation(page: Page): Promise<ValuationCapture> {
  const identity = await readDetailIdentity(page);
  const encodedRole = await readDetailEncodedRole(page);
  const source = await evaluateDetailRoot(
    page,
    (root, { serverId, eid, encoded }) => {
      try {
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
        if (typeof decode !== "function" || typeof Parser !== "function" || !encoded) return null;
        const parser = new Parser(decode(encoded), { resUrl: globals.ResUrl, serverId });
        const raw = parser.raw_info;
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          throw new TypeError("角色原文结构无效");
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
          riders: raw.AllRider,
          advancedMount: raw.jinjie_rider_info,
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
          askingPrice: root.innerText
            .match(/价格[：:]\s*[￥¥]\s*([\d,.]+)/)?.[1]
            ?.replaceAll(",", ""),
        };
      } catch (error) {
        return {
          parseIssue: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : "角色解析器执行失败",
          },
        };
      }
    },
    { serverId: identity.serverId, eid: identity.eid, encoded: encodedRole },
  );
  if (source && "parseIssue" in source && source.parseIssue) {
    const cause = Object.assign(new Error(source.parseIssue.message), {
      name: source.parseIssue.name,
    });
    throw Object.assign(new Error("角色公开原文解析失败，本件资料未完整读取", { cause }), {
      name: "IncompleteDetailError",
    });
  }
  const after = await readDetailIdentity(page);
  if (after.serverId !== identity.serverId || after.eid !== identity.eid)
    identity.issues.push("详情读取期间商品身份发生变化");
  identity.issues.push(...after.issues);
  if (!source)
    return {
      version: 1,
      fields: [],
      source: {},
      issues: ["网页没有可读取的角色解析数据，需补采坐骑和神器", ...identity.issues],
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
