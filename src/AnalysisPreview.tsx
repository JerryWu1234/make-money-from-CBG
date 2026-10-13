import { useCallback, useEffect, useRef, useState } from "react";
import type { AiProvider } from "../server/ai/types";
import type { AnalysisItem, AnalysisOverview, AnalysisRun } from "../server/analysis/types";
import { AiConnectionControl } from "./AiConnectionControl";
import { AnalysisResultDrawer } from "./AnalysisResultDrawer";
import { AnalysisSettings } from "./AnalysisSettings";
import {
  valuationDecisionLabel,
  valuationMoney,
  valuationPriceDifferenceText,
  valuationPriceSummary,
  valuationSummaryText,
} from "./ValuationResultView";
import { RoleDetailDrawer } from "./RoleDetailDrawer";
import { displayTime } from "./SavedRoleList";
import "./analysis-preview.css";

const labels = {
  ready: "待分析",
  waiting_detail: "待补采",
  waiting_pricing: "价格待补齐",
  queued: "排队中",
  running: "分析中",
  completed: "已分析",
  failed: "分析失败",
  stale: "需要重新分析",
};
const providerNames = { codex: "Codex", deepseek: "DeepSeek" };
const price = (value: string) => (value ? `¥${value}` : "价格未采集");
function savedProvider(): AiProvider {
  try {
    return localStorage.getItem("cbg-analysis-provider") === "deepseek" ? "deepseek" : "codex";
  } catch {
    return "codex";
  }
}
async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    cache: "no-store",
    signal,
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "请求失败，请重试");
  return data as T;
}

