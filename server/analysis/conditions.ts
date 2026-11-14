import {
  normalizeCompiledRule,
  RULE_ENGINE_VERSION,
  type CompiledConditionRule,
} from "./condition-rule-types";

export type ConditionOperator = "and" | "or";
export type PriceCondition = {
  comparison: "none" | "eq" | "lt" | "lte" | "gt" | "gte";
  adjustment: "none" | "minus" | "plus";
  unit: "amount" | "percent";
  value: number;
};
export type Condition = {
  id: string;
  text: string;
  join?: ConditionOperator;
  price?: PriceCondition;
  rule?: CompiledConditionRule;
};
// Legacy trees remain readable in saved settings and historical results.
export type ConditionGroup = {
  id: string;
  operator: ConditionOperator;
  children: ConditionNode[];
  evaluation?: "sequence";
  join?: ConditionOperator;
};
export type ConditionNode = Condition | ConditionGroup;
export type ConditionResult = {
  id: string;
  status: "met" | "unmet" | "unknown";
  reason: string;
  skipped?: boolean;
  evidence?: import("./condition-rule-runtime").RuleEvidence[];
};
export type ConditionReview = {
  tree: ConditionGroup;
  results: ConditionResult[];
  engineVersion?: string;
};
export type ConditionPrices = { asking: number | null; bare: number | null };

export function defaultConditions(): ConditionGroup {
  return {
    id: "G1",
    operator: "and",
    evaluation: "sequence",
    children: [
      {
        id: "C1",
        text: "",
        price: { comparison: "none", adjustment: "none", unit: "amount", value: 0 },
      },
    ],
  };
}

export function conditionNodes(root: ConditionGroup): ConditionNode[] {
  return [
    root,
    ...root.children.flatMap((node) => ("children" in node ? conditionNodes(node) : [node])),
  ];
}

/** Conditions are evaluated locally; the valuation model never decides eligibility. */
export function aiConditionNodes(_root: ConditionGroup): ConditionNode[] {
  return [];
}

export function normalizeConditions(value: unknown): ConditionGroup | undefined {
  if (value == null) return undefined;
  const ids = new Set<string>();
  let count = 0;
  function visit(raw: unknown, depth: number): ConditionNode {
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || depth > 5 || ++count > 60)
      throw new Error("条件最多60项，旧版分组最多4层");
    const node = raw as Record<string, unknown>;
    if (
      typeof node.id !== "string" ||
      !/^[CG][a-zA-Z0-9-]{1,50}$/.test(node.id) ||
      ids.has(node.id)
    )
      throw new Error("条件编号无效或重复");
    ids.add(node.id);
    if (node.join !== undefined && node.join !== "and" && node.join !== "or")
      throw new Error(`${node.id} 须选择且或关系`);
    const join = node.join === undefined ? {} : { join: node.join as ConditionOperator };
    if ("children" in node) {
      if (depth > 4) throw new Error("条件分组最多4层");
      if (
        (node.operator !== "and" && node.operator !== "or") ||
        !Array.isArray(node.children) ||
        !node.children.length
      )
        throw new Error(`${node.id} 须至少有一条条件`);
      if (node.evaluation !== undefined && node.evaluation !== "sequence")
        throw new Error("条件计算方式无效");
      if (
        node.evaluation === "sequence" &&
        (depth !== 1 ||
          node.children.some((child) => child && typeof child === "object" && "children" in child))
      )
        throw new Error("条件列表不能嵌套条件组");
      const children = node.children.map((child) => visit(child, depth + 1));
      if (node.evaluation === "sequence" && children.slice(1).some((child) => !child.join))
        throw new Error("每条后续条件须选择且或关系");
      return {
        id: node.id,
        operator: node.operator,
        children,
        ...join,
        ...(node.evaluation === "sequence" ? { evaluation: "sequence" as const } : {}),
      };
    }
    if (node.price !== undefined) {
      if (!node.price || typeof node.price !== "object" || Array.isArray(node.price))
        throw new Error("价格条件无效");
      const p = node.price as Record<string, unknown>;
      if (
        !["none", "eq", "lt", "lte", "gt", "gte"].includes(String(p.comparison)) ||
        !["none", "minus", "plus"].includes(String(p.adjustment)) ||
        !["amount", "percent"].includes(String(p.unit)) ||
        typeof p.value !== "number" ||
        !Number.isFinite(p.value) ||
        p.value < 0 ||
        p.value > 1e9 ||
        (p.unit === "percent" && p.adjustment === "minus" && p.value > 100)
      )
        throw new Error(`${node.id} 价格条件数值无效；下浮百分比须在0至100之间`);
      return {
        id: node.id,
        text: "",
        ...join,
        price: {
          comparison: p.comparison as PriceCondition["comparison"],
          adjustment:
            p.comparison === "none" ? "none" : (p.adjustment as PriceCondition["adjustment"]),
          unit: p.comparison === "none" ? "amount" : (p.unit as PriceCondition["unit"]),
          value: p.comparison === "none" || p.adjustment === "none" ? 0 : p.value,
        },
      };
    }
    if (typeof node.text !== "string" || !node.text.trim() || node.text.length > 1000)
      throw new Error(`${node.id} 条件须填写1至1000字，不能只填空格`);
    const text = node.text.trim();
    return {
      id: node.id,
      text,
      ...join,
      ...(node.rule === undefined ? {} : { rule: normalizeCompiledRule(node.rule, text) }),
    };
  }
  const root = visit(value, 1);
  if (!("children" in root)) throw new Error("条件根节点必须是组");
  if (
    root.evaluation !== "sequence" &&
    conditionNodes(root).some((node) => !("children" in node) && node.price)
  )
    throw new Error("价格条件须使用单层条件列表");
  return root;
}

