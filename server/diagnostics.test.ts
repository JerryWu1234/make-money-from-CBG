import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanDiagnostic, DiagnosticLog, workflowDiagnostic } from "./diagnostics";
import { disconnectedState } from "./page-state";

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return { ...original, writeFileSync: vi.fn(original.writeFileSync) };
});

const directories: string[] = [];
function temporaryDirectory() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "cbg-logs-"));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("durable diagnostic logs", () => {
  it("persists ordered events and exports the preceding run after a restart", () => {
    const directory = temporaryDirectory();
    const log = new DiagnosticLog(directory);
    log.record("browser.connect_start");
    log.record("workflow.error", { error: new Error("连接超时"), durationMs: 60000 });
    const result = new DiagnosticLog(directory).export();
    expect(result.events).toMatchObject([
      { sequence: 1, event: "browser.connect_start" },
      {
        sequence: 2,
        event: "workflow.error",
        data: { error: { message: "连接超时" }, durationMs: 60000 },
      },
    ]);
    expect(result.writeError).toBeNull();
    expect(JSON.parse(JSON.stringify(result)).events).toHaveLength(2);
    // A truncated final write must not hide the completed events.
    appendFileSync(result.file!, '{"timestamp":');
    expect(new DiagnosticLog(directory).export()).toMatchObject({
      events: result.events,
      incompleteLines: 1,
    });
  });

  it("omits credentials, QR payloads and account identity while retaining failure context", () => {
    const log = new DiagnosticLog(temporaryDirectory());
    log.record("workflow.error", {
      accountUrs: "secret-account",
      qrCodeUrl: "secret-qr",
      headers: { cookie: "secret-cookie" },
      url: "https://user:pass@xyq.cbg.163.com/equip?s=367&token=secret-query",
      error: new Error(
        '\u001b[2mlocator.hover: Timeout 5000ms exceeded\u001b[22m\n<img data-secret="secret-attribute">\nCookie: secret-inline\nlogin=person@example.test\ndata:image/png;base64,secret-image',
      ),
      page: 2,
      crawlId: "public-crawl-id",
      key: "367:public-product-id",
    });
    const json = JSON.stringify(log.export());
    expect(json).not.toMatch(/secret-|person@example|user:pass/);
    expect(json).not.toContain("\\u001b");
    expect(json).toContain("locator.hover: Timeout 5000ms exceeded");
    expect(json).toContain("367:public-product-id");
    expect(json).toContain("public-crawl-id");
    expect(cleanDiagnostic("ws://127.0.0.1:9222/devtools/browser/private-id")).not.toContain(
      "private-id",
    );
    const state = workflowDiagnostic({
      ...disconnectedState("登录"),
      accountUrs: "secret-account",
      nickname: "secret-name",
      qrCodeUrl: "secret-qr",
      selectedRoleId: "secret-role",
    });
    expect(state.hasQr).toBe(true);
    expect(JSON.stringify(state)).not.toContain("secret-");
  });

  it("reports a disk write failure without interrupting the workflow", () => {
    const file = path.join(temporaryDirectory(), "not-a-directory");
    writeFileSync(file, "fixture");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = new DiagnosticLog(file);
    expect(() => log.record("browser.connect_start")).not.toThrow();
    expect(error).toHaveBeenCalledOnce();
    expect(log.export()).toMatchObject({
      events: [],
      writeError: expect.stringContaining("无法保存运行日志"),
    });
  });

  it("cleans a marker created before ENOSPC and resumes logging when disk writes recover", () => {
    const directory = temporaryDirectory();
    const writers = path.join(directory, ".writers");
    const log = new DiagnosticLog(directory);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      // openSync already created this temporary file; its first write now fails.
      const [temporary] = readdirSync(writers);
      expect(temporary).toMatch(/\.tmp$/);
      expect(statSync(path.join(writers, temporary)).size).toBe(0);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    expect(() => log.record("before-recovery")).not.toThrow();
    expect(error).toHaveBeenCalledOnce();
    expect(readdirSync(writers)).toEqual([]);
    expect(log.export()).toMatchObject({ events: [], writeError: expect.any(String) });

    log.record("after-recovery");
    expect(log.export()).toMatchObject({
      events: [{ sequence: 1, event: "after-recovery" }],
      writeError: null,
    });
    const { runId } = log.storageContext();
    expect(readdirSync(writers)).toEqual([runId + ".json"]);
    expect(JSON.parse(readFileSync(path.join(writers, runId + ".json"), "utf8"))).toEqual({
      runId,
      pid: process.pid,
    });
  });
});