export function AnalysisPreview() {
  const [provider, setProvider] = useState<AiProvider>(savedProvider);
  const [selectedModels, setSelectedModels] = useState<Record<AiProvider, string>>({
    codex: "",
    deepseek: "",
  });
  const [modelChanged, setModelChanged] = useState(false);
  const [defaultModels, setDefaultModels] = useState<Record<AiProvider, string | null>>({
    codex: null,
    deepseek: null,
  });
  const updateDefaultModel = useCallback((source: AiProvider, model: string | null) => {
    setDefaultModels((previous) => ({ ...previous, [source]: model }));
  }, []);
  const [tab, setTab] = useState<"ranking" | "all" | "history">("history");
  const [data, setData] = useState<AnalysisOverview | null>(null);
  const [page, setPage] = useState(1);
  const [resultsPage, setResultsPage] = useState(1);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [roleKey, setRoleKey] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState(false);
  const firstLoad = useRef(true);
  const operation = useRef(false);
  const run = data?.run;
  const active = data?.activeRun;
  const preparation = data?.capturePreparation;
  const running = !!active || !!preparation;
  const searchingEquipment =
    active?.phase === "equipment_search" ||
    active?.phase === "pet_search" ||
    active?.phase === "pet_gear_search" ||
    active?.phase === "role_search";
  const searchAsset =
    active?.phase === "role_search"
      ? "整号"
      : active?.phase === "pet_gear_search"
        ? "宝宝装备"
        : active?.phase === "pet_search"
          ? "宝宝"
          : "装备";
  const waitingPricing = run?.waitingPricing || 0;
  const finished = (run?.completed || 0) + (run?.failed || 0) + waitingPricing;
  const sameCalculation =
    !run?.calculationVersion || run.calculationVersion === data?.profile?.calculationVersion;
  const selectedModel = selectedModels[provider];
  const effectiveModel = selectedModel || defaultModels[provider];
  const sameModel = !modelChanged || !effectiveModel || run?.model === effectiveModel;
  const valuationMode = run ? run.ruleVersion === "role-valuation-v1" : !!data?.profile;
  const listingComparison =
    valuationMode && (!run || run.calculationVersion?.startsWith("price-comparison-"));

  useEffect(() => {
    try {
      localStorage.setItem("cbg-analysis-provider", provider);
    } catch {
      /* Storage is optional. */
    }
  }, [provider]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const params = new URLSearchParams({
          provider,
          page: String(page),
          resultsPage: String(resultsPage),
          search,
          filter,
        });
        const next = await request<AnalysisOverview>(
          `/api/analysis/status?${params}`,
          undefined,
          AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        );
        if (controller.signal.aborted) return;
        if (firstLoad.current) {
          const saved = next.activeRun || next.run;
          if (saved) {
            setProvider(saved.provider);
            setSelectedModels((previous) => ({ ...previous, [saved.provider]: saved.model }));
          }
        }
        firstLoad.current = false;
        setData(next);
        setLoadError(null);
        if (next.records.page !== page) setPage(next.records.page);
        if (next.results && next.results.page !== resultsPage) setResultsPage(next.results.page);
        timer = setTimeout(refresh, next.activeRun || next.capturePreparation ? 1500 : 5000);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setLoadError(failure instanceof Error ? failure.message : "无法加载分析记录");
        timer = setTimeout(refresh, 5000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [provider, page, resultsPage, search, filter, revision]);

  const mutate = useCallback(async (path: string, body: unknown) => {
    if (operation.current && path !== "/api/analysis/pause") return;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = await request<AnalysisRun | null>(path, body);
      if (next) {
        setProvider(next.provider);
        setSelectedModels((previous) => ({ ...previous, [next.provider]: next.model }));
        setModelChanged(false);
      }
      setRevision((value) => value + 1);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : "操作失败，请重试";
      setError(message === "已暂停完整资料采集准备" ? null : message);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }, []);
  const start = useCallback(
    async (selected: AiProvider) => {
      setTab("history");
      setResultsPage(1);
      if (sameCalculation && sameModel && run?.provider === selected && run.status === "paused")
        await mutate("/api/analysis/resume", { runId: run.id });
      else
        await mutate("/api/analysis/start", {
          provider: selected,
          model: selectedModels[selected] || undefined,
        });
    },
    [run, mutate, sameCalculation, sameModel, selectedModels],
  );
  const changeProvider = (selected: AiProvider) => {
    setProvider(selected);
    setModelChanged(!!selectedModels[selected]);
    setData(null);
    setPage(1);
    setResultsPage(1);
    setError(null);
  };
  const viewItem = (item: AnalysisItem) => {
    if (item.taskId) setTaskId(item.taskId);
    else setRoleKey(item.key);
  };
  const startLabel = preparation
    ? "正在完整采集…"
    : busy
      ? "正在处理…"
      : running
        ? searchingEquipment
          ? "正在查价…"
          : "正在分析…"
        : run && !sameModel
          ? "按新模型开始分析"
          : run && !sameCalculation
            ? "按新规则开始分析"
            : run?.status === "paused"
              ? "继续分析"
              : run?.status === "completed"
                ? "分析新增或已更新商品"
                : "开始分析已有商品";

  return (
    <div className="analysis-page">
      <header className="analysis-topbar">
        <a className="analysis-brand" href="/">
          <span className="analysis-brand-mark">◇</span> 藏宝阁助手
        </a>
        <nav className="analysis-nav" aria-label="主导航">
          <a href="/">采集工作台</a>
          <span aria-current="page">商品分析</span>
        </nav>
        <span className="analysis-preview-pill">原文与结果可追溯</span>
      </header>
      <main className="analysis-shell">
        <section className="analysis-hero">
          <div className="analysis-hero-copy">
            <span className="analysis-eyebrow">PRODUCT ANALYSIS / 商品分析</span>
            <h1>
              每件商品一条，
              <br />
              <em>点开查看详情</em>
            </h1>
            <p>
              先核对装备和宝宝，再联网查价，直接比较参考估值与挂牌价；缺资料或可靠报价时显示补齐办法。
            </p>
            <AiConnectionControl
              provider={provider}
              onProviderChange={changeProvider}
              selectedModel={selectedModel}
              onModelChange={(model) => {
                setSelectedModels((previous) => ({ ...previous, [provider]: model }));
                setModelChanged(true);
                setError(null);
              }}
              onDefaultModelChange={updateDefaultModel}
              onStart={start}
              startLabel={startLabel}
              disabled={busy || running || !data || data.counts.total === 0}
              locked={busy || running}
            />
            <div className="analysis-hero-actions">
              <button
                className="analysis-button analysis-button-outline"
                disabled={busy}
                onClick={() => setSettingsOpen(true)}
              >
                分析设置
              </button>
              {(active || preparation) && (
                <button
                  className="analysis-button analysis-button-stop"
                  disabled={busy && !preparation}
                  onClick={() => void mutate("/api/analysis/pause", { runId: active?.id })}
                >
                  {preparation ? "暂停资料采集" : "暂停分析"}
                </button>
              )}
              {!running && sameCalculation && run && !!(run.failed + waitingPricing) && (
                <button
                  className="analysis-button analysis-button-outline"
                  disabled={busy}
                  onClick={() => void mutate("/api/analysis/retry", { runId: run.id })}
                >
                  重试失败及待补齐的 {run.failed + waitingPricing} 件
                </button>
              )}
            </div>
            {settingsNotice && (
              <p className="analysis-start-hint" role="status">
                设置已保存。下次分析将更新受影响的商品，已有结果保留。
              </p>
            )}
            {data?.profile && !data.profile.calculationCompatible && (
              <p className="analysis-pending-note" role="status">
                计价 Prompt 已修改，需要同步复算规则；当前结果会标为待确认。
              </p>
            )}
            <p className="analysis-start-hint" role="status">
              {!data
                ? "正在读取已采集商品…"
                : preparation
                  ? `正在采集并核验角色资料：${preparation.completed}/${preparation.total} 个 · ${preparation.current || "准备下一角色"} · ${preparation.message}`
                  : data.counts.total === 0
                    ? "尚未采集商品，请先回到采集工作台采集详情。"
                    : active
                      ? searchingEquipment
                        ? `正在联网查${searchAsset}价格：${active.current || "准备下一件"} · ${active.completed + active.failed + (active.waitingPricing || 0)}/${active.total} 件已处理`
                        : `正在用 ${providerNames[active.provider]} 分析：${active.current || "准备下一件"} · ${active.completed + active.failed + (active.waitingPricing || 0)}/${active.total} 件已处理`
                      : run && !sameModel
                        ? "模型选择已更改，下次分析使用所选模型，已有结果保留。"
                        : run && !sameCalculation
                          ? "估值规则已更新，下次分析使用新规则，已有结果保留。"
                          : run?.status === "paused"
                            ? `${run.pauseNotice ? run.pauseNotice + "。" : "分析已暂停。"}已完成结果保留；继续分析会沿用任务开始时的设置。`
                            : run?.status === "completed"
                              ? `本批次已处理：${run.completed} 件成功，${run.failed} 件失败，${waitingPricing} 件价格待补齐。待补齐项保留进度，需单独重试。`
                              : `${data.counts.complete} 件资料完整，可以开始分析；${data.counts.waitingDetail} 件等待补采。`}
            </p>
            {active && searchingEquipment && active.pricingProgress && (
              <p className="analysis-start-hint" role="status">
                {active.pricingProgress.assetName || searchAsset}
                {active.pricingProgress.page ? ` · 第 ${active.pricingProgress.page} 页` : ""}
                {active.pricingProgress.validSamples !== undefined
                  ? ` · 已核验 ${active.pricingProgress.validSamples} 个样本`
                  : ""}
                {active.pricingProgress.retryCount
                  ? ` · 重试 ${active.pricingProgress.retryCount}/2`
                  : ""}
                {` · 本角色第 ${active.pricingProgress.round} 轮 · 最近进度 ${displayTime(active.pricingProgress.updatedAt)}`}
              </p>
            )}
            {(error || loadError || run?.error) && (
              <p className="analysis-auth-notice" role="alert">
                {error || loadError || run?.error}
              </p>
            )}
          </div>
          <div className="analysis-hero-visual" aria-hidden="true">
            <div className="analysis-visual-top">
              <span>逐件分析</span>
              <span>{providerNames[provider]}</span>
            </div>
            <div className="analysis-visual-orbit">
              <span>底子</span>
              <span>装备</span>
              <span>召唤兽</span>
              <span>完整原文</span>
            </div>
            <div className="analysis-visual-focus">
              <small>当前状态</small>
              <strong>
                {preparation
                  ? "完整采集中"
                  : running
                    ? searchingEquipment
                      ? "联网查价中"
                      : "分析中"
                    : run?.status === "paused"
                      ? "已暂停"
                      : run?.status === "completed"
                        ? waitingPricing
                          ? "有价格待补齐"
                          : "已处理"
                        : "待开始"}
              </strong>
              <span>
                {run
                  ? `${finished} / ${run.total} 件已处理`
                  : `${data?.counts.complete || 0} 件可分析`}
              </span>
            </div>
            <div className="analysis-visual-bars">
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
        </section>
        <div className="analysis-overview" aria-label="分析页面概览">
          <div>
            <span className="analysis-overview-icon">01</span>
            <small>已采集商品</small>
            <strong>{data?.counts.total || 0} 件</strong>
            <p>
              {data?.counts.complete || 0} 件详情完整 · {data?.counts.waitingDetail || 0} 件待补采
            </p>
          </div>
          <div>
            <span className="analysis-overview-icon">02</span>
            <small>已完成分析</small>
            <strong>{data?.results?.total || 0} 件已有结果</strong>
            <p>
              {run
                ? `${waitingPricing} 件价格待补齐 · ${run.failed} 件失败 · ${run.queued} 件排队中`
                : "选择 AI 后点击开始分析"}
            </p>
          </div>
          <div>
            <span className="analysis-overview-icon">03</span>
            <small>原文留档</small>
            <strong>一件商品，一份原文</strong>
            <p>保留输入、完整请求与每次调用回复</p>
          </div>
        </div>
        <div className="analysis-workspace">
          <section className="analysis-results" aria-label="商品分析结果">
            <div className="analysis-tabbar" role="tablist" aria-label="分析结果视图">
              <button
                role="tab"
                aria-selected={tab === "ranking"}
                onClick={() => setTab("ranking")}
              >
                推荐榜 <span>{data?.ranking.length || 0}</span>
              </button>
              <button role="tab" aria-selected={tab === "all"} onClick={() => setTab("all")}>
                全部商品 <span>{data?.counts.total || 0}</span>
              </button>
              <button
                role="tab"
                aria-selected={tab === "history"}
                onClick={() => setTab("history")}
              >
                分析记录 <span>{data?.results?.total || 0}</span>
              </button>
            </div>
            {tab === "ranking" ? (
              <div className="analysis-rank-list" role="tabpanel" aria-label="推荐榜">
                <div className="analysis-list-intro">
                  <span>已完成商品前 10 名</span>
                  <span>完整保存后更新榜单</span>
                </div>
                {!data?.ranking.length && (
                  <div className="analysis-start-empty">
                    <strong>
                      {run?.completed
                        ? valuationMode
                          ? "暂无符合推荐条件的商品"
                          : "暂无可排序的结果"
                        : "暂无分析结果"}
                    </strong>
                    <p>
                      {run?.completed
                        ? `已有 ${run.completed} 件分析结果，可在全部商品查看。`
                        : "开始分析后，结果会保存在这里。"}
                    </p>
                  </div>
                )}
                {data?.ranking.map((item, index) => (
                  <article
                    className={`analysis-rank-card ${index === 0 ? "analysis-rank-first" : ""}`}
                    key={item.key}
                  >
                    <div className="analysis-rank-number">
                      {String(index + 1).padStart(2, "0")}
                      <small>
                        {item.valuation
                          ? item.valuation.comparison_mode === "listing-only"
                            ? "价格比较"
                            : "购买参考"
                          : "配置参考"}
                      </small>
                    </div>
                    <div className="analysis-rank-main">
                      <div className="analysis-rank-title">
                        <h3>{item.name}</h3>
                        <span>{item.server}</span>
                      </div>
                      <p>{item.summary}</p>
                      <div className="analysis-tags">
                        {item.highlights.map((item, index) => (
                          <span key={index}>{item}</span>
                        ))}
                      </div>
                    </div>
                    <div className="analysis-rank-side">
                      <small>挂牌价格</small>
                      <strong>{price(item.price)}</strong>
                      <span>
                        {item.valuation
                          ? item.valuation.comparison_mode === "listing-only"
                            ? valuationPriceDifferenceText(item.valuation) ||
                              valuationDecisionLabel(item.valuation)
                            : `最高买入 ${valuationMoney(item.valuation.max_listing_price)}`
                          : `配置参考分 ${item.score}`}
                      </span>
                      <button onClick={() => viewItem(item)}>查看分析依据 →</button>
                    </div>
                  </article>
                ))}
              </div>
            ) : tab === "all" ? (
              <div role="tabpanel" aria-label="全部商品">
                <div className="analysis-filterbar">
                  <label className="analysis-search">
                    <span aria-hidden="true">⌕</span>
                    <input
                      type="search"
                      aria-label="搜索商品"
                      placeholder="搜索角色、服务器、资料"
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        setPage(1);
                      }}
                    />
                  </label>
                  <label className="analysis-filter">
                    分析状态
                    <select
                      value={filter}
                      onChange={(event) => {
                        setFilter(event.target.value);
                        setPage(1);
                      }}
                    >
                      <option value="all">全部状态</option>
                      {Object.entries(labels).map(([id, label]) => (
                        <option key={id} value={id}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="analysis-mobile-table-hint">左右滑动表格查看更多字段 →</p>
                <div className="analysis-table-scroll">
                  <table className="analysis-table">
                    <thead>
                      <tr>
                        <th>商品 / 服务器</th>
                        <th>挂牌价格</th>
                        <th>资料</th>
                        <th>分析状态</th>
                        <th>
                          {valuationMode
                            ? listingComparison
                              ? "估值 / 挂牌差异"
                              : "估值 / 结论"
                            : "配置分"}
                        </th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data?.records.items.map((item) => (
                        <tr key={item.key}>
                          <td>
                            <strong>{item.name}</strong>
                            <small>{item.server}</small>
                          </td>
                          <td className="analysis-table-price">{price(item.price)}</td>
                          <td>
                            <span
                              className={`analysis-status ${item.collectionStatus === "complete" ? "is-complete" : "is-pending"}`}
                            >
                              {item.collectionStatus === "complete" ? "详情完整" : "待补采"}
                            </span>
                          </td>
                          <td>
                            <span className={`analysis-state analysis-state-${item.state}`}>
                              {item.state === "completed" && item.profileChanged
                                ? "上次分析"
                                : item.state === "completed" &&
                                    item.valuation?.estimated_value_range
                                  ? "分析完成 · 参考区间"
                                  : item.state === "completed" &&
                                      item.valuation?.decision === "NEED_INFO"
                                    ? "分析完成 · 待补齐"
                                    : item.state === "ready" && run
                                      ? "待分析"
                                      : labels[item.state]}
                            </span>
                            {item.error && <small>{item.error}</small>}
                          </td>
                          <td>
                            {item.valuation ? (
                              <>
                                {item.profileChanged && <small>上次结果</small>}
                                <strong>{valuationDecisionLabel(item.valuation)}</strong>
                                <small>
                                  {valuationPriceSummary(item.valuation).label}{" "}
                                  {valuationSummaryText(item.valuation)}
                                </small>
                                {item.valuation.comparison_mode === "listing-only" &&
                                  item.valuation.price_difference != null && (
                                    <small>{valuationPriceDifferenceText(item.valuation)}</small>
                                  )}
                                {item.valuation.comparison_mode !== "listing-only" &&
                                  item.valuation.estimated_price_difference && (
                                    <small>
                                      差额区间{" "}
                                      {valuationMoney(
                                        item.valuation.estimated_price_difference.min,
                                      )}
                                      —
                                      {valuationMoney(
                                        item.valuation.estimated_price_difference.max,
                                      )}
                                    </small>
                                  )}
                                {item.valuation.comparison_mode !== "listing-only" &&
                                  item.valuation.max_listing_price !== null && (
                                    <small>
                                      最高买入 {valuationMoney(item.valuation.max_listing_price)}
                                    </small>
                                  )}
                                {item.valuation.decision === "NEED_INFO" &&
                                  !item.valuation.estimated_value_range && (
                                    <small>查看分析里的补齐建议</small>
                                  )}
                              </>
                            ) : item.state === "completed" ? (
                              (item.score ?? "资料不足")
                            ) : (
                              "—"
                            )}
                          </td>
                          <td>
                            <button onClick={() => viewItem(item)}>
                              {item.taskId ? "查看分析" : "查看资料"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {!data?.records.items.length && (
                  <p className="analysis-empty">没有符合条件的商品</p>
                )}
                <div className="analysis-pagination">
                  <span>
                    共 {data?.records.total || 0} 件 · 第 {page} / {data?.records.totalPages || 1}{" "}
                    页
                  </span>
                  <button disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                    上一页
                  </button>
                  <button
                    disabled={page >= (data?.records.totalPages || 1)}
                    onClick={() => setPage((value) => value + 1)}
                  >
                    下一页
                  </button>
                </div>
              </div>
            ) : (
              <div className="analysis-history" role="tabpanel" aria-label="分析记录">
                <p className="analysis-list-intro">
                  每件商品一条记录，点击查看完整分析、原文与调用记录。
                </p>
                {!data?.results?.total && (
                  <p className="analysis-empty">
                    暂无已完成结果。每完成一件，结果就会自动显示在这里。
                  </p>
                )}
                <ol className="analysis-result-list" start={(resultsPage - 1) * 20 + 1}>
                  {data?.results?.items.map((entry, index) => {
                    const valuation = entry.result.valuation;
                    const previousSettings =
                      entry.profileChanged ||
                      (!!valuation &&
                        !!data?.profile?.calculationVersion &&
                        valuation.calculation_version !== data.profile.calculationVersion);
                    return (
                      <li key={entry.taskId}>
                        <article
                          className="analysis-result-card"
                          aria-label={`${(resultsPage - 1) * 20 + index + 1} ${entry.name}`}
                        >
                          <button
                            className="analysis-result-row"
                            aria-label={`查看分析详情：${entry.name}`}
                            aria-haspopup="dialog"
                            onClick={() => setTaskId(entry.taskId)}
                          >
                            <span className="analysis-result-number">
                              {(resultsPage - 1) * 20 + index + 1}
                            </span>
                            <span className="analysis-result-identity">
                              <strong className="analysis-result-name">{entry.name}</strong>
                              <span className="analysis-result-meta">
                                {entry.server} · {providerNames[entry.provider]} · {entry.model} ·{" "}
                                {displayTime(entry.completedAt)}
                              </span>
                              <span
                                className="analysis-result-summary"
                                title={entry.result.summary}
                              >
                                {entry.result.summary}
                              </span>
                            </span>
                            <span className="analysis-result-price">
                              <small>
                                {valuation ? valuationPriceSummary(valuation).label : "配置参考分"}
                              </small>
                              <strong>
                                {valuation
                                  ? valuationSummaryText(valuation)
                                  : (entry.result.score ?? "资料不足")}
                              </strong>
                              <small>挂牌 {price(entry.price)}</small>
                            </span>
                            <span className="analysis-result-action">
                              <span className="analysis-result-decision">
                                {valuation ? valuationDecisionLabel(valuation) : "已分析"}
                              </span>
                              {(entry.stale || previousSettings) && (
                                <span className="analysis-result-outdated">
                                  {entry.stale ? "资料或报价已更新" : "上次设置的结果"}
                                </span>
                              )}
                              <span className="analysis-result-open">查看详情 →</span>
                            </span>
                          </button>
                        </article>
                      </li>
                    );
                  })}
                </ol>
                {(data?.results?.total || 0) > 20 && (
                  <div className="analysis-pagination">
                    <span>
                      共 {data?.results.total} 件 · 第 {resultsPage} / {data?.results.totalPages} 页
                    </span>
                    <button
                      disabled={resultsPage <= 1}
                      onClick={() => setResultsPage((value) => value - 1)}
                    >
                      上一页
                    </button>
                    <button
                      disabled={resultsPage >= (data?.results.totalPages || 1)}
                      onClick={() => setResultsPage((value) => value + 1)}
                    >
                      下一页
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>
          <aside className="analysis-aside">
            <section className="analysis-plan-card">
              <span className="analysis-kicker">QUEUE / 顺序执行</span>
              <h2>当前分析队列</h2>
              <p>
                {run
                  ? `${providerNames[run.provider]} · ${run.model}`
                  : "选择 AI 后开始分析已有商品"}
              </p>
              <div className="analysis-current">
                <small>处理进度</small>
                <strong>
                  {finished} / {run?.total || 0}
                </strong>
                <div className="analysis-progress-track">
                  <span style={{ width: `${run?.total ? (finished / run.total) * 100 : 0}%` }} />
                </div>
                <p>
                  {active?.current
                    ? searchingEquipment
                      ? `正在联网查${searchAsset}价格 · ${active.current}`
                      : `正在分析 ${active.current}`
                    : running
                      ? "正在准备下一件商品"
                      : run?.status === "paused"
                        ? "已暂停，等待继续"
                        : "暂无正在执行的商品"}
                </p>
              </div>
              <p>
                关闭页面后，本机服务会继续处理。刷新页面会保留进度；服务关闭后可继续未完成的任务。
              </p>
            </section>
            <section className="analysis-flow-card">
              <span className="analysis-kicker">RULES / 分析依据</span>
              <h2>{valuationMode ? "估值与挂牌差异" : "历史配置参考分"}</h2>
              {valuationMode ? (
                <ol>
                  <li>
                    <span>1</span>
                    <div>
                      <strong>完整商品 + 你的 Prompt</strong>
                      <p>每件角色的全部数据库字段一次提交，保留当时的原文和规则。</p>
                    </div>
                  </li>
                  <li>
                    <span>2</span>
                    <div>
                      <strong>先核对装备和宝宝，再联网查价</strong>
                      <p>
                        按装备属性、宝宝技能与成长查全服同类挂牌，保存来源、参考价和未采用原因。
                      </p>
                    </div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>
                      <strong>比较价格，展示搜索依据</strong>
                      <p>展示总估值、价格组成和卖家要价；资料或报价不足时说明缺什么、怎么补。</p>
                    </div>
                  </li>
                </ol>
              ) : (
                <ol>
                  <li>
                    <span>1</span>
                    <div>
                      <strong>角色底子 · 40%</strong>
                      <p>根据已采集的修炼、技能等资料判断。</p>
                    </div>
                  </li>
                  <li>
                    <span>2</span>
                    <div>
                      <strong>装备 · 35%</strong>
                      <p>引用实际装备字段，不补写未采集的属性。</p>
                    </div>
                  </li>
                  <li>
                    <span>3</span>
                    <div>
                      <strong>召唤兽 · 25%</strong>
                      <p>整份原文包含全部已保存的召唤兽资料。</p>
                    </div>
                  </li>
                </ol>
              )}
              <p>
                {valuationMode
                  ? "从“分析设置”调整 Prompt 和参数。修改后只更新受影响的商品，保留历史结果及其依据。"
                  : "任一维度缺少必要资料时，总分显示“资料不足”，仍保存分析说明。分数用于配置比较。"}
              </p>
            </section>
          </aside>
        </div>
        <div className="analysis-bottom-note">
          <span>
            资料变化或行情过期后，旧结论标为“需要重新分析”；再次分析时更新相关商品，历史结果保留。
          </span>
          <a href="/">返回采集工作台 →</a>
        </div>
      </main>
      {settingsOpen && (
        <AnalysisSettings
          onClose={() => setSettingsOpen(false)}
          onSaved={() => {
            setSettingsOpen(false);
            setSettingsNotice(true);
            setRevision((value) => value + 1);
          }}
        />
      )}
      {taskId && (
        <AnalysisResultDrawer
          taskId={taskId}
          onClose={() => setTaskId(null)}
          currentCalculationVersion={data?.profile?.calculationVersion}
          onConfigure={() => {
            setTaskId(null);
            setSettingsOpen(true);
          }}
          onShowRole={(key) => {
            setTaskId(null);
            setRoleKey(key);
          }}
        />
      )}
      {roleKey && (
        <RoleDetailDrawer recordKey={roleKey} running={false} onClose={() => setRoleKey(null)} />
      )}
    </div>
  );
}
