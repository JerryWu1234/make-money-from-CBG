import { useEffect, useState } from "react";
import type { SavedListingPage } from "../server/crawler/types";
import { replaceSavedRecordsPage, savedRecordsPage } from "./saved-view-state";

export function displayTime(value?: string | null) {
  return value
    ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })
    : "—";
}

export function SavedRoleList({
  running,
  selectedKey,
  onSelect,
}: {
  running: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [page, setPage] = useState(savedRecordsPage);
  const [data, setData] = useState<SavedListingPage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const control = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const response = await fetch(`/api/crawl/records?page=${page}&pageSize=20`, {
          cache: "no-store",
          signal: AbortSignal.any([control.signal, AbortSignal.timeout(8000)]),
        });
        const result = await response.json();
        if (!response.ok || !Array.isArray(result.items))
          throw new Error(result.error || "无法读取已采集角色");
        if (!control.signal.aborted) {
          setData(result);
          setError("");
          if (result.page !== page) {
            setPage(result.page);
            replaceSavedRecordsPage(result.page);
          }
        }
      } catch (error) {
        if (!control.signal.aborted)
          setError(error instanceof Error ? error.message : "列表读取失败");
      } finally {
        if (!control.signal.aborted) timer = setTimeout(() => void load(), running ? 2000 : 5000);
      }
    };
    setData(null);
    void load();
    return () => {
      control.abort();
      clearTimeout(timer);
    };
  }, [page, running]);
  return (
    <section className="saved-roles" aria-label="已采集角色">
      <h2>已采集角色</h2>
      <p className="status-note">
        全部已采集记录，任务结束或刷新页面后仍可查看。点击任意一行查看详情，时间均为北京时间。
      </p>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {!data && !error && <p>正在加载已采集数据…</p>}
      {data && (
        <>
          <p>
            共 {data.total} 条 · 第 {data.page} / {data.totalPages} 页
          </p>
          {data.items.length ? (
            <div className="role-table-scroll">
              <table className="saved-role-table">
                <thead>
                  <tr>
                    <th>角色 / 价格</th>
                    <th>服务器</th>
                    <th>原商品</th>
                    <th>亮点</th>
                    <th>上架时间</th>
                    <th>采集时间</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((item) => (
                    <tr
                      key={item.key}
                      className="role-list-row"
                      data-selected={selectedKey === item.key}
                      onClick={(event) => {
                        if (event.target instanceof HTMLElement && event.target.closest("a"))
                          return;
                        if (
                          !(event.target instanceof HTMLElement && event.target.closest("button"))
                        )
                          event.currentTarget
                            .querySelector("button")
                            ?.focus({ preventScroll: true });
                        onSelect(item.key);
                      }}
                    >
                      <td>
                        <button aria-pressed={selectedKey === item.key} aria-haspopup="dialog">
                          {item.name || item.key} · ¥{item.price}
                          <small className="view-detail-hint">查看详情 →</small>
                        </button>
                      </td>
                      <td>{item.serverName || `服务器 ${item.serverId}`}</td>
                      <td>
                        <a href={item.url} target="_blank" rel="noreferrer">
                          打开原页 ↗
                        </a>
                      </td>
                      <td>{item.highlights.join(" · ") || "—"}</td>
                      <td>{displayTime(item.sellingTime)}</td>
                      <td>
                        {item.status === "complete"
                          ? displayTime(item.collectedAt)
                          : "详情尚未完成"}
                        <small>最近发现：{displayTime(item.lastSeenAt)}</small>
                      </td>
                      <td>
                        {item.status === "complete"
                          ? item.valuationReady === false
                            ? "估值资料待补齐"
                            : item.captureMode === "body"
                              ? "裸号资料已采集"
                              : "已采集"
                          : item.status === "failed"
                            ? "待重试"
                            : running
                              ? "详情采集中"
                              : "待续采"}
                        {item.error && <small>{item.error}</small>}
                        {item.status !== "complete" && item.lastAttemptAt && (
                          <small>
                            已尝试 {item.attemptCount} 次：{displayTime(item.lastAttemptAt)}
                          </small>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>尚无采集记录，开始采集后会自动显示。</p>
          )}
          <div className="crawl-actions" aria-label="采集记录分页">
            <button
              className="btn-secondary"
              disabled={data.page <= 1}
              onClick={() => {
                const next = data.page - 1;
                setPage(next);
                replaceSavedRecordsPage(next);
              }}
            >
              上一页
            </button>
            <span>
              第 {data.page} / {data.totalPages} 页
            </span>
            <button
              className="btn-secondary"
              disabled={data.page >= data.totalPages}
              onClick={() => {
                const next = data.page + 1;
                setPage(next);
                replaceSavedRecordsPage(next);
              }}
            >
              下一页
            </button>
          </div>
        </>
      )}
    </section>
  );
}
