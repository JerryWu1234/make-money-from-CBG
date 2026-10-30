import { useEffect, useRef, useState } from "react";
import { pollingError } from "./request-error";
import type { StoredSchedule } from "../server/crawler/schedule-store";
import type { ScanDayConfig, ScanScheduleConfig } from "../server/crawler/schedule-time";

type ScheduleStatus = StoredSchedule & {
  state: string;
  message: string;
  timezone: string;
};
type Draft = {
  scheduleType: ScanScheduleConfig["scheduleType"];
  daily: ScanScheduleConfig["daily"];
  days: ScanDayConfig[];
  maxDurationMinutes: string;
};

const WEEKDAYS = [
  [1, "周一"],
  [2, "周二"],
  [3, "周三"],
  [4, "周四"],
  [5, "周五"],
  [6, "周六"],
  [7, "周日"],
] as const;

const LABELS: Record<string, string> = {
  disabled: "已关闭",
  waiting_window: "等待执行",
  waiting_login: "等待登录",
  running: "扫描中",
  waiting_next: "等待下次执行",
  waiting_lock: "等待采集锁",
  needs_action: "需要处理",
  other_instance: "其他服务运行中",
};

type TimeSetting = { startTime: string; additionalStartTimes?: string[] };

function timesOf(setting: TimeSetting) {
  return [setting.startTime, ...(setting.additionalStartTimes ?? [])];
}

function withTimes(times: string[]): TimeSetting {
  return {
    startTime: times[0],
    additionalStartTimes: times.length > 1 ? times.slice(1) : undefined,
  };
}

function TimeInputs({
  label,
  setting,
  disabled,
  onChange,
}: {
  label: string;
  setting: TimeSetting;
  disabled?: boolean;
  onChange: (value: TimeSetting) => void;
}) {
  const times = timesOf(setting);
  return (
    <div className="scan-schedule-times">
      {times.map((time, index) => (
        <div className="scan-schedule-time" key={index}>
          <label>
            执行时间 {index + 1}
            <input
              type="time"
              aria-label={`${label}执行时间 ${index + 1}`}
              value={time}
              disabled={disabled}
              onClick={(event) => event.currentTarget.showPicker?.()}
              onChange={(event) =>
                onChange(
                  withTimes(
                    times.map((item, position) => (position === index ? event.target.value : item)),
                  ),
                )
              }
              required
            />
          </label>
          {time && (
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled}
              aria-label={`清空${label}执行时间 ${index + 1}`}
              onClick={() =>
                onChange(withTimes(times.map((item, position) => (position === index ? "" : item))))
              }
            >
              清空
            </button>
          )}
          {times.length > 1 && (
            <button
              type="button"
              className="btn-secondary"
              disabled={disabled}
              aria-label={`删除${label}执行时间 ${index + 1}`}
              onClick={() => onChange(withTimes(times.filter((_, position) => position !== index)))}
            >
              删除
            </button>
          )}
        </div>
      ))}
      {times.length < 5 && (
        <button
          type="button"
          className="btn-secondary scan-schedule-add-time"
          disabled={disabled}
          onClick={() => onChange(withTimes([...times, ""]))}
        >
          + 添加执行时间
        </button>
      )}
    </div>
  );
}

function localTime(value: number | string, timezone: string) {
  return new Date(value).toLocaleString("zh-CN", { timeZone: timezone, hour12: false });
}

