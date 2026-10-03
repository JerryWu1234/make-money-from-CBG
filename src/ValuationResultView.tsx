import type { Decision, ValuationResult } from "../server/analysis/valuation-types";
export const decisionLabels: Record<Decision, string> = {
  BUY: "建议买入",
  WATCH: "等降价再买",
  PASS: "不建议买入",
  NEED_INFO: "暂不建议买入",
  OUT_OF_SCOPE: "不适用估值规则",
};
export const valuationMoney = (value: number | null | undefined) =>
  value == null
    ? "暂无法计算"
    : "¥" + value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function valuationPriceSummary(result: ValuationResult) {
  if (result.model_value != null) return { label: "裸号参考估值", value: result.model_value };
  if (result.body_value != null)
    return { label: "裸号本体（未做区服调整）", value: result.body_value };
  if (result.items.length) return { label: "已算部分（非完整估值）", value: result.known_subtotal };
  return { label: "关键资料不足", value: null };
}
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
  const metrics: [string, number][] = [];
  if (amount.value !== null) metrics.push([amount.label, amount.value]);
  if (result.asking_price !== null) metrics.push(["当前挂牌价", result.asking_price]);
  if (result.max_listing_price !== null) metrics.push(["建议最高买入价", result.max_listing_price]);
  if (result.max_listing_price === null && result.max_total_cost != null)
    metrics.push(["建议最高总成本（含费用）", result.max_total_cost]);
  if (result.ideal_listing_price !== null) metrics.push(["理想买入价", result.ideal_listing_price]);
  if (result.total_cost !== null) metrics.push(["购买总成本", result.total_cost]);
  const suggestions = result.suggestions || [];
  return (
    <section className="analysis-valuation-result">
      {previousSettings && (
        <p role="status" className="analysis-pending-note">
          这是旧设置下的结果。估值规则已更新，请按新规则开始分析。
        </p>
      )}
      <div className={"analysis-detail-score analysis-valuation-decision-" + result.decision}>
        <small>裸号买入建议</small>
        <strong>{decisionLabels[result.decision]}</strong>
        <p>{result.reason}</p>
      </div>
      <div className="analysis-valuation-metrics">
        {metrics.map(([name, value]) => (
          <div key={String(name)}>
            <small>{name}</small>
            <strong>{valuationMoney(value)}</strong>
          </div>
        ))}
        {result.margin_of_safety !== null && (
          <div>
            <small>相对估值安全边际</small>
            <strong>{(result.margin_of_safety * 100).toFixed(2) + "%"}</strong>
          </div>
        )}
      </div>
      <p>按裸号规则估值，装备、灵饰、召唤兽个体和锦衣未计价。</p>
      {result.model_value === null && (
        <p className="analysis-pending-note">
          当前金额是已算部分。请按下面的具体缺项补齐资料或定价规则，再判断买入上限。
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
      {onConfigure && (result.decision === "NEED_INFO" || previousSettings) && (
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
          <summary>查看缺少的资料和未设置的规则</summary>
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
              <h3>缺少的资料</h3>
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
      <h3>估值明细</h3>
      <p>
        已核算分项小计：{valuationMoney(result.known_subtotal)}
        。小计包含已识别项目，未完成的项目仍需补齐。
      </p>
      {result.items.map((item) => (
        <section key={item.name} className="analysis-evidence-card">
          <header>
            <strong>{item.name}</strong>
            <span>{item.amount === null ? "缺资料或计价设置" : valuationMoney(item.amount)}</span>
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
