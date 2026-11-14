import type { SavedRoleRecord, DetailItem } from "../crawler/types";
import { observedEquipmentCategory } from "../crawler/compact";
import { equipmentInventory, isJewelryEquipment } from "./equipment-pricing";
import { petInventory } from "./pet-pricing";
import { parseEquipmentAttributes } from "./equip-attributes";
import { currentPetSkills } from "./pet-match";
import {
  normalizeCompiledRule,
  describeRule,
  RULE_FIELDS,
  RULE_COLLECTION_LABELS,
  type CompiledConditionRule,
  type RuleCollection,
  type RuleExpression,
} from "./condition-rule-types";
export * from "./condition-rule-types";

export type RuleEvidence = {
  path: string;
  label: string;
  value: number | string | boolean | string[] | null;
};
export type RuleEvaluation = {
  status: "met" | "unmet" | "unknown";
  reason: string;
  evidence: RuleEvidence[];
};
type Value = number | string | boolean | string[];
type Observed = { value?: Value; trace: string; money?: boolean };
type Item = { key: string; path: string; fields: Record<string, Observed> };
type Collection = {
  items: Item[];
  complete: boolean;
  issues: string[];
  classificationUncertain?: boolean;
};
const known = (value: Value, trace: string, money = false): Observed => ({
  value,
  trace,
  ...(money ? { money } : {}),
});
const missing = (trace: string): Observed => ({ trace });
const display = (value: Value) => (Array.isArray(value) ? value.join("、") || "无" : String(value));
function number(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const text = value.trim().replace(/(?:级|点)$/, "");
  return /^[+-]?\d+(?:\.\d+)?$/.test(text) && Number.isFinite(Number(text))
    ? Number(text)
    : undefined;
}
function uniqueFields(
  values: Array<{ value: string; path: string }>,
  numeric: boolean,
  label: string,
  addEvidence: (e: RuleEvidence) => void,
): Observed {
  if (!values.length) return missing(`缺少${label}`);
  const parsed = values.map((item) => ({
    ...item,
    parsed: numeric ? number(item.value) : item.value.trim() || undefined,
  }));
  if (
    parsed.some((item) => item.parsed === undefined) ||
    new Set(parsed.map((item) => item.parsed)).size !== 1
  )
    return missing(`${label}缺失、格式不明或存在冲突`);
  for (const item of parsed) addEvidence({ path: item.path, label, value: item.parsed! });
  return known(parsed[0].parsed!, `${label}=${parsed[0].parsed}`);
}

