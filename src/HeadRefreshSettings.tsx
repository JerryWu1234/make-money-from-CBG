import { useEffect, useRef, useState } from "react";
import {
  describeHeadRefresh,
  MAX_HEAD_REFRESH_SECONDS,
  validateHeadRefreshSettings,
  type HeadRefreshSettings as Settings,
} from "../server/crawler/head-refresh";

async function requestSettings(body?: Settings, signal?: AbortSignal): Promise<Settings> {
  const response = await fetch(`/api/crawl/head-refresh${body ? "/save" : ""}`, {
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
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "无法保存首页刷新设置");
  return validateHeadRefreshSettings(data);
}

export function HeadRefreshSettings() {
  const [time, setTime] = useState("1");
  const [unit, setUnit] = useState(60);
  const [random, setRandom] = useState(false);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef(false);
  const load = async (signal?: AbortSignal) => {
    setLoading(true);
    setError("");
    try {
      const settings = await requestSettings(undefined, signal);
      const nextUnit =
        settings.intervalSeconds % 3600 === 0 ? 3600 : settings.intervalSeconds % 60 === 0 ? 60 : 1;
      setSaved(settings);
      setUnit(nextUnit);
      setTime(String(settings.intervalSeconds / nextUnit));
      setRandom(settings.random);
    } catch (error) {
      if (!signal?.aborted)
        setError(error instanceof Error ? error.message : "无法读取首页刷新设置");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    const control = new AbortController();
    void load(control.signal);
    return () => control.abort();
  }, []);

  const save = async () => {
    if (pending.current) return;
    setError("");
    setNotice("");
    pending.current = true;
    setSaving(true);
    try {
      const settings = validateHeadRefreshSettings({
        intervalSeconds: Number(time) * unit,
        random,
      });
      const result = await requestSettings(settings);
      setSaved(result);
      setNotice("已保存，下次开始或继续采集时生效。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "无法保存首页刷新设置");
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  const disabled = loading || saving || !saved;
  return (
    <section className="head-refresh-settings" aria-label="列表首页刷新设置">
      <h3>列表首页刷新</h3>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="head-refresh-fields">
          <label>
            刷新间隔
            <input
              type="number"
              min={1 / unit}
              max={MAX_HEAD_REFRESH_SECONDS / unit}
              step="any"
              value={time}
              disabled={disabled}
              onChange={(event) => {
                setTime(event.target.value);
                setNotice("");
              }}
            />
          </label>
          <label>
            时间单位
            <select
              value={unit}
              disabled={disabled}
              onChange={(event) => {
                setUnit(Number(event.target.value));
                setNotice("");
              }}
            >
              <option value={1}>秒</option>
              <option value={60}>分钟</option>
              <option value={3600}>小时</option>
            </select>
          </label>
          <button className="btn-secondary" disabled={disabled} type="submit">
            {saving ? "正在保存…" : "保存刷新设置"}
          </button>
        </div>
        <label className="head-refresh-random">
          <input
            type="checkbox"
            checked={random}
            disabled={disabled}
            onChange={(event) => {
              setRandom(event.target.checked);
              setNotice("");
            }}
          />
          在设定时间内随机刷新
        </label>
      </form>
      <p className="status-note">
        {random
          ? "勾选后，每轮从1秒到设定时长之间随机抽取等待时间。"
          : "未勾选时，每次按设定时长等待。"}
        例如设置10分钟并勾选随机，每轮等待1秒至10分钟。可设置1秒至7天。
        首次开始会立即读取第一页，之后按间隔检查；列表忙时可能延后。
      </p>
      <p className="status-note">
        {loading
          ? "正在读取刷新设置…"
          : saved
            ? `当前已保存：${describeHeadRefresh(saved)}。`
            : "尚未读取到已保存的设置。"}
        设置保存在本机，下次开始或继续采集时生效；当前任务保持原设置，只影响列表首页检查。
      </p>
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
      {!loading && !saved && (
        <button className="btn-secondary" onClick={() => void load()}>
          重新读取刷新设置
        </button>
      )}
    </section>
  );
}
