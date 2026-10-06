import type { Decision, ValuationResult } from "../server/analysis/valuation-types";
import { EquipmentPricingView } from "./EquipmentPricingView";
export const decisionLabels: Record<Decision, string> = {
  BUY: "建议买入",
  WATCH: "等降价再买",
  PASS: "不建议买入",
  NEED_INFO: "暂不建议买入",
  OUT_OF_SCOPE: "不适用估值规则",
};
const comparisonLabels: Record<Decision, string> = {
  BUY: "挂牌低于估值",
  WATCH: "挂牌等于估值",
  PASS: "挂牌高于估值",
  NEED_INFO: "暂无法比较",
  OUT_OF_SCOPE: "不适用估值规则",
};
export const valuationDecisionLabel = (result: ValuationResult) => {
  if (result.estimated_comparison)
    return { below: "挂牌低于参考区间", within: "挂牌在参考区间内", above: "挂牌高于参考区间" }[
      result.estimated_comparison
    ];
  return (result.comparison_mode === "listing-only" ? comparisonLabels : decisionLabels)[
    result.decision
  ];
};
export const valuationMoney = (value: number | null | undefined) =>
  value == null
    ? "暂无法计算"
    : "¥" + value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function valuationPriceSummary(result: ValuationResult) {
  if (result.model_value != null)
    return {
      label: result.pet_pricing
        ? "裸号、装备和宝宝参考估值"
        : result.equipment_pricing
          ? "裸号及已核实装备参考估值"
          : "裸号参考估值",
      value: result.model_value,
    };
  if (result.estimated_value_range)
    return {
      label: result.estimated_sources?.includes("baseline")
        ? "完整参考估值区间（含默认参考价）"
        : "完整参考估值区间",
      value: null,
      range: result.estimated_value_range,
    };
  if (result.estimated_subtotal_range)
    return {
      label: result.estimated_sources?.includes("baseline")
        ? "部分参考价区间（含默认参考价，仍有缺项）"
        : "部分参考价区间（仍有缺项）",
      value: null,
      range: result.estimated_subtotal_range,
    };
  if ((result.equipment_pricing || result.pet_pricing) && result.known_subtotal > 0)
    return { label: "已算部分（非完整估值）", value: result.known_subtotal };
  if (result.bare_role_value != null)
    return {
      label: result.pet_pricing ? "裸号参考估值（附带资产待补齐）" : "裸号参考估值（装备待补齐）",
      value: result.bare_role_value,
    };
  if (result.body_value != null)
    return { label: "裸号本体（未做区服调整）", value: result.body_value };
  if (result.items.length) return { label: "已算部分（非完整估值）", value: result.known_subtotal };
  return { label: "关键资料不足", value: null };
}
export const valuationRangeMoney = (range: { min: number; max: number }) =>
  valuationMoney(range.min) + "—" + valuationMoney(range.max);
