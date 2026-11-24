import { useEffect, useState } from "react";
import type { AccessState, AccessPolicy } from "../server/access";
import type { QueryDiagnosticState } from "../server/query-health/diagnostic-state";

const diagnosticMessages: Record<QueryDiagnosticState["code"], string> = {
  diagnostics_disabled:
    "自动对照诊断已关闭；请人工核对原条件下的空结果。可在下方开启后供后续事件使用，本事件不会重放。",
  diagnostics_unavailable: "当前页面没有可核验的诊断入口，请人工核对原查询。",
  unsupported_condition: "当前条件或公开控件尚不支持自动诊断，请保留条件并人工核对。",
  no_valid_baseline: "没有同会话、同服务器和服龄、同排序的有效宽条件非空基线；请人工核对原查询。",
  blocked_no_probe: "已发现明确访问限制，已停止对照和恢复动作，请先在绑定页面处理限制。",
  diagnostic_failed: "诊断结果未确认，已消耗的动作不会重放，请人工核对页面和原查询。",
  budget_already_spent: "本事件的诊断额度已使用，请人工核对，重新连接不会重置额度。",
  manual_verification_required: "对照证据已归档；即使对照出现商品，也需要人工核对原查询后继续。",
  restoration_failed: "原条件、排序或页码未确认恢复，请先在绑定页面恢复并逐项核对。",
};
export function QueryDiagnosticSummary({ value }: { value: QueryDiagnosticState }) {
  return (
    <div className="access-query-diagnostic" role="status">
      <p>{diagnosticMessages[value.code]}</p>
      {value.unsupportedFields.length > 0 && (
        <p>需人工核对的字段：{value.unsupportedFields.join("、")}</p>
      )}
      <p>
        {value.restoration === "verified"
          ? "已核验原条件、排序和页码恢复，采集仍暂停。"
          : value.nextAction === "restore_original_query"
            ? "下一步：恢复原条件、排序和页码，再核对未确认动作的结果。"
            : "下一步：在绑定页面核对原条件、排序、页码和查询结果。"}
      </p>
    </div>
  );
}

