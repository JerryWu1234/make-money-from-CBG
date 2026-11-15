import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Page } from "playwright-core";
import type { AccessContext } from "../access";
import { CBG_ORIGIN, classifyBusinessResponse } from "../access/response-classifier";
import { queryPageContext, reportQueryCallbackRisk } from "./runtime";

const MAX_MESSAGE_LENGTH = 256;
const MAX_PROOF_LENGTH = 4096;
type CallbackProof = {
  installationId: string;
  activationId: string;
  queryToken: string;
  context: AccessContext;
};
type Host = {
  name: string;
  installationId: string;
  secret: Buffer;
  reasonEpochs: Map<string, number>;
};
const hosts = new WeakMap<Page, Host>();
const installations = new WeakMap<Page, Promise<void>>();

function readProof(host: Host, value: unknown): CallbackProof | undefined {
  if (typeof value !== "string" || value.length > MAX_PROOF_LENGTH) return;
  const parts = value.split(".");
  if (parts.length !== 2 || parts[1].length !== 43) return;
  const actual = Buffer.from(parts[1], "base64url");
  const expected = createHmac("sha256", host.secret).update(parts[0]).digest();
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return;
  const proof = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as CallbackProof;
  return proof.installationId === host.installationId ? proof : undefined;
}

async function observationHost(page: Page) {
  const existing = hosts.get(page);
  if (existing) return existing;
  const host: Host = {
    name: "__cbgQueryRisk_" + randomUUID().replaceAll("-", ""),
    installationId: "",
    secret: randomBytes(32),
    reasonEpochs: new Map(),
  };
  // The binding is one way. Website values never grant permits, accept a query or clear risk.
  await page.exposeBinding(host.name, (source, input: unknown) => {
    try {
      if (
        source.page !== page ||
        source.frame !== page.mainFrame() ||
        new URL(source.frame.url()).origin !== CBG_ORIGIN
      )
        return;
      if (!input || typeof input !== "object") return;
      const data = input as Record<string, unknown>;
      if (data.schemaVersion !== 1) return;
      const proof = readProof(host, data.proof);
      if (!proof || proof.context.queryId !== proof.queryToken) return;
      if (
        !Number.isSafeInteger(data.status) ||
        data.status === 0 ||
        typeof data.msg !== "string" ||
        data.msg.length > MAX_MESSAGE_LENGTH
      )
        return;
      const classification = classifyBusinessResponse({
        url: CBG_ORIGIN + "/cgi-bin/recommend.py",
        status: 200,
        resourceType: "script",
        mainFrame: true,
        body: JSON.stringify({ status: data.status, msg: data.msg }),
      });
      if (classification.kind !== "blocked") return;
      // Three classifier reasons bound this replay ledger, independently of query count.
      if ((host.reasonEpochs.get(classification.reason) ?? -1) >= proof.context.stopEpoch) return;
      // The signed source context, never the latest query, owns a late denial.
      // The proof, original message and other website fields are never retained as evidence.
      if (reportQueryCallbackRisk(page, proof.context, classification))
        host.reasonEpochs.set(classification.reason, proof.context.stopEpoch);
    } catch {
      // A storage failure leaves the shared governor fail-closed. Never reject into website code.
    }
  });
  hosts.set(page, host);
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) host.installationId = "";
  });
  page.once("close", () => {
    host.installationId = "";
  });
  return host;
}