export const comparisonLabels = {
  none: "不限制",
  eq: "等于",
  lt: "小于",
  lte: "小于或等于",
  gt: "大于",
  gte: "大于或等于",
};
export function priceConditionLabel(price: PriceCondition) {
  if (price.comparison === "none") return "价格不限制";
  return `挂牌价${comparisonLabels[price.comparison]}裸号估值${
    price.adjustment === "none"
      ? ""
      : `${price.adjustment === "minus" ? "减去" : "加上"}${price.value}${price.unit === "percent" ? "%" : "元"}`
  }`;
}

export function conditionPrompt(_root?: ConditionGroup) {
  return "";
}

export function assertConditionsCompiled(root?: ConditionGroup) {
  if (!root) return;
  for (const node of conditionNodes(root)) {
    if (!("children" in node) && !node.price && !node.rule)
      throw new Error(`${node.id} 请先解析文字条件，再核对口径并保存`);
  }
}

export const CONDITION_RESULTS_SCHEMA = {
  type: "array",
  maxItems: 60,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "status", "reason"],
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["met", "unmet", "unknown"] },
      reason: { type: "string" },
    },
  },
};

function combine(
  left: ConditionResult["status"],
  right: ConditionResult["status"],
  operator: ConditionOperator,
): ConditionResult["status"] {
  if (operator === "and")
    return left === "unmet" || right === "unmet"
      ? "unmet"
      : left === "met" && right === "met"
        ? "met"
        : "unknown";
  return left === "met" || right === "met"
    ? "met"
    : left === "unmet" && right === "unmet"
      ? "unmet"
      : "unknown";
}

export function evaluateConditions(
  tree: ConditionGroup,
  _evidence: ConditionResult[] = [],
  prices?: ConditionPrices,
  resolve?: (condition: Condition) => ConditionResult,
): ConditionReview {
  const results: ConditionResult[] = [];
  function visit(node: ConditionNode): ConditionResult {
    let result: ConditionResult;
    if ("children" in node) {
      const children = node.children.map((child) => ({ node: child, result: visit(child) }));
      const active = children.filter((child) => !child.result.skipped);
      const skipped = children.length > 0 && !active.length;
      const status = active
        .slice(1)
        .reduce(
          (status, child) =>
            combine(
              status,
              child.result.status,
              node.evaluation === "sequence" ? child.node.join! : node.operator,
            ),
          active[0]?.result.status ?? (skipped ? "met" : "unknown"),
        );
      result = {
        id: node.id,
        status,
        ...(skipped ? { skipped: true } : {}),
        reason: !children.length
          ? "条件列表为空，无法判断"
          : skipped
            ? "价格不限制，没有启用需要判断的条件"
            : node.evaluation === "sequence"
              ? "按列表从上到下依次计算且／或；仅最终满足时入榜。"
              : "按保存的且／或关系计算。",
      };
    } else if (node.price?.comparison === "none") {
      result = {
        id: node.id,
        status: "met",
        skipped: true,
        reason: "价格不限制，此条不参与且／或运算；其他条件按原关系计算",
      };
    } else if (node.price) {
      const asking = prices?.asking,
        bare = prices?.bare;
      if (
        typeof asking !== "number" ||
        !Number.isFinite(asking) ||
        asking <= 0 ||
        typeof bare !== "number" ||
        !Number.isFinite(bare) ||
        bare < 0
      ) {
        result = { id: node.id, status: "unknown", reason: "缺少有效挂牌价或裸号估值" };
      } else {
        const p = node.price;
        const offset =
          p.adjustment === "none" ? 0 : p.unit === "percent" ? (bare * p.value) / 100 : p.value;
        const target = Math.round((bare + (p.adjustment === "minus" ? -offset : offset)) * 100);
        const actual = Math.round(asking * 100);
        const met =
          p.comparison === "eq"
            ? actual === target
            : p.comparison === "lt"
              ? actual < target
              : p.comparison === "lte"
                ? actual <= target
                : p.comparison === "gt"
                  ? actual > target
                  : actual >= target;
        result = {
          id: node.id,
          status: met ? "met" : "unmet",
          reason: `${priceConditionLabel(p)}：挂牌价${asking.toFixed(2)}元，裸号估值${bare.toFixed(2)}元，比较目标${(target / 100).toFixed(2)}元（按分比较）`,
        };
      }
    } else
      result = resolve?.(node) || {
        id: node.id,
        status: "unknown",
        reason: "文字条件须先解析为可执行规则，旧AI满足状态不作为入榜依据",
      };
    results.push(result);
    return result;
  }
  visit(tree);
  return { tree, results, engineVersion: RULE_ENGINE_VERSION };
}

/** Legacy AI condition_results are retained in raw attempts only, never trusted. */
export function validateConditionResults(
  _raw: unknown,
  tree?: ConditionGroup,
  prices?: ConditionPrices,
  resolve?: (condition: Condition) => ConditionResult,
): ConditionReview | undefined {
  return tree ? evaluateConditions(tree, [], prices, resolve) : undefined;
}
