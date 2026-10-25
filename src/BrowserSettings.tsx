import { useCallback, useEffect, useRef, useState } from "react";

import type { OpenCbgResult } from "../server/types";

export type BrowserMode = "dedicated" | "daily";
type Settings = { mode: BrowserMode; modes: BrowserMode[]; connected: boolean; busy: boolean };
const sameModes = (left: BrowserMode[], right: BrowserMode[]) => left.join(",") === right.join(",");

async function request(body?: { modes: BrowserMode[] }, signal?: AbortSignal): Promise<Settings> {
  const response = await fetch(body ? "/api/browser/settings/save" : "/api/browser/settings", {
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    cache: "no-store",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => {
    throw new Error("浏览器设置服务响应无效，请重新读取设置");
  });
  if (!response.ok) throw new Error(data.error || "浏览器运行方式保存失败");
  if (data.modes === undefined && ["dedicated", "daily"].includes(data.mode))
    data.modes = [data.mode];
  if (
    !["dedicated", "daily"].includes(data.mode) ||
    !Array.isArray(data.modes) ||
    !data.modes.length ||
    data.modes.some((mode: unknown) => mode !== "dedicated" && mode !== "daily") ||
    typeof data.connected !== "boolean" ||
    typeof data.busy !== "boolean"
  )
    throw new Error("无法确认浏览器运行方式，请重新读取设置");
  return data as Settings;
}

export function BrowserSettings({
  active,
  onBusy,
  onMode,
  onSaved,
  onModes,
  states,
}: {
  active: boolean;
  onBusy: (busy: boolean) => void;
  onMode: (mode: BrowserMode) => void;
  onSaved: (mode: BrowserMode) => Promise<void>;
  onModes: (modes: BrowserMode[]) => void;
  states?: OpenCbgResult["browsers"];
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const mode = useRef<BrowserMode[] | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      if (pending.current) return;
      const id = ++generation.current;
      const initial = mode.current === null;
      if (initial) {
        setLoading(true);
        onBusy(true);
      }
      try {
        const data = await request(undefined, signal);
        if (id !== generation.current || signal?.aborted) return;
        const changed = mode.current !== null && !sameModes(data.modes, mode.current);
        mode.current = data.modes;
        setSettings(data);
        onMode(data.mode);
        onModes(data.modes);
        setError("");
        if (changed) await onSaved(data.mode);
      } catch (cause) {
        if (id === generation.current && !signal?.aborted)
          setError(cause instanceof Error ? cause.message : "无法读取浏览器运行方式，请重试");
      } finally {
        if (initial && id === generation.current && !signal?.aborted) {
          setLoading(false);
          onBusy(mode.current === null);
        }
      }
    },
    [onBusy, onMode, onModes, onSaved],
  );

  useEffect(() => {
    const control = new AbortController();
    if (!active || mode.current === null) void load(control.signal);
    return () => control.abort();
  }, [active, load]);
  useEffect(() => {
    if (!settings?.busy || active || saving) return;
    const control = new AbortController();
    const timer = setTimeout(() => void load(control.signal), 1500);
    return () => {
      clearTimeout(timer);
      control.abort();
    };
  }, [active, load, saving, settings]);

  const save = async (next: BrowserMode[]) => {
    if (pending.current || active || settings?.busy) return;
    if (!next.length) {
      setError("请至少保留一种浏览器方式");
      return;
    }
    if (mode.current && sameModes(next, mode.current)) return;
    ++generation.current;
    pending.current = true;
    setSaving(true);
    onBusy(true);
    setError("");
    try {
      const data = await request({ modes: next });
      if (!sameModes(data.modes, next)) throw new Error("浏览器运行方式未保存，请重试");
      mode.current = data.modes;
      setSettings(data);
      onMode(data.mode);
      onModes(data.modes);
      await onSaved(data.mode);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "浏览器运行方式保存失败，请重试");
    } finally {
      pending.current = false;
      setSaving(false);
      onBusy(false);
    }
  };

  return (
    <section className="browser-mode-settings" aria-label="浏览器运行方式">
      <fieldset disabled={loading || saving || active || settings?.busy || settings === null}>
        <legend>浏览器运行方式</legend>
        <div className="browser-mode-options">
          <label>
            <input
              type="checkbox"
              value="dedicated"
              checked={settings ? settings.modes.includes("dedicated") : true}
              onChange={(event) =>
                void save(
                  (["dedicated", "daily"] as BrowserMode[]).filter((value) =>
                    value === "dedicated" ? event.target.checked : settings?.modes.includes(value),
                  ),
                )
              }
            />
            <span>
              <strong>项目专用浏览器（保存登录）</strong>
              <small>首次需扫码，之后复用本机保存的登录；登录过期仍需扫码。</small>
            </span>
          </label>
          <label>
            <input
              type="checkbox"
              value="daily"
              checked={settings ? settings.modes.includes("daily") : true}
              onChange={(event) =>
                void save(
                  (["dedicated", "daily"] as BrowserMode[]).filter((value) =>
                    value === "daily" ? event.target.checked : settings?.modes.includes(value),
                  ),
                )
              }
            />
            <span>
              <strong>连接日常 Chrome</strong>
              <small>复用日常浏览器登录；重新建立调试连接时，Chrome 可能再次要求允许。</small>
            </span>
          </label>
        </div>
      </fieldset>
      {states?.map((state) => (
        <section
          className="browser-connection-state"
          key={state.mode}
          aria-label={state.mode === "dedicated" ? "专用浏览器状态" : "日常 Chrome 状态"}
        >
          <strong>
            {state.mode === "dedicated" ? "项目专用浏览器" : "日常 Chrome"}：
            {state.workflowStep === "completed" && state.isLoggedIn
              ? "角色列表已就绪"
              : state.running
                ? "正在启动 / 查询"
                : state.error
                  ? "连接或查询失败"
                  : "等待启动"}
          </strong>
          <p className={state.error ? "error-message" : "status-note"}>{state.message}</p>
          {state.qrCodeUrl && (
            <img
              className="browser-login-qr"
              src={state.qrCodeUrl}
              alt={`${state.mode === "dedicated" ? "专用浏览器" : "日常 Chrome"}登录二维码`}
            />
          )}
        </section>
      ))}
      <p className="status-note" role="status">
        {loading
          ? "正在读取浏览器运行方式…"
          : saving
            ? "正在保存并更新浏览器状态…"
            : active || settings?.busy
              ? "查询、采集或分析正在运行，请先暂停任务再修改启用方式。"
              : "默认同时启用两种方式；点击开始查询时同时启动并分别核对登录。已就绪的浏览器共用采集并发名额，修改勾选后需重新开始查询。"}
      </p>
      {error && (
        <p className="error-message" role="alert">
          {error}{" "}
          <button
            type="button"
            className="btn-secondary"
            disabled={saving || loading || active}
            onClick={() => void load()}
          >
            重新读取设置
          </button>
        </p>
      )}
    </section>
  );
}
