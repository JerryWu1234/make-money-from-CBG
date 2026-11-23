import { createServer } from "node:http";
import { once } from "node:events";
import { attachCodexRuntime } from "./codex-runtime.mjs";

/**
 * A standalone audit is a real exclusive owner, not a borrowed main-service lease.
 * Binding an ephemeral loopback listener runs the same startup guard as the app.
 * If another process owns this project's runtime, attachment fails before any AI call.
 */
export async function acquireConditionAuditRuntime(projectRoot, options = {}) {
  const http = (options.httpServerFactory || createServer)((_request, response) => {
    response.statusCode = 404;
    response.end("This audit listener does not expose application APIs.\n");
  });
  let release;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (http.listening) {
        const finished = once(http, "close");
        http.close();
        await finished;
      }
    } finally {
      if (release) await release();
    }
  };
  try {
    release = await (options.attach || attachCodexRuntime)(
      {
        httpServer: http,
        config: { root: projectRoot, logger: { info: () => {} } },
        // No request is handled while startup is pending: all requests are inert 404s.
        middlewares: { use: () => {} },
      },
      { projectRoot, ...options.runtimeOptions },
    );
    const ready = once(http, "listening");
    http.listen(0, "127.0.0.1");
    await ready;
    return { close };
  } catch (error) {
    await close();
    throw new Error(
      "独立审计无法取得此项目的 Codex 服务租约；未启动 AI。请使用 --compiled-json 重放，或通过 --compile-url 调用已支持规则解析的受管服务。不要并发借用运行中服务的登录目录。",
      { cause: error },
    );
  }
}

/** Existing managed services perform compilation and cleanup in their own process. */
export async function compileAuditThroughService(
  endpoint,
  input,
  options,
  normalizeCompiledRule,
  request = fetch,
) {
  const url = new URL(endpoint);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/api/analysis/conditions/compile"
  )
    throw new Error("--compile-url 仅支持本机 http 服务的 /api/analysis/conditions/compile 接口");
  const response = await request(url, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", Origin: url.origin },
    body: JSON.stringify({
      conditions: {
        id: "G1",
        operator: "and",
        evaluation: "sequence",
        children: input.map((item, index) => ({ ...item, ...(index ? { join: "and" } : {}) })),
      },
      provider: options.provider,
      ...(options.model ? { model: options.model } : {}),
    }),
    signal: AbortSignal.timeout(130_000),
  });
  if (!response.ok)
    throw new Error(
      `受管服务条件解析失败（HTTP ${response.status}）。请确认该服务已部署规则解析接口，或使用 --compiled-json。`,
    );
  const result = await response.json();
  const children = result?.conditions?.children;
  if (
    !Array.isArray(children) ||
    children.length !== input.length ||
    new Set(children.map((item) => item.id)).size !== input.length
  )
    throw new Error("受管服务解析结果缺项或重复");
  const rules = new Map(children.map((item) => [item.id, item.rule]));
  return input.map((item) => ({
    id: item.id,
    rule: normalizeCompiledRule(rules.get(item.id), item.text),
  }));
}
