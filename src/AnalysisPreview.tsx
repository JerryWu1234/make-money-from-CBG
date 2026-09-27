import { useEffect, useState } from "react";
import "./analysis-preview.css";

type DemoItem = {
  id: string;
  name: string;
  server: string;
  level: number;
  price: number;
  status: "complete" | "pending";
  analysisState: "ready" | "analyzed" | "analyzing" | "stopped" | "queued" | "waiting_detail";
  score?: number;
  highlights: string[];
  reason: string;
};

// 页面演示资料，不对应数据库中的真实商品或真实分析结论。
const DEMO_ITEMS: DemoItem[] = [
  {
    id: "A",
    name: "示例角色 A",
    server: "示例服务器 · 甲",
    level: 129,
    price: 2850,
    status: "complete",
    analysisState: "analyzed",
    score: 92,
    highlights: ["修炼较完整", "装备搭配均衡"],
    reason: "同价位中，角色底子与装备配置比较均衡，值得优先打开详情核对。",
  },
  {
    id: "B",
    name: "示例角色 B",
    server: "示例服务器 · 乙",
    level: 109,
    price: 1699,
    status: "complete",
    analysisState: "analyzed",
    score: 88,
    highlights: ["入手门槛低", "召唤兽配置"],
    reason: "价格较低，已展示的召唤兽与角色基础资料适合进一步比较。",
  },
  {
    id: "C",
    name: "示例角色 C",
    server: "示例服务器 · 丙",
    level: 159,
    price: 5200,
    status: "complete",
    analysisState: "analyzed",
    score: 84,
    highlights: ["角色底子", "成长空间"],
    reason: "角色资料完整，价格与养成程度的关系适合作为候选项核对。",
  },
  {
    id: "D",
    name: "示例角色 D",
    server: "示例服务器 · 丁",
    level: 175,
    price: 8600,
    status: "complete",
    analysisState: "analyzed",
    score: 76,
    highlights: ["高等级", "外观收藏"],
    reason: "资料已完整采集，可以进入分析，但暂未排在本页示例前三。",
  },
  {
    id: "E",
    name: "示例角色 E",
    server: "示例服务器 · 戊",
    level: 69,
    price: 1150,
    status: "complete",
    analysisState: "analyzing",
    highlights: ["低价格", "基础资料完整"],
    reason: "详情已完整入库，正在分析这件商品；完成并保存结果后才会处理下一件。",
  },
  {
    id: "F",
    name: "示例角色 F",
    server: "示例服务器 · 己",
    level: 59,
    price: 360,
    status: "pending",
    analysisState: "waiting_detail",
    highlights: ["详情尚未完成"],
    reason: "商品仍会出现在全部列表，补齐详情之前不生成推荐结论。",
  },
  {
    id: "G",
    name: "示例角色 G",
    server: "示例服务器 · 庚",
    level: 89,
    price: 2480,
    status: "complete",
    analysisState: "queued",
    highlights: ["详情已完整入库"],
    reason: "这件商品已排队，必须等示例角色 E 的分析结果完整保存后才开始。",
  },
];

const money = (price: number) => `¥${price.toLocaleString("zh-CN")}`;
const analysisLabel = {
  ready: "待开始",
  analyzed: "已分析",
  analyzing: "分析中",
  stopped: "已停止 · 待继续",
  queued: "等待上一件",
  waiting_detail: "待补采",
};

