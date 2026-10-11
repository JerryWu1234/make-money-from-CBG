import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { verifyCdpEndpoint } from "./chrome";

const { createConnection } = vi.hoisted(() => ({ createConnection: vi.fn() }));
vi.mock("node:net", () => ({ createConnection }));

beforeEach(() => vi.clearAllMocks());

describe("Chrome 调试端口检查", () => {
  const endpoint = "ws://127.0.0.1:9345/devtools/browser/test";
  function socket() {
    const value = Object.assign(new EventEmitter(), {
      destroy: vi.fn(),
      setTimeout: vi.fn(),
    });
    createConnection.mockReturnValue(value);
    return value;
  }
  it("只检查发布的本地端口，成功后关闭探测连接", async () => {
    const connection = socket();
    const pending = verifyCdpEndpoint(endpoint);
    expect(createConnection).toHaveBeenCalledExactlyOnceWith({ host: "127.0.0.1", port: 9345 });
    connection.emit("connect");
    await pending;
    expect(connection.destroy).toHaveBeenCalledOnce();
  });
  it("端口被拒绝时指出旧地址失效及重新开启调试的操作", async () => {
    const connection = socket();
    const pending = verifyCdpEndpoint(endpoint);
    connection.emit("error", Object.assign(new Error("refused"), { code: "ECONNREFUSED" }));
    await expect(pending).rejects.toThrow("Chrome 调试端口 9345 未启动，保存的调试地址已失效");
    expect(connection.destroy).toHaveBeenCalledOnce();
  });
  it("权限错误不误报成未开启远程调试", async () => {
    const connection = socket();
    const pending = verifyCdpEndpoint(endpoint);
    connection.emit("error", Object.assign(new Error("denied"), { code: "EPERM" }));
    await expect(pending).rejects.toThrow("无法访问 Chrome 调试端口 9345（EPERM）");
  });
  it("端口探测超时会关闭连接，不等待浏览器授权", async () => {
    const connection = socket();
    const pending = verifyCdpEndpoint(endpoint);
    expect(connection.setTimeout).toHaveBeenCalledWith(2000, expect.any(Function));
    connection.setTimeout.mock.calls[0][1]();
    await expect(pending).rejects.toThrow("Chrome 调试端口 9345 无响应");
    expect(connection.destroy).toHaveBeenCalledOnce();
  });
});
