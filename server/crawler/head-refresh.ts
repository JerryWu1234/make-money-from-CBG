export interface HeadRefreshSettings {
  intervalSeconds: number;
  random: boolean;
  initialPages?: number;
}

export const DEFAULT_INITIAL_PAGES = 5;
export const MAX_INITIAL_PAGES = 1000;
export const DEFAULT_HEAD_REFRESH: HeadRefreshSettings = {
  intervalSeconds: 60,
  random: false,
  initialPages: DEFAULT_INITIAL_PAGES,
};
// 保持在浏览器和 Node 定时器的安全范围内。
export const MAX_HEAD_REFRESH_SECONDS = 7 * 24 * 60 * 60;

export class HeadRefreshSettingsError extends Error {}

export function validateHeadRefreshSettings(value: unknown): HeadRefreshSettings {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HeadRefreshSettingsError("首页刷新设置无效");
  const {
    intervalSeconds,
    random,
    initialPages = DEFAULT_INITIAL_PAGES,
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
    typeof initialPages !== "number" ||
    !Number.isSafeInteger(initialPages) ||
    initialPages < 1 ||
    initialPages > MAX_INITIAL_PAGES
  )
    throw new HeadRefreshSettingsError(`首次采集页数必须是1至${MAX_INITIAL_PAGES}的整数`);
  return { intervalSeconds, random, initialPages };
}

export function headRefreshDelayMs(settings: HeadRefreshSettings, random = Math.random): number {
  const seconds = settings.random
    ? 1 + Math.floor(random() * settings.intervalSeconds)
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
  return settings.random ? `每轮在1秒至${time}之间随机` : `每${time}刷新一次`;
}
