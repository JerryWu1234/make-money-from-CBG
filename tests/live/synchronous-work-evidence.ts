import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import {
  accountRegions,
  evidenceSignature,
  isEvidencePage,
  observeWorkPage,
} from "./work-page-evidence";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
type Step = {
  method: string;
  locator?: string;
  outcome: "returned" | "threw";
  readResult?: Record<string, string | number | string[]>;
};
function publicReadResult(value: unknown): Step["readResult"] {
  if (typeof value === "string")
    return /等级|防御|伤害|未鉴定物品/.test(value) ? { text: value.slice(0, 40000) } : undefined;
  if (!value || typeof value !== "object") return undefined;
  const result: NonNullable<Step["readResult"]> = {};
  for (const key of [
    "name",
    "tooltip",
    "description",
    "productName",
    "productId",
    "serverId",
    "modelId",
    "kindId",
    "rawPrice",
    "prices",
  ]) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "string") result[key] = field.slice(0, 40000);
    else if (typeof field === "number") result[key] = field;
    else if (Array.isArray(field) && field.every((entry) => typeof entry === "string"))
      result[key] = field.slice(0, 20).map((entry) => entry.slice(0, 100));
  }
  return Object.keys(result).length ? result : undefined;
}
type Method = (...args: unknown[]) => unknown;
type Methods = Record<string, unknown>;

/** Instance-only wrapping: preserve the actual operation and await its evidence before returning. */
export function instrumentWorkPage(
  page: Page,
  checkpoint: (step: Step) => Promise<void>,
  failed: (error: unknown) => void = () => {},
) {
  const restores: Array<() => void> = [];
  const seen = new WeakSet<object>();
  let stopped = false;
  const replace = (object: object, key: string, factory: (original: Method) => Method) => {
    const target = object as Methods;
    if (typeof target[key] !== "function") return;
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    const original = target[key] as Method;
    target[key] = factory(original.bind(object));
    restores.push(() => {
      if (descriptor) Object.defineProperty(object, key, descriptor);
      else delete target[key];
    });
  };
  const action = (object: object, key: string, kind: string, locator?: string) =>
    replace(object, key, (original) => async (...args) => {
      let outcome: Step["outcome"] = "returned";
      let readResult: Step["readResult"];
      try {
        const result = await original(...args);
        if (key === "evaluate" || key === "evaluateAll") readResult = publicReadResult(result);
        return result;
      } catch (error) {
        outcome = "threw";
        throw error;
      } finally {
        if (!stopped) {
          try {
            await checkpoint({ method: kind + "." + key, locator, outcome, readResult });
          } catch (error) {
            // Never turn screenshot failures into market read_failed/no-sample results.
            try {
              failed(error);
            } catch {
              /* Audit callbacks cannot replace business outcomes. */
            }
          }
        }
      }
    });
  const factories = [
    "locator",
    "getByText",
    "getByRole",
    "getByLabel",
    "getByPlaceholder",
    "getByAltText",
    "getByTitle",
    "getByTestId",
  ];
  const wrapLocator = (value: unknown): unknown => {
    if (!value || typeof value !== "object" || seen.has(value)) return value;
    seen.add(value);
    const label = (value as { toString(): string }).toString().slice(0, 500);
    for (const key of [
      "fill",
      "clear",
      "check",
      "uncheck",
      "setChecked",
      "selectOption",
      "click",
      "dblclick",
      "press",
      "pressSequentially",
      "type",
      "hover",
      "scrollIntoViewIfNeeded",
      "evaluate",
      "evaluateAll",
    ])
      action(value, key, "locator", label);
    for (const key of [...factories, "first", "last", "nth", "filter", "and", "or"])
      replace(
        value,
        key,
        (original) =>
          (...args) =>
            wrapLocator(original(...args)),
      );
    return value;
  };
  for (const key of factories)
    replace(
      page,
      key,
      (original) =>
        (...args) =>
          wrapLocator(original(...args)),
    );
  for (const key of ["goto", "reload", "evaluate", "waitForFunction", "content"])
    action(page, key, "page");
  action(page.mouse, "up", "mouse");
  return () => {
    stopped = true;
    for (const restore of restores.reverse()) restore();
  };
}

