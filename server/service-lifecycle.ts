const lifecycleKey = Symbol.for("cbg.service-lifecycle.v1");
const runtime = globalThis as typeof globalThis & {
  [lifecycleKey]?: { closing: boolean };
};
const lifecycle = (runtime[lifecycleKey] ??= { closing: false });

export function beginServiceShutdown() {
  lifecycle.closing = true;
}

export function assertServiceOpen() {
  if (lifecycle.closing) throw new Error("本地服务正在关闭，请稍后重试");
}

export function resetServiceLifecycle() {
  lifecycle.closing = false;
}