export const valuationSummaryText = (result: ValuationResult) => {
  const summary = valuationPriceSummary(result);
  return summary.range ? valuationRangeMoney(summary.range) : valuationMoney(summary.value);
};
export function ValuationResultView({
  result,
  onConfigure,
  previousSettings = false,
}: {
  result: ValuationResult;
  onConfigure?: () => void;
  previousSettings?: boolean;
}) {
  const amount = valuationPriceSummary(result);
  const hasBaseline =
    result.items.some((item) => item.referenceBasis) ||
    result.equipment_pricing?.items.some((item) => item.baselineEstimate);
  const comparison = result.comparison_mode === "listing-only";
  const metrics: [string, number][] = [];
  if (amount.value !== null) metrics.push([amount.label, amount.value]);
  if (result.asking_price !== null) metrics.push(["采集时挂牌价", result.asking_price]);
  if (comparison) {
    if (result.equipment_pricing && result.bare_role_value != null)
      metrics.push(["裸号参考估值", result.bare_role_value]);
    if (result.equipment_value != null) metrics.push(["装备挂牌参考价", result.equipment_value]);
    if (result.pet_value != null) metrics.push(["宝宝挂牌参考价", result.pet_value]);
    if (result.price_difference != null)
      metrics.push(["估值与挂牌价差额", result.price_difference]);
  } else {
    if (result.max_listing_price !== null)
      metrics.push(["建议最高买入价", result.max_listing_price]);
    if (result.max_listing_price === null && result.max_total_cost != null)
      metrics.push(["建议最高总成本（含费用）", result.max_total_cost]);
    if (result.ideal_listing_price !== null)
      metrics.push(["理想买入价", result.ideal_listing_price]);
    if (result.total_cost !== null) metrics.push(["购买总成本", result.total_cost]);
  }
  const suggestions = result.suggestions || [];
  return (
    <section className="analysis-valuation-result">
      {previousSettings && (
        <p role="status" className="analysis-pending-note">
          这是旧设置下的结果。估值规则已更新，请按新规则开始分析。
        </p>
      )}
      <div className={"analysis-detail-score analysis-valuation-decision-" + result.decision}>
        <small>{comparison ? "估值与挂牌价比较" : "裸号买入建议"}</small>
        <strong>{valuationDecisionLabel(result)}</strong>
        <p>{result.reason}</p>
      </div>
      <div className="analysis-valuation-metrics">
        {amount.range && (
          <div>
            <small>{amount.label}</small>
            <strong>{valuationRangeMoney(amount.range)}</strong>
          </div>
        )}
        {result.estimated_price_difference && (
          <div>
            <small>估值区间与挂牌差额</small>
            <strong>{valuationRangeMoney(result.estimated_price_difference)}</strong>
          </div>
        )}
        {metrics.map(([name, value]) => (
          <div key={String(name)}>
            <small>{name}</small>
            <strong>{valuationMoney(value)}</strong>
          </div>
        ))}
        {comparison && result.price_difference_ratio != null && (
          <div>
            <small>差异比例（以挂牌价为基准）</small>
            <strong>{(result.price_difference_ratio * 100).toFixed(2) + "%"}</strong>
          </div>
        )}
        {!comparison && result.margin_of_safety !== null && (
          <div>
            <small>相对估值安全边际</small>
            <strong>{(result.margin_of_safety * 100).toFixed(2) + "%"}</strong>
          </div>
        )}
      </div>
      <p>
        {comparison
          ? result.price_comparison_scope || "裸号参考估值，附带资产需另行核实"
          : "按裸号规则估值，装备、灵饰、召唤兽个体和锦衣未计价。"}
      </p>
      {comparison && <p>差额为正表示估值高于挂牌价，为负表示挂牌价更高。</p>}
      {amount.range && result.estimated_sources?.includes("baseline") && (
        <p className="analysis-pending-note">
          {result.estimated_sources.includes("similar")
            ? "参考区间包含相近配置挂牌样本和普通装备默认参考价；"
            : "参考金额包含普通装备默认参考价；"}
          默认价来自历史资料或人工预设，未实时核实藏宝阁报价，不能视为精确成交价值。
        </p>
      )}
      {result.estimated_value_range && !result.estimated_sources?.includes("baseline") && (
        <p className="analysis-pending-note">
          这是基于相近配置挂牌样本的完整参考区间，配置差异已列明，不能视为精确成交价值。
        </p>
      )}
      {result.model_value === null && !result.estimated_value_range && (
        <p className="analysis-pending-note">
          当前金额是已算部分。请按下面的具体缺项补齐资料或定价规则，
          {comparison ? "再比较挂牌差异。" : "再判断买入上限。"}
        </p>
      )}
      {!!suggestions.length && (
        <section>
          <h3>建议怎么补齐</h3>
          <ul>
            {suggestions.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
        </section>
      )}
      {onConfigure &&
        ((result.decision === "NEED_INFO" && !result.estimated_value_range) ||
          previousSettings) && (
          <button
            type="button"
            className="analysis-button analysis-button-outline"
            onClick={onConfigure}
          >
            去补充分析设置
          </button>
        )}
      {!!(result.pending_rules.length || result.missing_fields.length) && (
        <details>
          <summary>
            {result.estimated_value_range ? "查看未取得精确报价的项目" : "查看未补齐的项目与原因"}
          </summary>
          {!!result.pending_rules.length && (
            <section>
              <h3>未设置的计价方式</h3>
              <ul>
                {result.pending_rules.map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            </section>
          )}
          {!!result.missing_fields.length && (
            <section>
              <h3>未补齐的项目与原因</h3>
              <ul>
                {result.missing_fields.map((value) => (
                  <li key={value}>{value}</li>
                ))}
              </ul>
            </section>
          )}
        </details>
      )}
      {!suggestions.length && result.next_action && (
        <p className="analysis-pending-note">
          <strong>建议：</strong>
          {result.next_action}
        </p>
      )}
      {result.ai_explanation && (
        <section>
          <h3>AI 核对说明</h3>
          <p>{result.ai_explanation}</p>
        </section>
      )}
      {result.equipment_pricing && <EquipmentPricingView snapshot={result.equipment_pricing} />}
      {result.pet_pricing && <EquipmentPricingView snapshot={result.pet_pricing} asset="宝宝" />}
      <h3>估值明细</h3>
      <p>
        已核算分项小计：{valuationMoney(result.known_subtotal)}
        {hasBaseline
          ? "。已核算小计不含另列默认参考价或相近区间；未完成的项目仍需补齐。"
          : "。小计包含已识别项目，未完成的项目仍需补齐。"}
      </p>
      {result.items.map((item) => (
        <section key={item.name} className="analysis-evidence-card">
          <header>
            <strong>{item.name}</strong>
            <span>
              {item.referenceBasis === "excluded"
                ? "低值未计入"
                : item.referenceBasis === "baseline"
                  ? item.amount === null
                    ? "默认价或金价待补"
                    : "默认参考 " + valuationMoney(item.amount)
                  : item.amount === null
                    ? "缺资料或计价设置"
                    : valuationMoney(item.amount)}
            </span>
          </header>
          <p>输入：{item.input}</p>
          <p>{item.formula}</p>
          {item.evidence.map((proof, index) => (
            <details key={index}>
              <summary>{proof.reason}</summary>
              <code>{proof.path}</code>
              <pre>{proof.value}</pre>
            </details>
          ))}
        </section>
      ))}
    </section>
  );
}
