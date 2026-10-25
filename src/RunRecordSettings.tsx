import { useEffect, useRef, useState } from "react";

type StoragePreview = {
  token: string;
  runs: number;
  files: number;
  bytes: number;
  protectedRuns: string[];
};
type ClearResult = {
  removedRuns: number;
  removedFiles: number;
  freedBytes: number;
  skippedRuns: string[];
  errors: { runId: string; message: string }[];
};

function storageSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

async function request(path: string, body?: object, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(path.startsWith("/api/logs/") ? 60000 : 15000);
  const response = await fetch(path, {
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    cache: "no-store",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  const data = await response.json().catch(() => {
    throw new Error("服务未返回有效结果，请重试");
  });
  if (!response.ok) throw new Error(data.error || "运行记录操作失败");
  return data;
}

export function RunRecordSettings() {
  const [saveScreenshots, setSaveScreenshots] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<StoragePreview | null>(null);
  const [clearError, setClearError] = useState("");
  const [clearNotice, setClearNotice] = useState("");
  const settingsPending = useRef(false);
  const cleanupPending = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);

  const loadSettings = async (signal?: AbortSignal) => {
    setLoading(true);
    setSettingsError("");
    try {
      const data = await request("/api/runtime/settings", undefined, signal);
      if (typeof data.saveScreenshots !== "boolean") throw new Error("截图设置返回无效，请重试");
      setSaveScreenshots(data.saveScreenshots);
    } catch (error) {
      if (!signal?.aborted)
        setSettingsError(error instanceof Error ? error.message : "无法读取截图设置，请重试");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    const control = new AbortController();
    void loadSettings(control.signal);
    return () => control.abort();
  }, []);
  useEffect(() => {
    if (preview && !dialog.current?.open) dialog.current?.showModal();
    else if (!preview) dialog.current?.close();
  }, [preview]);

  const saveSetting = async (checked: boolean) => {
    if (settingsPending.current) return;
    settingsPending.current = true;
    setSaving(true);
    setSettingsError("");
    try {
      const data = await request("/api/runtime/settings/save", { saveScreenshots: checked });
      if (typeof data.saveScreenshots !== "boolean")
        throw new Error("截图设置保存结果无效，请重试");
      setSaveScreenshots(data.saveScreenshots);
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "截图设置保存失败，请重试");
    } finally {
      settingsPending.current = false;
      setSaving(false);
    }
  };
  const previewCleanup = async () => {
    if (cleanupPending.current) return;
    cleanupPending.current = true;
    setPreviewing(true);
    setClearError("");
    setClearNotice("");
    try {
      const data = (await request("/api/logs/storage")) as StoragePreview;
      if (
        typeof data.token !== "string" ||
        !data.token ||
        ![data.runs, data.files, data.bytes].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        !Array.isArray(data.protectedRuns)
      )
        throw new Error("清理预览返回无效，请重新预览");
      setPreview(data);
    } catch (error) {
      setClearError(error instanceof Error ? error.message : "无法读取清理范围，请重试");
    } finally {
      cleanupPending.current = false;
      setPreviewing(false);
    }
  };
  const clearLogs = async () => {
    if (!preview || cleanupPending.current) return;
    cleanupPending.current = true;
    setClearing(true);
    setClearError("");
    try {
      const result = (await request("/api/logs/clear", { token: preview.token })) as ClearResult;
      if (
        ![result.removedRuns, result.removedFiles, result.freedBytes].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        !Array.isArray(result.skippedRuns) ||
        !Array.isArray(result.errors)
      )
        throw new Error("清理结果无法确认，请重新预览后核对");
      setClearNotice(
        `已清理 ${result.removedRuns} 个运行、${result.removedFiles} 个文件，释放 ${storageSize(result.freedBytes)}。` +
          (result.skippedRuns.length
            ? `另有 ${result.skippedRuns.length} 个运行受保护，已保留。`
            : ""),
      );
      if (result.errors.length)
        setClearError(
          `部分记录未能清理：${result.errors.map((error) => error.message).join("；")}。请重新预览核对后再清理。`,
        );
    } catch (error) {
      setClearError(
        `清理结果未确认（${error instanceof Error ? error.message : "服务连接中断"}）。请重新预览核对。`,
      );
    } finally {
      setPreview(null);
      cleanupPending.current = false;
      setClearing(false);
    }
  };

  return (
    <div className="run-record-settings" role="group" aria-label="运行记录设置">
      <div className="run-record-controls">
        <label className="equipment-analysis-toggle">
          <input
            type="checkbox"
            checked={saveScreenshots === true}
            disabled={loading || saving || saveScreenshots === null}
            onChange={(event) => void saveSetting(event.target.checked)}
          />
          <strong>保存过程截图</strong>
        </label>
        <button
          type="button"
          className="btn-secondary"
          disabled={previewing || clearing || preview !== null}
          onClick={() => void previewCleanup()}
        >
          {previewing ? "正在读取清理范围…" : clearing ? "正在清理…" : "清理运行记录"}
        </button>
      </div>
      <p className="status-note" role="status">
        {loading
          ? "正在读取截图设置…"
          : saving
            ? "正在保存截图设置…"
            : saveScreenshots === null
              ? "截图设置尚未读取。"
              : saveScreenshots
                ? "已开启：后续操作会保存过程截图。"
                : "已关闭：后续操作不再保存过程截图。"}
        运行中也可切换；已保存的截图可通过清理运行记录释放空间。
      </p>
      <p className="status-note">
        清理仅删除已结束运行的截图和诊断日志，保留当前运行、商品资料和分析结果。
      </p>
      {settingsError && (
        <p role="alert" className="error-message">
          {settingsError}{" "}
          {saveScreenshots === null && (
            <button
              type="button"
              className="btn-secondary"
              disabled={loading}
              onClick={() => void loadSettings()}
            >
              重试读取截图设置
            </button>
          )}
        </p>
      )}
      {clearNotice && (
        <p role="status" className="status-note">
          {clearNotice}
        </p>
      )}
      {clearError && (
        <p role="alert" className="error-message">
          {clearError}
        </p>
      )}
      <dialog
        ref={dialog}
        className="run-record-dialog"
        aria-label="确认清理运行记录"
        onCancel={(event) => {
          if (clearing) event.preventDefault();
          else setPreview(null);
        }}
      >
        {preview && (
          <>
            <h3>清理运行记录</h3>
            <p>将删除已结束运行的过程截图和诊断日志，此操作无法撤销。</p>
            <p>
              清理范围：{preview.runs} 个运行 · {preview.files} 个文件 ·{" "}
              {storageSize(preview.bytes)}
            </p>
            <p className="status-note">
              保留 {preview.protectedRuns.length} 个受保护运行，以及全部商品资料和分析结果。
            </p>
            <div className="run-record-dialog-actions">
              <button
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
                disabled={clearing || preview.files === 0}
                onClick={() => void clearLogs()}
              >
                {clearing ? "正在清理…" : "确认清理"}
              </button>
            </div>
          </>
        )}
      </dialog>
    </div>
  );
}
