const SECRET =
  /cookie|authorization|token|password|passwd|secret|fingerprint|^fp$|csrf|session|ticket|credential|^sid$/i;
const PUBLIC_QUERY = /^(?:page|page_no|serverid|server_id|eid|act|sort|order|kind|type)$/i;

export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    for (const key of new Set(url.searchParams.keys()))
      if (!PUBLIC_QUERY.test(key)) url.searchParams.set(key, "[redacted]");
    return url.toString();
  } catch {
    return "[invalid-url]";
  }
}

export function redactText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>"']+/g, (url) => redactUrl(url))
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_\-.]+/gi, "[redacted-authorization]")
    .replace(/((?:set-cookie|cookie|authorization)\s*[:=])[^\r\n]*/gi, "$1[redacted]")
    .replace(
      /((?:token|password|passwd|fingerprint|\bfp|csrf|session|ticket|secret)[\w.-]*["']?\s*[=:]\s*["']?)[^\s,;&"'}]+/gi,
      "$1[redacted]",
    )
    .slice(0, 2000);
}

/** Bounded evidence summaries only; never retain a complete website body. */
export function redactEvidence(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth-limit]";
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactEvidence(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 40))
      // This is a locally generated correlation epoch, never a website session credential.
      out[key] =
        SECRET.test(key) && key !== "browserSessionEpoch"
          ? "[redacted]"
          : redactEvidence(item, depth + 1);
    return out;
  }
  return null;
}
