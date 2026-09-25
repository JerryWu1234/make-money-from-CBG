export interface ScanScheduleConfig {
  startTime: string;
  endTime: string;
  intervalMinutes: number;
}

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
export class ScheduleConfigError extends Error {}

export function parseScanScheduleConfig(value: unknown): ScanScheduleConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ScheduleConfigError("定时计划格式错误");
  const input = value as Record<string, unknown>;
  if (typeof input.startTime !== "string" || !TIME.test(input.startTime))
    throw new ScheduleConfigError("开始时间格式错误，请使用 HH:mm");
  if (typeof input.endTime !== "string" || !TIME.test(input.endTime))
    throw new ScheduleConfigError("结束时间格式错误，请使用 HH:mm");
  if (input.startTime === input.endTime) throw new ScheduleConfigError("开始和结束时间不能相同");
  if (
    typeof input.intervalMinutes !== "number" ||
    !Number.isSafeInteger(input.intervalMinutes) ||
    input.intervalMinutes < 10
  )
    throw new ScheduleConfigError("轮次间隔至少为 10 分钟");
  return {
    startTime: input.startTime,
    endTime: input.endTime,
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
  for (let offset = -1; offset <= 2; offset++) {
    const day = new Date(base);
    day.setDate(day.getDate() + offset);
    const start = atLocalTime(day, config.startTime);
    const endDay = new Date(day);
    if (config.endTime < config.startTime) endDay.setDate(endDay.getDate() + 1);
    const end = atLocalTime(endDay, config.endTime);
    windows.push({ start, end });
  }
  return windows;
}

export function scanWindow(now: number, config: ScanScheduleConfig) {
  const windows = windowsAround(now, config);
  const active = windows.find(({ start, end }) => start <= now && now < end);
  const next = windows.find(({ start }) => start > now);
  if (!next) throw new Error("无法计算下一次定时窗口");
  return { active: !!active, endAt: active?.end ?? null, nextStartAt: next.start };
}

export function nextScanTime(earliest: number, config: ScanScheduleConfig) {
  const window = scanWindow(earliest, config);
  return window.active ? earliest : window.nextStartAt;
}
