import { EventEmitter } from "node:events";
import type { Page, Response } from "playwright-core";
import { expect, it, vi } from "vite-plus/test";
vi.mock("./page", () => ({ assertAvailable: async () => undefined }));
vi.mock("./login-dialog", () => ({ watchLoginRequiredDialog: async () => async () => undefined }));
import { watchCrawlAccess } from "./access-guard";

function fixture(
  status: number,
  headers: Record<string, string> = {},
  body = '{"status":0,"msg":[]}',
) {
  const main = {};
  const emitter = new EventEmitter();
  const page = Object.assign(emitter, {
    mainFrame: () => main,
    isClosed: () => false,
  }) as unknown as Page;
  const text = vi.fn(async () => body);
  const response = {
    status: () => status,
    url: () => "https://xyq.cbg.163.com/cgi-bin/recommend.py",
    headers: () => headers,
    request: () => ({ frame: () => main, resourceType: () => "script" }),
    text,
  } as unknown as Response;
  return { page, response, emitter, text };
}
it("records blocked JSONP before abort and preserves Retry-After", async () => {
  const f = fixture(429, { "retry-after": "30" });
  const order: string[] = [];
  const control = new AbortController();
  const errors: unknown[] = [];
  const dispose = await watchCrawlAccess(
    f.page,
    control.signal,
    (error) => {
      order.push("pause");
      errors.push(error);
      control.abort();
    },
    () => {
      order.push("record");
    },
  );
  f.emitter.emit("response", f.response);
  expect(order).toEqual(["record", "pause"]);
  expect(errors[0]).toMatchObject({ status: 429, retryAfter: "30" });
  expect(f.text).not.toHaveBeenCalled();
  await dispose();
});
it("parses bounded uncompressed JSONP and reports explicit HTTP200 business denial", async () => {
  const body = 'callback({"status":1,"msg":"请先登录"});';
  const f = fixture(200, { "content-length": String(Buffer.byteLength(body)) }, body);
  const report = vi.fn();
  const observed = vi.fn();
  const dispose = await watchCrawlAccess(f.page, new AbortController().signal, report, observed);
  f.emitter.emit("response", f.response);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ reason: "login", kind: "login" }),
    expect.anything(),
  );
  expect(observed).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "blocked" }),
    expect.anything(),
    expect.anything(),
  );
  await dispose();
});
it("unknown, compressed, chunked and oversized bodies are never materialized", async () => {
  const observations: Record<string, string>[] = [
    {},
    { "content-length": "262145" },
    { "content-length": "20", "content-encoding": "gzip" },
    { "content-length": "20", "transfer-encoding": "chunked" },
  ];
  for (const headers of observations) {
    const f = fixture(200, headers);
    const observed = vi.fn();
    const dispose = await watchCrawlAccess(f.page, new AbortController().signal, vi.fn(), observed);
    f.emitter.emit("response", f.response);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.text).not.toHaveBeenCalled();
    expect(observed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "unknown" }),
      expect.anything(),
      expect.anything(),
    );
    await dispose();
  }
});
it("evidence persistence failure is surfaced through fail-closed protection callback", async () => {
  const f = fixture(403);
  const fail = vi.fn();
  const report = vi.fn();
  const failure = new Error("db unavailable");
  const dispose = await watchCrawlAccess(
    f.page,
    new AbortController().signal,
    report,
    () => {
      throw failure;
    },
    fail,
  );
  f.emitter.emit("response", f.response);
  expect(fail).toHaveBeenCalledWith(failure);
  expect(report).not.toHaveBeenCalled();
  await dispose();
});