const labels: Partial<Record<keyof AccessPolicy, string>> = {
  minIntervalMs: "最小动作间隔（毫秒）",
  windowMs: "统计窗口（毫秒）",
  maxActionsPerWindow: "窗口内最多动作数",
  fallbackCooldownMs: "无服务端时间时的冷却（毫秒）",
  diagnosticMaxActions: "每事件诊断动作上限",
  detailReadBudgetMs: "每件详情读取时限（毫秒）",
  baselineTtlMs: "可信查询基线有效期（毫秒）",
  newTaskQuota: "连续新任务配额",
};
const reasons: Record<string, string> = {
  login: "登录失效",
  verification: "安全验证",
  http_403: "官网拒绝访问",
  http_429: "官网要求降低频率",
  frequency: "访问频繁",
  unknown_inflight: "存在未确认操作",
  clock_anomaly: "系统时间异常",
  manual_stop: "人工立即停止",
  query_suspect: "查询结果异常",
  query_blocked: "查询发现访问限制，请在绑定页面处理后核对原查询条件、排序和页码",
  query_manual_verification: "查询需人工核实",
  "native-activity-stopped":
    "原生活动已停止；请核对桌面状态、原查询条件、排序和页码，以及未确认操作；必要时人工恢复原查询。",
};
async function request(path = "status", body?: unknown): Promise<AccessState> {
  const response = await fetch(`/api/access/${path}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "无法读取访问状态");
  if (
    !data ||
    data.schemaVersion !== 1 ||
    !["ready", "suspect", "cooldown", "needs_action"].includes(data.state) ||
    !Array.isArray(data.reasons) ||
    !data.policy
  )
    throw new Error("官网访问状态响应无效");
  return data;
}
export function AccessSettings() {
  const [state, setState] = useState<AccessState>();
  const [policy, setPolicy] = useState<AccessPolicy>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const next = await request();
        if (live) {
          setState((current) => (!current || next.revision >= current.revision ? next : current));
          setPolicy((previous) => previous ?? next.policy);
          setError("");
        }
      } catch (error) {
        if (live) setError(String(error instanceof Error ? error.message : error));
      }
    };
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    setAcknowledged(false);
  }, [state?.revision]);
  const act = async (path: string, body: unknown) => {
    setBusy(true);
    setError("");
    try {
      const next = await request(path, body);
      setState((current) => (!current || next.revision >= current.revision ? next : current));
      setPolicy(next.policy);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="head-refresh-settings access-settings" aria-label="官网访问保护">
      <h3>官网访问保护</h3>
      <p role="status">
        {state
          ? {
              ready: "可以开始官网任务",
              suspect: "查询有疑点，已暂停",
              cooldown: "冷却中，需人工继续",
              needs_action: "已暂停，需人工处理",
            }[state.state]
          : "正在读取访问状态…"}
      </p>
      {state && (
        <>
          {state.reasons.length > 0 && (
            <ul>
              {state.reasons.map((reason) => (
                <li key={reason.code}>{reasons[reason.code] ?? reason.code}</li>
              ))}
            </ul>
          )}
          {state.queryDiagnostic && <QueryDiagnosticSummary value={state.queryDiagnostic} />}
          {state.retryNotBefore && (
            <p>
              最早可人工继续：{new Date(state.retryNotBefore).toLocaleString()}
              。到期后不会自动重试。
            </p>
          )}
          <p>
            所有采集与官网查价共享一个交互槽；离线分析继续运行。当前最小动作间隔{" "}
            {state.policy.minIntervalMs / 1000} 秒，每 {state.policy.windowMs / 1000} 秒最多{" "}
            {state.policy.maxActionsPerWindow} 个动作。
          </p>
          <button className="btn-secondary" disabled={busy} onClick={() => void act("stop", {})}>
            立即停止官网动作
          </button>
          {state.state !== "ready" && (
            <div className="access-recovery">
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => void act("open", { revision: state.revision })}
              >
                打开人工处理页面
              </button>
              <label className="access-checkbox">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                我已在绑定页面处理全部暂停原因，并核对未确认操作的结果
              </label>
              <button
                className="btn-secondary"
                disabled={
                  busy ||
                  !acknowledged ||
                  !!(state.retryNotBefore && state.retryNotBefore > Date.now())
                }
                onClick={() =>
                  void act("recover", {
                    revision: state.revision,
                    acknowledgedReasons: state.reasons.map((reason) => reason.code),
                  })
                }
              >
                核验页面并人工继续
              </button>
            </div>
          )}
        </>
      )}
      {state && policy && (
        <details>
          <summary>访问节奏与诊断设置</summary>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (policy.version !== state.policy.version) {
                setError("访问策略已在其他窗口更新，请重新读取后保存");
                return;
              }
              void act("policy", {
                revision: state.revision,
                policy: { ...policy, version: state.policy.version + 1 },
              });
            }}
          >
            {Object.entries(labels).map(([key, label]) => (
              <label className="access-policy-field" key={key}>
                {label}
                <input
                  type="number"
                  min={key === "minIntervalMs" ? 0 : 1}
                  step={1}
                  value={Number(policy[key as keyof AccessPolicy])}
                  disabled={busy}
                  onChange={(event) => setPolicy({ ...policy, [key]: Number(event.target.value) })}
                />
              </label>
            ))}
            <label className="access-checkbox">
              <input
                type="checkbox"
                checked={policy.canaryEnabled}
                disabled={busy}
                onChange={(event) => setPolicy({ ...policy, canaryEnabled: event.target.checked })}
              />
              异常空结果时执行有界对照（需要同会话真实基线）
            </label>
            <button className="btn-secondary" disabled={busy}>
              保存访问策略
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => setPolicy(state.policy)}
            >
              重新读取访问策略
            </button>
          </form>
          <p>策略更新保留暂停原因和已消耗额度。这些参数不代表官网认可的访问频率。</p>
        </details>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
    </section>
  );
}
