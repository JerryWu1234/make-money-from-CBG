import type { CapturedAssetCounts, DimensionId, ProductAnalysis } from "../server/analysis/types";
import { ValuationResultView } from "./ValuationResultView";

const dimensions: { id: DimensionId; label: string }[] = [
  { id: "foundation", label: "角色底子 · 40%" },
  { id: "equipment", label: "装备 · 35%" },
  { id: "pets", label: "召唤兽 · 25%" },
];
export function ProductAnalysisView({
  result,
  onConfigure,
  previousSettings,
  expanded = false,
  assetCounts,
}: {
  result: ProductAnalysis;
  onConfigure?: () => void;
  previousSettings?: boolean;
  expanded?: boolean;
  assetCounts?: CapturedAssetCounts | null;
}) {
  return result.valuation ? (
    <ValuationResultView
      result={result.valuation}
      onConfigure={onConfigure}
      previousSettings={previousSettings}
      expanded={expanded}
      assetCounts={assetCounts}
    />
  ) : (
    <>
      <div className="analysis-detail-score">
        <small>配置参考分</small>
        <strong>
          {result.score ?? "资料不足"}
          {result.score !== null && <span> / 100</span>}
        </strong>
        <p>{result.summary}</p>
      </div>
      <div className="analysis-tags">
        {result.highlights.map((value, index) => (
          <span key={index}>{value}</span>
        ))}
      </div>
      {!!result.risks.length && (
        <section>
          <h3>需要核对的风险</h3>
          <ul>
            {result.risks.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </section>
      )}
      {!!result.missingData.length && (
        <section>
          <h3>缺少的资料</h3>
          <ul>
            {result.missingData.map((value, index) => (
              <li key={index}>{value}</li>
            ))}
          </ul>
        </section>
      )}
      <h3>评分字段依据</h3>
      {dimensions.map(({ id, label }) => {
        const dimension = result.dimensions[id];
        return (
          <section className="analysis-evidence-card" key={id}>
            <header>
              <strong>{label}</strong>
              <span>{dimension.score ?? "资料不足"}</span>
            </header>
            <p>{dimension.reason}</p>
            {dimension.evidence.map((proof, index) => (
              <details key={index}>
                <summary>{proof.reason}</summary>
                <code>{proof.path}</code>
                <pre>{proof.value}</pre>
              </details>
            ))}
          </section>
        );
      })}
    </>
  );
}
