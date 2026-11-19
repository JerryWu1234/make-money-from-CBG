export interface HeadRefreshSettings {
  schemaVersion?: 1 | 2;
  minIntervalSeconds?: number;
  maxIntervalSeconds?: number;
  intervalSeconds: number;
  random: boolean;
  listingAgeMinutes?: number;
}

export const DEFAULT_LISTING_AGE_MINUTES = 10;
export const MAX_LISTING_AGE_MINUTES = 7 * 24 * 60;
export const DEFAULT_HEAD_REFRESH: HeadRefreshSettings = {
  intervalSeconds: 60,
  random: false,
  listingAgeMinutes: DEFAULT_LISTING_AGE_MINUTES,
};
// 保持在浏览器和 Node 定时器的安全范围内。
export const MAX_HEAD_REFRESH_SECONDS = 7 * 24 * 60 * 60;

export class HeadRefreshSettingsError extends Error {}

export function validateHeadRefreshSettings(value: unknown): HeadRefreshSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HeadRefreshSettingsError("首页刷新设置无效");
  const fields = value as Record<string, unknown>;
  if (
    fields.schemaVersion !== undefined &&
    fields.schemaVersion !== 1 &&
    fields.schemaVersion !== 2
  )
    throw new HeadRefreshSettingsError("不支持的首页刷新配置版本");
  const {
    intervalSeconds,
    random,
    listingAgeMinutes = DEFAULT_LISTING_AGE_MINUTES,
  } = value as Record<string, unknown>;
  if (
    typeof intervalSeconds !== "number" ||
    !Number.isSafeInteger(intervalSeconds) ||
    intervalSeconds < 1 ||
    intervalSeconds > MAX_HEAD_REFRESH_SECONDS
  )
    throw new HeadRefreshSettingsError("刷新间隔必须在1秒至7天之间，且精确到秒");
  if (typeof random !== "boolean") throw new HeadRefreshSettingsError("随机刷新选项必须为布尔值");
  if (
    typeof listingAgeMinutes !== "number" ||
    !Number.isSafeInteger(listingAgeMinutes) ||
    listingAgeMinutes < 1 ||
    listingAgeMinutes > MAX_LISTING_AGE_MINUTES
  )
    throw new HeadRefreshSettingsError(`上架时间范围必须是1至${MAX_LISTING_AGE_MINUTES}分钟的整数`);
  if (fields.schemaVersion === 2) {
    const min = fields.minIntervalSeconds;
    const max = fields.maxIntervalSeconds;
    if (
      typeof min !== "number" ||
      typeof max !== "number" ||
      !Number.isSafeInteger(min) ||
      !Number.isSafeInteger(max) ||
      min < 1 ||
      max > MAX_HEAD_REFRESH_SECONDS ||
      min > max
    )
      throw new HeadRefreshSettingsError("随机刷新上下限必须为1秒至7天的整数，且下限不能超过上限");
    if (intervalSeconds !== max || (!random && min !== max))
      throw new HeadRefreshSettingsError("新旧刷新字段冲突，请重新读取设置");
    return {
      schemaVersion: 2,
      intervalSeconds,
      random,
      listingAgeMinutes,
      minIntervalSeconds: min,
      maxIntervalSeconds: max,
    };
  }
  if (fields.minIntervalSeconds !== undefined || fields.maxIntervalSeconds !== undefined)
    throw new HeadRefreshSettingsError("刷新上下限需要配置版本2");
  return { intervalSeconds, random, listingAgeMinutes };
}

export function headRefreshDelayMs(settings: HeadRefreshSettings, random = Math.random): number {
  const min = settings.schemaVersion === 2 ? settings.minIntervalSeconds! : 1;
  const max =
    settings.schemaVersion === 2 ? settings.maxIntervalSeconds! : settings.intervalSeconds;
  const seconds = settings.random
    ? min + Math.floor(Math.max(0, Math.min(1 - Number.EPSILON, random())) * (max - min + 1))
    : settings.intervalSeconds;
  return seconds * 1000;
}

export function formatHeadRefreshTime(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}小时`;
  if (seconds % 60 === 0) return `${seconds / 60}分钟`;
  return `${seconds}秒`;
}

export function describeHeadRefresh(settings: HeadRefreshSettings): string {
  const time = formatHeadRefreshTime(settings.intervalSeconds);
  return settings.random
    ? settings.schemaVersion === 2
      ? `每轮在${formatHeadRefreshTime(settings.minIntervalSeconds!)}至${time}之间随机`
      : `旧版随机：每轮在1秒至${time}之间随机（legacy）`
    : `每${time}刷新一次`;
}

export function isRecentListing(sellingTime: string | null, minutes: number, now = Date.now()) {
  const time = sellingTime ? Date.parse(sellingTime) : NaN;
  return Number.isFinite(time) && time >= now - minutes * 60_000;
}
