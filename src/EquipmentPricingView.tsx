import type { EquipmentPricingSnapshot } from "../server/analysis/equipment-pricing";
import { valuationMoney, valuationRangeMoney } from "./ValuationResultView";

const statusLabels = {
  priced: "已核实挂牌参考价",
  no_match: "未找到可靠报价",
  incomplete: "装备资料待补采",
  untradable: "不可交易，未计挂牌参考价",
  unsupported: "资料已齐，需独立定价规则",
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

export function EquipmentPricingView({
  snapshot,
  asset = "装备",
  accounting,
}: {
  snapshot: EquipmentPricingSnapshot;
  asset?: "装备" | "宝宝" | "宝宝装备";
  accounting?: string;
}) {
  const label = (status: keyof typeof statusLabels) =>
    asset !== "装备" ? statusLabels[status].replaceAll("装备", asset) : statusLabels[status];
  const browserQuery = snapshot.provider === "browser";
  const queried = snapshot.queries.length > 0;
  const baselines = snapshot.items.flatMap((item) =>
    item.baselineEstimate && item.baselineInvalidReason === undefined
      ? [item.baselineEstimate]
      : [],
  );
  const hasBaseline = snapshot.items.some((item) => item.baselineEstimate);
  const hasBaseUpperBound = snapshot.items.some(
    (item) => item.comparisonPolicy === "base-upper-bound-v1",
  );
  const exactCount = snapshot.items.reduce(
    (sum, item) =>
      sum +
      item.candidates.filter(
        (candidate) =>
          candidate.verified &&
          (item.comparisonPolicy === "base-upper-bound-v1" || candidate.matchType !== "similar"),
      ).length,
    0,
  );
  const pricedBaselines = baselines.filter(
    (item) => item.kind !== "ignored" && item.amount !== null && item.amount > 0,
  );
  const baselineTotal = pricedBaselines.reduce((sum, item) => sum + item.amount!, 0);
  const pendingBaselines = baselines.filter(
    (item) => item.kind !== "ignored" && item.amount === null,
  ).length;
  const outdated = Date.now() - Date.parse(snapshot.searchedAt) >= 24 * 60 * 60 * 1000;
  return (
    <section aria-label={asset + (queried ? "联网查价" : "查价")}>
      <h3>
        {asset}
        {queried ? "联网查价" : "查价"}
      </h3>
      {browserQuery && queried && <p>查价方式：程序通过已登录藏宝阁查询，AI只接收核实后的结果。</p>}
      {queried && snapshot.items.some((item) => item.priceMethod === "first-five-average-v3") && (
        <p>
          每件资产优先收集前5件有效在售商品，按实际样本数计算算术平均价；同配与相近样本分别计价。
        </p>
      )}
      {queried && snapshot.items.some((item) => item.priceMethod === "first-five-minimum-v4") && (
        <p>
          {asset === "宝宝装备" ? "最多取前5件有效在售商品" : "每个筛选条件只核验前5条不同候选"}
          ，采用实际有效样本的最低挂牌价；无样本跳过，搜索范围有限。
          {hasBaseUpperBound
            ? "装备和灵饰的基础值相等或较低样本一起取最低价，属性差异保留在下方。"
            : "同配与相近样本分别计价。"}
        </p>
      )}
      {hasBaseline && <p>普通装备默认参考价来自历史资料或人工预设，未实时核实藏宝阁报价。</p>}
      {queried && <p>相近商品的网页挂牌参考价，不代表实际成交价。</p>}
      {accounting && <p>{accounting}</p>}
      <p>
        {queried ? (browserQuery ? "查询时间" : "搜索时间") : "参考价记录时间"}：
        {readTime(snapshot.searchedAt)}
      </p>
      {outdated && (
        <p className="analysis-pending-note">
          这是超过24小时的历史快照。请开始新批次重新核对；继续旧批次保留当时资料。
        </p>
      )}
      {snapshot.captureComplete && snapshot.items.length === 0 ? (
        <p>已确认没有{asset}。</p>
      ) : snapshot.items.length && snapshot.items.every((item) => item.skipReason) ? (
        <p>
          本次{asset}按规则跳过，未计入参考合计；
          {queried ? "查询未取得可用报价。" : "未发起查价。"}
        </p>
      ) : accounting ? (
        <p>逐件参考报价与匹配依据见下方。</p>
      ) : hasBaseline && snapshot.total === null && snapshot.knownTotal === 0 ? (
        <p>本次没有已核实挂牌参考价；默认参考价另列。</p>
      ) : snapshot.total === null && snapshot.knownTotal === 0 ? (
        <p>尚无合格挂牌参考价；相近商品的参考价和未定价项目见下方。</p>
      ) : (
        <p>
          {snapshot.total !== null
            ? asset + "参考价合计："
            : "已核实" + asset + "小计（非完整总价）："}
          {valuationMoney(snapshot.total ?? snapshot.knownTotal)}
        </p>
      )}
      {hasBaseline && exactCount > 0 && (
        <p>以上仅含已核实挂牌参考价，不含普通装备默认参考价或另列的相近配置区间。</p>
      )}
      {!!pricedBaselines.length && (
        <p>
          默认参考价小计（非实时挂牌价）：{valuationMoney(baselineTotal)} · {pricedBaselines.length}
          件{pendingBaselines ? `，另有${pendingBaselines}件待补价` : ""}。
        </p>
      )}
      {!snapshot.captureComplete && (
        <p className="analysis-pending-note">{asset}资料尚未完整，未采到的部分不会按0计价。</p>
      )}
      {!!snapshot.queries.length && (
        <details>
          <summary>{browserQuery ? "查看实际筛选条件" : "查看搜索关键词"}</summary>
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
      {snapshot.items.map((item) => {
        const searchRecords = (snapshot.searchItems || []).filter(
          (value) => value && typeof value === "object" && "key" in value && value.key === item.key,
        );
        const baseline = item.baselineEstimate;
        const baselineInvalid = item.baselineInvalidReason !== undefined;
        const itemIssues = item.issues.filter((issue) => issue.trim() !== baseline?.note.trim());
        const baselineLink =
          baseline?.source.basis === "historical" && baseline.source.url
            ? safeLink(baseline.source.url)
            : null;
        const baselineLabel = baseline?.kind === "ignored" ? "低值未计入" : "默认参考价";
        const searchLabel =
          item.searchState === "skipped"
            ? item.skipReason || "无样本，未计入参考合计"
            : item.searchState === "read_failed"
              ? "详情读取失败，需重试"
              : item.searchState === "pending"
                ? "查价未完成，继续时重试"
                : item.exclusion
                  ? "无匹配，未计入参考合计"
                  : label(item.status);
        const pendingAverage =
          !!item.priceMethod && ["pending", "read_failed"].includes(item.searchState || "");
        const minimumReference = item.priceMethod === "first-five-minimum-v4";
        const baseUpperBound = item.comparisonPolicy === "base-upper-bound-v1";
        return (
          <section key={item.key} className="analysis-evidence-card">
            <header>
              <strong>
                {item.name}
                {item.level !== null ? ` · ${item.level}级` : ""}
              </strong>
              <span>
                {baselineInvalid
                  ? "默认参考价已失效"
                  : item.status === "priced"
                    ? valuationMoney(item.referencePrice)
                    : baseline
                      ? baseline.kind === "ignored"
                        ? "低值未计入"
                        : baseline.amount !== null
                          ? valuationMoney(baseline.amount)
                          : "默认参考价待补"
                      : pendingAverage
                        ? searchLabel
                        : minimumReference && item.similarEstimate?.range
                          ? valuationMoney(item.similarEstimate.range.min)
                          : item.similarEstimate?.average !== undefined
                            ? valuationMoney(item.similarEstimate.average)
                            : item.similarEstimate?.median !== undefined
                              ? valuationMoney(item.similarEstimate.median)
                              : item.similarEstimate?.range
                                ? valuationRangeMoney(item.similarEstimate.range)
                                : searchLabel}
              </span>
            </header>
            <p>
              {baselineInvalid
                ? "默认参考价已失效"
                : baseline
                  ? baselineLabel
                  : pendingAverage
                    ? searchLabel
                    : item.status === "priced" && item.priceMethod
                      ? minimumReference
                        ? baseUpperBound
                          ? "基础值不高于目标的最低挂牌价"
                          : "同配置最低挂牌价"
                        : "同配置挂牌平均价"
                      : minimumReference && item.similarEstimate?.range
                        ? "相近" + asset + "参考价（最低挂牌价）"
                        : item.similarEstimate?.average !== undefined
                          ? "相近" + asset + "参考价（挂牌平均价）"
                          : item.similarEstimate?.median !== undefined
                            ? "相近" + asset + "参考价（挂牌中位数）"
                            : item.similarEstimate?.range
                              ? "相近配置参考区间"
                              : searchLabel}
            </p>
            {"reason" in item &&
              typeof item.reason === "string" &&
              item.reason.trim() &&
              !itemIssues.includes(item.reason) && <p>{item.reason}</p>}
            {baseline && (
              <>
                {baselineInvalid && (
                  <p className="analysis-pending-note">
                    {item.baselineInvalidReason || "默认参考价核验未通过。"}
                    请按当前资料和设置重新分析。
                  </p>
                )}
                {!baselineInvalid && baseline.kind !== "ignored" && (
                  <p>
                    梦幻币参考价：
                    {baseline.gameCurrency === null
                      ? "未设置默认价，保留待补"
                      : baseline.gameCurrency.toLocaleString("zh-CN") + "梦幻币"}
                    ；人民币参考价：{valuationMoney(baseline.amount)}。
                  </p>
                )}
                <p>
                  {baselineInvalid ? "原参考依据（已失效，未采用）：" : "参考依据："}
                  {baseline.source.basis === "historical"
                    ? "历史资料"
                    : baseline.source.basis === "preset"
                      ? "人工预设"
                      : "低值排除"}
                  {baseline.source.basis === "historical" && baseline.source.publishedAt
                    ? " · " + baseline.source.publishedAt
                    : ""}{" "}
                  ·{" "}
                  {baselineLink ? (
                    <a href={baselineLink} target="_blank" rel="noreferrer">
                      {baseline.source.label}
                    </a>
                  ) : (
                    baseline.source.label
                  )}
                </p>
                {!baselineInvalid &&
                  baseline.kind !== "ignored" &&
                  baseline.gameCurrency !== null && (
                    <p>
                      折算区服：{baseline.serverId}；
                      {baseline.goldPrice !== null && baseline.goldUnit !== null
                        ? `金价${valuationMoney(baseline.goldPrice)} / ${baseline.goldUnit.toLocaleString("zh-CN")}梦幻币`
                        : "本服金价或报价单位缺失，人民币参考价待补"}
                      。
                    </p>
                  )}
                {!baselineInvalid && <p>{baseline.note}</p>}
              </>
            )}
            {!baseline && (
              <p>
                {baseUpperBound ? "合格挂牌样本：" : "同配置挂牌样本："}
                {
                  item.candidates.filter(
                    (candidate) =>
                      candidate.verified && (baseUpperBound || candidate.matchType !== "similar"),
                  ).length
                }
                条。
                {item.similarEstimate &&
                  " 相近配置样本：" + item.similarEstimate.sampleCount + "条。"}
              </p>
            )}
            {!!searchRecords.length && (
              <details>
                <summary>查看这件{asset}的搜索页面与条件记录</summary>
                <pre>{JSON.stringify(searchRecords, null, 2)}</pre>
              </details>
            )}
            {item.status === "priced" &&
              item.candidates.filter(
                (candidate) =>
                  candidate.verified && (baseUpperBound || candidate.matchType !== "similar"),
              ).length === 1 && (
                <p className="analysis-pending-note">仅1条挂牌样本，参考范围有限。</p>
              )}
            {item.similarEstimate && (
              <>
                {!item.similarEstimate.range && item.similarEstimate.observedRange && (
                  <p>
                    已核实样本挂牌范围：{valuationRangeMoney(item.similarEstimate.observedRange)}
                    ；样本不足或报价分散，未纳入估值。
                  </p>
                )}
                {(item.similarEstimate.average !== undefined ||
                  item.similarEstimate.median !== undefined) &&
                  item.similarEstimate.range && (
                    <p>样本挂牌范围：{valuationRangeMoney(item.similarEstimate.range)}。</p>
                  )}
                <ul>
                  {item.similarEstimate.issues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              </>
            )}
            <p>
              {item.category} · {item.description}
            </p>
            {!baseline && (
              <p>
                {browserQuery ? "筛选条件" : "搜索关键词"}：
                {item.query ||
                  (item.skipReason ? "按规则跳过，未发起查价" : "资料不足，未发起查价")}
              </p>
            )}
            {!!itemIssues.length && (
              <ul>
                {itemIssues.map((issue, index) => (
                  <li key={index}>{issue}</li>
                ))}
              </ul>
            )}
            {item.candidates.map((candidate, index) => {
              const link = safeLink(candidate.url);
              return (
                <details key={index}>
                  <summary>
                    {candidate.title} ·{" "}
                    {candidate.verified
                      ? candidate.matchType === "similar"
                        ? "相近配置，已核实来源"
                        : "同配置，已核实来源"
                      : "未采用"}
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
        );
      })}
      {snapshot.rawResponse && (
        <details>
          <summary>{browserQuery ? "查看原始查询记录" : "查看完整搜索回复"}</summary>
          <pre>{snapshot.rawResponse}</pre>
        </details>
      )}
    </section>
  );
}
