export interface AccessPolicy {
  schemaVersion: 1;
  version: number;
  minIntervalMs: number;
  windowMs: number;
  maxActionsPerWindow: number;
  maxConcurrent: number;
  fallbackCooldownMs: number;
  leaseMs: number;
  reservationTtlMs: number;
  clockToleranceMs: number;
  maxClockJumpMs: number;
  canaryEnabled: boolean;
  baselineTtlMs: number;
  newTaskQuota: number;
  detailReadBudgetMs: number;
  diagnosticMaxActions: number;
}

/** Conservative operational defaults, not a promise about website rate limits. */
export const DEFAULT_ACCESS_POLICY: AccessPolicy = {
  schemaVersion: 1,
  version: 1,
  minIntervalMs: 5000,
  windowMs: 60000,
  maxActionsPerWindow: 12,
  maxConcurrent: 1,
  fallbackCooldownMs: 60000,
  leaseMs: 120000,
  reservationTtlMs: 120000,
  clockToleranceMs: 1000,
  maxClockJumpMs: 300000,
  canaryEnabled: false,
  baselineTtlMs: 1800000,
  newTaskQuota: 3,
  detailReadBudgetMs: 900000,
  diagnosticMaxActions: 128,
};

export function parseAccessPolicy(value: unknown): AccessPolicy {
  if (!value || typeof value !== "object") throw new Error("Invalid access policy");
  const p = value as Record<string, unknown>;
  if (p.schemaVersion !== 1) throw new Error("Unsupported access policy schema");
  const limits: Record<string, [number, number]> = {
    version: [1, 1000000],
    minIntervalMs: [0, 3600000],
    windowMs: [1, 86400000],
    maxActionsPerWindow: [1, 100000],
    maxConcurrent: [1, 1],
    fallbackCooldownMs: [1, 86400000],
    leaseMs: [1000, 3600000],
    reservationTtlMs: [1000, 3600000],
    clockToleranceMs: [0, 10000],
    maxClockJumpMs: [1000, 86400000],
    baselineTtlMs: [1000, 86400000],
    newTaskQuota: [1, 100],
    detailReadBudgetMs: [180000, 3600000],
    diagnosticMaxActions: [1, 256],
  };
  for (const [key, [min, max]] of Object.entries(limits)) {
    const v = p[key];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max)
      throw new Error(`Invalid access policy ${key}`);
  }
  if (typeof p.canaryEnabled !== "boolean") throw new Error("Invalid access policy canaryEnabled");
  return { ...p } as unknown as AccessPolicy;
}

export function retryAfterDeadline(
  header: string | undefined,
  now: number,
  fallbackMs: number,
): number {
  if (header) {
    const value = header.trim();
    if (/^\d+$/.test(value)) {
      const ms = Number(value) * 1000;
      if (Number.isSafeInteger(ms) && Number.isSafeInteger(now + ms)) return now + ms;
    }
    const deadline = parseHttpDate(value, now);
    if (deadline !== null) return Math.max(now, deadline);
  }
  return now + fallbackMs;
}

function parseHttpDate(value: string, now: number): number | null {
  const shortDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const longDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  let weekday: string,
    day: number,
    month: string,
    year: number,
    hour: number,
    minute: number,
    second: number;
  const imf = /^(\w{3}), (\d{2}) (\w{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const old = /^(\w+), (\d{2})-(\w{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  const ascii = /^(\w{3}) (\w{3}) ( {1,2}\d{1,2}|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
    value,
  );
  if (imf || old) {
    const match = (imf ?? old)!;
    [, weekday, , month] = match;
    day = Number(match[2]);
    year = Number(match[4]);
    hour = Number(match[5]);
    minute = Number(match[6]);
    second = Number(match[7]);
    if (old) {
      const currentYear = new Date(now).getUTCFullYear();
      year += Math.floor(currentYear / 100) * 100;
      if (year > currentYear + 50) year -= 100;
      if (!longDays.includes(weekday)) return null;
      weekday = weekday.slice(0, 3);
    }
  } else if (ascii) {
    [, weekday, month] = ascii;
    day = Number(ascii[3].trim());
    hour = Number(ascii[4]);
    minute = Number(ascii[5]);
    second = Number(ascii[6]);
    year = Number(ascii[7]);
  } else return null;
  const monthIndex = months.indexOf(month);
  if (year < 1601 || monthIndex < 0 || hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(Date.UTC(year, monthIndex, day, hour, minute, second));
  if (
    date.getUTCDate() !== day ||
    date.getUTCMonth() !== monthIndex ||
    shortDays[date.getUTCDay()] !== weekday
  )
    return null;
  return date.getTime();
}
