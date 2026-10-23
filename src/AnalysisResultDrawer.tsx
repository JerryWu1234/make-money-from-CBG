import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AnalysisDetail } from "../server/analysis/types";
import { displayTime } from "./SavedRoleList";
import { ProductAnalysisView } from "./ProductAnalysisView";
import { AssetCounts, EquipmentSummary } from "./AssetCounts";

export function AnalysisResultDrawer({
  taskId,
  onClose,
  onShowRole,
  onConfigure,
  currentCalculationVersion,
}: {
  taskId: string;
  onClose: () => void;
  onShowRole: (key: string) => void;
  onConfigure?: () => void;
  currentCalculationVersion?: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<AnalysisDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setDetail(null);
    setError(null);
    async function load() {
      try {
        const response = await fetch(`/api/analysis/detail?taskId=${encodeURIComponent(taskId)}`, {
          cache: "no-store",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || "无法加载分析结果");
        if (controller.signal.aborted) return;
        setDetail(result);
        setError(null);
        if (result.state === "running" || result.state === "queued") timer = setTimeout(load, 2000);
      } catch (failure) {
        if (!controller.signal.aborted) {
          setError(failure instanceof Error ? failure.message : "无法加载分析结果");
          timer = setTimeout(load, 5000);
        }
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [taskId]);
  return createPortal(
    <dialog
      ref={dialog}
      className="analysis-result-dialog analysis-detail-dialog"
      aria-labelledby="analysis-detail-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <header className="analysis-modal-header">
        <div>
          <span className="analysis-kicker">ANALYSIS / 分析依据</span>
          <h2 id="analysis-detail-title">{detail?.listing.name || "商品分析"}</h2>
        </div>
        <button autoFocus className="analysis-close" aria-label="关闭分析详情" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="analysis-modal-content">
        {error && (
          <p role="alert" className="analysis-pending-note">
            {error}
          </p>
        )}
        {!detail && !error && <p role="status">正在读取分析结果…</p>}
        {detail && (
          <>
            {detail.result?.valuation?.comparison_mode === "listing-only" ? (
              <p>
                {detail.listing.serverName} · {detail.provider === "codex" ? "Codex" : "DeepSeek"} ·{" "}
                {detail.model}
              </p>
            ) : (
              <div className="analysis-detail-price">
                <small>
                  分析时的挂牌价格 · {detail.provider === "codex" ? "Codex" : "DeepSeek"} ·{" "}
                  {detail.model}
                </small>
                <strong>{detail.listing.price ? `¥${detail.listing.price}` : "未采集"}</strong>
              </div>
            )}
            {detail.reusedFrom && (
              <p className="analysis-pending-note">
                资料、模型与规则相同，复用已有结论。下方保留首次生成该结论时的调用记录。
              </p>
            )}
            {detail.result ? (
              <ProductAnalysisView
                result={detail.result}
                assetCounts={detail.assetCounts}
                onConfigure={onConfigure}
                previousSettings={
                  detail.profileChanged ||
                  (!!currentCalculationVersion &&
                    detail.result.valuation?.calculation_version !== currentCalculationVersion)
                }
              />
            ) : (
              <p className="analysis-pending-note" role="status">
                {detail.error ||
                  (detail.state === "running"
                    ? "正在分析，还没有完整结果。"
                    : "商品已排队，等待分析。")}
              </p>
            )}
            {!detail.result && (
              <p>
                <AssetCounts counts={detail.assetCounts} />
              </p>
            )}
            {!detail.result && <EquipmentSummary counts={detail.assetCounts} />}
            <section className="analysis-input-preview">
              <h3>本次输入留档</h3>
              <p>
                商品 ID：{detail.listing.key}
                <br />
                规则：{detail.ruleVersion}
                <br />
                完成时间：{displayTime(detail.completedAt)}
              </p>
              <small>输入 SHA-256</small>
              <code>{detail.inputHash}</code>
              {detail.profile && (
                <>
                  <p>
                    Prompt SHA-256：<code>{detail.profile.promptHash}</code>参数 SHA-256：
                    <code>{detail.profile.settingsHash}</code>复算版本：
                    {detail.profile.calculationVersion}
                  </p>
                  <details>
                    <summary>查看本次购买参数与公式口径</summary>
                    <pre>{JSON.stringify(detail.profile.settings, null, 2)}</pre>
                  </details>
                  <details>
                    <summary>查看本次使用的 Prompt 模板</summary>
                    <pre>{detail.requestTemplate ?? detail.profile.template}</pre>
                  </details>
                </>
              )}
              <details>
                <summary>查看完整商品原文</summary>
                <pre>{detail.inputText}</pre>
              </details>
              <details>
                <summary>查看完整 AI 请求</summary>
                <pre>{detail.promptText}</pre>
              </details>
              <div className="analysis-detail-links">
                <a href={`/api/analysis/input?taskId=${encodeURIComponent(taskId)}`}>
                  下载商品原文 TXT
                </a>
                <a href={`/api/analysis/input?taskId=${encodeURIComponent(taskId)}&kind=prompt`}>
                  下载完整请求 TXT
                </a>
              </div>
            </section>
            <section>
              <h3>调用记录（{detail.attempts.length} 次）</h3>
              {detail.attempts.map((attempt, index) => (
                <details className="analysis-attempt" key={attempt.id}>
                  <summary>
                    第 {index + 1} 次 ·{" "}
                    {attempt.state === "completed"
                      ? "完成"
                      : attempt.state === "interrupted"
                        ? "中断"
                        : attempt.state === "failed"
                          ? "失败"
                          : "执行中"}{" "}
                    · {displayTime(attempt.finishedAt || attempt.createdAt)}
                  </summary>
                  {attempt.error && <p>{attempt.error}</p>}
                  {attempt.requestText && (
                    <details>
                      <summary>查看这次调用的完整请求</summary>
                      <code>{attempt.requestHash}</code>
                      <pre>{attempt.requestText}</pre>
                    </details>
                  )}
                  {attempt.rawResponse !== null ? (
                    <pre>{attempt.rawResponse}</pre>
                  ) : (
                    <p>本次未收到完整回复。</p>
                  )}
                  {attempt.usage != null && <pre>{JSON.stringify(attempt.usage, null, 2)}</pre>}
                </details>
              ))}
            </section>
            <div className="analysis-detail-links">
              <button
                className="analysis-button analysis-button-outline"
                onClick={() => onShowRole(detail.listing.key)}
              >
                查看当前采集资料
              </button>
              <a href={detail.listing.url} target="_blank" rel="noopener noreferrer">
                打开原商品 ↗
              </a>
            </div>
          </>
        )}
      </div>
    </dialog>,
    document.body,
  );
}
