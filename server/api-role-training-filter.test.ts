import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock("./crawler/role-training-settings", () => ({
  roleTrainingSettings: mocks.read,
  saveRoleTrainingSettings: mocks.save,
  RoleTrainingSettingsError: class RoleTrainingSettingsError extends Error {},
}));
vi.mock("./diagnostics", () => ({ diagnostics: { record: vi.fn() } }));
async function call(method: string, path: string, body = {}, origin = "http://127.0.0.1:5174") {
  const req = Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    url: path,
    headers: { host: "127.0.0.1:5174", origin },
  }) as IncomingMessage;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    destroyed: false,
    setHeader: vi.fn(),
    end: vi.fn(),
  });
  const next = vi.fn();
  await (await import("./api")).apiMiddleware(req, res as unknown as ServerResponse, next);
  expect(next).not.toHaveBeenCalled();
  return { status: res.statusCode, body: JSON.parse(res.end.mock.calls[0][0]) };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockReturnValue({ minTotal: 40 });
});
it("读取独立采集前置阈值，不进入浏览器或估值配置", async () => {
  expect(await call("GET", "/api/crawl/role-training-filter")).toEqual({
    status: 200,
    body: { minTotal: 40 },
  });
  expect(mocks.read).toHaveBeenCalledOnce();
  expect(mocks.save).not.toHaveBeenCalled();
});
it.each([0, 40, null])("保存阈值%s并返回服务端已保存值", async (minTotal) => {
  mocks.save.mockReturnValue({ minTotal });
  expect(await call("POST", "/api/crawl/role-training-filter/save", { minTotal })).toEqual({
    status: 200,
    body: { minTotal },
  });
  expect(mocks.save).toHaveBeenCalledWith(minTotal);
});
it("非法设置返回400，保留已保存设置", async () => {
  const { RoleTrainingSettingsError } = await import("./crawler/role-training-settings");
  mocks.save.mockImplementation(() => {
    throw new RoleTrainingSettingsError("四修门槛必须为非负整数或空");
  });
  expect(await call("POST", "/api/crawl/role-training-filter/save", { minTotal: -1 })).toEqual({
    status: 400,
    body: { error: "四修门槛必须为非负整数或空" },
  });
});
it("错误方法及外站写入不调用保存", async () => {
  expect((await call("GET", "/api/crawl/role-training-filter/save")).status).toBe(405);
  expect(
    (
      await call(
        "POST",
        "/api/crawl/role-training-filter/save",
        { minTotal: 0 },
        "https://example.com",
      )
    ).status,
  ).toBe(403);
  expect(mocks.save).not.toHaveBeenCalled();
});