/** Observe a small status/msg copy; never read a detached network body or traverse website data. */
export async function installQueryCallbackObservation(page: Page, kind: "Equipment" | "Pet") {
  const pending = (installations.get(page) ?? Promise.resolve())
    .catch(() => {})
    .then(() => install(page, kind));
  installations.set(page, pending);
  try {
    await pending;
  } finally {
    if (installations.get(page) === pending) installations.delete(page);
  }
}
async function install(page: Page, kind: "Equipment" | "Pet") {
  const host = await observationHost(page);
  const installationId = await page.evaluate(
    ({ kind, name, previousId, nextId, maxLength }) => {
      const g = window as unknown as Record<string, any>;
      const previous = g.__cbgQueryObserver;
      if (
        previous &&
        previous.installationId === previousId &&
        g.ajax_with_recommend === previous.wrapper
      ) {
        previous.kind = kind;
        return previous.installationId as string;
      }
      const original =
        previous && g.ajax_with_recommend === previous.wrapper
          ? previous.original
          : g.ajax_with_recommend;
      if (typeof original !== "function") throw new Error("官网查询组件发生变化");
      const state = {
        original,
        wrapper: undefined as any,
        kind,
        installationId: nextId,
        activation: { token: "", id: "", proof: "" },
      };
      const current = (token: string, activationId: string) =>
        g.__cbgQueryObserver === state &&
        state.activation.token === token &&
        state.activation.id === activationId;
      const observe = (field: string, value: unknown, token: string, activationId: string) => {
        try {
          if (current(token, activationId)) g[field] = value;
        } catch {
          /* Observation must never change website callback behavior. */
        }
      };
      const optionSummary = (options: object) => {
        try {
          const data = Object.getOwnPropertyDescriptor(options, "data")?.value;
          const rawPage =
            data && typeof data === "object"
              ? Object.getOwnPropertyDescriptor(data, "page")?.value
              : undefined;
          const rawServer =
            data && typeof data === "object"
              ? Object.getOwnPropertyDescriptor(data, "server_type")?.value
              : undefined;
          const page =
            typeof rawPage === "number" && Number.isSafeInteger(rawPage)
              ? rawPage
              : typeof rawPage === "string" && /^\d{1,6}$/.test(rawPage)
                ? Number(rawPage)
                : NaN;
          const serverType =
            typeof rawServer === "string" && /^\d{0,8}$/.test(rawServer)
              ? rawServer
              : typeof rawServer === "number" &&
                  Number.isSafeInteger(rawServer) &&
                  rawServer > 0 &&
                  rawServer < 100000000
                ? String(rawServer)
                : "";
          return { page, serverType };
        } catch {
          return { page: NaN, serverType: "" };
        }
      };
      const summarize = (result: unknown) => {
        // Own data properties only: observing must not invoke website getters or serialize arrays.
        if (!result || typeof result !== "object") return undefined;
        const status = Object.getOwnPropertyDescriptor(result, "status");
        const msg = Object.getOwnPropertyDescriptor(result, "msg");
        if (!status || !("value" in status) || !msg || !("value" in msg)) return undefined;
        return { status: status.value as unknown, msg: msg.value as unknown };
      };
      state.wrapper = function (this: unknown, options: Record<string, any>, ...rest: unknown[]) {
        if (!options || typeof options !== "object")
          return Reflect.apply(original, this, [options, ...rest]);
        const activation = state.activation;
        const token = activation.token,
          activationId = activation.id;
        const field = "__cbg" + state.kind + "Result";
        const success = options.onSuccess,
          failure = options.onFailure;
        return Reflect.apply(original, this, [
          {
            ...options,
            onSuccess: function (this: unknown, ...values: unknown[]) {
              try {
                const result = summarize(values[0]);
                const items = result && Array.isArray(result.msg) ? result.msg : undefined;
                const length = items && Object.getOwnPropertyDescriptor(items, "length")?.value;
                observe(
                  field,
                  {
                    queryToken: token,
                    ...optionSummary(options),
                    ok: result?.status === 0 && !!items,
                    count: typeof length === "number" ? length : -1,
                    error: typeof result?.msg === "string" ? "官网查询未确认成功" : "",
                  },
                  token,
                  activationId,
                );
                if (
                  g.__cbgQueryObserver === state &&
                  activation.proof &&
                  result &&
                  Number.isSafeInteger(result.status) &&
                  result.status !== 0 &&
                  typeof result.msg === "string" &&
                  result.msg.length <= maxLength
                ) {
                  // No await: retain synchronous callback return/throw and original call count.
                  const sent = g[name]({
                    schemaVersion: 1,
                    proof: activation.proof,
                    status: result.status,
                    msg: result.msg,
                  });
                  void Promise.resolve(sent).catch(() => {});
                }
              } catch {
                /* Keep the original callback's return/throw intact. */
              }
              return typeof success === "function"
                ? Reflect.apply(success, this, values)
                : undefined;
            },
            onFailure: function (this: unknown, ...values: unknown[]) {
              try {
                observe(
                  field,
                  {
                    queryToken: token,
                    ...optionSummary(options),
                    ok: false,
                    error: "官网查询请求失败",
                  },
                  token,
                  activationId,
                );
              } catch {
                /* Observation errors must not replace the original failure callback. */
              }
              return typeof failure === "function"
                ? Reflect.apply(failure, this, values)
                : undefined;
            },
          },
          ...rest,
        ]);
      };
      g.__cbgQueryObserver = state;
      g.ajax_with_recommend = state.wrapper;
      return state.installationId;
    },
    {
      kind,
      name: host.name,
      previousId: host.installationId,
      nextId: randomUUID(),
      maxLength: MAX_MESSAGE_LENGTH,
    },
  );
  if (host.installationId !== installationId) host.reasonEpochs.clear();
  host.installationId = installationId;
}

export async function activateQueryObservation(page: Page, token: string) {
  await installations.get(page);
  const host = hosts.get(page);
  if (!host) return;
  if (!token || token.length > 200) throw new Error("无效官网查询观察标识");
  const context = queryPageContext(page);
  const activationId = randomUUID();
  let proof = "";
  if (context?.queryId === token) {
    // Only local correlation identifiers cross into the page. Recovery credentials and
    // website parameters never enter this capability or the callback summary.
    const {
      owner,
      fence,
      runId,
      queryId,
      pageId,
      pageGeneration,
      browserSessionEpoch,
      stopEpoch,
      sourceKind,
      actionId,
    } = context;
    const source: AccessContext = {
      owner,
      fence,
      runId,
      queryId,
      pageId,
      pageGeneration,
      browserSessionEpoch,
      stopEpoch,
      sourceKind,
      actionId,
    };
    const encoded = Buffer.from(
      JSON.stringify({
        installationId: host.installationId,
        activationId,
        queryToken: token,
        context: source,
      } satisfies CallbackProof),
    ).toString("base64url");
    proof = encoded + "." + createHmac("sha256", host.secret).update(encoded).digest("base64url");
    if (proof.length > MAX_PROOF_LENGTH) throw new Error("官网查询观察上下文过大，已停止本次查询");
  }
  await page.evaluate(
    ({ token, activationId, installationId, proof }) => {
      const g = window as unknown as Record<string, any>;
      const state = g.__cbgQueryObserver;
      if (state?.installationId === installationId)
        state.activation = { token, id: activationId, proof };
    },
    { token, activationId, installationId: host.installationId, proof },
  );
}
export async function clearQueryCallbackObservation(page: Page) {
  await installations.get(page)?.catch(() => {});
  const host = hosts.get(page);
  if (!host) return;
  const installationId = host.installationId;
  host.installationId = "";
  await page.evaluate((installationId) => {
    const g = window as unknown as Record<string, any>;
    const state = g.__cbgQueryObserver;
    if (!state || state.installationId !== installationId) return;
    if (g.ajax_with_recommend === state.wrapper) g.ajax_with_recommend = state.original;
    if (g.__cbgQueryObserver === state) delete g.__cbgQueryObserver;
  }, installationId);
}
