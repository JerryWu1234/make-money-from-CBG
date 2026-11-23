/** Safe rule data shared by the settings editor, compiler and evaluator. */
export const RULE_ENGINE_VERSION = "condition-rules-v1";
export type RuleCollection = "equipment" | "jewelry" | "petEquipment" | "pets";
export type RuleValue = number | string | boolean;
export type RuleOperator =
  | "add"
  | "subtract"
  | "multiply"
  | "divide"
  | "eq"
  | "ne"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "and"
  | "or"
  | "not";
export type RuleExpression =
  | { op: "literal"; value: RuleValue }
  | { op: "field"; path: string }
  | { op: "count"; collections: RuleCollection[]; where?: RuleExpression }
  | { op: "sum" | "min" | "max"; collection: RuleCollection; field: string; where?: RuleExpression }
  | { op: RuleOperator; args: RuleExpression[] };
export type CompiledConditionRule = {
  version: typeof RULE_ENGINE_VERSION;
  sourceText: string;
  status: "ready" | "ambiguous" | "unsupported";
  expression?: RuleExpression;
  explanation: string;
  issues: string[];
};
export const RULE_COLLECTION_LABELS: Record<RuleCollection, string> = {
  equipment: "人物装备",
  jewelry: "灵饰",
  petEquipment: "宝宝装备（不含饰品）",
  pets: "召唤兽（含0级和野生）",
};
type RuleFieldType = "number" | "string" | "boolean" | "strings";
export type RuleFieldDefinition = {
  label: string;
  type: RuleFieldType;
  collections?: RuleCollection[];
};
const gear: RuleCollection[] = ["equipment", "jewelry", "petEquipment"];
const all: RuleCollection[] = [...gear, "pets"];
export const RULE_FIELDS: Record<string, RuleFieldDefinition> = {
  "listing.price": { label: "挂牌价（元）", type: "number" },
  "listing.serverId": { label: "服务器ID", type: "string" },
  "listing.serverName": { label: "服务器名称", type: "string" },
  "valuation.bare": { label: "裸号估值（元）", type: "number" },
  "role.level": { label: "人物等级", type: "number" },
  "role.school": { label: "人物门派", type: "string" },
  "role.speed": { label: "人物速度", type: "number" },
  "role.hp": { label: "人物气血", type: "number" },
  "role.damage": { label: "人物伤害", type: "number" },
  "role.defense": { label: "人物防御", type: "number" },
  "role.magicDamage": { label: "人物法术伤害", type: "number" },
  "item.level": { label: "单件等级", type: "number", collections: all },
  "item.name": { label: "单件名称", type: "string", collections: all },
  "item.category": { label: "单件类别", type: "string", collections: all },
  "item.skills": { label: "召唤兽当前技能", type: "strings", collections: ["pets"] },
  "item.skillCount": { label: "召唤兽当前技能数", type: "number", collections: ["pets"] },
  "item.growth": { label: "召唤兽成长", type: "number", collections: ["pets"] },
  "item.isBaby": { label: "召唤兽是否宝宝", type: "boolean", collections: ["pets"] },
  "item.gemLevel": { label: "宝石锻炼等级", type: "number", collections: ["equipment"] },
  "item.refineLevel": { label: "灵饰精炼等级", type: "number", collections: ["jewelry"] },
  "item.damage": { label: "装备伤害", type: "number", collections: gear },
  "item.defense": { label: "装备防御", type: "number", collections: gear },
  "item.speed": { label: "装备速度", type: "number", collections: gear },
  "item.hp": { label: "装备气血", type: "number", collections: gear },
};
const operations = new Set([
  "add",
  "subtract",
  "multiply",
  "divide",
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "and",
  "or",
  "not",
]);
const collectionNames = Object.keys(RULE_COLLECTION_LABELS);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("规则节点必须是对象");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error("规则包含未支持的字段");
}
/** No arbitrary property paths, executable code, unknown operators or coercions. */
export function normalizeRuleExpression(raw: unknown): RuleExpression {
  let count = 0;
  function visit(
    raw: unknown,
    depth: number,
    scope?: RuleCollection[],
  ): { expr: RuleExpression; type: RuleFieldType } {
    if (++count > 120 || depth > 12) throw new Error("规则最多120个节点、12层");
    const node = object(raw);
    if (node.op === "literal") {
      keys(node, ["op", "value"]);
      if (
        (typeof node.value !== "number" &&
          typeof node.value !== "string" &&
          typeof node.value !== "boolean") ||
        (typeof node.value === "number" &&
          (!Number.isFinite(node.value) || Math.abs(node.value) > 1e12)) ||
        (typeof node.value === "string" && node.value.length > 500)
      )
        throw new Error("规则常量无效");
      return {
        expr: { op: "literal", value: node.value },
        type: typeof node.value as RuleFieldType,
      };
    }
    if (node.op === "field") {
      keys(node, ["op", "path"]);
      if (typeof node.path !== "string" || !Object.hasOwn(RULE_FIELDS, node.path))
        throw new Error("规则引用了未支持的字段");
      const field = RULE_FIELDS[node.path];
      if (
        field.collections &&
        (!scope || scope.some((collection) => !field.collections!.includes(collection)))
      )
        throw new Error("规则字段不适用于当前集合");
      return { expr: { op: "field", path: node.path }, type: field.type };
    }
    if (node.op === "count") {
      keys(node, ["op", "collections", "where"]);
      if (
        !Array.isArray(node.collections) ||
        !node.collections.length ||
        node.collections.length > 4 ||
        node.collections.some(
          (value) => typeof value !== "string" || !collectionNames.includes(value),
        ) ||
        new Set(node.collections).size !== node.collections.length
      )
        throw new Error("计数集合无效或重复");
      const collections = [...(node.collections as RuleCollection[])].sort(
        (a, b) => collectionNames.indexOf(a) - collectionNames.indexOf(b),
      );
      const where =
        node.where === undefined ? undefined : visit(node.where, depth + 1, collections);
      if (where && where.type !== "boolean") throw new Error("筛选条件必须返回布尔值");
      return {
        expr: { op: "count", collections, ...(where ? { where: where.expr } : {}) },
        type: "number",
      };
    }
    if (["sum", "min", "max"].includes(String(node.op))) {
      keys(node, ["op", "collection", "field", "where"]);
      if (typeof node.collection !== "string" || !collectionNames.includes(node.collection))
        throw new Error("聚合集合无效");
      const collection = node.collection as RuleCollection;
      if (
        typeof node.field !== "string" ||
        !Object.hasOwn(RULE_FIELDS, node.field) ||
        RULE_FIELDS[node.field].type !== "number" ||
        !RULE_FIELDS[node.field].collections?.includes(collection)
      )
        throw new Error("聚合字段须为集合中的数值字段");
      const where =
        node.where === undefined ? undefined : visit(node.where, depth + 1, [collection]);
      if (where && where.type !== "boolean") throw new Error("筛选条件必须返回布尔值");
      return {
        expr: {
          op: node.op as "sum" | "min" | "max",
          collection,
          field: node.field,
          ...(where ? { where: where.expr } : {}),
        },
        type: "number",
      };
    }
    keys(node, ["op", "args"]);
    if (typeof node.op !== "string" || !operations.has(node.op) || !Array.isArray(node.args))
      throw new Error("规则操作符无效");
    const op = node.op as RuleOperator;
    const args = node.args.map((arg) => visit(arg, depth + 1, scope));
    if (op === "and" || op === "or") {
      if (args.length < 2 || args.length > 20 || args.some((arg) => arg.type !== "boolean"))
        throw new Error("且或操作需要2至20个布尔条件");
    } else if (op === "not") {
      if (args.length !== 1 || args[0].type !== "boolean")
        throw new Error("非操作需要一个布尔条件");
    } else {
      if (args.length !== 2) throw new Error("比较或运算需要两个参数");
      if (
        ["add", "subtract", "multiply", "divide", "gt", "gte", "lt", "lte"].includes(op) &&
        args.some((arg) => arg.type !== "number")
      )
        throw new Error("此运算仅支持数值");
      if (
        (op === "eq" || op === "ne") &&
        (args[0].type !== args[1].type || args[0].type === "strings")
      )
        throw new Error("等值比较的类型须一致");
      if (
        op === "contains" &&
        (!["string", "strings"].includes(args[0].type) || args[1].type !== "string")
      )
        throw new Error("包含运算需要文本或文本列表与文本");
    }
    const arithmetic = ["add", "subtract", "multiply", "divide"].includes(op);
    return {
      expr: { op, args: args.map((arg) => arg.expr) },
      type: arithmetic ? "number" : "boolean",
    };
  }
  const result = visit(raw, 1);
  if (result.type !== "boolean") throw new Error("完整规则必须返回布尔值");
  return result.expr;
}
export function normalizeCompiledRule(raw: unknown, sourceText: string): CompiledConditionRule {
  const rule = object(raw);
  keys(rule, ["version", "sourceText", "status", "expression", "explanation", "issues"]);
  if (
    rule.version !== RULE_ENGINE_VERSION ||
    rule.sourceText !== sourceText ||
    !["ready", "ambiguous", "unsupported"].includes(String(rule.status)) ||
    typeof rule.explanation !== "string" ||
    !rule.explanation.trim() ||
    rule.explanation.length > 2000 ||
    !Array.isArray(rule.issues) ||
    rule.issues.length > 20 ||
    rule.issues.some((issue) => typeof issue !== "string" || !issue.trim() || issue.length > 500)
  )
    throw new Error("条件规则版本、原文或说明无效");
  if (rule.status === "ready" && rule.issues.length)
    throw new Error("可执行规则不能有未解决的问题");
  if (rule.status !== "ready" && (!rule.issues.length || rule.expression !== undefined))
    throw new Error("未就绪规则须说明问题，不能包含可执行表达式");
  const expression = rule.status === "ready" ? normalizeRuleExpression(rule.expression) : undefined;
  function referenced(expr: RuleExpression): boolean {
    if (expr.op === "literal") return false;
    return "args" in expr ? expr.args.some(referenced) : true;
  }
  if (expression && !referenced(expression))
    throw new Error("规则必须引用采集字段或集合，不能是常量结论");
  return {
    version: RULE_ENGINE_VERSION,
    sourceText,
    status: rule.status as CompiledConditionRule["status"],
    ...(expression ? { expression } : {}),
    explanation: expression ? describeRule(expression) : rule.explanation.trim(),
    issues: rule.issues as string[],
  };
}
const opLabel: Record<RuleOperator, string> = {
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
};
export function describeRule(expr: RuleExpression): string {
  if (expr.op === "literal")
    return typeof expr.value === "string" ? `“${expr.value}”` : String(expr.value);
  if (expr.op === "field") return RULE_FIELDS[expr.path]?.label || expr.path;
  if (expr.op === "count")
    return `计数(${expr.collections.map((key) => RULE_COLLECTION_LABELS[key]).join("＋")}${expr.where ? `；筛选：${describeRule(expr.where)}` : ""})`;
  if (expr.op === "sum" || expr.op === "min" || expr.op === "max")
    return `${{ sum: "求和", min: "最小值", max: "最大值" }[expr.op]}(${RULE_COLLECTION_LABELS[expr.collection]}；${RULE_FIELDS[expr.field].label}${expr.where ? `；筛选：${describeRule(expr.where)}` : ""})`;
  if (!("args" in expr)) throw new Error("不支持的规则节点");
  return `(${expr.args.map(describeRule).join(` ${opLabel[expr.op]} `)}${expr.op === "not" ? " 取反" : ""})`;
}
