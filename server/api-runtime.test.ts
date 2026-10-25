import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  runtimeSettings: vi.fn(),
  saveRuntimeSettings: vi.fn(),
  preview: vi.fn(),
  clear: vi.fn(),
  record: vi.fn(),
  crawlerImported: vi.fn(),
  analysisImported: vi.fn(),
  browserImported: vi.fn(),
}));
vi.mock("./runtime-settings", () => mocks);
vi.mock("./log-storage", () => ({
  logStorage: { preview: mocks.preview, clear: mocks.clear },
}));
vi.mock("./diagnostics", () => ({ diagnostics: { record: mocks.record } }));
vi.mock("./crawler/controller", () => {
  mocks.crawlerImported();
  return {};
});
vi.mock("./analysis/controller", () => {
  mocks.analysisImported();
  return {};
});
vi.mock("./browser", () => {
  mocks.browserImported();
  return {};
});

function request(pathname: string, method = "GET", body: Record<string, unknown> = {}) {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    url: pathname,
    method,
    headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
  }) as IncomingMessage;
}

function response() {
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    destroyed: false,
    setHeader: vi.fn(),
    end: vi.fn(),
  });
  return res as typeof res & ServerResponse;
}

async function invoke(req: IncomingMessage) {
  const res = response();
  const next = vi.fn();
  await (await import("./api")).apiMiddleware(req, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(mocks.crawlerImported).not.toHaveBeenCalled();
  expect(mocks.analysisImported).not.toHaveBeenCalled();
  expect(mocks.browserImported).not.toHaveBeenCalled();
  return res;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.resetModules();
});

describe("runtime settings API", () => {
  it("reads runtime settings without loading collection or analysis controllers", async () => {
    mocks.runtimeSettings.mockReturnValue({ saveScreenshots: false });
    const res = await invoke(request("/api/runtime/settings"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ saveScreenshots: false });
    expect(mocks.runtimeSettings).toHaveBeenCalledOnce();
    expect(mocks.saveRuntimeSettings).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");
  });

  it.each([false, true])(
    "saves the strict boolean %s independently of valuation settings",
    async (value) => {
      mocks.saveRuntimeSettings.mockReturnValue({ saveScreenshots: value });
      const res = await invoke(
        request("/api/runtime/settings/save", "POST", { saveScreenshots: value }),
      );
      expect(res.statusCode).toBe(200);
      expect(mocks.saveRuntimeSettings).toHaveBeenCalledExactlyOnceWith(value);
      expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ saveScreenshots: value });
    },
  );

  it.each([undefined, null, "false", 0, {}, []])(
    "rejects an invalid flag %j without saving",
    async (value) => {
      const res = await invoke(
        request("/api/runtime/settings/save", "POST", { saveScreenshots: value }),
      );
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ error: "保存截图选项必须为布尔值" });
      expect(mocks.saveRuntimeSettings).not.toHaveBeenCalled();
    },
  );

  it("reports a persistence failure instead of claiming a successful change", async () => {
    mocks.saveRuntimeSettings.mockImplementation(() => {
      throw new Error("写入失败");
    });
    const res = await invoke(
      request("/api/runtime/settings/save", "POST", { saveScreenshots: false }),
    );
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ error: "写入失败" });
  });
});

describe("log storage API", () => {
  it("returns the preview token and storage summary without clearing", async () => {
    const preview = {
      token: "preview-token",
      runs: 2,
      files: 8,
      bytes: 1234,
      protectedRuns: ["active"],
    };
    mocks.preview.mockResolvedValue(preview);
    const res = await invoke(request("/api/logs/storage"));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual(preview);
    expect(mocks.preview).toHaveBeenCalledOnce();
    expect(mocks.clear).not.toHaveBeenCalled();
  });

  it("passes only the preview token to clear and returns the actual receipt", async () => {
    const receipt = {
      removedRuns: 1,
      removedFiles: 4,
      freedBytes: 512,
      skippedRuns: ["active"],
      errors: [],
    };
    mocks.clear.mockResolvedValue(receipt);
    const res = await invoke(request("/api/logs/clear", "POST", { token: "preview-token" }));
    expect(res.statusCode).toBe(200);
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith("preview-token");
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual(receipt);
  });

  it("requires a fresh preview when a token is missing, invalid or expired", async () => {
    mocks.clear.mockRejectedValue(
      Object.assign(new Error("清理预览已失效，请重新预览"), { name: "LogStorageTokenError" }),
    );
    const res = await invoke(request("/api/logs/clear", "POST"));
    expect(mocks.clear).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ error: "清理预览已失效，请重新预览" });
  });

  it("keeps genuine storage failures as server errors", async () => {
    mocks.preview.mockRejectedValue(new Error("读取日志目录失败"));
    const res = await invoke(request("/api/logs/storage"));
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.end.mock.calls[0][0])).toEqual({ error: "读取日志目录失败" });
  });
});

it.each([
  ["/api/runtime/settings", "POST"],
  ["/api/runtime/settings/save", "GET"],
  ["/api/logs/storage", "POST"],
  ["/api/logs/clear", "GET"],
])("keeps method and origin checks for %s", async (pathname, method) => {
  const unsupported = await invoke(request(pathname, method));
  expect(unsupported.statusCode).toBe(405);
  const crossOrigin = request(pathname, method === "POST" ? "GET" : "POST");
  crossOrigin.headers.origin = "http://untrusted.example";
  const forbidden = await invoke(crossOrigin);
  expect(forbidden.statusCode).toBe(403);
  expect(mocks.saveRuntimeSettings).not.toHaveBeenCalled();
  expect(mocks.clear).not.toHaveBeenCalled();
});
