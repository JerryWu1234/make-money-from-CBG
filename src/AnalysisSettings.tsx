import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AnalysisProfile, ValuationSettings } from "../server/analysis/valuation-types";

type SettingsResponse = {
  profile: AnalysisProfile;
  promptFile: string;
  servers: { serverId: string; serverName: string }[];
};
export function AnalysisSettings({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [source, setSource] = useState<SettingsResponse | null>(null);
  const [template, setTemplate] = useState("");
  const [settings, setSettings] = useState<ValuationSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const element = dialog.current!,
      previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    element.showModal();
    document.body.style.overflow = "hidden";
    const controller = new AbortController();
    void fetch("/api/analysis/settings", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "无法读取分析设置");
        if (!controller.signal.aborted) {
          setSource(data);
          setTemplate(data.profile.template);
          setSettings(data.profile.settings);
        }
      })
      .catch((failure) => {
        if (!controller.signal.aborted)
          setError(failure instanceof Error ? failure.message : "无法读取分析设置");
      });
    return () => {
      controller.abort();
      element.close();
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const set = (key: keyof ValuationSettings, value: unknown) =>
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  const numberInput = (key: "b" | "a" | "budget" | "extraCost", label: string, hint: string) => (
    <label>
      {label}
      <input
        aria-label={label}
        type="number"
        step="any"
        min="0"
        max={key === "a" || key === "b" ? 1 : undefined}
        value={settings?.[key] ?? ""}
        onChange={(event) =>
          set(key, event.target.value === "" ? null : Number(event.target.value))
        }
      />
      <small>{hint}</small>
    </label>
  );
  const choice = (
    key:
      | "strengthMode"
      | "capMode"
      | "capTie"
      | "opportunityMode"
      | "mountBoundary"
      | "adjustmentMode"
      | "adjustmentScope",
    label: string,
    choices: [string, string][],
  ) => (
    <label>
      {label}
      <select
        value={String(settings?.[key] ?? "")}
        onChange={(event) => set(key, event.target.value || null)}
      >
        <option value="">待确认</option>
        {choices.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  const serverRows = source
    ? [
        ...new Map(
          [
            ...source.servers,
            ...source.profile.settings.servers.map((row) => ({
              serverId: row.serverId,
              serverName:
                source.servers.find((item) => item.serverId === row.serverId)?.serverName ||
                row.serverId,
            })),
          ].map((row) => [row.serverId, row]),
        ).values(),
      ]
    : [];
  const server = (id: string) =>
    settings?.servers.find((row) => row.serverId === id) || {
      serverId: id,
      age: null,
      rank: null,
      goldPrice: null,
      goldUnit: null,
      baselineUnitConfirmed: false,
    };
  const updateServer = (id: string, key: string, value: unknown) =>
    setSettings((current) =>
      current
        ? {
            ...current,
            servers: [
              ...current.servers.filter((row) => row.serverId !== id),
              { ...server(id), [key]: value },
            ],
          }
        : current,
    );
  async function save() {
    if (!source || !settings || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/analysis/settings/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template, settings, baseHash: source.profile.hash }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存失败");
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }
  return createPortal(
    <dialog
      ref={dialog}
      className="analysis-result-dialog analysis-settings-dialog"
      aria-labelledby="analysis-settings-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else onClose();
      }}
    >
      <header className="analysis-modal-header">
        <div>
          <span className="analysis-kicker">PROMPT / 分析设置</span>
          <h2 id="analysis-settings-title">裸号估值与购买设置</h2>
        </div>
        <button
          autoFocus
          className="analysis-close"
          aria-label="关闭分析设置"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <p>
        每次开始分析都会冻结这份 Prompt
        和参数。保存修改后，新批次采用新设置；继续旧批次仍使用当时的设置。留空的必需参数会在结果中显示“待确认”。
      </p>
      {error && (
        <p role="alert" className="analysis-pending-note">
          {error}
        </p>
      )}
      {!source && !error && <p role="status">正在读取设置…</p>}
      {source && settings && (
        <>
          <h3>购买条件</h3>
          <div className="analysis-settings-grid">
            {numberInput("b", "最高买入系数 b", "0 < b ≤ 1，例如0.8表示估值的八折。")}
            {numberInput("a", "理想买入系数 a（可选）", "不大于 b；留空不计算理想买价。")}
            {numberInput("budget", "总预算 B（元，可选）", "包含挂牌价格和额外成本。")}
            {numberInput("extraCost", "全部额外成本 F（元）", "无额外费用时明确填0，不默认免费。")}
          </div>
          <details className="analysis-settings-section">
            <summary>公式口径：有分歧时由你确认</summary>
            <div className="analysis-settings-grid">
              {choice("strengthMode", "强壮、神速", [
                ["single", "按当前等级计算一次"],
                ["cumulative", "从1级逐级累加"],
              ])}
              {choice("capMode", "攻法修炼上限", [
                ["both", "攻击和法术分别计价"],
                ["effective", "只计有效攻法项"],
              ])}
              {choice("capTie", "攻法等级相同时", [
                ["attack", "选攻击修炼"],
                ["magic", "选法术修炼"],
              ])}
              <label>
                化圣是否叠加等级溢价
                <select
                  value={
                    settings.holyLevelPremium === null ? "" : String(settings.holyLevelPremium)
                  }
                  onChange={(event) =>
                    set(
                      "holyLevelPremium",
                      event.target.value === "" ? null : event.target.value === "true",
                    )
                  }
                >
                  <option value="">待确认</option>
                  <option value="true">叠加</option>
                  <option value="false">不叠加</option>
                </select>
              </label>
              {choice("opportunityMode", "69级机缘", [
                ["formula", "公式计算"],
                ["discrete", "离散报价（仅列出的值）"],
              ])}
              {choice("mountBoundary", "坐骑百分比恰好70、80", [
                ["lower", "采用下档"],
                ["upper", "采用上档"],
              ])}
              {choice("adjustmentMode", "区服调整合并", [
                ["add", "百分比相加"],
                ["multiply", "系数相乘"],
              ])}
              {choice("adjustmentScope", "区服调整作用范围", [
                ["body", "仅角色本体"],
                ["all", "角色及附带资产"],
              ])}
            </div>
            <label className="analysis-settings-check">
              <input
                type="checkbox"
                checked={settings.schoolCapConfirmed}
                onChange={(event) => set("schoolCapConfirmed", event.target.checked)}
              />
              确认未飞升技能超过130级时，先封顶为130再代入公式
            </label>
            <label className="analysis-settings-check">
              <input
                type="checkbox"
                checked={settings.sumAdvancedMounts}
                onChange={(event) => set("sumAdvancedMounts", event.target.checked)}
              />
              确认多只进阶坐骑分别计价后全额相加
            </label>
          </details>
          <details className="analysis-settings-section">
            <summary>区服参数：按服务器分别设置</summary>
            <p>
              金价 G 是每 U 个游戏币的人民币价。三年外还需确认 G 与 Prompt 基准210的报价单位一致。
            </p>
            {serverRows.map((row) => {
              const value = server(row.serverId);
              return (
                <fieldset key={row.serverId}>
                  <legend>
                    {row.serverName} · {row.serverId}
                  </legend>
                  <div className="analysis-settings-grid">
                    <label>
                      区服年代
                      <select
                        value={value.age || ""}
                        onChange={(event) =>
                          updateServer(row.serverId, "age", event.target.value || null)
                        }
                      >
                        <option value="">待确认</option>
                        <option value="one">一年内</option>
                        <option value="three">三年内</option>
                        <option value="older">三年外</option>
                      </select>
                    </label>
                    {(
                      [
                        ["rank", "热度排名 r"],
                        ["goldPrice", "金价 G（元）"],
                        ["goldUnit", "报价单位 U（游戏币数）"],
                      ] as const
                    ).map(([key, label]) => (
                      <label key={key}>
                        {label}
                        <input
                          type="number"
                          min="0"
                          step={key === "rank" ? "1" : "any"}
                          value={value[key] ?? ""}
                          onChange={(event) =>
                            updateServer(
                              row.serverId,
                              key,
                              event.target.value === "" ? null : Number(event.target.value),
                            )
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <label className="analysis-settings-check">
                    <input
                      type="checkbox"
                      checked={value.baselineUnitConfirmed}
                      onChange={(event) =>
                        updateServer(row.serverId, "baselineUnitConfirmed", event.target.checked)
                      }
                    />
                    确认本服 G 与基准210使用相同单位
                  </label>
                </fieldset>
              );
            })}
            {!serverRows.length && <p>采集商品后会显示对应服务器。</p>}
          </details>
          <details className="analysis-settings-section">
            <summary>编辑完整 Prompt</summary>
            <p>
              文件：<code>{source.promptFile}</code>
            </p>
            <p>
              可调整分析说明和输出要求。修改计价表或公式后，需同步服务端复算规则；同步前只输出“待确认”，防止新旧算法混用。
            </p>
            <textarea
              aria-label="估值 Prompt 全文"
              className="analysis-prompt-editor"
              value={template}
              onChange={(event) => setTemplate(event.target.value)}
              spellCheck={false}
            />
          </details>
          {!source.profile.calculationCompatible && (
            <p role="status" className="analysis-pending-note">
              当前 Prompt 的计价部分已修改，复算规则尚未同步。
            </p>
          )}
          <div className="analysis-detail-links">
            <button
              className="analysis-button analysis-button-primary"
              disabled={busy}
              onClick={() => void save()}
            >
              {busy ? "保存中…" : "保存设置"}
            </button>
            <button
              className="analysis-button analysis-button-outline"
              disabled={busy}
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </>
      )}
    </dialog>,
    document.body,
  );
}
