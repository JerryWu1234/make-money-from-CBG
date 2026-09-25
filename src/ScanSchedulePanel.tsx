import { useEffect, useRef, useState } from "react";
import type { StoredSchedule } from "../server/crawler/schedule-store";

type ScheduleStatus = StoredSchedule & {
  state: string;
  message: string;
  timezone: string;
};
type Draft = { startTime: string; endTime: string; intervalMinutes: string };

const LABELS: Record<string, string> = {
  disabled: "已关闭",
  waiting_window: "等待时段",
  waiting_login: "等待登录",
  running: "扫描中",
  waiting_next: "等待下轮",
  waiting_lock: "等待采集锁",
  needs_action: "需要处理",
  other_instance: "其他服务运行中",
};

function localTime(value: number | string, timezone: string) {
  return new Date(value).toLocaleString("zh-CN", { timeZone: timezone, hour12: false });
}

export function ScanSchedulePanel() {
  const [status, setStatus] = useState<ScheduleStatus | null>(null);
  const [draft, setDraft] = useState<Draft>({
    startTime: "09:00",
    endTime: "23:00",
    intervalMinutes: "30",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [transportError, setTransportError] = useState("");
  const dirty = useRef(false);

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
              startTime: data.config.startTime,
              endTime: data.config.endTime,
              intervalMinutes: String(data.config.intervalMinutes),
            });
          setTransportError("");
        }
      } catch (cause) {
        if (!closed)
          setTransportError(cause instanceof Error ? cause.message : "定时计划服务不可用");
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
          ? JSON.stringify({ ...draft, intervalMinutes: Number(draft.intervalMinutes) })
          : "{}",
      signal: AbortSignal.timeout(15000),
    });
    const data = (await response.json()) as ScheduleStatus & { error?: string };
    if (!response.ok) throw new Error(data.error || "定时计划操作失败");
    setStatus(data);
    return data;
  };

  const action = async (command: "configure" | "enable" | "disable") => {
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
        startTime: updated.config.startTime,
        endTime: updated.config.endTime,
        intervalMinutes: String(updated.config.intervalMinutes),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "定时计划操作失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="scan-schedule" aria-label="定时循环扫描">
      <h3>定时循环扫描</h3>
      <p className="status-note">
        每天在设置的时段内循环扫描；一轮结束后等待指定间隔。到结束时间时，当前轮会完成。
      </p>
      <form
        className="scan-schedule-form"
        onSubmit={(event) => {
          event.preventDefault();
          void action("configure");
        }}
      >
        <label>
          开始时间
          <input
            type="time"
            value={draft.startTime}
            onChange={(event) => {
              dirty.current = true;
              setDraft({ ...draft, startTime: event.target.value });
            }}
            required
          />
        </label>
        <label>
          结束时间
          <input
            type="time"
            value={draft.endTime}
            onChange={(event) => {
              dirty.current = true;
              setDraft({ ...draft, endTime: event.target.value });
            }}
            required
          />
        </label>
        <label>
          每轮间隔（分钟）
          <input
            type="number"
            min="10"
            step="1"
            value={draft.intervalMinutes}
            onChange={(event) => {
              dirty.current = true;
              setDraft({ ...draft, intervalMinutes: event.target.value });
            }}
            required
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
              disabled={busy || !status}
              onClick={() => void action("enable")}
            >
              {status?.mode === "suspended" ? "恢复计划" : "启用计划"}
            </button>
          )}
        </div>
      </form>
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
            <p>请在页面上方完成登录；二维码失效时点击“重新尝试”获取新二维码。</p>
          )}
          {status.lastRun && (
            <p>
              上轮 {localTime(status.lastRun.endedAt, status.timezone)} ·
              {status.lastRun.outcome === "completed" ? "已完成" : "已中断"} · 保存{" "}
              {status.lastRun.saved}
              条 · 跳过 {status.lastRun.skipped} 条 · 待重试 {status.lastRun.failed} 条
            </p>
          )}
          <p className="status-note">关闭网页不影响计划；本地服务、Chrome 和电脑需保持运行。</p>
        </div>
      )}
    </section>
  );
}
