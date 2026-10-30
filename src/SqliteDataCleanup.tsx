import { useEffect, useRef, useState } from "react";
import type { CrawlStatus } from "../server/crawler/types";

export function SqliteDataCleanup({
  disabled = false,
  onCleared,
}: {
  disabled?: boolean;
  onCleared: (status: CrawlStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (!open) return;
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
  }, [open]);

  const clear = async () => {
    if (!open || disabled || pending.current) return;
    pending.current = true;
    setClearing(true);
    setError("");
    try {
      const response = await fetch("/api/crawl/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) setError(result.error || "请先暂停采集和分析，再清空数据。");
        else
          setError(
            `清空结果未确认：${result.error || "服务请求失败"}。请刷新页面核对后，再决定是否重新清空。`,
          );
        return;
      }
      if (result.running !== false || result.totalSaved !== 0)
        throw new Error("服务未返回有效的清空结果");
      onCleared(result as CrawlStatus);
      setNotice("SQLite 业务数据已清空。");
    } catch (failure) {
      setError(
        `清空结果未确认：${failure instanceof Error ? failure.message : "服务连接中断"}。请刷新页面核对后，再决定是否重新清空。`,
      );
    } finally {
      pending.current = false;
      setClearing(false);
      setOpen(false);
    }
  };

  return (
    <div role="group" aria-label="SQLite 数据清理">
      <button
        type="button"
        className="btn-secondary"
        disabled={disabled || open || clearing}
        onClick={() => {
          setNotice("");
          setError("");
          setOpen(true);
        }}
      >
        {clearing ? "正在清空…" : "清空 SQLite 数据"}
      </button>
      <p className="status-note">清空已采集商品和分析数据；采集或分析运行时不可清空。</p>
      {notice && (
        <p role="status" className="status-note">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      <dialog
        ref={dialog}
        className="run-record-dialog"
        aria-label="确认清空 SQLite 数据"
        onCancel={(event) => {
          if (pending.current) event.preventDefault();
          else setOpen(false);
        }}
      >
        <h3>清空 SQLite 数据</h3>
        <p>
          将删除全部已采集商品、详情和原文历史、数据库内的分析输入、结果与调用记录、榜单已查看标记及采集断点，此操作无法撤销。
        </p>
        <p>清空成功后会关闭定时采集计划。</p>
        <p className="status-note">
          保留登录、设置、区服行情、运行日志和文件，以及数据库文件和表结构。
        </p>
        <div className="run-record-dialog-actions">
          <button
            autoFocus
            type="button"
            className="btn-secondary"
            disabled={clearing}
            onClick={() => setOpen(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={disabled || clearing}
            onClick={() => void clear()}
          >
            {clearing ? "正在清空…" : "确认清空"}
          </button>
        </div>
      </dialog>
    </div>
  );
}
