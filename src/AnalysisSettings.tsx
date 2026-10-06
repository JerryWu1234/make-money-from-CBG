import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AnalysisProfile, ValuationSettings } from "../server/analysis/valuation-types";
import { RECOMMENDED_RULES } from "../server/analysis/valuation-settings";
import {
  DEFAULT_EQUIPMENT_BASELINE_PRICES,
  type EquipmentBaselinePrices,
} from "../server/analysis/equipment-baseline";

export function EquipmentBaselinePriceFields({
  prices = DEFAULT_EQUIPMENT_BASELINE_PRICES,
  onChange,
}: {
  prices?: EquipmentBaselinePrices;
  onChange: (prices: EquipmentBaselinePrices) => void;
}) {
  return (
    <details className="analysis-settings-section">
      <summary>普通装备默认参考价（梦幻币）</summary>
      <p>
        60–80级普通环装、90–100级普通白板采用默认参考价，按角色区服金价折算成人民币。预设来自历史资料或人工参数，不是实时藏宝阁报价；修改后会标为人工预设。
      </p>
      <p>60、90、100级默认留空待补。70、80级历史默认值仅适用于三年外区服；其他年代需自行设置。</p>
      <p>只填大于0的梦幻币整数。留空表示暂不计价，保留待补；低值装备会保留卡片并标明未计入。</p>
      {(["60", "70", "80", "90", "100"] as const).map((level) => (
        <fieldset key={level}>
          <legend>
            {level}级{Number(level) <= 80 ? "环装" : "普通白板"}
          </legend>
          <div className="analysis-settings-grid">
            {(["weapon", "armor"] as const).map((kind) => (
              <label key={kind}>
                {level}级{kind === "weapon" ? "武器" : "防具"}默认价（梦幻币）
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={prices[level][kind] ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...prices,
                      [level]: {
                        ...prices[level],
                        [kind]: event.target.value === "" ? null : Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
            ))}
          </div>
        </fieldset>
      ))}
    </details>
  );
}

type SettingsResponse = {
  profile: AnalysisProfile;
  promptFile: string;
  marketError?: string;
  market?: import("../server/analysis/market").MarketServer[];
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
              { ...server(id), [key]: value, source: "manual" },
            ],
          }
        : current,
    );
  async function save() {
    if (!source || !settings || busy) return;
    if (
      Object.values(settings.equipmentBaselinePrices || DEFAULT_EQUIPMENT_BASELINE_PRICES).some(
        (row) =>
          Object.values(row).some(
            (value) => value !== null && (!Number.isSafeInteger(value) || value <= 0),
          ),
      )
    ) {
      setError("普通装备默认价须为大于0的梦幻币整数；留空表示未计价。");
      return;
    }
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
          <h2 id="analysis-settings-title">估值与挂牌比较设置</h2>
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
        和参数。新批次使用新设置，历史结果保留。先核对装备和宝宝，再联网查价，比较挂牌差异；区服金价和热度自动匹配。
      </p>
      {error && (
        <p role="alert" className="analysis-pending-note">
          {error}
        </p>
      )}
      {!source && !error && <p role="status">正在读取设置…</p>}
      {source && settings && (
        <>
          <h3>计价方式</h3>
          <p className="analysis-pending-note">
            普通环装采用默认参考价，其他装备和宝宝查找全服同类挂牌样本。强壮神速按当前等级计价，参考依据和采用的价格会保存在结果里。
          </p>
          <button
            type="button"
            className="analysis-button analysis-button-outline"
            onClick={() =>
              setSettings((current) => (current ? { ...current, ...RECOMMENDED_RULES } : current))
            }
          >
            使用建议计价方案
          </button>
          <details className="analysis-settings-section">
            <summary>计价方案：已有默认规则，也可修改</summary>
            <p>
              建议方案：强壮神速计算一次；攻法上限取有效项，同级选攻击；化圣不叠加等级溢价；69级机缘用公式；坐骑边界取下档、多只分别求和；区服比例相加，只调整角色本体。20及以下修炼上限没有额外溢价。
            </p>
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
          <EquipmentBaselinePriceFields
            prices={settings.equipmentBaselinePrices}
            onChange={(prices) => set("equipmentBaselinePrices", prices)}
          />
          <details className="analysis-settings-section">
            <summary>全服行情：自动匹配每件商品的区服</summary>
            <p>
              按商品已有服务器 ID
              匹配全服金价与热度榜，默认报价和基准210元都按3000万游戏币计算。修改某个区服后，该服使用手动参数。
            </p>
            {source.marketError && <p role="status">{source.marketError}；可手动填写所需参数。</p>}
            <p>
              <a href="https://www.aimhxy.com/mhb" target="_blank" rel="noreferrer">
                金价来源：梦幻天眼
              </a>{" "}
              ·{" "}
              <a href="https://www.aimhxy.com/hot" target="_blank" rel="noreferrer">
                热度来源：梦幻天眼
              </a>
            </p>
            {serverRows.map((row) => {
              const value = server(row.serverId);
              return (
                <fieldset key={row.serverId}>
                  <legend>
                    {row.serverName} · {row.serverId}
                  </legend>
                  <p>{value.source === "auto" ? "已按本商品区服自动匹配" : "手动参数"}</p>
                  {source.market?.find((item) => item.serverId === row.serverId) &&
                    value.source !== "auto" && (
                      <button
                        type="button"
                        onClick={() =>
                          setSettings((current) =>
                            current
                              ? {
                                  ...current,
                                  servers: [
                                    ...current.servers.filter(
                                      (item) => item.serverId !== row.serverId,
                                    ),
                                    source.market!.find((item) => item.serverId === row.serverId)!,
                                  ],
                                }
                              : current,
                          )
                        }
                      >
                        恢复本服自动行情
                      </button>
                    )}
                  {value.source === "auto" && (
                    <small>
                      行情读取时间：
                      {source.market?.find((item) => item.serverId === row.serverId)?.fetchedAt}
                    </small>
                  )}
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
