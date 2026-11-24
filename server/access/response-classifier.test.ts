import { expect, it } from "vite-plus/test";
import {
  classifyBusinessResponse,
  parseBusinessPayload,
  retryAfterDeadline,
  redactEvidence,
} from "./index";
const base = {
  url: "https://xyq.cbg.163.com/cgi-bin/recommend.py",
  status: 200,
  resourceType: "script",
  mainFrame: true,
};
it("handles verified JSON and JSONP without evaluating callback or modifying the input", () => {
  for (const body of ['{"status":0,"msg":[]}', 'cb.foo({"status":0,"msg":[1,2]});'])
    expect(classifyBusinessResponse({ ...base, body })).toMatchObject({ kind: "normal" });
  expect(
    classifyBusinessResponse({ ...base, body: 'cb({"status":1,"msg":"请先登录"});' }),
  ).toMatchObject({ kind: "blocked", reason: "login" });
  expect(
    classifyBusinessResponse({ ...base, body: 'cb({"status":9,"msg":"访问过于频繁"});' }),
  ).toMatchObject({ kind: "blocked", reason: "frequency" });
  expect(() => parseBusinessPayload('cb({"status":0,"msg":[]});globalThis.pwned=true;')).toThrow();
  expect(() => parseBusinessPayload('cb({"status":0,"msg":[]}, alert(1))')).toThrow();
});
it.each([403, 429])("covers business JSONP HTTP %s and main documents", (status) => {
  expect(classifyBusinessResponse({ ...base, status })).toMatchObject({
    kind: "blocked",
    reason: `http_${status}`,
  });
  expect(
    classifyBusinessResponse({
      ...base,
      status,
      resourceType: "document",
      url: "https://xyq.cbg.163.com/equip",
    }),
  ).toMatchObject({ kind: "blocked" });
});
it("ignores static, logging, iframe, AI and unregistered business-like endpoints", () => {
  for (const input of [
    { ...base, resourceType: "image" },
    { ...base, mainFrame: false },
    { ...base, url: "https://api.openai.com/v1/responses", resourceType: "fetch" },
    { ...base, url: "https://xyq.cbg.163.com/cgi-bin/logger.py" },
    { ...base, url: "https://cbg-xyq.res.netease.com/a.js" },
  ])
    expect(classifyBusinessResponse({ ...input, status: 429 })).toMatchObject({ kind: "ignored" });
});
it("unknown schema, unknown error numbers and malformed or oversized payloads stay unknown", () => {
  for (const body of [
    '{"error":403}',
    '{"status":429,"msg":"failed"}',
    '{"status":0,"msg":{}}',
    "<html>error</html>",
    '{"status":0,"msg":[],"large":"' + "x".repeat(262144) + '"}',
  ])
    expect(classifyBusinessResponse({ ...base, body })).toMatchObject({ kind: "unknown" });
  expect(
    classifyBusinessResponse({
      ...base,
      url: "https://xyq.cbg.163.com/cgi-bin/query.py",
      body: '{"status":0,"msg":[]}',
    }),
  ).toMatchObject({ kind: "unknown" });
});
it("Retry-After accepts seconds and HTTP dates and falls back for illegal values", () => {
  const now = Date.parse("2026-11-15T08:00:00Z");
  expect(retryAfterDeadline("12", now, 60000)).toBe(now + 12000);
  expect(retryAfterDeadline("Sun, 15 Nov 2026 08:01:00 GMT", now, 60000)).toBe(now + 60000);
  expect(retryAfterDeadline("Sunday, 15-Nov-26 08:02:00 GMT", now, 60000)).toBe(now + 120000);
  expect(retryAfterDeadline("Sun Nov 15 08:02:00 2026", now, 60000)).toBe(now + 120000);
  expect(retryAfterDeadline("Sun, 15 Nov 2026 07:00:00 GMT", now, 60000)).toBe(now);
  for (const value of [
    undefined,
    "-1",
    "1.5",
    "not a date",
    "2026-11-15",
    "Sun, 31 Feb 2027 08:00:00 GMT",
    "999999999999999999999999",
  ])
    expect(retryAfterDeadline(value, now, 60000)).toBe(now + 60000);
});
it("bounded evidence removes credentials and full fingerprints, including URL secrets", () => {
  const result = JSON.stringify(
    redactEvidence({
      Cookie: "c-secret",
      Authorization: "a-secret",
      fp: "full-fingerprint",
      token: "t-secret",
      nested: {
        url: "https://user:password@xyq.cbg.163.com/equip?token=url-secret&fp=fp-secret&page=1#fragment-secret",
        message: "Bearer bearer-secret",
      },
    }),
  );
  for (const value of [
    "c-secret",
    "a-secret",
    "full-fingerprint",
    "t-secret",
    "url-secret",
    "fp-secret",
    "fragment-secret",
    "bearer-secret",
    "user:password",
  ])
    expect(result).not.toContain(value);
  expect(result).toContain("page=1");
});