/** Execute validated data only. No model status or model-authored factual values are consumed. */
export function evaluateCompiledRule(
  suppliedRule: CompiledConditionRule,
  record: SavedRoleRecord,
  prices: { asking: number | null; bare: number | null },
): RuleEvaluation {
  const evidence: RuleEvidence[] = [];
  const addEvidence = (entry: RuleEvidence) => {
    if (
      evidence.length < 80 &&
      !evidence.some(
        (item) =>
          item.path === entry.path &&
          item.label === entry.label &&
          JSON.stringify(item.value) === JSON.stringify(entry.value),
      )
    )
      evidence.push(entry);
  };
  let rule: CompiledConditionRule;
  try {
    rule = normalizeCompiledRule(suppliedRule, suppliedRule.sourceText);
  } catch (error) {
    return {
      status: "unknown",
      reason: `规则无效：${error instanceof Error ? error.message : "无法执行"}`,
      evidence,
    };
  }
  if (rule.status !== "ready" || !rule.expression)
    return {
      status: "unknown",
      reason: `${rule.status === "ambiguous" ? "条件口径待澄清" : "条件暂不支持自动执行"}：${rule.issues.join("；")}`,
      evidence,
    };

  const detail = record.detail;
  const paths = new Map<string, { path: string; raw: DetailItem }>();
  for (const [tabIndex, tab] of (detail?.tabs || []).entries())
    for (const [itemIndex, item] of (tab.items || []).entries())
      paths.set(tab.name + ":" + item.index, {
        path: `/detail/tabs/${tabIndex}/items/${itemIndex}`,
        raw: item,
      });
  let collections: Record<RuleCollection, Collection> | undefined;
  function inventories(): Record<RuleCollection, Collection> {
    if (collections) return collections;
    if (!detail || detail.captureMode === "body") {
      const absent = () => ({ items: [], complete: false, issues: ["未采集完整资产资料"] });
      return (collections = {
        equipment: absent(),
        jewelry: absent(),
        petEquipment: absent(),
        pets: absent(),
      });
    }
    const gear = equipmentInventory(record),
      pets = petInventory(record);
    const gearComplete = gear.captureComplete;
    const empty = (complete: boolean, issues: string[]): Collection => ({
      items: [],
      complete,
      issues: [...issues],
    });
    collections = {
      equipment: empty(gearComplete, gear.issues),
      jewelry: empty(gearComplete, gear.issues),
      petEquipment: empty(pets.captureComplete && gearComplete, [...pets.issues, ...gear.issues]),
      pets: empty(pets.captureComplete, pets.issues),
    };
    const attributes = (raw: string, key: string) => {
      const fields = parseEquipmentAttributes(raw).fields;
      const value = fields[key];
      return value?.length === 1 ? number(value[0]) : undefined;
    };
    function numericItemField(
      fields: Record<string, Observed>,
      key: string,
      value: unknown,
      label: string,
    ) {
      const parsed = number(value);
      fields[key] =
        parsed === undefined ? missing(`缺少${label}`) : known(parsed, `${label}=${parsed}`);
    }
    function petAccessory(item: DetailItem) {
      return (
        item.location === "RolePetShipin" ||
        /(?:宝宝|召唤兽).*饰品|饰品.*(?:宝宝|召唤兽)/.test(item.category || "")
      );
    }
    function loosePetEquipment(item: DetailItem) {
      if (item.kind === "skill" || item.kind === "innerSkill" || petAccessory(item)) return false;
      const category = observedEquipmentCategory(item.category, item.location, item.modelId);
      if (/法宝|灵宝|神器|道具|材料|消耗品|上古玉魄|元身/.test(category)) return false;
      return (
        /^(?:召唤兽|宝宝)装备(?:$|[·/\s])/.test(category) ||
        item.location === "RolePetEquips" ||
        item.attributes?.装备对象?.trim() === "召唤兽"
      );
    }
    function addPetEquipment(
      item: DetailItem,
      fallbackKey: string,
      path: string,
      description: string,
    ) {
      // Model/name/stat equality is not an item identity: two identical items still count twice.
      // Only an observed item ID can join observations from different containers.
      const location = item.location || "";
      const identity = /^\d{14,}-\d+-[a-zA-Z0-9]+$/.test(location)
        ? `pet-gear:${location}`
        : fallbackKey;
      const fields: Record<string, Observed> = {
        "item.name": known(item.name, `名称=${item.name}`),
        "item.category": known("召唤兽装备", "类别=召唤兽装备"),
      };
      const parsed = parseEquipmentAttributes(description).fields;
      const level =
        parsed.等级?.length === 1
          ? number(parsed.等级[0])
          : number(item.attributes?.等级 ?? item.level);
      numericItemField(fields, "item.level", level, "等级");
      for (const [field, name] of Object.entries({
        damage: "伤害",
        defense: "防御",
        speed: "速度",
        hp: "气血",
      }))
        numericItemField(
          fields,
          "item." + field,
          attributes(description, name) ?? item.attributes?.[name],
          name,
        );
      const target = collections!.petEquipment;
      const existing = target.items.find((value) => value.key === identity);
      if (existing) {
        if (JSON.stringify(existing.fields) !== JSON.stringify(fields)) {
          target.complete = false;
          target.issues.push("同一宝宝装备标识出现不同属性");
        }
      } else target.items.push({ key: identity, path, fields });
    }
    for (const [tabIndex, tab] of detail.tabs.entries()) {
      if (!/^道具\/法宝(?:\s*\/|$)/.test(tab.name)) continue;
      for (const [itemIndex, item] of (tab.items || []).entries()) {
        if (!loosePetEquipment(item)) continue;
        const description =
          item.description ||
          item.tooltip ||
          Object.entries(item.attributes || {})
            .map(([name, value]) => `${name}：${value}`)
            .join("\n");
        addPetEquipment(
          item,
          `${tab.name}:${item.index}`,
          `/detail/tabs/${tabIndex}/items/${itemIndex}`,
          description,
        );
      }
    }
    for (const item of gear.items.filter((item) => !/上古玉魄|元身/.test(item.category))) {
      const source = paths.get(item.key);
      if (!source) {
        collections.equipment.complete = collections.jewelry.complete = false;
        collections.equipment.issues.push("装备缺少采集来源");
        continue;
      }
      if (loosePetEquipment(source.raw) || petAccessory(source.raw)) continue;
      const category = observedEquipmentCategory(
        source.raw.category,
        source.raw.location,
        source.raw.modelId,
      );
      const jewelry = isJewelryEquipment(item);
      if (!category && !jewelry) {
        collections.equipment.classificationUncertain =
          collections.jewelry.classificationUncertain = true;
      }
      // The broad equipment inventory may infer a tradable item from attributes. That is
      // enough for the equipment+jewelry total, but not evidence of its specific category.
      const fields: Record<string, Observed> = {
        "item.name": known(item.name, `名称=${item.name}`),
        "item.category": category
          ? known(category, `类别=${category}`)
          : missing("装备具体类别待核实"),
      };
      numericItemField(fields, "item.level", item.level, "等级");
      numericItemField(
        fields,
        "item.gemLevel",
        attributes(item.description, "锻炼等级"),
        "宝石锻炼等级",
      );
      numericItemField(
        fields,
        "item.refineLevel",
        attributes(item.description, "精炼等级"),
        "精炼等级",
      );
      for (const [key, name] of Object.entries({
        damage: "伤害",
        defense: "防御",
        speed: "速度",
        hp: "气血",
      }))
        numericItemField(fields, "item." + key, attributes(item.description, name), name);
      const target = jewelry ? collections.jewelry : collections.equipment;
      const existing = target.items.find((value) => value.key === item.key);
      if (existing) {
        if (JSON.stringify(existing.fields) !== JSON.stringify(fields)) {
          target.complete = false;
          target.issues.push("同一装备标识出现不同属性");
        }
      } else target.items.push({ key: item.key, path: source.path, fields });
    }
    for (const pet of pets.items) {
      let tabIndex = -1,
        petIndex = -1;
      for (const [ti, tab] of detail.tabs.entries()) {
        const pi = (tab.pets || []).findIndex((value) => tab.name + ":" + value.index === pet.key);
        if (pi >= 0) {
          tabIndex = ti;
          petIndex = pi;
          break;
        }
      }
      if (tabIndex < 0 || petIndex < 0) {
        collections.pets.complete = collections.petEquipment.complete = false;
        continue;
      }
      const raw = detail.tabs[tabIndex].pets![petIndex];
      const path = `/detail/tabs/${tabIndex}/pets/${petIndex}`;
      const fields: Record<string, Observed> = {
        "item.name": known(pet.name, `名称=${pet.name}`),
        "item.category": known("召唤兽", "类别=召唤兽"),
      };
      numericItemField(fields, "item.level", pet.level, "等级");
      const growth = pet.fields.filter((field) => field.name === "成长");
      numericItemField(
        fields,
        "item.growth",
        growth.length === 1 ? growth[0].value : undefined,
        "成长",
      );
      const baby = pet.fields.filter((field) => ["是否宝宝", "宝宝"].includes(field.name));
      fields["item.isBaby"] =
        baby.length === 1 && /^(是|否|1|0|野生)$/.test(baby[0].value)
          ? known(/^(是|1)$/.test(baby[0].value), "是否宝宝=" + baby[0].value)
          : missing("是否宝宝字段缺失或冲突");
      const skills = currentPetSkills(pet);
      const skillsComplete = !pet.issues.some((issue) =>
        /技能名称缺失|完整技能列表|技能名称.*重复/.test(issue),
      );
      fields["item.skills"] = skillsComplete
        ? known(skills, `当前技能=${skills.join("、") || "无"}`)
        : missing("召唤兽当前技能未核实完整");
      fields["item.skillCount"] = skillsComplete
        ? known(skills.length, `当前技能数=${skills.length}`)
        : missing("召唤兽当前技能未核实完整");
      collections.pets.items.push({ key: pet.key, path, fields });
      // Count physical gear even when its pet is zero-level, wild, bound or excluded
      // from market pricing. Accessories remain a different item category.
      for (const [index, item] of raw.equipment.entries()) {
        if (petAccessory(item)) continue;
        const normalized = pet.equipment[index];
        if (!normalized || normalized.accessory) continue;
        addPetEquipment(
          item,
          `${pet.key}:gear:${item.index}`,
          `${path}/equipment/${index}`,
          normalized.description,
        );
      }
    }
    return collections;
  }
  function rootField(path: string): Observed {
    const label = RULE_FIELDS[path].label;
    if (path === "listing.price" || path === "valuation.bare") {
      const value = path === "listing.price" ? prices.asking : prices.bare;
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        (path === "listing.price" && value === 0)
      )
        return missing(`缺少有效${label}`);
      addEvidence({
        path: path === "listing.price" ? "/listing/price" : "/valuation/bare_role_value",
        label,
        value,
      });
      return known(value, `${label}=${value}`, true);
    }
    if (path === "listing.serverId" || path === "listing.serverName") {
      const value =
        path === "listing.serverId" ? record.listing.serverId : record.listing.serverName;
      if (!value) return missing(`缺少${label}`);
      addEvidence({
        path: path === "listing.serverId" ? "/listing/serverId" : "/listing/serverName",
        label,
        value,
      });
      return known(value, `${label}=${value}`);
    }
    const aliases: Record<string, string[]> = {
      "role.level": ["级别", "等级", "人物等级"],
      "role.school": ["门派"],
      "role.speed": ["速度"],
      "role.hp": ["气血"],
      "role.damage": ["伤害"],
      "role.defense": ["防御"],
      "role.magicDamage": ["法术伤害", "法伤"],
    };
    const names = aliases[path] || [];
    const observed: Array<{ value: string; path: string }> = [];
    for (const [ti, tab] of (detail?.tabs || []).entries()) {
      if (!/^(人物|角色)(?:\/|$)/.test(tab.name)) continue;
      for (const [fi, field] of (tab.fields || []).entries())
        if (names.includes(field.name))
          observed.push({ value: field.value, path: `/detail/tabs/${ti}/fields/${fi}/value` });
    }
    if (!observed.length)
      for (const [key, value] of Object.entries(record.listing.attrs || {}))
        if (names.includes(key))
          observed.push({ value: String(value), path: `/listing/attrs/${key}` });
    if (!observed.length && path === "role.level") {
      const summary = record.listing.summary as Record<string, unknown> | null;
      if (typeof summary?.iGrade === "string" || typeof summary?.iGrade === "number")
        observed.push({ value: String(summary.iGrade), path: "/listing/summary/iGrade" });
    }
    return uniqueFields(observed, RULE_FIELDS[path].type === "number", label, addEvidence);
  }
  function field(path: string, item?: Item): Observed {
    if (!path.startsWith("item.")) return rootField(path);
    const result = item?.fields[path] || missing(`缺少${RULE_FIELDS[path].label}`);
    if (item && result.value !== undefined)
      addEvidence({ path: item.path, label: RULE_FIELDS[path].label, value: result.value });
    return result;
  }
  function evaluate(expr: RuleExpression, item?: Item): Observed {
    if (expr.op === "literal") return known(expr.value, display(expr.value));
    if (expr.op === "field") return field(expr.path, item);
    if (expr.op === "count" || expr.op === "sum" || expr.op === "min" || expr.op === "max") {
      const names = expr.op === "count" ? expr.collections : [expr.collection];
      const inventory = inventories();
      const selected: Item[] = [];
      const traces: string[] = [];
      let complete = true;
      for (const name of names) {
        const collection = inventory[name];
        const matches: Item[] = [];
        if (!collection.complete) complete = false;
        addEvidence({
          path:
            name === "equipment" || name === "jewelry"
              ? "/detail/equipmentCapture/complete"
              : name === "petEquipment"
                ? "/detail"
                : "/detail/petCapture/complete",
          label: RULE_COLLECTION_LABELS[name] + "采集完整",
          value: collection.complete,
        });
        for (const candidate of collection.items) {
          const decision = expr.where ? evaluate(expr.where, candidate) : known(true, "全部");
          if (decision.value === true) matches.push(candidate);
          else if (decision.value !== false) complete = false;
        }
        traces.push(
          `${RULE_COLLECTION_LABELS[name]}${matches.length}${collection.complete ? "" : "（未完整）"}`,
        );
        selected.push(...matches);
      }
      const uncertainClassification = names.some((name) => inventory[name].classificationUncertain);
      const coversGear = names.includes("equipment") && names.includes("jewelry");
      if (uncertainClassification && !coversGear) {
        complete = false;
        traces.push("人物装备与灵饰的分类待核实");
      }
      if (uncertainClassification && coversGear) {
        traces.splice(
          0,
          traces.length,
          `人物装备/灵饰合计（部分分类待核实）${selected.filter((candidate) => inventory.equipment.items.includes(candidate) || inventory.jewelry.items.includes(candidate)).length}`,
          ...names
            .filter((name) => name !== "equipment" && name !== "jewelry")
            .map(
              (name) =>
                `${RULE_COLLECTION_LABELS[name]}${selected.filter((candidate) => inventory[name].items.includes(candidate)).length}`,
            ),
        );
      }
      const scope = traces.join("＋");
      if (!complete) return missing(`${scope}；资料或筛选字段未核实完整，不把缺失当作0`);
      for (const candidate of selected)
        addEvidence({
          path: candidate.path,
          label: "计入" + (expr.op === "count" ? "数量" : "聚合"),
          value: candidate.key,
        });
      if (expr.op === "count") return known(selected.length, `${scope}＝${selected.length}`);
      const values = selected.map((candidate) => field(expr.field, candidate));
      if (values.some((value) => typeof value.value !== "number"))
        return missing(`${scope}；${RULE_FIELDS[expr.field].label}缺失，无法完成聚合`);
      const numbers = values.map((value) => value.value as number);
      if (!numbers.length && expr.op !== "sum") return missing(`${scope}；空集合没有最大或最小值`);
      const total =
        expr.op === "sum"
          ? numbers.reduce((a, b) => a + b, 0)
          : expr.op === "min"
            ? Math.min(...numbers)
            : Math.max(...numbers);
      return Number.isFinite(total)
        ? known(total, `${describeRule(expr)}=${total}`)
        : missing("聚合结果超出有效数值范围");
    }
    if (!("args" in expr)) return missing("不支持的规则节点");
    const args = expr.args.map((arg) => evaluate(arg, item));
    const operatorLabel = {
      add: "+",
      subtract: "−",
      multiply: "×",
      divide: "÷",
      eq: "=",
      ne: "≠",
      gt: ">",
      gte: "≥",
      lt: "<",
      lte: "≤",
      contains: "包含",
      and: "且",
      or: "或",
      not: "非",
    }[expr.op];
    const trace = args.map((arg) => arg.trace).join(` ${operatorLabel} `);
    if (expr.op === "and" || expr.op === "or") {
      const decisive = expr.op === "and" ? false : true;
      if (args.some((arg) => arg.value === decisive)) return known(decisive, trace);
      if (args.some((arg) => typeof arg.value !== "boolean")) return missing(trace);
      return known(!decisive, trace);
    }
    if (expr.op === "not")
      return typeof args[0].value === "boolean"
        ? known(!args[0].value, `非(${args[0].trace})`)
        : missing(trace);
    const [left, right] = args;
    if (left.value === undefined || right.value === undefined) return missing(trace);
    if (expr.op === "contains") {
      const value = Array.isArray(left.value)
        ? left.value.includes(String(right.value))
        : typeof left.value === "string" && left.value.includes(String(right.value));
      return known(value, trace);
    }
    const money = left.money || right.money;
    if (["add", "subtract", "multiply", "divide"].includes(expr.op)) {
      if (
        typeof left.value !== "number" ||
        typeof right.value !== "number" ||
        (expr.op === "divide" && right.value === 0)
      )
        return missing(`${trace}；无效算术或除零`);
      const value =
        expr.op === "add"
          ? left.value + right.value
          : expr.op === "subtract"
            ? left.value - right.value
            : expr.op === "multiply"
              ? left.value * right.value
              : left.value / right.value;
      return Number.isFinite(value) && Math.abs(value) <= 1e15
        ? known(value, `${trace}=${value}`, money)
        : missing("算术结果超出有效数值范围");
    }
    const l = money && typeof left.value === "number" ? Math.round(left.value * 100) : left.value;
    const r =
      money && typeof right.value === "number" ? Math.round(right.value * 100) : right.value;
    const result =
      expr.op === "eq"
        ? l === r
        : expr.op === "ne"
          ? l !== r
          : typeof l !== "number" || typeof r !== "number"
            ? undefined
            : expr.op === "gt"
              ? l > r
              : expr.op === "gte"
                ? l >= r
                : expr.op === "lt"
                  ? l < r
                  : l <= r;
    return result === undefined
      ? missing(trace)
      : known(result, `${trace} ⇒ ${result ? "成立" : "不成立"}${money ? "（金额按分比较）" : ""}`);
  }
  try {
    const result = evaluate(rule.expression);
    return {
      status: result.value === true ? "met" : result.value === false ? "unmet" : "unknown",
      reason: result.trace.slice(0, 1900),
      evidence,
    };
  } catch {
    return { status: "unknown", reason: "采集资料格式不完整，无法可靠执行本条规则", evidence };
  }
}
