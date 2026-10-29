import { useEffect, useRef, useState } from "react";
import { deleteIndexedDb, indexedDbNames } from "./indexeddb-cleanup";

export function IndexedDbCleanup() {
  const [preview, setPreview] = useState<string[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [removed, setRemoved] = useState(0);
  const [blocked, setBlocked] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const showing = preview !== null;

  useEffect(() => {
    if (!showing) return;
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
  }, [showing]);

  const previewCleanup = async () => {
    if (pending.current) return;
    pending.current = true;
    setPreviewing(true);
    setNotice("");
    setError("");
    try {
      setPreview(await indexedDbNames(window.indexedDB));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "无法读取 IndexedDB 数据库列表。");
    } finally {
      pending.current = false;
      setPreviewing(false);
    }
  };

  const clear = async () => {
    if (!preview || pending.current) return;
    pending.current = true;
    setClearing(true);
    setRemoved(0);
    setBlocked("");
    setError("");
    let count = 0;
    try {
      const factory = window.indexedDB;
      const names = await indexedDbNames(factory);
      setPreview(names);
      for (const name of names) {
        setBlocked("");
        await deleteIndexedDb(factory, name, () =>
          setBlocked(
            `数据库「${name || "（空名称）"}」仍被其他页面占用。请关闭占用页面，清理会在连接关闭后继续。`,
          ),
        );
        count++;
        setRemoved(count);
      }
      setNotice(`已清除当前站点的 ${count} 个 IndexedDB 数据库。`);
    } catch (failure) {
      setError(
        `已清除 ${count} 个数据库，其余数据库尚未确认清除：${failure instanceof Error ? failure.message : "删除失败"}。请重新预览核对。`,
      );
    } finally {
      setPreview(null);
      setBlocked("");
      pending.current = false;
      setClearing(false);
    }
  };

  return (
    <div role="group" aria-label="本地 IndexedDB 数据">
      <button
        type="button"
        className="btn-secondary"
        disabled={previewing || clearing || showing}
        onClick={() => void previewCleanup()}
      >
        {previewing ? "正在读取本地数据…" : clearing ? "正在清除…" : "清除本地 IndexedDB"}
      </button>
      <p className="status-note">仅清除当前站点浏览器中的 IndexedDB；已采集商品和分析记录保留。</p>
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
        aria-label="确认清除本地 IndexedDB"
        onCancel={(event) => {
          if (pending.current) event.preventDefault();
          else setPreview(null);
        }}
      >
        {preview && (
          <>
            <h3>清除本地 IndexedDB</h3>
            <p>仅删除当前站点的 IndexedDB 数据库及其中的全部内容，此操作无法撤销。</p>
            <p className="status-note">保留已采集商品、分析记录、Cookie 和 localStorage。</p>
            <p>清理范围：{preview.length} 个数据库</p>
            {preview.length ? (
              <ul>
                {preview.map((name) => (
                  <li key={name}>{name || "（空名称）"}</li>
                ))}
              </ul>
            ) : (
              <p>当前站点没有 IndexedDB 数据库，无需清除。</p>
            )}
            {clearing && (
              <p role="status">
                正在清除数据库…已完成 {removed} / {preview.length}
              </p>
            )}
            {blocked && (
              <p role="status" className="status-note">
                {blocked}
              </p>
            )}
            <div className="run-record-dialog-actions">
              <button
                autoFocus
                type="button"
                className="btn-secondary"
                disabled={clearing}
                onClick={() => setPreview(null)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={clearing || preview.length === 0}
                onClick={() => void clear()}
              >
                {clearing ? "正在清除…" : "确认清除"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
