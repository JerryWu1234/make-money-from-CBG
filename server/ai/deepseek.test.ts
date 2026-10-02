import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { probeDeepSeek, requestDeepSeek } from "./deepseek";

afterEach(() => vi.unstubAllGlobals());

describe("Pi Agent SDK 的 DeepSeek 调用", () => {
  it("通过真实 SDK 编解码 DeepSeek 流式响应", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const chunk = {
        id: "chatcmpl-fixture",
        object: "chat.completion.chunk",
        created: 0,
        model: "deepseek-flash",
        choices: [
          { index: 0, delta: { role: "assistant", content: "READY" }, finish_reason: "stop" },
        ],
      };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(
      await probeDeepSeek(
        "fixture-only-key",
        "deepseek-flash",
        "Reply with exactly READY.",
        new AbortController().signal,
      ),
    ).toBe("READY");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests[0].url).toBe("https://api.deepseek.com/chat/completions");
    expect(requests[0].headers.get("authorization")).toBe("Bearer fixture-only-key");
    const body = await requests[0].json();
    expect(body.model).toBe("deepseek-flash");
    expect(JSON.stringify(body.messages.at(-1).content)).toContain("Reply with exactly READY.");
    expect(body.max_tokens).toBe(32);
  });

  it("API 拒绝密钥时不会把调用当成成功", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { message: "Invalid API Key", type: "authentication_error" } }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    await expect(
      probeDeepSeek(
        "fixture-only-key",
        "deepseek-flash",
        "Reply READY.",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Invalid API Key");
  });

  it("取消会中止 SDK 的 HTTP 请求", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_input: unknown, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = probeDeepSeek(
      "fixture-only-key",
      "deepseek-flash",
      "Reply READY.",
      controller.signal,
    );
    const cancelled = expect(request).rejects.toThrow();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    controller.abort();
    await cancelled;
  });
  it("商品调用使用足够的输出长度，达到上限时仍返回原始回复供留档", async () => {
    let request: Request | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        request = new Request(input, init);
        const chunk = {
          id: "fixture",
          object: "chat.completion.chunk",
          created: 0,
          model: "deepseek-flash",
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: '{"summary":' },
              finish_reason: "length",
            },
          ],
        };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    const result = await requestDeepSeek(
      "fixture-only-key",
      "deepseek-flash",
      "整份商品原文",
      new AbortController().signal,
    );
    expect(result).toMatchObject({ text: '{"summary":', truncated: true });
    expect((await request!.json()).max_tokens).toBe(4096);
  });
});