export function ScanSchedulePanel({
  ready,
  running,
  onBusy,
}: {
  ready: boolean;
  running: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const [status, setStatus] = useState<ScheduleStatus | null>(null);
  const [draft, setDraft] = useState<Draft>({
    scheduleType: "weekly",
    daily: { startTime: "09:00" },
    days: WEEKDAYS.map(([weekday]) => ({
      weekday,
      enabled: true,
      startTime: "09:00",
    })),
    maxDurationMinutes: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transportError, setTransportError] = useState("");
  const dirty = useRef(false);
  const pending = busy || status === null;

  useEffect(() => {
    onBusy?.(pending);
    return () => onBusy?.(false);
  }, [onBusy, pending]);

  useEffect(() => {
    let closed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const response = await fetch("/api/scan/status", {
          cache: "no-store",
          signal: AbortSignal.timeout(8000),
        });
        const data = (await response.json()) as ScheduleStatus & { error?: string };
        if (!response.ok) throw new Error(data.error || "无法读取定时计划");
        if (!closed) {
          setStatus(data);
          if (!dirty.current)
            setDraft({
              scheduleType: data.config.scheduleType,
              daily: data.config.daily,
              days: data.config.days,
              maxDurationMinutes: String(data.config.maxDurationMinutes ?? ""),
            });
          setTransportError("");
        }
      } catch (cause) {
        if (!closed) setTransportError(pollingError(cause, "读取计划状态"));
      } finally {
        if (!closed) timer = setTimeout(() => void poll(), 1500);
      }
    };
    void poll();
    return () => {
      closed = true;
      clearTimeout(timer);
    };
  }, []);

  const request = async (command: "configure" | "enable" | "disable") => {
    const response = await fetch(`/api/scan/${command}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body:
        command === "configure"
          ? JSON.stringify({
              ...draft,
              maxDurationMinutes: draft.maxDurationMinutes
                ? Number(draft.maxDurationMinutes)
                : null,
            })
          : "{}",
      signal: AbortSignal.timeout(15000),
    });
    const data = (await response.json()) as ScheduleStatus & { error?: string };
    if (!response.ok) throw new Error(data.error || "定时计划操作失败");
    setStatus(data);
    return data;
  };

  const action = async (command: "configure" | "enable" | "disable") => {
    onBusy?.(true);
    setBusy(true);
    setError("");
    try {
      if (command === "enable" && dirty.current) {
        await request("configure");
        dirty.current = false;
      }
      const updated = await request(command);
      if (command === "configure") dirty.current = false;
      setDraft({
        scheduleType: updated.config.scheduleType,
        daily: updated.config.daily,
        days: updated.config.days,
        maxDurationMinutes: String(updated.config.maxDurationMinutes ?? ""),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "定时计划操作失败");
    } finally {
      setBusy(false);
    }
  };

  const updateDay = (weekday: number, changes: Partial<ScanDayConfig>) => {
    dirty.current = true;
    setDraft((current) => ({
      ...current,
      days: current.days.map((day) => (day.weekday === weekday ? { ...day, ...changes } : day)),
    }));
  };

  const updateDaily = (changes: Partial<ScanScheduleConfig["daily"]>) => {
    dirty.current = true;
    setDraft((current) => ({ ...current, daily: { ...current.daily, ...changes } }));
  };
  const hasMultipleTimes =
    draft.scheduleType === "daily"
      ? timesOf(draft.daily).length > 1
      : draft.days.some((day) => day.enabled && timesOf(day).length > 1);

  return (
    <section className="scan-schedule" aria-label="定时循环扫描">
      <h3>定时循环扫描</h3>
      <p className="status-note">
        选择每天或每周循环，每个运行日最多设置 5
        个执行时间。每个时间点启动一轮；若上一轮仍在运行，则跳过该时间点。
        多个时间点必须设置最长运行时长，时间间隔不得小于该时长。启用时已过的时间点不会补跑。
      </p>
      <form
        className="scan-schedule-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action("configure");
        }}
      >
        <fieldset className="scan-schedule-repeat-mode">
          <legend>循环方式</legend>
          <div>
            <label>
              <input
                type="radio"
                name="scan-schedule-type"
                value="daily"
                checked={draft.scheduleType === "daily"}
                onChange={() => {
                  dirty.current = true;
                  setDraft((current) => ({ ...current, scheduleType: "daily" }));
                }}
              />
              每天循环
            </label>
            <label>
              <input
                type="radio"
                name="scan-schedule-type"
                value="weekly"
                checked={draft.scheduleType === "weekly"}
                onChange={() => {
                  dirty.current = true;
                  setDraft((current) => ({ ...current, scheduleType: "weekly" }));
                }}
              />
              每周循环
            </label>
          </div>
        </fieldset>
        {draft.scheduleType === "daily" ? (
          <fieldset className="scan-schedule-daily">
            <legend>每天的执行时间</legend>
            <TimeInputs label="每天" setting={draft.daily} onChange={updateDaily} />
          </fieldset>
        ) : (
          <fieldset className="scan-schedule-weekdays">
            <legend>每周运行日（已选 {draft.days.filter((day) => day.enabled).length} 天）</legend>
            <div className="scan-schedule-day-rows">
              {WEEKDAYS.map(([weekday, label]) => {
                const day = draft.days.find((entry) => entry.weekday === weekday)!;
                return (
                  <div className="scan-schedule-day-row" key={weekday}>
                    <label className="scan-schedule-day-toggle">
                      <input
                        type="checkbox"
                        checked={day.enabled}
                        onChange={(event) => updateDay(weekday, { enabled: event.target.checked })}
                      />
                      {label}
                    </label>
                    <TimeInputs
                      label={label}
                      setting={day}
                      disabled={!day.enabled}
                      onChange={(value) => updateDay(weekday, value)}
                    />
                  </div>
                );
              })}
            </div>
          </fieldset>
        )}
        <label className="scan-schedule-duration">
          最长运行时长（分钟{hasMultipleTimes ? "，必填" : "，可选"}）
          <input
            type="number"
            min="1"
            step="1"
            required={hasMultipleTimes}
            value={draft.maxDurationMinutes}
            placeholder="留空则运行到本次结束"
            onChange={(event) => {
              dirty.current = true;
              setDraft({ ...draft, maxDurationMinutes: event.target.value });
            }}
          />
        </label>
        <div className="scan-schedule-actions">
          <button type="submit" className="btn-secondary" disabled={busy || !status}>
            保存设置
          </button>
          {status?.mode === "enabled" ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy}
              onClick={() => void action("disable")}
            >
              关闭计划
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary"
              disabled={busy || !status || running || (status.mode === "disabled" && !ready)}
              onClick={() => void action("enable")}
            >
              {status?.mode === "suspended" ? "恢复计划" : "启用计划"}
            </button>
          )}
        </div>
      </form>
      {status?.mode === "disabled" && !ready && (
        <p className="status-note">请先登录藏宝阁并进入角色列表，再启用计划。</p>
      )}
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
        <div className="scan-schedule-status" aria-live="polite">
          <p>
            <strong>计划状态：{LABELS[status.state] || status.state}</strong> · 时区{" "}
            {status.timezone}
          </p>
          <p>{status.message}</p>
          {status.nextRunAt && status.mode === "enabled" && (
            <p>预计下轮：{localTime(status.nextRunAt, status.timezone)}</p>
          )}
          {status.state === "waiting_login" && (
            <p>
              {status.pendingLoginAt
                ? `${localTime(status.pendingLoginAt, status.timezone)} 这轮等待登录；`
                : "正在等待登录；"}
              请在页面上方扫码，二维码失效时点击“重新尝试”。
              下个执行时间或午夜前登录成功会自动扫描；过时则跳过这轮。
            </p>
          )}
          {status.lastSkippedAt && (
            <p>最近跳过的执行时间：{localTime(status.lastSkippedAt, status.timezone)}</p>
          )}
          {status.lastRun && (
            <p>
              上轮 {localTime(status.lastRun.endedAt, status.timezone)} ·
              {status.lastRun.outcome === "completed"
                ? "已完成"
                : status.lastRun.outcome === "time_limit"
                  ? "达到时长，已保留断点"
                  : "已中断"}{" "}
              · 保存 {status.lastRun.saved}
              条 · 跳过 {status.lastRun.skipped} 条 · 待重试 {status.lastRun.failed} 条
            </p>
          )}
          <p className="status-note">关闭网页不影响计划；本地服务、Chrome 和电脑需保持运行。</p>
        </div>
      )}
    </section>
  );
}