export function AnalysisPreview() {
  const [tab, setTab] = useState<"ranking" | "all" | "history">("ranking");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | DemoItem["analysisState"]>("all");
  const [selected, setSelected] = useState<DemoItem | null>(null);
  const [analysisStarted, setAnalysisStarted] = useState(false);
  const [queueStopped, setQueueStopped] = useState(false);
  const [recoveryPreview, setRecoveryPreview] = useState(false);

  useEffect(() => {
    if (!selected) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelected(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const displayItems = !analysisStarted
    ? DEMO_ITEMS.map((item): DemoItem =>
        item.status === "complete"
          ? { ...item, analysisState: "ready", score: undefined }
          : item,
      )
    : queueStopped
      ? DEMO_ITEMS.map((item): DemoItem => {
          if (item.id === "E") {
            return {
              ...item,
              analysisState: "stopped",
              reason: "队列已停止；当前结果不算完成。继续时先重新分析这一件。",
            };
          }
          if (item.id === "G") {
            return { ...item, reason: "队列停止期间继续等待；E 的结果完整保存后才开始。" };
          }
          return item;
        })
      : DEMO_ITEMS;
  const filteredItems = displayItems.filter((item) => {
    const matchesText = `${item.name} ${item.server} ${item.highlights.join(" ")}`
      .toLowerCase()
      .includes(search.trim().toLowerCase());
    return matchesText && (filter === "all" || item.analysisState === filter);
  });
  const queueActionLabel = !analysisStarted
    ? "开始分析已有商品"
    : queueStopped
      ? "继续分析队列"
      : "停止分析队列";
  const toggleQueue = () => {
    if (!analysisStarted) {
      setAnalysisStarted(true);
      setFilter("all");
    } else {
      setQueueStopped((current) => !current);
    }
    setRecoveryPreview(false);
  };

  return (
    <div className="analysis-page">
      <header className="analysis-topbar">
        <a className="analysis-brand" href="/" aria-label="返回采集工作台">
          <span className="analysis-brand-mark" aria-hidden="true">
            ◇
          </span>
          <span>藏宝阁助手</span>
        </a>
        <nav className="analysis-nav" aria-label="页面导航">
          <a href="/">采集与记录</a>
          <span aria-current="page">性价比分析</span>
        </nav>
        <span className="analysis-preview-pill">静态交互稿 · 无真实分析</span>
      </header>

      <main className="analysis-shell">
        <section className="analysis-hero" aria-labelledby="analysis-title">
          <div className="analysis-hero-copy">
            <span className="analysis-eyebrow">
              <span aria-hidden="true">✦</span> 入库即分析 · 页面预览
            </span>
            <h1 id="analysis-title">
              每完成一件，
              <br />
              <em>就更新一次榜单。</em>
            </h1>
            <p>
              首次点击“开始分析已有商品”，随后完整入库的商品立即进入队列，结果保存后才处理下一件，无需等到次日。手动停止会保留队列，继续时先处理未完成商品。
            </p>
            <div className="analysis-hero-actions">
              <button
                type="button"
                className={`analysis-button ${analysisStarted && !queueStopped ? "analysis-button-stop" : "analysis-button-primary"}`}
                onClick={toggleQueue}
              >
                {queueActionLabel} <span aria-hidden="true">{analysisStarted && !queueStopped ? "■" : "→"}</span>
              </button>
              {analysisStarted && (
                <button
                  type="button"
                  className="analysis-button analysis-button-quiet"
                  onClick={() =>
                    document.getElementById("analysis-queue")?.scrollIntoView({ behavior: "smooth" })
                  }
                >
                  查看逐件分析队列 <span aria-hidden="true">↗</span>
                </button>
              )}
              <button
                type="button"
                className="analysis-button analysis-button-quiet"
                onClick={() => {
                  setTab("ranking");
                  document
                    .getElementById("analysis-results")
                    ?.scrollIntoView({ behavior: "smooth" });
                }}
              >
                {analysisStarted ? "看推荐结果示例" : "推荐结果显示在哪里"} <span aria-hidden="true">↓</span>
              </button>
            </div>
            <p className="analysis-start-hint" role="status">
              {!analysisStarted
                ? "静态演示：点击只切换页面画面，不会分析真实商品。"
                : queueStopped
                  ? "队列已停止：E 未完成，G 暂不开始。继续时先重新分析 E。"
                  : "演示进度：A–D 已分析，E 正在分析，G 等待上一件。"}
            </p>
          </div>
          <div className="analysis-hero-visual" aria-hidden="true">
            <div className="analysis-visual-top">
              <span>逐件处理</span>
              <span>PREVIEW / 01</span>
            </div>
            <div className="analysis-visual-orbit">
              <span>完整入库</span>
              <span>立即分析</span>
              <span>保存结果</span>
              <span>更新榜单</span>
            </div>
            <div className="analysis-visual-focus">
              <small>当前商品</small>
              <strong>{!analysisStarted ? "待开始" : queueStopped ? "已停止" : "分析中"}</strong>
              <span>{!analysisStarted ? "6 件已有商品可分析" : queueStopped ? "E 未完成 · G 等待" : "完成后处理下一件"}</span>
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
            <small>全部商品</small>
            <strong>7 件示意商品</strong>
            <p>完整与待补采都留在总列表</p>
          </div>
          <div>
            <span className="analysis-overview-icon">02</span>
            <small>当前进度</small>
            <strong>
              {!analysisStarted
                ? "6 件待首次分析"
                : queueStopped
                  ? "4 件已分析 · 队列已停止"
                  : "4 件已分析 · 1 件分析中"}
            </strong>
            <p>
              {!analysisStarted
                ? "点击上方按钮开始处理已有商品"
                : queueStopped
                  ? "已完成结果保留，当前 E 未计完成"
                  : "每件结果保存后立即更新推荐榜"}
            </p>
          </div>
          <div>
            <span className="analysis-overview-icon">03</span>
            <small>中断恢复</small>
            <strong>{analysisStarted ? "先完成当前商品" : "启动后逐件处理"}</strong>
            <p>{analysisStarted ? "继续时先分析 E，完整保存后再处理 G" : "中断后先恢复当前商品，再处理下一件"}</p>
          </div>
        </div>

        <div className="analysis-workspace">
          <section
            id="analysis-results"
            className="analysis-results"
            aria-labelledby="analysis-results-title"
          >
            <div className="analysis-section-heading">
              <div>
                <span className="analysis-kicker">RESULTS / 结果区</span>
                <h2 id="analysis-results-title">分析结果</h2>
                <p>推荐榜随单件完成更新；全部商品保留每个 item 的分析状态。</p>
              </div>
              <span className="analysis-demo-label">以下数据仅供页面演示</span>
            </div>

            <div className="analysis-tabbar" role="tablist" aria-label="分析结果视图">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "ranking"}
                onClick={() => setTab("ranking")}
              >
                推荐榜 <span>{analysisStarted ? "03" : "00"}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "all"}
                onClick={() => setTab("all")}
              >
                全部商品 <span>07</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "history"}
                onClick={() => setTab("history")}
              >
                分析记录
              </button>
            </div>

            {tab === "ranking" ? (
              <div className="analysis-rank-list" role="tabpanel" aria-label="推荐榜示例">
                <div className="analysis-list-intro">
                  <span>{analysisStarted ? "当前已分析 4 件 · 展示前 3 名" : "尚未开始分析 · 暂无推荐结果"}</span>
                  <span>新商品完成分析后，榜单会重新排序</span>
                </div>
                {!analysisStarted && (
                  <div className="analysis-start-empty">
                    <strong>推荐榜等待首次分析</strong>
                    <p>点击页面顶部“开始分析已有商品”，查看逐件处理与榜单更新的演示画面。</p>
                  </div>
                )}
                {(analysisStarted ? DEMO_ITEMS.slice(0, 3) : []).map((item, index) => (
                  <article
                    className={`analysis-rank-card ${index === 0 ? "analysis-rank-first" : ""}`}
                    key={item.id}
                  >
                    <div className="analysis-rank-number">
                      {String(index + 1).padStart(2, "0")}
                      <small>TOP PICK</small>
                    </div>
                    <div className="analysis-rank-main">
                      <div className="analysis-rank-title">
                        <h3>{item.name}</h3>
                        <span>
                          {item.level} 级 · {item.server}
                        </span>
                      </div>
                      <p>{item.reason}</p>
                      <div className="analysis-tags">
                        {item.highlights.map((highlight) => (
                          <span key={highlight}>{highlight}</span>
                        ))}
                      </div>
                    </div>
                    <div className="analysis-rank-side">
                      <small>挂牌价格</small>
                      <strong>{money(item.price)}</strong>
                      <span>演示评分 {item.score}</span>
                      <button type="button" onClick={() => setSelected(item)}>
                        查看分析依据 <span aria-hidden="true">→</span>
                      </button>
                    </div>
                  </article>
                ))}
                {analysisStarted && <div className="analysis-more">
                  <span>想看未进入推荐榜的商品？</span>
                  <button type="button" onClick={() => setTab("all")}>
                    查看全部商品 <span aria-hidden="true">→</span>
                  </button>
                </div>}
              </div>
            ) : tab === "all" ? (
              <div className="analysis-all-list" role="tabpanel" aria-label="全部商品列表示例">
                <div className="analysis-list-intro">
                  <span>
                    全部商品 · {filteredItems.length} / {displayItems.length} 条示意
                  </span>
                  <span>正式版将显示所有已采集 item</span>
                </div>
                <div className="analysis-filterbar">
                  <label className="analysis-search">
                    <span aria-hidden="true">⌕</span>
                    <input
                      type="search"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="搜索角色、服务器、亮点"
                      aria-label="搜索示意商品"
                    />
                  </label>
                  <label className="analysis-filter">
                    <span>分析状态</span>
                    <select
                      value={filter}
                      onChange={(event) => setFilter(event.target.value as typeof filter)}
                    >
                      <option value="all">全部状态</option>
                      <option value="ready">待开始</option>
                      <option value="analyzed">已分析</option>
                      <option value="analyzing">分析中</option>
                      <option value="stopped">已停止 · 待继续</option>
                      <option value="queued">等待上一件</option>
                      <option value="waiting_detail">待补采</option>
                    </select>
                  </label>
                </div>
                <p className="analysis-mobile-table-hint">左右滑动表格查看更多字段 →</p>
                <div className="analysis-table-scroll">
                  <table className="analysis-table">
                    <thead>
                      <tr>
                        <th>商品</th>
                        <th>挂牌价格</th>
                        <th>服务器</th>
                        <th>资料亮点</th>
                        <th>详情状态</th>
                        <th>分析状态 / 结果</th>
                        <th>
                          <span className="sr-only">操作</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredItems.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong>{item.name}</strong>
                            <small>
                              {item.level} 级 · item {item.id}
                            </small>
                          </td>
                          <td className="analysis-table-price">{money(item.price)}</td>
                          <td>{item.server}</td>
                          <td>{item.highlights.join(" · ")}</td>
                          <td>
                            <span
                              className={`analysis-status ${item.status === "complete" ? "is-complete" : "is-pending"}`}
                            >
                              {item.status === "complete" ? "详情完整" : "待补采"}
                            </span>
                          </td>
                          <td>
                            <span className={`analysis-state analysis-state-${item.analysisState}`}>
                              {analysisLabel[item.analysisState]}
                            </span>
                            <small>{item.score ? `演示评分 ${item.score}` : "暂无评分"}</small>
                          </td>
                          <td>
                            <button
                              type="button"
                              onClick={() => setSelected(item)}
                              aria-label={`查看${item.name}的展示详情`}
                            >
                              查看 <span aria-hidden="true">→</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {filteredItems.length === 0 && (
                  <div className="analysis-empty">没有符合当前筛选的示意商品。</div>
                )}
                <div className="analysis-list-footer">
                  正式版会显示全部已采集 item；详情未完成的商品不参与推荐。
                </div>
              </div>
            ) : (
              <div className="analysis-history" role="tabpanel" aria-label="分析记录示例">
                <div className="analysis-list-intro">
                  <span>逐件处理记录</span>
                  <span>以下顺序演示停止与中断恢复</span>
                </div>
                {analysisStarted ? <ol>
                  <li>
                    <span className="analysis-history-dot is-done" />
                    <div>
                      <strong>示例角色 D · 已分析</strong>
                      <p>结果已完整保存，榜单完成上一次更新。</p>
                    </div>
                    <small>上一件</small>
                  </li>
                  <li>
                    <span className={`analysis-history-dot ${queueStopped ? "is-stopped" : "is-current"}`} />
                    <div>
                      <strong>示例角色 E · {queueStopped ? "已停止 · 未完成" : recoveryPreview ? "恢复分析" : "分析中"}</strong>
                      <p>
                        {queueStopped
                          ? "当前结果不计完成；继续后先重新分析 E。"
                          : recoveryPreview
                          ? "重新打开后先处理这一件，不使用上次中断的半成品。"
                          : "详情已完整入库，当前只处理这一件。"}
                      </p>
                    </div>
                    <small>{queueStopped ? "已停止" : "当前"}</small>
                  </li>
                  <li>
                    <span className="analysis-history-dot" />
                    <div>
                      <strong>示例角色 G · 等待上一件</strong>
                      <p>{queueStopped ? "队列停止期间等待；E 完成并保存后才会开始。" : "只有 E 的结果完整保存，G 才会开始。"}</p>
                    </div>
                    <small>下一件</small>
                  </li>
                </ol> : (
                  <div className="analysis-start-empty">
                    <strong>暂无分析记录</strong>
                    <p>首次启动后，这里会展示当前商品、完成记录和等待顺序。</p>
                  </div>
                )}
              </div>
            )}
          </section>

          <aside className="analysis-aside" aria-label="逐件分析状态">
            <section id="analysis-queue" className="analysis-plan-card">
              <div className="analysis-aside-icon" aria-hidden="true">
                ↻
              </div>
              <span className="analysis-kicker">LIVE QUEUE / 逐件队列</span>
              <h2>{!analysisStarted ? "先启动已有商品分析" : queueStopped ? "分析队列已停止" : "入库后自动分析"}</h2>
              <p>
                {queueStopped
                  ? "停止期间不分析新商品，待处理商品留在队列。继续后先处理当前未完成的 E。"
                  : "首次启动会处理已有的完整商品；之后每件详情完整入库就进入队列。同一时间只处理一件。"}
              </p>
              <div className="analysis-auto-row">
                <span className={`analysis-auto-dot ${analysisStarted && !queueStopped ? "" : "is-idle"}`} />
                <strong>
                  {!analysisStarted
                    ? "未启动 · 6 件已有商品待分析"
                    : queueStopped
                      ? "已停止 · 队列保留"
                      : "自动分析 · 示例状态"}
                </strong>
              </div>
              <div className="analysis-current">
                <small>
                  {!analysisStarted
                    ? "首次启动前"
                    : queueStopped
                      ? "已停止 · 当前商品未完成"
                      : recoveryPreview
                        ? "重新打开后 · 优先恢复"
                        : "当前正在分析"}
                </small>
                <strong>{analysisStarted ? "示例角色 E" : "等待开始"}</strong>
                <p>
                  {!analysisStarted
                    ? "已有 6 件完整商品会按顺序进入分析，待补采的 F 暂不参与。"
                    : queueStopped
                      ? "E 的半成品不保存为结果；继续时重新分析 E，完成后才轮到 G。"
                    : recoveryPreview
                    ? "上次中断的结果未保存；先重新分析 E，完成后才会轮到 G。"
                    : "详情已完整入库。分析结果保存前，不推进到下一件。"}
                </p>
              </div>
              <ol className="analysis-queue-list">
                <li>
                  <span className="analysis-queue-index is-current">01</span>
                  <div>
                    <strong>{analysisStarted ? "示例角色 E" : "示例角色 A"}</strong>
                    <small>{!analysisStarted ? "待开始" : queueStopped ? "未完成 · 待继续" : recoveryPreview ? "恢复当前商品" : "分析中"}</small>
                  </div>
                </li>
                <li>
                  <span className="analysis-queue-index">02</span>
                  <div>
                    <strong>{analysisStarted ? "示例角色 G" : "示例角色 B"}</strong>
                    <small>{!analysisStarted ? "等待 A 完成 · 另有 4 件" : queueStopped ? "队列已停止 · 等待 E" : "等待 E 完成"}</small>
                  </div>
                </li>
              </ol>
              {analysisStarted && (
                <button
                  type="button"
                  className={`analysis-button ${queueStopped ? "analysis-button-primary" : "analysis-button-stop"}`}
                  onClick={toggleQueue}
                >
                  {queueActionLabel} <span aria-hidden="true">{queueStopped ? "→" : "■"}</span>
                </button>
              )}
              {analysisStarted && !queueStopped && (
                <button
                  type="button"
                  className="analysis-button analysis-button-outline"
                  aria-pressed={recoveryPreview}
                  onClick={() => setRecoveryPreview((current) => !current)}
                >
                  {recoveryPreview ? "返回分析中画面" : "查看关闭后重开的画面"}{" "}
                  <span aria-hidden="true">→</span>
                </button>
              )}
              <small className="analysis-draft-note">
                {!analysisStarted
                  ? "点击页面顶部按钮可查看启动后的示例进度。"
                  : queueStopped
                    ? "停止不会删除商品或已完成的结果；点击继续仅切换演示画面。"
                    : "按钮只切换展示状态；不会真正启动、停止或恢复分析。"}
              </small>
            </section>
            <section className="analysis-flow-card">
              <span className="analysis-kicker">RESUME / 恢复规则</span>
              <h2>关掉后怎么继续</h2>
              <ol>
                <li>
                  <span>01</span>
                  <div>
                    <strong>只关网页</strong>
                    <p>本地服务仍在时继续处理，重开页面同步进度。</p>
                  </div>
                </li>
                <li>
                  <span>02</span>
                  <div>
                    <strong>服务或电脑停止</strong>
                    <p>重新启动后先恢复未完成的 E，再处理 G。</p>
                  </div>
                </li>
                <li>
                  <span>03</span>
                  <div>
                    <strong>结果完整保存才前进</strong>
                    <p>中断半成品不计完成；失败停在当前商品。</p>
                  </div>
                </li>
              </ol>
            </section>
          </aside>
        </div>
        <p className="analysis-bottom-note">
          页面预览 · 队列、中断恢复、评分和推荐结果均为示意，尚未连接真实服务。
          <a href="/">返回采集工作台 →</a>
        </p>
      </main>

      {selected && (
        <div
          className="analysis-overlay"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          <section
            className="analysis-detail-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="analysis-detail-title"
          >
            <div className="analysis-modal-header">
              <div>
                <span className="analysis-kicker">ITEM / 商品分析示例</span>
                <h2 id="analysis-detail-title">{selected.name}</h2>
              </div>
              <button
                type="button"
                className="analysis-close"
                onClick={() => setSelected(null)}
                aria-label="关闭商品分析详情"
              >
                ×
              </button>
            </div>
            <div className="analysis-detail-price">
              <div>
                <small>
                  {selected.server} · {selected.level} 级
                </small>
                <strong>{money(selected.price)}</strong>
              </div>
              <span
                className={`analysis-status ${selected.status === "complete" ? "is-complete" : "is-pending"}`}
              >
                {selected.status === "complete" ? "详情完整" : "待补采"}
              </span>
            </div>
            {selected.analysisState === "analyzed" ? (
              <>
                <div className="analysis-detail-score">
                  <div>
                    <small>演示评分</small>
                    <strong>
                      {selected.score ?? "—"}
                      <span>/ 100</span>
                    </strong>
                  </div>
                  <p>仅演示未来的结果样式，并非实际计算。</p>
                </div>
                <h3>为什么值得关注</h3>
                <p className="analysis-detail-reason">{selected.reason}</p>
                <h3>分析依据会展开在这里</h3>
                <div className="analysis-factor-list">
                  <div>
                    <span>挂牌价格</span>
                    <strong>与同等级商品比较</strong>
                  </div>
                  <div>
                    <span>角色底子</span>
                    <strong>等级、修炼、技能等</strong>
                  </div>
                  <div>
                    <span>随身资产</span>
                    <strong>装备、召唤兽等</strong>
                  </div>
                </div>
              </>
            ) : (
              <div className="analysis-pending-note">
                <strong>{analysisLabel[selected.analysisState]}</strong>
                <p>{selected.reason}</p>
              </div>
            )}
            <div className="analysis-detail-bottom">
              <button
                type="button"
                className="analysis-button analysis-button-outline"
                onClick={() => setSelected(null)}
              >
                返回列表
              </button>
              <small>演示商品无真实原页链接</small>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
