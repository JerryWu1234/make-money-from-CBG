import { useCallback, useEffect, useId, useRef, useState } from "react";
import "./role-training-filter.css";

type Settings = { minTotal: number | null };
const invalidMinimum = "请输入有效的非负整数，留空表示不限。";

export function parseRoleTrainingMinimum(draft: string): number | null {
  const value = draft.trim();
  if (!value) return null;
  const minimum = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(minimum) || minimum < 0)
    throw new Error(invalidMinimum);
  return minimum;
}

async function requestSettings(body?: Settings, signal?: AbortSignal): Promise<Settings> {
  const operation = body ? "保存" : "读取";
  const response = await fetch(`/api/crawl/role-training-filter${body ? "/save" : ""}`, {
    cache: "no-store",
    ...(body
      ? {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
  });
  const data: unknown = await response.json().catch(() => {
    throw new Error(`${operation}采集前置筛选返回无效，请重试。`);
  });
  if (!response.ok)
    throw new Error(
      data && typeof data === "object" && "error" in data && typeof data.error === "string"
        ? data.error
        : `无法${operation}采集前置筛选，请重试。`,
    );
  if (!data || typeof data !== "object" || Array.isArray(data) || !("minTotal" in data))
    throw new Error(`${operation}采集前置筛选返回无效，请重试。`);
  const minTotal = data.minTotal;
  if (
    minTotal !== null &&
    (typeof minTotal !== "number" || !Number.isSafeInteger(minTotal) || minTotal < 0)
  )
    throw new Error(`${operation}采集前置筛选返回无效，请重试。`);
  return { minTotal };
}

export function RoleTrainingFilter() {
  const id = useId();
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const reading = useRef<AbortController | null>(null);
  const writing = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const load = useCallback(async () => {
    reading.current?.abort();
    const control = new AbortController();
    reading.current = control;
    setLoading(true);
    setError("");
    try {
      const settings = await requestSettings(undefined, control.signal);
      if (control.signal.aborted) return;
      setSaved(settings);
      setDraft(settings.minTotal === null ? "" : String(settings.minTotal));
    } catch (error) {
      if (!control.signal.aborted)
        setError(error instanceof Error ? error.message : "无法读取采集前置筛选，请重试。");
    } finally {
      if (!control.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    return () => {
      reading.current?.abort();
      writing.current?.abort();
    };
  }, [load]);

  const save = async () => {
    if (loading || !saved || pending.current) return;
    setError("");
    setNotice("");
    let minTotal: number | null;
    try {
      minTotal = parseRoleTrainingMinimum(draft);
    } catch (error) {
      setError(error instanceof Error ? error.message : invalidMinimum);
      return;
    }
    const control = new AbortController();
    writing.current = control;
    pending.current = true;
    setSaving(true);
    try {
      const settings = await requestSettings({ minTotal }, control.signal);
      if (control.signal.aborted) return;
      if (settings.minTotal !== minTotal) throw new Error("保存结果与提交值不一致，请重试核对。");
      setSaved(settings);
      // The response confirms the submitted value; it must not replace a newer draft.
      setNotice("已保存，下次开始或继续采集时生效。");
    } catch (error) {
      if (!control.signal.aborted)
        setError(error instanceof Error ? error.message : "无法保存采集前置筛选，请重试。");
    } finally {
      pending.current = false;
      if (!control.signal.aborted) setSaving(false);
    }
  };
  let dirty = false;
  if (saved) {
    try {
      dirty = parseRoleTrainingMinimum(draft) !== saved.minTotal;
    } catch {
      dirty = true;
    }
  }
  return (
    <section
      className="role-training-filter"
      aria-label="采集前置筛选"
      aria-busy={loading || saving}
    >
      <h2>采集前置筛选</h2>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label htmlFor={id}>
          人物四修总和 ≥
          <input
            id={id}
            type="text"
            inputMode="numeric"
            value={draft}
            placeholder="留空不限"
            disabled={loading || !saved}
            aria-describedby={`${id}-help ${id}-scope`}
            onChange={(event) => {
              setDraft(event.target.value);
              setError("");
              setNotice("");
            }}
          />
        </label>
        <button className="btn-secondary" type="submit" disabled={loading || saving || !saved}>
          {saving ? "正在保存…" : "保存前置筛选"}
        </button>
      </form>
      <p id={`${id}-help`}>
        将人物列表中攻修、防修、法修、抗法四项的当前等级相加（如21/25取21）。等于下限也通过；缺项或无法确认时仍按原采集流程处理。留空不限，0合法。
      </p>
      <p id={`${id}-scope`}>保存后在下次开始或继续采集时生效；当前采集运行保持原设置。</p>
      {saved && (
        <p>
          上次确认的设置：{saved.minTotal === null ? "不限" : `人物四修总和 ≥ ${saved.minTotal}`}。
        </p>
      )}
      <p role="status" aria-label="筛选设置状态">
        {loading
          ? "正在读取采集前置筛选…"
          : saving
            ? "正在保存采集前置筛选…"
            : notice
              ? `${notice}${dirty ? " 当前输入尚未保存。" : ""}`
              : dirty
                ? "当前输入尚未保存。"
                : saved
                  ? "设置已读取。"
                  : "尚未读取到已保存的设置。"}
      </p>
      {error && (
        <p role="alert" className="error-message">
          {error}
        </p>
      )}
      {!loading && !saved && (
        <button className="btn-secondary" type="button" onClick={() => void load()}>
          重新读取筛选设置
        </button>
      )}
    </section>
  );
}
