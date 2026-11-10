import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { apiMiddleware } from "./api";
import { validateHeadRefreshSettings } from "./crawler/head-refresh";

const mocks = vi.hoisted(() => ({ get: vi.fn(), save: vi.fn(), crawler: vi.fn() }));
vi.mock("./crawler/head-refresh-settings", () => ({
  headRefreshSettings: mocks.get,
  saveHeadRefreshSettings: mocks.save,
}));
vi.mock("./crawler/controller", () => {
  mocks.crawler();
  return {};
});
vi.mock("./diagnostics", () => ({ diagnostics: { record: vi.fn() } }));
beforeEach(() => vi.clearAllMocks());

async function invoke(method: string, body?: unknown) {
  const req = Object.assign(Readable.from([JSON.stringify(body ?? {})]), {
    url: `/api/crawl/head-refresh${method === "POST" ? "/save" : ""}`,
    method,
    headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
  }) as IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    destroyed: false,
    setHeader: vi.fn(),
    end: vi.fn(),
  });
  await apiMiddleware(req, res as unknown as ServerResponse, vi.fn());
  expect(mocks.crawler).not.toHaveBeenCalled();
  return { status: res.statusCode, body: JSON.parse(res.end.mock.calls[0][0]) };
}
it("未连接浏览器时仍能读取和保存独立的刷新设置", async () => {
  mocks.get.mockReturnValue({ intervalSeconds: 60, random: false, listingAgeMinutes: 10 });
  mocks.save.mockImplementation(validateHeadRefreshSettings);
  expect(await invoke("GET")).toEqual({
    status: 200,
    body: { intervalSeconds: 60, random: false, listingAgeMinutes: 10 },
  });
  expect(
    await invoke("POST", { intervalSeconds: 3600, random: true, listingAgeMinutes: 10 }),
  ).toEqual({
    status: 200,
    body: { intervalSeconds: 3600, random: true, listingAgeMinutes: 10 },
  });
});
it("无效配置返回400，写入失败返回500，不伪装成保存成功", async () => {
  mocks.save.mockImplementation(validateHeadRefreshSettings);
  expect(
    (await invoke("POST", { intervalSeconds: 0, random: false, listingAgeMinutes: 10 })).status,
  ).toBe(400);
  mocks.save.mockImplementation(() => {
    throw new Error("写入失败");
  });
  expect(
    await invoke("POST", { intervalSeconds: 60, random: true, listingAgeMinutes: 10 }),
  ).toEqual({
    status: 500,
    body: { error: "写入失败" },
  });
});
