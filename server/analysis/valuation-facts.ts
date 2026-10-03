import type { SavedRoleRecord } from "../crawler/types";
import type { Evidence } from "./types";
import type { ValuationFact } from "./valuation-types";

export type Fact = { raw: string; evidence: Evidence[] };
const aliases: Record<string, string[]> = {
  神器套数: ["神器套数", "神器数量"],
  坐骑总数: ["坐骑总数", "坐骑数量"],
  进阶状态: ["进阶状态", "坐骑进阶状态"],
  主属性百分比: ["主属性百分比", "主属性比例"],
  储备金: ["储备金", "储备"],
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const numericFact = (raw: string | undefined): number | null => {
  if (raw === undefined || !/^\d+(?:\.\d+)?(?:\s*[套只])?$/.test(raw.trim())) return null;
  const value = Number(raw.trim().replace(/\s*[套只]$/, ""));
  return Number.isFinite(value) ? value : null;
};

function textFact(name: string, text: string): string | null {
  const labels = aliases[name] || [name];
  for (const label of labels) {
    const match = text.match(
      new RegExp("(?:^|[\\n\\t])\\s*" + escape(label) + "\\s*[：:]\\s*([^\\n\\t]+)"),
    );
    if (match) return match[1].trim();
  }
  if (name === "神器套数" && /(?:没有神器|无神器|未(?:开启|解锁|获得)神器)/.test(text)) return "0";
  if (name === "坐骑总数" && /(?:没有坐骑|无坐骑|坐骑数量\s*[：:]?\s*0)/.test(text)) return "0";
  if (name === "进阶状态") {
    if (/(?:坐骑[·\s]*已进阶|进阶状态\s*[：:]?\s*已进阶)/.test(text)) return "已进阶";
    if (/(?:坐骑[·\s]*未进阶|进阶状态\s*[：:]?\s*未进阶)/.test(text)) return "未进阶";
  }
  return null;
}

function quotedFact(name: string, quote: string): string | null {
  const labelled = textFact(name, quote);
  if (labelled !== null) return labelled;
  if (name === "神器套数") return quote.match(/(?:共|共有|拥有)\s*(\d+)\s*套神器/)?.[1] ?? null;
  if (name === "坐骑总数") return quote.match(/(?:共|共有|拥有)\s*(\d+)\s*只坐骑/)?.[1] ?? null;
  const artifact = name.match(/^神器([1-3])(满槽|类型|总分)$/);
  const artifactText =
    artifact &&
    quote.match(
      new RegExp("第\\s*" + artifact[1] + "\\s*套神器([^\\n]*?)(?=第\\s*\\d+\\s*套神器|$|\\n)"),
    )?.[1];
  if (artifact && artifactText) {
    if (artifact[2] === "类型") return artifactText.match(/十二[水火金木土]|混合/)?.[0] ?? null;
    if (artifact[2] === "总分")
      return artifactText.match(/(?:总分|属性分值)\s*[：:]\s*(\d+(?:\.\d+)?)/)?.[1] ?? null;
    if (/未填满|未满槽/.test(artifactText)) return "否";
    if (/12\s*\/\s*12|已填满12槽/.test(artifactText)) return "是";
  }
  const mount = name.match(/^坐骑([1-9])(成长|进阶状态|主属性百分比)$/);
  const mountText =
    mount &&
    quote.match(
      new RegExp("第\\s*" + mount[1] + "\\s*只坐骑([^\\n]*?)(?=第\\s*\\d+\\s*只坐骑|$|\\n)"),
    )?.[1];
  if (mount && mountText) {
    if (mount[2] === "成长") return mountText.match(/成长\s*[：:]\s*(\d+(?:\.\d+)?)/)?.[1] ?? null;
    if (mount[2] === "进阶状态") return mountText.match(/已进阶|未进阶/)?.[0] ?? null;
    return mountText.match(/主属性(?:百分比|比例)?\s*[：:]\s*(\d+(?:\.\d+)?)%/)?.[1] ?? null;
  }
  return null;
}

/** Read the collected fields, both table layouts, and labelled text without guessing absence. */
export function readValuationFact(
  record: SavedRoleRecord,
  name: string,
  tabName?: string,
  supplements: ValuationFact[] = [],
): Fact | null {
  const labels = aliases[name] || [name];
  const captured = record.detail?.valuation;
  const index =
    captured?.fields.findIndex(
      (field) => labels.includes(field.name) && (!tabName || field.tab === tabName),
    ) ?? -1;
  if (captured && index >= 0)
    return {
      raw: captured.fields[index].value,
      evidence: [
        {
          path: `/detail/valuation/fields/${index}/value`,
          value: captured.fields[index].value,
          reason: "网页角色数据：" + name,
        },
      ],
    };
  for (const [ti, tab] of (record.detail?.tabs || []).entries()) {
    if (tabName && tab.name !== tabName) continue;
    const proof = (raw: string, path: string, value = raw): Fact => ({
      raw,
      evidence: [{ path, value, reason: "原始采集资料：" + name }],
    });
    const fi = tab.fields.findIndex((field) => labels.includes(field.name.trim()));
    if (fi >= 0) return proof(tab.fields[fi].value, `/detail/tabs/${ti}/fields/${fi}/value`);
    for (const [tableIndex, table] of tab.tables.entries())
      for (const [ri, row] of table.entries())
        for (const [ci, cell] of row.entries()) {
          const path = `/detail/tabs/${ti}/tables/${tableIndex}/${ri}/${ci}`;
          if (labels.includes(cell.replace(/[：:]\s*$/, "").trim()) && row[ci + 1] !== undefined)
            return proof(row[ci + 1], `/detail/tabs/${ti}/tables/${tableIndex}/${ri}/${ci + 1}`);
          const raw = textFact(name, cell);
          if (raw !== null) return proof(raw, path, cell);
        }
    const raw = textFact(name, tab.text);
    if (raw !== null) return proof(raw, `/detail/tabs/${ti}/text`, tab.text);
  }
  const extra = supplements.find(
    (entry) =>
      entry.name === name &&
      (!tabName || record.detail?.tabs[Number(entry.path.split("/")[3])]?.name === tabName),
  );
  return extra
    ? {
        raw: extra.value,
        evidence: [{ path: extra.path, value: extra.quote, reason: "AI 从原文补提：" + name }],
      }
    : null;
}

/** An AI supplement must quote a real string and derive its value from a supported label or numbered description. */
export function validateValuationFacts(input: unknown, record: SavedRoleRecord): ValuationFact[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 40) throw new Error("AI 补充资料格式错误");
  const names = new Set<string>();
  return input.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("AI 补充资料格式错误");
    const { name, value, path, quote } = entry as Record<string, unknown>;
    if (
      typeof name !== "string" ||
      typeof value !== "string" ||
      typeof path !== "string" ||
      typeof quote !== "string" ||
      !quote.trim() ||
      quote.length > 1000 ||
      path.length > 500 ||
      !/^(?:神器套数|坐骑总数|进阶状态|主属性百分比|神器[1-3](?:满槽|类型|总分)|坐骑[1-9](?:成长|进阶状态|主属性百分比))$/.test(
        name,
      ) ||
      names.has(name)
    )
      throw new Error("AI 补充资料名称或引用无效");
    names.add(name);
    if (!/^\/detail\/tabs\/\d+\/(?:text|fields\/\d+\/value|tables\/\d+\/\d+\/\d+)$/.test(path))
      throw new Error("AI 补充资料必须引用详情中的文字字段");
    let actual: unknown = { detail: record.detail };
    for (const part of path.slice(1).split("/")) {
      if (!actual || typeof actual !== "object" || !Object.hasOwn(actual, part))
        throw new Error("AI 补充资料的来源不存在");
      actual = (actual as Record<string, unknown>)[part];
    }
    if (typeof actual !== "string" || !actual.includes(quote))
      throw new Error("AI 补充资料与原文不一致");
    const derived = quotedFact(name, quote);
    if (derived !== value) throw new Error("AI 补充资料无法从引用中复核：" + name);
    const collected = readValuationFact(record, name);
    if (collected && collected.raw !== value)
      throw new Error("AI 补充资料与已采集字段冲突：" + name);
    return { name, value, path, quote };
  });
}
