import type { DetailItem, RoleDetail, TabSnapshot, ValuationCapture } from "./types";
import { MAIN_TABS } from "./detail-tabs";
import {
  isRoleValuationSource,
  ROLE_NUMERIC_FIELDS,
  roleNumericObservation,
} from "./valuation-source";

type FieldEvidence = NonNullable<RoleDetail["sourceEvidence"]>["fields"][number];
/** Field paths refer to the archived capture; the enclosing evidence binds every path to one product/revision. */
export function fieldEvidence(tabs: TabSnapshot[], valuation?: ValuationCapture): FieldEvidence[] {
  const fields: FieldEvidence[] = [];
  const add = (
    path: string,
    source: FieldEvidence["source"],
    value: unknown,
    emptyProof = false,
  ) => {
    fields.push({
      path,
      source,
      state:
        value === undefined || value === null || value === ""
          ? "unknown"
          : emptyProof
            ? "explicit-empty"
            : "observed",
    });
  };
  const items = (path: string, values: DetailItem[] | undefined, emptyProof = false) => {
    if (!values?.length) {
      add(path, "element-attributes", emptyProof ? 0 : undefined, emptyProof);
      return;
    }
    for (const [index, item] of values.entries()) {
      const current = `${path}[${index}]`;
      add(
        current + ".name",
        item.readSources?.name ||
          (item.nameSource === "tooltip"
            ? "tooltip"
            : item.nameSource === "official-model"
              ? "official-model"
              : "element-attributes"),
        item.name,
      );
      if (item.category !== undefined)
        add(
          current + ".category",
          item.readSources?.category ||
            (item.categorySource && item.categorySource !== "element"
              ? item.categorySource
              : "element-attributes"),
          item.category,
        );
      if (
        item.level !== undefined ||
        item.kind === "innerSkill" ||
        (item.kind === "skill" && item.category !== "召唤兽技能")
      )
        add(current + ".level", item.readSources?.level || "element-attributes", item.level);
      if (item.location !== undefined)
        add(current + ".location", "element-attributes", item.location);
      if (item.description !== undefined)
        add(
          current + ".description",
          item.readSources?.description || (item.tooltip ? "tooltip" : "element-attributes"),
          item.description,
        );
      for (const [key, value] of Object.entries(item.attributes || {}))
        add(
          current + `.attributes.${key}`,
          item.readSources?.[`attributes.${key}`] || "element-attributes",
          value,
        );
      if (item.skillObservation)
        for (const [key, value] of Object.entries(item.skillObservation))
          add(current + `.skillObservation.${key}`, "element-attributes", value);
    }
  };
  for (const name of MAIN_TABS)
    if (!tabs.some((tab) => tab.name === name)) add(`tabs.${name}`, "visible-text", undefined);
  for (const tab of tabs) {
    const path = `tabs.${tab.name}`;
    add(path + ".text", "visible-text", tab.text);
    if (["坐骑", "锦衣/外观", "玩家之家"].includes(tab.name)) {
      const text = tab.contentText?.trim() || "";
      const unavailable =
        /加载中|读取中|正在加载|请稍后|重试|读取失败|加载失败|信息不全|未提供|暂无数据|暂无[^\n]*信息/.test(
          text,
        );
      const labels =
        tab.name === "坐骑"
          ? "名称|坐骑|成长|坐骑成长|等级"
          : tab.name === "锦衣/外观"
            ? "锦衣|祥瑞|外观|足迹|光环|染色"
            : "房屋|庭院|房屋规模|房屋类型|环境|风水";
      const empty =
        tab.name === "坐骑"
          ? /(?:无|暂无|没有)(?:任何)?坐骑/.test(text)
          : tab.name === "锦衣/外观"
            ? /(?:无|暂无|没有)(?:任何)?(?:外观|锦衣)/.test(text) &&
              /(?:无|暂无|没有)(?:任何)?(?:外观|祥瑞)/.test(text)
            : /(?:无|暂无|没有)(?:任何)?(?:玩家之家|房屋)/.test(text);
      const observed = new RegExp(`(?:^|\\n)(?:${labels})\\s*[：:]\\s*[^\\s：:]`).test(text);
      add(
        path + ".content",
        "visible-text",
        !unavailable && (observed || empty) ? text : undefined,
        !unavailable && !observed && empty,
      );
    }
    for (const [index, field] of tab.fields.entries())
      add(`${path}.fields[${index}].${field.name}`, "visible-field", field.value);
    for (const [index, table] of tab.tables.entries())
      for (const [row, cells] of table.entries())
        for (const [cell, value] of cells.entries())
          add(`${path}.tables[${index}][${row}][${cell}]`, "visible-table", value);
    items(path + ".items", tab.items, tab.equipmentEmptyProof === "official-containers");
    if (tab.equipmentContainers)
      for (const container of tab.equipmentContainers)
        add(
          `${path}.containers.${container.id}`,
          "official-container",
          container.present && container.visible ? container.icons.length : undefined,
          container.present && container.visible && container.icons.length === 0,
        );
    for (const [index, pet] of (tab.pets || []).entries()) {
      const base = `${path}.pets[${index}]`;
      add(base + ".name", "visible-field", pet.name);
      for (const [index, field] of pet.fields.entries())
        add(`${base}.fields[${index}].${field.name}`, "visible-field", field.value);
      items(base + ".skills", pet.skills);
      items(base + ".equipment", pet.equipment);
      items(base + ".innerSkills", pet.innerSkills);
    }
  }
  for (const [index, field] of (valuation?.fields || []).entries())
    add(`valuation.fields[${index}].${field.name}`, "official-role-parser", field.value);
  for (const key of ["riders", "advancedMount", "allSkills", "schoolSkills"])
    add(`valuation.source.${key}`, "official-role-parser", valuation?.source[key]);
  if (
    tabs.some((tab) => tab.name === "人物/修炼") ||
    isRoleValuationSource(valuation?.source || {})
  )
    for (const field of ROLE_NUMERIC_FIELDS)
      add(
        `valuation.source.${field.path}`,
        "official-role-parser",
        roleNumericObservation(valuation?.source || {}, field.key).value,
      );
  return fields;
}
