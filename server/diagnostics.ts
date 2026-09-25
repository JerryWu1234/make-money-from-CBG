import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { Page } from "playwright-core";
import type { OpenCbgResult } from "./types";

// Never pass page snapshots, response bodies or browser credentials to the logger.
const privateKey =
  /cookie|authorization|password|token|secret|qrcode|account|nickname|selectedRoleId|headers|html|^(?:raw|summary|attrs)$/i;
export function cleanDiagnostic(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: cleanDiagnostic(value.message) };
  if (typeof value === "string")
    return stripVTControlCharacters(value)
      .replace(/data:[^\s"'<>]+/gi, "[data omitted]")
      .replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi, (address) => {
        try {
          const url = new URL(address);
          return `${url.protocol}//${url.host}${url.protocol.startsWith("ws") ? "/[endpoint omitted]" : url.pathname}`;
        } catch {
          return "[URL omitted]";
        }
      })
      .replace(/<[^>]*>/g, "[element]")
      .replace(
        /^.*(?:cookie|authorization|password|token|secret|accountUrs|nickname|selectedRoleId)\s*[=:].*$/gim,
        "[private line omitted]",
      )
      .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email omitted]")
      .slice(0, 6000);
  if (Array.isArray(value)) return value.slice(0, 100).map(cleanDiagnostic);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => !privateKey.test(key) && item !== undefined)
        .map(([key, item]) => [key, cleanDiagnostic(item)]),
    );
  return value;
}

export class DiagnosticLog {
  private file: string | undefined;
  private readonly started = Date.now();
  private readonly runId = randomUUID();
  private sequence = 0;
  private writeError: string | null = null;

  constructor(
    private readonly directory = path.resolve("data/logs"),
    private readonly enabled = true,
  ) {}

  record(event: string, data: Record<string, unknown> = {}) {
    if (!this.enabled) return;
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      this.file ||= path.join(
        this.directory,
        `run-${new Date(this.started).toISOString().replace(/[:.]/g, "-")}-${this.runId}.jsonl`,
      );
      appendFileSync(
        this.file,
        JSON.stringify({
          timestamp: new Date().toISOString(),
          elapsedMs: Date.now() - this.started,
          runId: this.runId,
          sequence: ++this.sequence,
          event,
          data: cleanDiagnostic(data),
        }) + "\n",
        { mode: 0o600 },
      );
      this.writeError = null;
    } catch {
      if (!this.writeError)
        console.error("[CBG_LOG] 无法保存运行日志，请检查 data/logs 的写入权限和磁盘空间。");
      this.writeError = "无法保存运行日志，请检查 data/logs 的写入权限和磁盘空间。";
    }
  }

  export() {
    let file = this.file;
    // A dev-server restart must not hide the preceding attempt's log.
    if (!file && !this.writeError) {
      try {
        const name = readdirSync(this.directory)
          .filter((name) => /^run-.*\.jsonl$/.test(name))
          .sort()
          .at(-1);
        if (name) file = path.join(this.directory, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const events: unknown[] = [];
    let incompleteLines = 0;
    if (file) {
      let contents = "";
      try {
        contents = readFileSync(file, "utf8");
      } catch (error) {
        if (!this.writeError) throw error;
      }
      for (const line of contents.split("\n").filter(Boolean)) {
        try {
          events.push(JSON.parse(line));
        } catch {
          incompleteLines++;
        }
      }
    }
    return {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      file: file ?? null,
      writeError: this.writeError,
      incompleteLines,
      events,
    };
  }
}

export const diagnostics = new DiagnosticLog(undefined, !process.env.VITEST);

export function workflowDiagnostic(state: OpenCbgResult) {
  return {
    workflowStep: state.workflowStep,
    message: cleanDiagnostic(state.message),
    pageUrl: cleanDiagnostic(state.url),
    loginStep: state.step,
    connected: state.connected,
    loginStatus: state.loginStatus,
    isLoggedIn: state.isLoggedIn,
    needLogin: state.needLogin,
    hasQr: Boolean(state.qrCodeUrl),
    dialogDetected: state.dialogDetected,
    roleDetected: state.roleDetected,
    roleSelected: state.roleSelected,
    running: state.running,
    rowCount: state.roleList?.rows.length,
  };
}

const watched = new WeakSet<Page>();
export function watchWorkPage(page: Page, kind: "list" | "detail") {
  if (watched.has(page)) return;
  watched.add(page);
  page.on("pageerror", (error) => diagnostics.record("page.error", { kind, error }));
  page.on("requestfailed", (request) =>
    diagnostics.record("page.request_failed", {
      kind,
      url: request.url(),
      resourceType: request.resourceType(),
      error: request.failure()?.errorText,
    }),
  );
  page.on("response", (response) => {
    if (response.status() >= 400)
      diagnostics.record("page.http_error", {
        kind,
        url: response.url(),
        status: response.status(),
      });
  });
  page.on("close", () => diagnostics.record("page.closed", { kind }));
}
