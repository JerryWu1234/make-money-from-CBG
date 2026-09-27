export interface ScanDayConfig {
  weekday: number;
  enabled: boolean;
  startTime: string;
  additionalStartTimes?: string[];
}

export interface ScanScheduleConfig {
  scheduleType: "daily" | "weekly";
  daily: { startTime: string; additionalStartTimes?: string[] };
  days: ScanDayConfig[];
  maxDurationMinutes: number | null;
}

export const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export class ScheduleConfigError extends Error {}

function parseTimes(value: Record<string, unknown>, label: string) {
  if (typeof value.startTime !== "string" || !TIME.test(value.startTime))
    throw new ScheduleConfigError(`${label}执行时间格式错误，请使用 HH:mm`);
  const extra = value.additionalStartTimes ?? [];
  if (!Array.isArray(extra) || extra.some((time) => typeof time !== "string" || !TIME.test(time)))
    throw new ScheduleConfigError(`${label}执行时间格式错误，请使用 HH:mm`);
  const times = [value.startTime, ...(extra as string[])].sort((a, b) => a.localeCompare(b));
  if (times.length > 5) throw new ScheduleConfigError(`${label}最多设置 5 个执行时间`);
  if (new Set(times).size !== times.length)
    throw new ScheduleConfigError(`${label}执行时间不能重复`);
  return times.length === 1
    ? { startTime: times[0] }
    : { startTime: times[0], additionalStartTimes: times.slice(1) };
}

export function startTimes(schedule: { startTime: string; additionalStartTimes?: string[] }) {
  return [schedule.startTime, ...(schedule.additionalStartTimes ?? [])];
}

function minuteOfWeek(weekday: number, time: string) {
  const [hour, minute] = time.split(":").map(Number);
  return (weekday - 1) * 1440 + hour * 60 + minute;
}

export function parseScanScheduleConfig(value: unknown): ScanScheduleConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ScheduleConfigError("定时计划格式错误");
  const input = value as Record<string, unknown>;
  if (input.scheduleType !== "daily" && input.scheduleType !== "weekly")
    throw new ScheduleConfigError("请选择每天循环或每周循环");
  if (!input.daily || typeof input.daily !== "object" || Array.isArray(input.daily))
    throw new ScheduleConfigError("每天执行时间设置格式错误");
  const daily = input.daily as Record<string, unknown>;
  const parsedDaily = parseTimes(daily, "每天");
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
    return { weekday: day.weekday as number, enabled: day.enabled, ...parseTimes(day, label) };
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
  const active =
    input.scheduleType === "daily"
      ? startTimes(parsedDaily).map((time) => minuteOfWeek(1, time))
      : days
          .filter((day) => day.enabled)
          .flatMap((day) => startTimes(day).map((time) => minuteOfWeek(day.weekday, time)));
  const hasMultipleTimes =
    input.scheduleType === "daily"
      ? active.length > 1
      : days.some((day) => day.enabled && startTimes(day).length > 1);
  if (input.maxDurationMinutes === null && hasMultipleTimes)
    throw new ScheduleConfigError("同一天设置多个执行时间时，必须填写最长运行时长");
  if (input.maxDurationMinutes !== null && hasMultipleTimes) {
    const cycle = input.scheduleType === "daily" ? 1440 : 10080;
    const sorted = active.map((time) => time % cycle).sort((a, b) => a - b);
    for (let index = 0; index < sorted.length; index++) {
      const next = sorted[(index + 1) % sorted.length] + (index + 1 === sorted.length ? cycle : 0);
      if (next - sorted[index] < input.maxDurationMinutes)
        throw new ScheduleConfigError("相邻执行时间至少间隔最长运行时长");
    }
  }
  return {
    scheduleType: input.scheduleType,
    daily: parsedDaily,
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

export function scheduledStartsForDay(day: Date, config: ScanScheduleConfig): number[] {
  const weekday = day.getDay() || 7;
  const schedule =
    config.scheduleType === "daily"
      ? config.daily
      : config.days.find((entry) => entry.weekday === weekday && entry.enabled);
  if (!schedule) return [];
  return startTimes(schedule).map((time) => {
    const [hours, minutes] = time.split(":").map(Number);
    const result = new Date(day);
    result.setHours(hours, minutes, 0, 0);
    return result.getTime();
  });
}
