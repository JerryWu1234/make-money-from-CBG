export type AiRequestIssue = {
  kind: "rate_limit" | "quota";
  message: string;
  retryAfterMs?: number;
};

export function aiRequestIssue(error: unknown): AiRequestIssue | null {
  const message = error instanceof Error ? error.message : String(error);
  const value = error as {
    status?: number;
    kind?: AiRequestIssue["kind"];
    code?: string;
    type?: string;
    error?: { code?: string; type?: string; message?: string };
    retryAfterMs?: number;
    headers?: { get?: (name: string) => string | null };
  } | null;
  const text = `${value?.code || ""} ${value?.type || ""} ${value?.error?.code || ""} ${value?.error?.type || ""} ${value?.error?.message || ""} ${message}`;
  if (
    value?.kind === "quota" ||
    /insufficient_quota|quota.*(?:exceeded|exhausted)|exceeded.*(?:current |your )*quota|usage.limit.*(?:reached|exceeded)|hit.*usage.limit|credit.balance.exhausted|额度.*(?:不足|耗尽|用完)|余额不足/i.test(
      text,
    )
  )
    return {
      kind: "quota",
      message: "AI 服务使用额度已达上限，请检查账号用量及恢复时间后继续；已完成结果保留。",
    };
  if (
    value?.kind !== "rate_limit" &&
    value?.status !== 429 &&
    !/\b429\b|rate[ _-]?limit|too many requests|限流/i.test(text)
  )
    return null;
  const header = value?.headers?.get?.("retry-after");
  const seconds = header?.trim() ? Number(header) : NaN;
  const delay = header
    ? Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(header) - Date.now()
    : NaN;
  const retryAfterMs = value?.retryAfterMs ?? delay;
  return {
    kind: "rate_limit",
    message: /exceeded retry limit/i.test(message)
      ? "AI 服务请求受限（HTTP 429 / 限流），上游已用完本次重试次数；请等待冷却后继续，若持续受限请检查账号用量。"
      : "AI 服务请求受限（HTTP 429 / 限流）；请等待冷却后继续，若持续受限请检查账号用量。",
    ...(Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}),
  };
}

/** Preserve retry instructions while the connection layer removes credentials. */
export function publicAiRequestError(error: unknown, message: string) {
  const issue = aiRequestIssue(error);
  return issue ? Object.assign(new Error(message), { ...issue, message }) : new Error(message);
}

export function aiRequestMessage(message: string) {
  if (message.startsWith("AI 服务")) return message;
  return aiRequestIssue(new Error(message))?.message || message;
}
