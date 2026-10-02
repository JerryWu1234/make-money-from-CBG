import type { Decision, ValuationResult } from "../server/analysis/valuation-types";
export const decisionLabels: Record<Decision, string> = {
  BUY: "符合购买条件",
  WATCH: "观察",
  PASS: "不符合价格条件",
  NEED_INFO: "待确认",
  OUT_OF_SCOPE: "不适用模型",
};
export const valuationMoney = (value: number | null | undefined) =>
  value == null
    ? "待确认"
    : "¥" + value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export function ValuationResultView({ result }: { result: ValuationResult }) {
  return (
    <section className="analysis-valuation-result">
      <div className="analysis-detail-score">
        <small>裸号估值结论</small>
        <strong>{decisionLabels[result.decision]}</strong>
        <p>{result.reason}</p>
      </div>
      <div className="analysis-valuation-metrics">
        {[
          ["模型估值", result.model_value],
          ["最高挂牌买入价", result.max_listing_price],
          ["理想挂牌买入价", result.ideal_listing_price],
          ["购买总成本", result.total_cost],
        ].map(([name, value]) => (
          <div key={String(name)}>
            <small>{name}</small>
            <strong>{valuationMoney(value as number | null)}</strong>
          </div>
        ))}
        <div>
          <small>相对估值安全边际</small>
          <strong>
            {result.margin_of_safety === null
              ? "待确认"
              : (result.margin_of_safety * 100).toFixed(2) + "%"}
          </strong>
        </div>
      </div>
      {!!result.pending_rules.length && (
        <section>
          <h3>待确认的计价口径</h3>
          <ul>
            {result.pending_rules.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
        </section>
      )}
      {!!result.missing_fields.length && (
        <section>
          <h3>缺少或未覆盖的资料</h3>
          <ul>
            {result.missing_fields.map((value) => (
              <li key={value}>{value}</li>
            ))}
          </ul>
        </section>
      )}
      {result.next_action && (
        <p className="analysis-pending-note">
          <strong>下一步：</strong>
          {result.next_action}
        </p>
      )}
      <h3>估值明细</h3>
      <p>
        已核算分项小计：{valuationMoney(result.known_subtotal)}
        。小计不含完整区服调整，存在待确认项时不代表完整估值。装备、灵饰、召唤兽个体及锦衣未纳入计价。
      </p>
      {result.items.map((item) => (
        <section key={item.name} className="analysis-evidence-card">
          <header>
            <strong>{item.name}</strong>
            <span>{valuationMoney(item.amount)}</span>
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
