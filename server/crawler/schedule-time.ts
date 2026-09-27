export interface ScanDayConfig {
  weekday: number;
  enabled: boolean;
  startTime: string;
}

export interface ScanScheduleConfig {
  scheduleType: "daily" | "weekly";
  daily: { startTime: string };
  days: ScanDayConfig[];
  maxDurationMinutes: number | null;
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
    throw new ScheduleConfigError("每天执行时间设置格式错误");
  const daily = input.daily as Record<string, unknown>;
  if (typeof daily.startTime !== "string" || !TIME.test(daily.startTime))
    throw new ScheduleConfigError("每天执行时间格式错误，请使用 HH:mm");
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
      throw new ScheduleConfigError(`${label}执行时间格式错误，请使用 HH:mm`);
    return { weekday: day.weekday as number, enabled: day.enabled, startTime: day.startTime };
  });
  if (new Set(days.map((day) => day.weekday)).size !== 7)
    throw new ScheduleConfigError("周一至周日不能重复或缺失");
  if (input.scheduleType === "weekly" && !days.some((day) => day.enabled))
    throw new ScheduleConfigError("每周至少选择一天");
  if (
    input.maxDurationMinutes !== null &&
    (typeof input.maxDurationMinutes !== "number" ||
      !Number.isSafeInteger(input.maxDurationMinutes) ||
      input.maxDurationMinutes < 1)
  )
    throw new ScheduleConfigError("最长运行时长必须是大于 0 的整数分钟，或留空");
  return {
    scheduleType: input.scheduleType,
    daily: { startTime: daily.startTime },
    days: days.sort((a, b) => a.weekday - b.weekday),
    maxDurationMinutes: input.maxDurationMinutes as number | null,
  };
}

export function localDateKey(value: number) {
  const day = new Date(value);
  const month = String(day.getMonth() + 1).padStart(2, "0");
  const date = String(day.getDate()).padStart(2, "0");
  return `${day.getFullYear()}-${month}-${date}`;
}

export function scheduledStartForDay(day: Date, config: ScanScheduleConfig): number | null {
  const weekday = day.getDay() || 7;
  const schedule =
    config.scheduleType === "daily"
      ? config.daily
      : config.days.find((entry) => entry.weekday === weekday && entry.enabled);
  if (!schedule) return null;
  const [hours, minutes] = schedule.startTime.split(":").map(Number);
  const result = new Date(day);
  result.setHours(hours, minutes, 0, 0);
  return result.getTime();
}

export function nextScanTime(
  now: number,
  config: ScanScheduleConfig,
  lastScheduledDate: string | null,
  enabledAt: number | null = null,
) {
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);
  for (let offset = 0; offset <= 7; offset++) {
    const day = new Date(base);
    day.setDate(day.getDate() + offset);
    const start = scheduledStartForDay(day, config);
    if (start === null) continue;
    if (
      offset === 0 &&
      (lastScheduledDate === localDateKey(now) || (enabledAt !== null && start < enabledAt))
    )
      continue;
    return offset === 0 && start <= now ? now : start;
  }
  throw new Error("无法计算下一次定时执行时间");
}
