import {
  appendFileSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import type { Page, Request } from "playwright-core";
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
  private writerRegistered = false;

  constructor(
    private readonly directory = path.resolve("data/logs"),
    private readonly enabled = true,
  ) {}

  storageContext() {
    return { directory: this.directory, runId: this.runId };
  }

  private registerWriter() {
    if (!this.enabled || this.writerRegistered) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = path.join(this.directory, ".writers");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink() || lstatSync(directory).isSymbolicLink())
      throw new Error("运行日志目录不能使用符号链接");
    const temporary = path.join(directory, `${this.runId}-${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, "wx", 0o600);
    try {
      try {
        writeFileSync(descriptor, JSON.stringify({ runId: this.runId, pid: process.pid }));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporary, path.join(directory, this.runId + ".json"));
      this.writerRegistered = true;
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Keep the original write error; a unique temporary name cannot block a retry.
      }
      throw error;
    }
  }

  evidenceDirectory() {
    try {
      this.registerWriter();
    } catch {
      // Screenshot/log write failures are reported by their existing callers.
    }
    return path.join(this.directory, "browser-steps", this.runId);
  }

  record(event: string, data: Record<string, unknown> = {}) {
    if (!this.enabled) return;
    try {
      this.registerWriter();
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

type QueryEvidence = { requestId: string; started: number; phase: string };
const watched = new WeakMap<Page, { pageId: string; query?: QueryEvidence }>();

export function workPageDiagnostic(page: Page) {
  const context = watched.get(page);
  return context
    ? {
        pageId: context.pageId,
        ...(context.query
          ? {
              lastQueryId: context.query.requestId,
              lastQueryPhase: context.query.phase,
              lastQueryAgeMs: Date.now() - context.query.started,
            }
          : {}),
      }
    : {};
}

/** Keep only response format and error fields, never the response body or role data. */
export function listQueryResponseDiagnostic(text: string) {
  if (Buffer.byteLength(text, "utf8") > 32 * 1024) return { format: "too-large" };
  const wrapper = text.trim().match(/^([\w.$]+)\s*\(([\s\S]*)\)\s*;?$/);
  try {
    const value: unknown = JSON.parse(wrapper ? wrapper[2]! : text);
    const result: Record<string, unknown> = { format: wrapper ? "jsonp" : "json" };
    if (wrapper)
      result.expectedCallback = /^Request\.JSONP\.request_map\.request_\d+$/.test(wrapper[1]!);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const data = value as Record<string, unknown>;
      for (const key of ["status", "status_code", "code", "msg", "message", "error"]) {
        const field = data[key];
        if (typeof field === "string") result[key] = cleanDiagnostic(field.slice(0, 240));
        else if (typeof field === "number" || typeof field === "boolean") result[key] = field;
      }
    }
    return result;
  } catch {
    return { format: "unrecognized" };
  }
}

export function watchWorkPage(page: Page, kind: "list" | "detail") {
  if (watched.has(page)) return;
  const context: { pageId: string; query?: QueryEvidence } = { pageId: randomUUID() };
  watched.set(page, context);
  const queries = new WeakMap<Request, QueryEvidence>();
  const reportQuery = (request: Request, phase: string, extra: Record<string, unknown> = {}) => {
    const query = queries.get(request);
    if (!query) return;
    query.phase = phase;
    diagnostics.record("list.query", {
      pageId: context.pageId,
      requestId: query.requestId,
      phase,
      durationMs: Date.now() - query.started,
      ...extra,
    });
  };
  page.on("request", (request) => {
    if (kind !== "list") return;
    try {
      const url = new URL(request.url());
      if (
        url.origin !== new URL(page.url()).origin ||
        url.pathname !== "/cgi-bin/recommend.py" ||
        !["script", "xhr", "fetch"].includes(request.resourceType()) ||
        request.frame() !== page.mainFrame()
      )
        return;
      const query = { requestId: randomUUID(), started: Date.now(), phase: "started" };
      context.query = query;
      queries.set(request, query);
      const order = url.searchParams.get("order_by") || "";
      const number = url.searchParams.get("page") || "";
      reportQuery(request, "started", {
        method: request.method(),
        resourceType: request.resourceType(),
        path: url.pathname,
        order: /^(?:expire_time|selling_time) (?:ASC|DESC)$/.test(order) ? order : undefined,
        page: /^\d{1,6}$/.test(number) ? Number(number) : undefined,
      });
    } catch {
      // Detached frames and non-page requests are outside this evidence scope.
    }
  });
  page.on("requestfinished", (request) => reportQuery(request, "finished"));
  page.on("requestfailed", (request) =>
    reportQuery(request, "failed", { error: request.failure()?.errorText }),
  );
  page.on("response", (response) => {
    const request = response.request();
    const query = queries.get(request);
    if (!query) return;
    reportQuery(request, "response", { httpStatus: response.status() });
    const summary = (data: Record<string, unknown>) =>
      diagnostics.record("list.query_result", {
        pageId: context.pageId,
        requestId: query.requestId,
        httpStatus: response.status(),
        ...data,
      });
    void response.text().then(
      (text) => summary(listQueryResponseDiagnostic(text)),
      () => summary({ format: "unavailable" }),
    );
  });
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
  page.on("close", () => diagnostics.record("page.closed", { kind, ...workPageDiagnostic(page) }));
}
