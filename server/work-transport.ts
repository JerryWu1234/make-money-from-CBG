import type { ConnectOverCDPTransport } from "playwright-core";
import { diagnostics } from "./diagnostics";

interface Message {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: Record<string, unknown>;
  result?: { targetId?: string };
  error?: { message: string };
}

// Root auto-attach normally initializes every daily-browser tab before connectOverCDP resolves.
// Exclude those targets and attach only targets created by this connection. Child-frame
// auto-attach remains unchanged, so login iframes in our work pages still function.
export class WorkTransport implements ConnectOverCDPTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private readonly creates = new Set<number>();
  private readonly attaches = new Map<number, Message>();
  private nextId = -1;

  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.receive(JSON.parse(String(event.data))));
    socket.addEventListener("close", (event) => {
      diagnostics.record("browser.transport_closed", {
        code: event.code,
        reason: event.reason,
        clean: event.wasClean,
      });
      this.onclose?.(event.reason);
    });
    socket.addEventListener("error", () => {
      diagnostics.record("browser.transport_error");
      this.close();
    });
  }

  send(message: Message) {
    if (message.method === "Target.setAutoAttach" && !message.sessionId)
      message = { ...message, params: { ...message.params, filter: [{ exclude: true }] } };
    if (message.method === "Target.createTarget" && message.id !== undefined)
      this.creates.add(message.id);
    this.socket.send(JSON.stringify(message));
  }

  private receive(message: Message) {
    if (message.id !== undefined && this.attaches.has(message.id)) {
      const created = this.attaches.get(message.id)!;
      this.attaches.delete(message.id);
      this.onmessage?.(
        message.error ? { ...created, result: undefined, error: message.error } : created,
      );
      return;
    }
    if (message.id !== undefined && this.creates.delete(message.id) && message.result?.targetId) {
      const id = this.nextId--;
      this.attaches.set(id, message);
      // Attaching on the root session lets Playwright discover the new work page.
      // Delay the create response until attachment has finished (or failed).
      this.socket.send(
        JSON.stringify({
          id,
          method: "Target.attachToTarget",
          params: { targetId: message.result.targetId, flatten: true },
        }),
      );
      return;
    }
    this.onmessage?.(message);
  }

  close() {
    this.socket.close();
  }
}

export async function openWorkTransport(endpoint: string, timeout = 60000): Promise<WorkTransport> {
  const socket = new WebSocket(endpoint);
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeEventListener("open", opened);
      socket.removeEventListener("error", failed);
      socket.removeEventListener("close", failed);
      if (error) {
        // Keep an error listener while a pending handshake is being cancelled.
        socket.addEventListener("error", () => {}, { once: true });
        socket.close();
        reject(error);
      } else resolve();
    };
    const opened = () => finish();
    const failed = () =>
      finish(new Error("Chrome 调试连接未建立，请检查浏览器连接提示和调试开关。"));
    const timer = setTimeout(
      () => finish(new Error("Chrome 调试连接握手超时；尚未确认连接授权完成。")),
      timeout,
    );
    socket.addEventListener("open", opened, { once: true });
    socket.addEventListener("error", failed, { once: true });
    socket.addEventListener("close", failed, { once: true });
  });
  return new WorkTransport(socket);
}
