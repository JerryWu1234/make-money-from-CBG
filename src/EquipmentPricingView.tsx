import type { EquipmentPricingSnapshot } from "../server/analysis/equipment-pricing";
import { valuationMoney } from "./ValuationResultView";

const statusLabels = {
  priced: "已核实挂牌参考价",
  no_match: "未找到可靠报价",
  incomplete: "装备资料待补采",
  untradable: "不可交易，未计挂牌参考价",
};
const readTime = (value: string | null) =>
  value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN") : "未读取";
const safeLink = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

export function EquipmentPricingView({ snapshot }: { snapshot: EquipmentPricingSnapshot }) {
  const outdated = Date.now() - Date.parse(snapshot.searchedAt) >= 24 * 60 * 60 * 1000;
  return (
    <section aria-label="装备联网查价">
      <h3>装备联网查价</h3>
      <p>相近商品的网页挂牌参考价，不代表实际成交价。</p>
      <p>搜索时间：{readTime(snapshot.searchedAt)}</p>
      {outdated && (
        <p className="analysis-pending-note">
          这是超过24小时的历史报价。请开始新批次重新查价；继续旧批次保留当时快照。
        </p>
      )}
      <p>
        {snapshot.total !== null ? "装备参考价合计：" : "已核实装备小计（非完整总价）："}
        {valuationMoney(snapshot.total ?? snapshot.knownTotal)}
      </p>
      {!snapshot.captureComplete && (
        <p className="analysis-pending-note">装备资料尚未完整，未采到的部分不会按0计价。</p>
      )}
      {!!snapshot.queries.length && (
        <details>
          <summary>查看搜索关键词</summary>
          <ul>
            {snapshot.queries.map((query, index) => (
              <li key={index}>{query}</li>
            ))}
          </ul>
        </details>
      )}
      {!!snapshot.issues.length && (
        <ul>
          {snapshot.issues.map((issue, index) => (
            <li key={index}>{issue}</li>
          ))}
        </ul>
      )}
      {snapshot.items.map((item) => (
        <section key={item.key} className="analysis-evidence-card">
          <header>
            <strong>
              {item.name}
              {item.level !== null ? ` · ${item.level}级` : ""}
            </strong>
            <span>
              {item.status === "priced"
                ? valuationMoney(item.referencePrice)
                : statusLabels[item.status]}
            </span>
          </header>
          <p>{statusLabels[item.status]}</p>
          <p>
            已核实挂牌样本：{item.candidates.filter((candidate) => candidate.verified).length}条。
          </p>
          {item.status === "priced" &&
            item.candidates.filter((candidate) => candidate.verified).length === 1 && (
              <p className="analysis-pending-note">仅1条挂牌样本，参考范围有限。</p>
            )}
          <p>
            {item.category} · {item.description}
          </p>
          <p>搜索关键词：{item.query || "资料不足，未发起查价"}</p>
          {!!item.issues.length && (
            <ul>
              {item.issues.map((issue, index) => (
                <li key={index}>{issue}</li>
              ))}
            </ul>
          )}
          {item.candidates.map((candidate, index) => {
            const link = safeLink(candidate.url);
            return (
              <details key={index}>
                <summary>
                  {candidate.title} · {candidate.verified ? "已核实" : "未采用"}
                </summary>
                <p className="analysis-detail-links">
                  {link ? (
                    <a href={link} target="_blank" rel="noreferrer">
                      打开来源网页
                    </a>
                  ) : (
                    "来源链接无效"
                  )}
                  {" · "}
                  {candidate.priceType === "listing" ? "网页挂牌价" : "价格类型未确认"}：
                  {valuationMoney(candidate.price)}
                </p>
                <p>读取时间：{readTime(candidate.fetchedAt)}</p>
                <p>核实说明：{candidate.reason}</p>
                {!!candidate.differences?.length && (
                  <div>
                    <p>样本配置差异（未据此折价）：</p>
                    <ul>
                      {candidate.differences.map((difference, differenceIndex) => (
                        <li key={differenceIndex}>{difference}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <pre>{candidate.quote}</pre>
              </details>
            );
          })}
        </section>
      ))}
      {snapshot.rawResponse && (
        <details>
          <summary>查看完整搜索回复</summary>
          <pre>{snapshot.rawResponse}</pre>
        </details>
      )}
    </section>
  );
}
