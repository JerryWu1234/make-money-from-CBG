/** Local HTTP polling timeouts do not establish that a product's capture failed. */
export function pollingError(error: unknown, action: string): string {
  if (error && typeof error === "object" && "name" in error && error.name === "TimeoutError")
    return `${action}超时：本地服务未及时响应。已保留上次进度，稍后自动检查。`;
  return error instanceof Error ? error.message : `${action}失败`;
}
