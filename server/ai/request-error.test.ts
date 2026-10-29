import { expect, it, vi } from "vite-plus/test";
import { aiRequestIssue, publicAiRequestError } from "./request-error";

it.each([
  "exceeded retry limit, last status: 429 Too Many Requests",
  "rate_limit_exceeded",
  "Too Many Requests",
])("识别临时限流：%s", (message) => {
  expect(aiRequestIssue(new Error(message))?.kind).toBe("rate_limit");
});

it.each([
  "429 insufficient_quota",
  "429 quota exceeded",
  "You've hit your usage limit",
  "429 You exceeded your current quota, please check your plan and billing details.",
  "余额不足",
])("额度耗尽优先于429分类：%s", (message) => {
  expect(aiRequestIssue(new Error(message))?.kind).toBe("quota");
});

it("结构化额度code优先于429，RPM/TPM限流仍允许有界恢复", () => {
  expect(
    aiRequestIssue(
      Object.assign(new Error("429"), {
        error: { code: "insufficient_quota", type: "insufficient_quota" },
      }),
    )?.kind,
  ).toBe("quota");
  expect(
    aiRequestIssue(
      Object.assign(new Error("requests per minute exceeded"), {
        status: 429,
        code: "rate_limit_exceeded",
      }),
    )?.kind,
  ).toBe("rate_limit");
});

it("保留Retry-After秒数及HTTP日期，错误脱敏不丢失重试指令", () => {
  const header = new Headers({ "Retry-After": "90" });
  const error = Object.assign(new Error("private credential omitted"), {
    status: 429,
    headers: header,
  });
  const safe = publicAiRequestError(error, "凭证已隐藏");
  expect(aiRequestIssue(safe)).toMatchObject({ kind: "rate_limit", retryAfterMs: 90_000 });
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-10-26T15:00:00Z"));
    header.set("Retry-After", "Mon, 26 Oct 2026 15:01:00 GMT");
    expect(aiRequestIssue(error)?.retryAfterMs).toBe(60_000);
    header.set("Retry-After", "invalid");
    expect(aiRequestIssue(error)?.retryAfterMs).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it.each(["401 Unauthorized", "analysis output is invalid", "TimeoutError"])(
  "非限流错误保持原分类：%s",
  (message) => {
    expect(aiRequestIssue(new Error(message))).toBeNull();
  },
);
