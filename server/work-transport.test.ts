import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { openWorkTransport, WorkTransport } from "./work-transport";
import { diagnostics } from "./diagnostics";

class Socket extends EventTarget {
  static latest: Socket;
  send = vi.fn();
  close = vi.fn(() => this.dispatchEvent(new Event("close")));
  constructor() {
    super();
    Socket.latest = this;
  }
  receive(message: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("work-page CDP transport", () => {
  it("异常断连保留socket错误与关闭码，不再记录空错误", () => {
    const record = vi.spyOn(diagnostics, "record");
    const socket = new Socket();
    const transport = new WorkTransport(socket as unknown as WebSocket);
    transport.onclose = vi.fn();
    const error = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    socket.dispatchEvent(Object.assign(new Event("error"), { error, message: "socket reset" }));
    expect(record).toHaveBeenCalledWith(
      "browser.transport_error",
      expect.objectContaining({ error, errorCode: "ECONNRESET" }),
    );
    expect(transport.onclose).toHaveBeenCalledWith(expect.stringContaining("调试连接"));
    record.mockRestore();
  });
  it("excludes existing daily tabs while preserving child-frame auto attachment", () => {
    const socket = new Socket();
    const transport = new WorkTransport(socket as unknown as WebSocket);
    transport.send({
      id: 1,
      method: "Target.setAutoAttach",
      params: { autoAttach: true, flatten: true },
    });
    expect(JSON.parse(socket.send.mock.calls[0][0])).toMatchObject({
      params: { filter: [{ exclude: true }], autoAttach: true },
    });
    const frame = {
      id: 2,
      sessionId: "own-page",
      method: "Target.setAutoAttach",
      params: { autoAttach: true },
    };
    transport.send(frame);
    expect(JSON.parse(socket.send.mock.calls[1][0])).toEqual(frame);
  });
  it("only attaches targets created by this connection and propagates attach failures", () => {
    const socket = new Socket();
    const transport = new WorkTransport(socket as unknown as WebSocket);
    transport.onmessage = vi.fn();
    transport.send({
      id: 3,
      sessionId: "creator",
      method: "Target.createTarget",
      params: { url: "about:blank", hidden: true },
    });
    const created = { id: 3, sessionId: "creator", result: { targetId: "own-target" } };
    socket.receive(created);
    expect(transport.onmessage).not.toHaveBeenCalled();
    const attach = JSON.parse(socket.send.mock.calls[1][0]);
    expect(attach).toEqual({
      id: -1,
      method: "Target.attachToTarget",
      params: { targetId: "own-target", flatten: true },
    });
    socket.receive({ id: -1, result: { sessionId: "own-session" } });
    expect(transport.onmessage).toHaveBeenLastCalledWith(created);
    transport.send({ id: 4, method: "Target.createTarget" });
    socket.receive({ id: 4, result: { targetId: "failed-target" } });
    socket.receive({ id: -2, error: { message: "target closed" } });
    expect(transport.onmessage).toHaveBeenLastCalledWith({
      id: 4,
      result: undefined,
      error: { message: "target closed" },
    });
  });
  it("bounds a pending authorization handshake and closes the socket on timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", Socket);
    const pending = openWorkTransport("ws://127.0.0.1:9222/test", 100);
    const rejected = expect(pending).rejects.toThrow("握手超时");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(Socket.latest.close).toHaveBeenCalledOnce();
  });
});
