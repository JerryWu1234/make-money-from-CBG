import { redactUrl } from "./redaction";

export const CBG_ORIGIN = "https://xyq.cbg.163.com";
// Explicit inventory from the collector and three browser market sources; never match arbitrary .py.
const BUSINESS_PATHS = new Set([
  "/cgi-bin/recommend.py",
  "/cgi-bin/query.py",
  "/cgi-bin/equipquery.py",
  "/cgi-bin/xyq_overall_search.py",
  "/cgi-bin/role_search.py",
]);
export interface ResponseObservation {
  url: string;
  status: number;
  resourceType: string;
  mainFrame: boolean;
  body?: string;
  retryAfter?: string;
}
export type ResponseClassification =
  | { kind: "ignored"; reason: string }
  | { kind: "normal"; reason: string; resultCount?: number }
  | { kind: "unknown"; reason: string; url: string }
  | {
      kind: "blocked";
      reason: "http_403" | "http_429" | "login" | "verification" | "frequency";
      retryAfter?: string;
      url: string;
    };

export function isBusinessResponse(
  input: Pick<ResponseObservation, "url" | "resourceType" | "mainFrame">,
): boolean {
  try {
    const url = new URL(input.url);
    return (
      input.mainFrame &&
      url.origin === CBG_ORIGIN &&
      (input.resourceType === "document" ||
        (["xhr", "fetch", "script"].includes(input.resourceType) &&
          BUSINESS_PATHS.has(url.pathname)))
    );
  } catch {
    return false;
  }
}

/** Parse only a bounded, detached copy; no eval, script execution or callback mutation. */
export function parseBusinessPayload(body: string, maxBytes = 262144): unknown {
  if (Buffer.byteLength(body, "utf8") > maxBytes) throw new Error("body_too_large");
  const trimmed = body.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return JSON.parse(trimmed);
  const jsonp = /^(?:[A-Za-z_$][\w$]*)(?:\.[A-Za-z_$][\w$]*)*\s*\(([\s\S]*)\)\s*;?$/.exec(trimmed);
  if (!jsonp) throw new Error("unrecognized_payload");
  return JSON.parse(jsonp[1]);
}

export function classifyBusinessResponse(input: ResponseObservation): ResponseClassification {
  if (!isBusinessResponse(input)) return { kind: "ignored", reason: "outside_business_scope" };
  const url = redactUrl(input.url);
  if (input.status === 403 || input.status === 429)
    return {
      kind: "blocked",
      reason: input.status === 429 ? "http_429" : "http_403",
      retryAfter: input.retryAfter,
      url,
    };
  if (input.resourceType === "document")
    return { kind: "unknown", reason: "document_requires_visible_state", url };
  if (input.status !== 200) return { kind: "unknown", reason: "unexpected_http_status", url };
  if (input.body === undefined) return { kind: "unknown", reason: "body_unavailable", url };
  let data: unknown;
  try {
    data = parseBusinessPayload(input.body);
  } catch {
    return { kind: "unknown", reason: "unrecognized_payload", url };
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    return { kind: "unknown", reason: "unknown_business_schema", url };
  const payload = data as Record<string, unknown>;
  // recommend.py's observed callback schema is status:0 + msg:[]. Other codes have no inferred meaning.
  if (new URL(input.url).pathname !== "/cgi-bin/recommend.py" || !Number.isInteger(payload.status))
    return { kind: "unknown", reason: "unknown_business_schema", url };
  if (payload.status === 0 && Array.isArray(payload.msg))
    return { kind: "normal", reason: "recommend_success", resultCount: payload.msg.length };
  if (payload.status !== 0 && typeof payload.msg === "string") {
    const message = payload.msg.trim();
    // Only explicit denial text in the verified status/msg envelope, never guessed numeric codes.
    const reason = /^(?:请先登录|请登录|登录已失效|登录状态已失效|未登录)[。！!，,\s]*$/.test(
      message,
    )
      ? "login"
      : /^(?:请完成验证码验证|请进行安全验证|需要安全验证|请完成安全验证)[。！!，,\s]*$/.test(
            message,
          )
        ? "verification"
        : /^(?:访问过于频繁|操作过于频繁|访问频繁|请求过于频繁|访问过于频繁，请稍后再试)[。！!，,\s]*$/.test(
              message,
            )
          ? "frequency"
          : undefined;
    if (reason) return { kind: "blocked", reason, retryAfter: input.retryAfter, url };
  }
  return { kind: "unknown", reason: "unrecognized_business_result", url };
}
