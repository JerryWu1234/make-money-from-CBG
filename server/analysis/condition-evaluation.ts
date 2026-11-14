import type { SavedRoleRecord } from "../crawler/types";
import { evaluateConditions, type ConditionGroup, type ConditionPrices } from "./conditions";
import { evaluateCompiledRule } from "./condition-rule-runtime";

/** The caller supplies a source-bound record; UI and ranking share this exact evaluator. */
export function evaluateSavedConditions(
  tree: ConditionGroup,
  record: SavedRoleRecord,
  prices: ConditionPrices,
) {
  return evaluateConditions(tree, [], prices, (node) => {
    if (!node.rule || node.rule.sourceText !== node.text.trim())
      return {
        id: node.id,
        status: "unknown",
        reason: "条件未解析或文字已变化，请先解析并保存；不采用旧AI满足状态",
      };
    try {
      return { id: node.id, ...evaluateCompiledRule(node.rule, record, prices) };
    } catch {
      return {
        id: node.id,
        status: "unknown",
        reason: "条件规则无效，请重新解析；未将缺失或异常资料视为满足",
      };
    }
  });
}
