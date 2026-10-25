import { useCallback, useEffect, useRef, useState } from "react";
import { pollingError } from "./request-error";
import { DEFAULT_CRAWL_CONCURRENCY, type CrawlStatus } from "../server/crawler/types";
import { RoleDetailDrawer } from "./RoleDetailDrawer";
import { SavedRoleList, displayTime } from "./SavedRoleList";
import { ScanSchedulePanel } from "./ScanSchedulePanel";
import { RunRecordSettings } from "./RunRecordSettings";
import { replaceSavedRecordKey, savedRecordKey } from "./saved-view-state";

type Status = CrawlStatus & {
  recent?: { key: string; name: string; price: string; status: string; error?: string }[];
};
export function CrawlPanel({
  ready,
  onRunning,
  onPrepare,
  preparationError,
}: {
  ready: boolean;
  onRunning: (running: boolean) => void;
  onPrepare?: () => Promise<void>;
  preparationError?: string | null;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [transportError, setTransportError] = useState("");
  const [busy, setBusy] = useState(false);
  const [waitingForReady, setWaitingForReady] = useState(false);
  const pendingStart = useRef(false);
  const [concurrency, setConcurrency] = useState(String(DEFAULT_CRAWL_CONCURRENCY));
  const [analyzeEquipment, setAnalyzeEquipment] = useState<boolean | null>(null);
  const [savingMode, setSavingMode] = useState(false);
  useEffect(() => {
    const control = new AbortController();
    void fetch("/api/crawl/settings", { signal: control.signal, cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || typeof data.analyzeEquipment !== "boolean")
          throw new Error(data.error || "无法读取装备分析设置");
        setAnalyzeEquipment(data.analyzeEquipment);
      })
      .catch((e) => {
        if (!control.signal.aborted) setError(e.message);
      });
    return () => control.abort();
  }, []);
  const saveMode = async (checked: boolean) => {
    setSavingMode(true);
    setError("");
    try {
      const response = await fetch("/api/crawl/settings/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analyzeEquipment: checked }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "开关保存失败");
      setAnalyzeEquipment(data.analyzeEquipment);
    } catch (e) {
      setError(e instanceof Error ? e.message : "开关保存失败");
    } finally {
      setSavingMode(false);
    }
  };
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
        if (!closed) setTransportError(pollingError(e, "读取采集进度"));
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
  const action = useCallback(
    async (command: "start" | "stop") => {
      const count = Number(concurrency);
      if (command === "start" && (!Number.isSafeInteger(count) || count < 2 || count % 2 !== 0)) {
        setError("并发数必须是正偶数（2、4、6…）");
        return;
      }
      setBusy(true);
      setError("");
      try {
        if (command === "stop" && pendingStart.current) {
          pendingStart.current = false;
          setWaitingForReady(false);
          return;
        }
        if (command === "start" && !ready) {
          if (!onPrepare) throw new Error("请先进入角色列表，再继续采集");
          pendingStart.current = true;
          setWaitingForReady(true);
          await onPrepare();
          return;
        }
        const response = await fetch(`/api/crawl/${command}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command === "start" ? { concurrency: count } : {}),
          signal: AbortSignal.timeout(15000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "采集操作失败");
        setStatus(data);
        onRunning(data.running);
      } catch (e) {
        pendingStart.current = false;
        setWaitingForReady(false);
        setError(e instanceof Error ? e.message : "采集操作失败");
      } finally {
        setBusy(false);
      }
    },
    [concurrency, onPrepare, onRunning, ready],
  );
  useEffect(() => {
    if (!waitingForReady || !pendingStart.current) return;
    if (preparationError) {
      pendingStart.current = false;
      setWaitingForReady(false);
      setError(preparationError);
    } else if (ready) {
      pendingStart.current = false;
      setWaitingForReady(false);
      void action("start");
    }
  }, [action, preparationError, ready, waitingForReady]);
  return (
    <section className="crawl-panel" aria-label="详情采集">
      <h2>详情采集与续采</h2>
      <p className="status-note">
        始终完整采集角色、装备、灵饰、宝宝等资料并保存到 SQLite；资料完整后才进入分析。
      </p>
      <label className="equipment-analysis-toggle">
        <input
          type="checkbox"
          checked={analyzeEquipment === true}
          disabled={analyzeEquipment === null || savingMode || busy}
          onChange={(event) => void saveMode(event.target.checked)}
        />
        <strong>分析装备</strong>
      </label>
      <p className="status-note" role="status">
        {analyzeEquipment === null
          ? "正在读取分析模式…"
          : savingMode
            ? "正在保存…"
            : analyzeEquipment
              ? "已开启：分析时按查价范围核对装备等资产的挂牌价格。"
              : "已关闭（默认）：只分析裸号本体，不查装备、灵饰、宝宝及玉魄价格；采集仍保留全部资料。"}
        开关只影响新分析任务；已开始的分析沿用原设置。
      </p>
      <RunRecordSettings />
      <label className="crawl-concurrency">
        并发抓取数
        <input
          type="number"
          min="2"
          step="2"
          value={concurrency}
          disabled={busy || waitingForReady || !!status?.running}
          onChange={(event) => setConcurrency(event.target.value)}
        />
      </label>
      <div className="crawl-actions">
        <button
          className="btn-primary"
          disabled={
            busy ||
            waitingForReady ||
            !!status?.running ||
            (!ready && !(status?.checkpoint && onPrepare))
          }
          onClick={() => void action("start")}
        >
          {waitingForReady
            ? "正在恢复采集准备…"
            : status?.checkpoint
              ? "继续采集 / 检查新增"
              : "开始采集详情"}
        </button>
        <button
          className="btn-secondary"
          disabled={busy || (!status?.running && !waitingForReady)}
          onClick={() => void action("stop")}
        >
          {waitingForReady ? "取消继续采集" : "暂停采集"}
        </button>
      </div>
      {waitingForReady && (
        <p role="status" className="status-note">
          正在恢复 Chrome 连接和角色列表；如需授权或扫码，请按页面提示完成，之后自动继续采集。
        </p>
      )}
      <p className="status-note">
        并发数只支持正偶数，默认 {DEFAULT_CRAWL_CONCURRENCY}
        个。开始或继续时，先用全部并发名额补采已保存的未完成任务，不分新老；补采结束后再发现商品。
        持续采集时，有新号排队就优先派发新号，没有新号待派时用老号补空位；已经在途的老号继续完成。
        失败任务独立保留，完整入库后才发布为商品并进入分析。列表首页约每 60
        秒检查一次，同时逐页核对历史列表。修改后在下次开始或继续采集时生效。
      </p>
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
          <p
            role={status.phase === "error" ? "alert" : undefined}
            className={status.phase === "error" ? "error-message" : undefined}
          >
            {status.message}
          </p>
          {status.running && (
            <p>本轮并发上限：{status.concurrency ?? DEFAULT_CRAWL_CONCURRENCY} 个角色</p>
          )}
          {(status.captureStrategy === "new-first" ||
            status.newRunning !== undefined ||
            status.oldRunning !== undefined) && (
            <p aria-label="采集双队列状态">
              {status.phase === "retrying"
                ? "已保存任务优先补采 · "
                : status.captureStrategy === "new-first"
                  ? "新号优先 · "
                  : ""}
              当前在途 {(status.newRunning ?? 0) + (status.oldRunning ?? 0)} 个 · 新号在途{" "}
              {status.newRunning ?? 0} · 老号在途 {status.oldRunning ?? 0}
              {` · 新号排队 ${status.newQueued ?? 0} · 老号排队 ${status.oldQueued ?? 0}`}
            </p>
          )}
          {status.phase !== "retrying" && status.nextHeadCheckAt && (
            <p className="status-note">
              首页下次检查：{displayTime(status.nextHeadCheckAt)}
              {status.headCheckedAt ? ` · 上次检查：${displayTime(status.headCheckedAt)}` : ""}
              {status.headPage ? ` · 新号检查至第 ${status.headPage} 页` : ""}
              {status.historyPage ? ` · 老号回补至第 ${status.historyPage} 页` : ""}
            </p>
          )}
          <p>
            第 {status.page} / {status.totalPages} 页 · 本轮保存 {status.saved} · 跳过{" "}
            {status.skipped} · 本轮待重试 {status.failed || 0} · 库内完整商品 {status.totalSaved}
          </p>
          {!!status.retryTotal && (
            <p>
              优先处理采集任务：{status.retryCompleted || 0} / {status.retryTotal} 条
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
          {status.latestComplete && (
            <p className="status-note">
              最近完整采集：{displayTime(status.latestComplete.collectedAt)} · 商品{" "}
              {status.latestComplete.key}
            </p>
          )}
          {status.checkpoint && (
            <p className="status-note">
              历史扫描断点：{displayTime(status.checkpoint.savedAt)} · 商品 {status.checkpoint.key}{" "}
              · 第 {status.checkpoint.page} 页
            </p>
          )}
          <p className="status-note">
            数据库：{status.database}
            。继续采集会先处理已保存的采集任务；只有完整资料才能入商品库，排序无法证明有序时自动逐页核对。
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
