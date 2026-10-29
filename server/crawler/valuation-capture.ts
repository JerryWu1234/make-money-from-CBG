import type { Page } from "playwright-core";
import type { ValuationCapture } from "./types";
import { roleIdentityIssues } from "./role-identity";
import { readDetailIdentity } from "./detail-identity";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const ATTRIBUTES: Record<string, number> = {
  伤害: 1,
  法术伤害: 1,
  物理暴击: 1,
  法术暴击: 1,
  封印命中: 1,
  防御: 0.5,
  抵抗封印: 0.5,
  速度: 1.3,
  治疗能力: 1.3,
  气血: 0.1,
};
const MAIN_ATTRIBUTES: Record<string, string> = {
  iRd_Cor: "体质",
  iRd_Str: "力量",
  iRd_Mag: "魔力",
  iRd_Res: "耐力",
  iRd_Spe: "敏捷",
};
const ELEMENTS: Record<number, string> = { 1: "金", 2: "木", 4: "土", 8: "水", 16: "火" };

/** Source is the website's decoded role object, never login or account state. */
export function normalizeValuationSource(source: Record<string, unknown>): ValuationCapture {
  const fields: ValuationCapture["fields"] = [],
    issues: string[] = [];
  const add = (name: string, value: string | number, tab: string) =>
    fields.push({ name, value: String(value), tab });
  const issue = (text: string) => issues.push(text);
  const skills = object(source.allSkills);
  if (
    skills &&
    Object.values(skills).every((value) => finite(value) !== null && Number(value) >= 0)
  ) {
    add("强壮", finite(skills["230"]) ?? 0, "技能");
    add("神速", finite(skills["237"]) ?? 0, "技能");
  }
  const holy = finite(source.holyLevel);
  if (holy !== null && Number.isInteger(holy) && holy >= 0 && holy <= 9)
    add("化圣层数", holy, "人物/修炼");
  const advanced = object(source.advancedMount);
  if (advanced?.isJinJie === 1) {
    add("坐骑总数", 1, "坐骑");
    add("坐骑1进阶状态", "已进阶", "坐骑");
    const grow = finite(advanced.iGrow),
      extra = finite(advanced.iExGrow);
    if (grow !== null && extra !== null)
      add("坐骑1成长", (grow / 100 + extra / 10000).toFixed(4), "坐骑");
    else issue("进阶坐骑成长缺失");
    const schemes = advanced.aAttrSchemes;
    const percentages: number[] = [];
    if (Array.isArray(schemes))
      for (const [index, entry] of schemes.entries()) {
        const scheme = object(entry),
          ratios = object(scheme?.mpRatio);
        const main = scheme?.cMainAttr;
        const percentage =
          typeof main === "string" && MAIN_ATTRIBUTES[main] ? finite(ratios?.[main]) : null;
        if (percentage !== null && percentage >= 0 && percentage <= 100) {
          percentages.push(percentage);
          add(`坐骑1方案${index + 1}主属性`, MAIN_ATTRIBUTES[String(main)], "坐骑");
          add(`坐骑1方案${index + 1}主属性百分比`, percentage, "坐骑");
        } else issue(`进阶坐骑方案${index + 1}的主属性比例缺失`);
      }
    if (percentages.length && percentages.length === (Array.isArray(schemes) ? schemes.length : 0))
      add("坐骑1主属性百分比", Math.max(...percentages), "坐骑");
    else issue("进阶坐骑方案未完整读取");
  } else if (
    source.riders !== undefined &&
    (object(source.riders) || Array.isArray(source.riders))
  ) {
    const riders = Object.values(source.riders as Record<string, unknown>);
    add("坐骑总数", riders.length, "坐骑");
    for (const [index, entry] of riders.entries()) {
      const rider = object(entry),
        grow = finite(rider?.iGrow),
        extra = finite(rider?.exgrow);
      const prefix = `坐骑${index + 1}`;
      add(prefix + "进阶状态", "未进阶", "坐骑");
      if (extra !== null && extra > 0) add(prefix + "成长", (extra / 10000).toFixed(4), "坐骑");
      else if (grow !== null) add(prefix + "成长", grow / 100, "坐骑");
      else issue(prefix + "成长缺失");
      if (typeof rider?.mattrib === "string") add(prefix + "主属性", rider.mattrib, "坐骑");
    }
  } else issue("坐骑清单未完整读取");

  const artifact = object(source.artifact);
  if (source.hasArtifact === false) add("神器套数", 0, "道具/法宝");
  else if (artifact && finite(artifact.id) !== null) {
    const sets = Array.isArray(artifact.suit) ? artifact.suit : [artifact];
    if (sets.length > 3 || !sets.length) issue("神器套数超出已支持范围或清单为空");
    else {
      add("神器套数", sets.length, "道具/法宝");
      for (const [index, entry] of sets.entries()) {
        const set = object(entry),
          components = set?.components;
        const prefix = `神器${index + 1}`;
        if (!Array.isArray(components)) {
          issue(prefix + "槽位未完整读取");
          continue;
        }
        const slots: Record<string, unknown>[] = [];
        let valid = components.length === 3;
        for (const entry of components) {
          const component = object(entry);
          if (!Array.isArray(component?.wuxing) || component.wuxing.length !== 4) {
            valid = false;
            break;
          }
          for (const slot of component.wuxing) {
            const data = object(slot);
            if (!data) {
              valid = false;
              break;
            }
            slots.push({ ...data, componentUnlocked: component.unlock });
          }
        }
        if (!valid || slots.length !== 12) {
          issue(prefix + "12槽结构未完整读取");
          continue;
        }
        const unknown = slots.some(
          (slot) =>
            ![0, 1].includes(finite(slot.componentUnlocked) ?? -1) ||
            (slot.componentUnlocked === 1 &&
              (![0, 1].includes(finite(slot.status) ?? -1) ||
                (slot.status === 1 &&
                  (finite(slot.wuxingshi_level) === null ||
                    Number(slot.wuxingshi_level) < 0 ||
                    (Number(slot.wuxingshi_level) > 0 && !ELEMENTS[Number(slot.id)]))))),
        );
        if (unknown) {
          issue(prefix + "槽位状态或五行未完整读取");
          continue;
        }
        const full = slots.every(
          (slot) =>
            slot.componentUnlocked === 1 && slot.status === 1 && Number(slot.wuxingshi_level) > 0,
        );
        add(prefix + "满槽", full ? "是" : "否", "道具/法宝");
        add(
          prefix + "已填槽数",
          slots.filter(
            (slot) =>
              slot.componentUnlocked === 1 &&
              slot.status === 1 &&
              (finite(slot.wuxingshi_level) ?? 0) > 0,
          ).length,
          "道具/法宝",
        );
        if (!full) continue;
        const elements = slots.map((slot) => ELEMENTS[Number(slot.id)]);
        add(
          prefix + "类型",
          elements.every((el) => el === elements[0]) ? "十二" + elements[0] : "混合",
          "道具/法宝",
        );
        const attrs = set?.attributes;
        let score = 0,
          scoreDecimals = 0,
          complete = Array.isArray(attrs) && attrs.length > 0;
        if (Array.isArray(attrs))
          for (const item of attrs) {
            const attr = object(item);
            if (attr?.disable === 1) continue;
            if (attr?.disable !== 0 || typeof attr.attr !== "string") {
              complete = false;
              continue;
            }
            const match = attr.attr
              .trim()
              .match(
                /^(伤害|法术伤害|物理暴击|法术暴击|封印命中|防御|法术防御|固定伤害|抵抗封印|速度|治疗能力|气血)\s*[+＋:]?\s*(\d+(?:\.\d+)?)$/,
              );
            if (!match) {
              complete = false;
              issue(prefix + "属性未识别：" + attr.attr);
              continue;
            }
            // 用户确认这两项不计分；保留原值，避免把已采到的属性误报为缺资料。
            if (["法术防御", "固定伤害"].includes(match[1])) {
              add(prefix + "未计分属性", attr.attr, "道具/法宝");
              continue;
            }
            // 当前权重最多一位小数，保留原始属性精度并清除求和的二进制尾差。
            scoreDecimals = Math.max(scoreDecimals, (match[2].split(".")[1]?.length || 0) + 1);
            score += Number(match[2]) * ATTRIBUTES[match[1]];
          }
        if (complete)
          add(prefix + "总分", Number(score.toFixed(Math.min(scoreDecimals, 100))), "道具/法宝");
        else issue(prefix + "属性分值未完整读取");
      }
    }
  } else issue("神器是否存在未完整读取");
  if (Array.isArray(source.idEffects) && source.idEffects.every((id) => finite(id) !== null)) {
    const gold = source.idEffects.some((id) => Number(id) >= 5 && Number(id) <= 8);
    add("靓号特效", gold ? "土豪金" : "无土豪金", "人物/修炼");
  } else if (source.goldIdFlag === false) add("靓号特效", "无土豪金", "人物/修炼");
  else issue("靓号具体特效未完整读取");
  const assets = object(source.assets);
  for (const [key, label] of [
    ["iCash", "现金"],
    ["iSaving", "存银"],
    ["iLearnCash", "储备金"],
    ["xianyu", "仙玉"],
  ]) {
    const quantity = finite(assets?.[key]);
    if (quantity !== null && quantity >= 0) add(label, quantity, "道具/法宝");
  }
  return { version: 1, fields, issues: [...new Set(issues)], source };
}

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
        result: { shenqi?: unknown; basic_info?: Record<string, unknown> };
      };
      const encoded = document.querySelector<HTMLTextAreaElement>("#equip_desc_value")?.value;
      if (typeof decode !== "function" || typeof Parser !== "function" || !encoded) return null;
      const parser = new Parser(decode(encoded), {
        resUrl: globals.ResUrl,
        serverId,
      });
      const raw = parser.raw_info;
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
