export interface ScanDayConfig {
  weekday: number;
  enabled: boolean;
  startTime: string;
  endTime: string;
}

export interface ScanTimeRange {
  startTime: string;
  endTime: string;
}

export interface ScanScheduleConfig {
  scheduleType: "daily" | "weekly";
  daily: ScanTimeRange;
  days: ScanDayConfig[];
  intervalMinutes: number;
}

export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export class ScheduleConfigError extends Error {}

export function parseScanScheduleConfig(value: unknown): ScanScheduleConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ScheduleConfigError("定时计划格式错误");
  const input = value as Record<string, unknown>;
  if (input.scheduleType !== "daily" && input.scheduleType !== "weekly")
    throw new ScheduleConfigError("请选择每天循环或每周循环");
  if (!input.daily || typeof input.daily !== "object" || Array.isArray(input.daily))
    throw new ScheduleConfigError("每天循环时间设置格式错误");
  const daily = input.daily as Record<string, unknown>;
  if (typeof daily.startTime !== "string" || !TIME.test(daily.startTime))
    throw new ScheduleConfigError("每天开始时间格式错误，请使用 HH:mm");
  if (typeof daily.endTime !== "string" || !TIME.test(daily.endTime))
    throw new ScheduleConfigError("每天结束时间格式错误，请使用 HH:mm");
  if (daily.startTime === daily.endTime)
    throw new ScheduleConfigError("每天开始和结束时间不能相同");
  if (!Array.isArray(input.days) || input.days.length !== 7)
    throw new ScheduleConfigError("请提供周一至周日的完整设置");
  const days: ScanDayConfig[] = input.days.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ScheduleConfigError("运行日设置格式错误");
    const day = value as Record<string, unknown>;
    if (!Number.isInteger(day.weekday) || Number(day.weekday) < 1 || Number(day.weekday) > 7)
      throw new ScheduleConfigError("运行日必须是周一至周日");
    if (typeof day.enabled !== "boolean") throw new ScheduleConfigError("运行日启用状态错误");
    const label = `周${"一二三四五六日"[Number(day.weekday) - 1]}`;
    if (typeof day.startTime !== "string" || !TIME.test(day.startTime))
      throw new ScheduleConfigError(`${label}开始时间格式错误，请使用 HH:mm`);
    if (typeof day.endTime !== "string" || !TIME.test(day.endTime))
      throw new ScheduleConfigError(`${label}结束时间格式错误，请使用 HH:mm`);
    if (day.startTime === day.endTime)
      throw new ScheduleConfigError(`${label}开始和结束时间不能相同`);
    return {
      weekday: day.weekday as number,
      enabled: day.enabled,
      startTime: day.startTime,
      endTime: day.endTime,
    };
  });
  if (new Set(days.map((day) => day.weekday)).size !== 7)
    throw new ScheduleConfigError("周一至周日不能重复或缺失");
  if (input.scheduleType === "weekly" && !days.some((day) => day.enabled))
    throw new ScheduleConfigError("每周至少选择一天");
  if (
    typeof input.intervalMinutes !== "number" ||
    !Number.isSafeInteger(input.intervalMinutes) ||
    input.intervalMinutes < 10
  )
    throw new ScheduleConfigError("轮次间隔至少为 10 分钟");
  return {
    scheduleType: input.scheduleType,
    daily: { startTime: daily.startTime, endTime: daily.endTime },
    days: days.sort((a, b) => a.weekday - b.weekday),
    intervalMinutes: input.intervalMinutes,
  };
}

function atLocalTime(day: Date, value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  const result = new Date(day);
  result.setHours(hours, minutes, 0, 0);
  return result.getTime();
}

function windowsAround(now: number, config: ScanScheduleConfig) {
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  const windows: { start: number; end: number }[] = [];
  for (let offset = -1; offset <= 7; offset++) {
    const day = new Date(base);
    day.setDate(day.getDate() + offset);
    const weekday = day.getDay() || 7;
    const schedule =
      config.scheduleType === "daily"
        ? config.daily
        : config.days.find((entry) => entry.weekday === weekday && entry.enabled);
    if (!schedule) continue;
    const start = atLocalTime(day, schedule.startTime);
    const endDay = new Date(day);
    if (schedule.endTime < schedule.startTime) endDay.setDate(endDay.getDate() + 1);
    const end = atLocalTime(endDay, schedule.endTime);
    windows.push({ start, end });
  }
  return windows;
}

export function scanWindow(now: number, config: ScanScheduleConfig) {
  const windows = windowsAround(now, config);
  const active = windows.filter(({ start, end }) => start <= now && now < end);
  const next = windows.find(({ start }) => start > now);
  if (!next) throw new Error("无法计算下一次定时窗口");
  return {
    active: active.length > 0,
    endAt: active.length ? Math.max(...active.map(({ end }) => end)) : null,
    nextStartAt: next.start,
  };
}

export function nextScanTime(earliest: number, config: ScanScheduleConfig) {
  const window = scanWindow(earliest, config);
  return window.active ? earliest : window.nextStartAt;
}
