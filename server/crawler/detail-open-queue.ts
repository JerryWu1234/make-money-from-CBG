export const DETAIL_OPEN_INTERVAL_MS = 5000;

/** Space starts, not whole captures; loaded detail pages can keep reading in parallel. */
export function createDetailOpenQueue(intervalMs = DETAIL_OPEN_INTERVAL_MS) {
  let tail = Promise.resolve();
  let nextOpenAt = 0;
  return (signal: AbortSignal) => {
    const turn = tail.then(async () => {
      signal.throwIfAborted();
      const remaining = nextOpenAt - Date.now();
      if (remaining > 0) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", cancel);
            resolve();
          }, remaining);
          const cancel = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          signal.addEventListener("abort", cancel, { once: true });
        });
      }
      signal.throwIfAborted();
      nextOpenAt = Date.now() + intervalMs;
    });
    tail = turn.catch(() => {});
    return turn;
  };
}
