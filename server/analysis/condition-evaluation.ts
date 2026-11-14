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
        reason: "条件已更新，点击开始分析后查看判断结果",
      };
    try {
      return { id: node.id, ...evaluateCompiledRule(node.rule, record, prices) };
    } catch {
      return {
        id: node.id,
        status: "unknown",
        reason: "本条条件暂时无法判断，请重新开始分析",
      };
    }
  });
}
