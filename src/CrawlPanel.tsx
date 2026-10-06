import { useCallback, useEffect, useState } from "react";
import type { CrawlStatus } from "../server/crawler/types";
import { RoleDetailDrawer } from "./RoleDetailDrawer";
import { SavedRoleList, displayTime } from "./SavedRoleList";
import { ScanSchedulePanel } from "./ScanSchedulePanel";
import { replaceSavedRecordKey, savedRecordKey } from "./saved-view-state";

type Status = CrawlStatus & {
  recent?: { key: string; name: string; price: string; status: string; error?: string }[];
};
export function CrawlPanel({
  ready,
  onRunning,
}: {
  ready: boolean;
  onRunning: (running: boolean) => void;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [transportError, setTransportError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState(savedRecordKey);
  const selectRecord = useCallback((key: string | null) => {
    setSelectedKey(key);
    replaceSavedRecordKey(key);
  }, []);
  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch("/api/crawl/status", {
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "无法读取采集进度");
        if (!closed) {
          setStatus(data);
          if (!data.running && data.totalSaved === 0 && !data.recent?.length) selectRecord(null);
          setTransportError("");
          onRunning(data.running);
        }
      } catch (e) {
        if (!closed) setTransportError(e instanceof Error ? e.message : "采集服务不可用");
      } finally {
        if (!closed) timer = setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, [onRunning, selectRecord]);
  const action = async (command: "start" | "stop" | "backfill") => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/crawl/${command}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "采集操作失败");
      setStatus(data);
      onRunning(data.running);
    } catch (e) {
      setError(e instanceof Error ? e.message : "采集操作失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="crawl-panel" aria-label="详情采集">
      <h2>详情采集与续采</h2>
      <p className="status-note">
        逐条悬停核对商品，读取详情标签及装备、召唤兽资料，并自动翻页保存到
        SQLite。已采集商品跳过详情。
        每个角色的全部标签处理完才会保存，当前页所有角色处理完后自动进入下一页。
      </p>
      <div className="crawl-actions">
        <button
          className="btn-primary"
          disabled={busy || !!status?.running || !ready}
          onClick={() => void action("start")}
        >
          {status?.checkpoint ? "继续采集 / 检查新增" : "开始采集详情"}
        </button>
        <button
          className="btn-secondary"
          disabled={busy || !!status?.running || !ready}
          onClick={() => void action("backfill")}
        >
          补齐已保存商品的估值资料
        </button>
        <button
          className="btn-secondary"
          disabled={busy || !status?.running}
          onClick={() => void action("stop")}
        >
          暂停采集
        </button>
      </div>
      <p className="status-note">手动开始采集会关闭已启用的定时计划。</p>
      <ScanSchedulePanel ready={ready} running={!!status?.running} />
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {transportError && (
        <p role="status" className="error-message">
          {transportError}
        </p>
      )}
      {status && (
        <div aria-live="polite">
          <p>{status.message}</p>
          <p>
            第 {status.page} / {status.totalPages} 页 · 本轮保存 {status.saved} · 跳过{" "}
            {status.skipped} · 本轮待重试 {status.failed || 0} · 库内完整商品 {status.totalSaved}
          </p>
          {!!status.retryTotal && (
            <p>
              优先补采：{status.retryCompleted || 0} / {status.retryTotal} 条未完成详情
            </p>
          )}
          {status.current && <p>当前商品：{status.current}</p>}
          {!!status.itemsOnPage && (
            <p>
              本页进度：{status.itemIndex || 0} / {status.itemsOnPage} 个角色
            </p>
          )}
          {status.running && status.detailProgress && (
            <p className="crawl-progress">{status.detailProgress}</p>
          )}
          {status.strategy && <p className="status-note">{status.strategy}</p>}
          {status.checkpoint && (
            <p className="status-note">
              上次成功入库：{displayTime(status.checkpoint.savedAt)} · 商品 {status.checkpoint.key}{" "}
              · 第 {status.checkpoint.page} 页
            </p>
          )}
          <p className="status-note">
            数据库：{status.database}
            。继续采集会先按已保存商品链接补采未完成详情；排序无法证明有序时自动逐页核对。
          </p>
          {status.lastItemError && (
            <p className="status-note">最近待重试：{status.lastItemError}</p>
          )}
        </div>
      )}
      <SavedRoleList
        running={!!status?.running}
        selectedKey={selectedKey}
        onSelect={selectRecord}
      />
      {selectedKey && (
        <RoleDetailDrawer
          recordKey={selectedKey}
          running={!!status?.running}
          onClose={() => selectRecord(null)}
        />
      )}
    </section>
  );
}