/** Installs before the producer starts; creates no browser connection, page, or navigation. */
export async function startSynchronousWorkEvidence(
  directory: string,
  browser: Browser,
  onBlocked: (reason: string) => void,
) {
  const root = path.join(directory, "synchronous-work-evidence");
  await mkdir(root, { recursive: true });
  const output = await mkdtemp(path.join(root, "session-"));
  const relative = (name: string) => path.relative(directory, path.join(output, name));
  const entries: Array<{
    id: number;
    page: number;
    at: string;
    method: string;
    locator?: string;
    outcome: Step["outcome"];
    state: "captured" | "gate" | "failed";
    durationMs: number;
    signature?: string;
    url?: string;
    reason?: string;
    attempts?: Array<{ at: string; elapsedMs: number; reason: string }>;
    files?: Array<{ name: string; sha256: string }>;
  }> = [];
  const failures: Array<{ at: string; reason: string }> = [];
  const attached = new Map<Page, () => void>();
  const contexts = new Map<BrowserContext, (page: Page) => void>();
  const connections = new Map<Browser, () => void>();
  const pending = new Set<Promise<void>>();
  let nextId = 0,
    nextPage = 0,
    blocked: string | undefined,
    stopping = false;
  let writes = Promise.resolve();
  const flush = () => {
    const bytes = JSON.stringify(
      {
        version: 1,
        scope: "production-connection-official-pages-synchronous-actions",
        auditBlocked: blocked || null,
        limits: [
          "Only instrumented public Page/Locator calls and mouse.up; no browser-internal operation or network proof",
          "Gate pages have no screenshot; up to 3 capture attempts share 9000ms per step, file writes add time; all failed attempts block audit",
          "Same-page steps await evidence; concurrent pages can still change independently",
          "Form edits may retain previous submittedArgs; bind completed submissions to uiQueries, not timestamps",
          "No direct unique asset binding when multiple assets have identical query conditions",
          "Screenshot time counts toward existing production timeouts",
        ],
        entries: [...entries].sort((a, b) => a.id - b.id),
        failures,
      },
      null,
      2,
    );
    writes = writes.then(() => writeFile(path.join(output, "index.json"), bytes, { mode: 0o600 }));
    return writes.then(() => ({ name: relative("index.json"), sha256: hash(bytes) }));
  };
  const block = (reason: string) => {
    failures.push({ at: new Date().toISOString(), reason });
    if (!stopping && !blocked) {
      blocked = reason;
      onBlocked(reason);
    }
  };
  const install = (page: Page) => {
    if (stopping || attached.has(page)) return;
    const pageId = ++nextPage;
    const evaluate = page.evaluate.bind(page) as Page["evaluate"];
    const locator = page.locator.bind(page);
    const checkpoint = async (step: Step) => {
      if (stopping || page.isClosed() || !isEvidencePage(page.url())) return;
      const entry: (typeof entries)[number] = {
        id: ++nextId,
        page: pageId,
        at: new Date().toISOString(),
        method: step.method,
        locator: step.locator,
        outcome: step.outcome,
        state: "failed",
        durationMs: 0,
      };
      const started = Date.now();
      const deadline = started + 9000;
      const readBudget = () => Math.max(1, Math.min(2000, deadline - Date.now()));
      entry.attempts = [];
      for (let attempt = 0; attempt < 3 && Date.now() < deadline; attempt++) {
        const attemptAt = new Date().toISOString();
        try {
          const before = await observeWorkPage({ evaluate }, readBudget());
          if (before.gate) {
            entry.state = "gate";
            entry.reason = "login_or_verification_visible_no_image";
            break;
          }
          const shotAt = new Date().toISOString();
          const fullPage = new URL(before.url).pathname.startsWith("/cgi-bin/");
          const png = await page.screenshot({
            timeout: Math.max(1, Math.min(2500, deadline - Date.now())),
            fullPage,
            mask: [locator(accountRegions)],
            maskColor: "#20394b",
          });
          const after = await observeWorkPage({ evaluate }, readBudget());
          if (after.gate) {
            entry.state = "gate";
            entry.reason = "verification_appeared_during_screenshot_no_image";
            break;
          }
          if (evidenceSignature(before) !== evidenceSignature(after)) {
            entry.attempts.push({
              at: attemptAt,
              elapsedMs: Date.now() - started,
              reason: "state_changed_during_screenshot",
            });
          } else {
            entry.attempts.push({
              at: attemptAt,
              elapsedMs: Date.now() - started,
              reason: "stable",
            });
            const stem = String(entry.id).padStart(6, "0");
            const signature = evidenceSignature(before);
            // A general body.innerText result can include the account bar. Only retain
            // string reads bound to the already scoped public tooltip/description.
            const normalize = (value: string) => value.replace(/\s+/g, "").trim();
            const readResult =
              typeof step.readResult?.text === "string" &&
              ![before.description, ...before.tooltips].some(
                (text) => normalize(text) === normalize(String(step.readResult!.text)),
              )
                ? undefined
                : step.readResult;
            const json = JSON.stringify(
              {
                ...entry,
                state: "captured",
                durationMs: Date.now() - started,
                observedAt: attemptAt,
                shotAt,
                verifiedAt: new Date().toISOString(),
                signature,
                captureMode: fullPage ? "full-page" : "viewport",
                descriptionSha256: hash(before.description),
                readResult,
                observation: before,
              },
              null,
              2,
            );
            await writeFile(path.join(output, stem + ".png"), png, { mode: 0o600 });
            await writeFile(path.join(output, stem + ".json"), json, { mode: 0o600 });
            Object.assign(entry, {
              state: "captured",
              url: before.url,
              signature,
              files: [
                { name: relative(stem + ".png"), sha256: hash(png) },
                { name: relative(stem + ".json"), sha256: hash(json) },
              ],
            });
            break;
          }
        } catch {
          entry.attempts.push({
            at: attemptAt,
            elapsedMs: Date.now() - started,
            reason: "screenshot_or_state_read_failed",
          });
        }
        if (attempt < 2 && Date.now() + 100 < deadline)
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (entry.state === "failed") {
        entry.reason = "synchronous_screenshot_or_state_read_failed";
        block(`step_${entry.id}_${step.method}_evidence_failed`);
      }
      entry.durationMs = Date.now() - started;
      entries.push(entry);
      await flush();
    };
    const restore = instrumentWorkPage(
      page,
      (step) => {
        const work = checkpoint(step);
        pending.add(work);
        void work.finally(() => pending.delete(work)).catch(() => {});
        return work;
      },
      () => block("synchronous_evidence_write_failed"),
    );
    attached.set(page, restore);
  };
  const attach = (connection: Browser) => {
    if (!connection.isConnected()) throw new Error("生产浏览器未连接，截图审核无法开始");
    if (!connections.has(connection)) {
      const disconnected = () => block("production_browser_disconnected_reinstall_before_retry");
      connection.on("disconnected", disconnected);
      connections.set(connection, disconnected);
    }
    for (const context of connection.contexts()) {
      if (!contexts.has(context)) {
        // Synchronous listener: install before createHiddenPage returns its new Page.
        context.on("page", install);
        contexts.set(context, install);
      }
      for (const page of context.pages()) install(page);
    }
  };
  attach(browser);
  await flush();
  return {
    get auditBlocked() {
      return blocked;
    },
    async rearm(connection: Browser) {
      attach(connection);
      blocked = undefined;
      await flush();
    },
    async stop() {
      stopping = true;
      for (const [context, listener] of contexts) context.off("page", listener);
      for (const [connection, listener] of connections) connection.off("disconnected", listener);
      await Promise.allSettled(pending);
      for (const restore of attached.values()) restore();
      return flush();
    },
  };
}
