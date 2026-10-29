import { aiRequestIssue } from "../ai/request-error";
import { diagnostics } from "../diagnostics";

export type AnalysisBackoff = { retryAt: number; concurrency: number; rounds: number };
const MAX_LIMIT_ROUNDS = 3;
const MAX_AUTOMATIC_WAIT_MS = 120_000;

/** All requests in a batch share one cooldown and one recovery probe. */
export class AnalysisRateLimit {
  private active = 0;
  private epoch = 0;
  private stopped: Error | null = null;
  private waiters = new Set<() => void>();
  private state: AnalysisBackoff | null;

  constructor(
    private readonly maximum: number,
    previous: AnalysisBackoff | null,
    private readonly save: (state: AnalysisBackoff | null) => void,
  ) {
    this.state = previous
      ? { ...previous, concurrency: Math.min(previous.concurrency, maximum) }
      : null;
    if (this.state) {
      const delay = this.state.retryAt - Date.now();
      if (delay > MAX_AUTOMATIC_WAIT_MS || (this.state.rounds >= MAX_LIMIT_ROUNDS && delay > 0))
        this.stopped = new Error(
          "AI 服务限流（HTTP 429）仍在冷却，暂不发送请求；请等冷却结束后再继续，已完成结果和队列保留。",
        );
      // A new gate is created only by an explicit start/resume. An exhausted cycle
      // may restart after its cooldown; pausing a partial cycle never resets it.
      else if (this.state.rounds >= MAX_LIMIT_ROUNDS) this.state.rounds = 0;
    }
    if (previous) save(this.state);
  }

  private wake() {
    for (const done of this.waiters) done();
  }

  halt(error: Error) {
    this.stopped ||= error;
    this.wake();
  }

  private async acquire(signal: AbortSignal) {
    for (;;) {
      signal.throwIfAborted();
      if (this.stopped) throw this.stopped;
      const delay = (this.state?.retryAt || 0) - Date.now();
      if (delay <= 0 && this.active < (this.state?.concurrency ?? this.maximum)) {
        this.active++;
        return this.epoch;
      }
      await new Promise<void>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          clearTimeout(timer);
          this.waiters.delete(done);
          signal.removeEventListener("abort", done);
          resolve();
        };
        this.waiters.add(done);
        signal.addEventListener("abort", done, { once: true });
        if (delay > 0) timer = setTimeout(done, delay);
      });
    }
  }

  async run<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (;;) {
      const epoch = await this.acquire(signal);
      try {
        const result = await request();
        signal.throwIfAborted();
        // Results from the pre-limit burst remain valid, but do not end its cooldown.
        if (this.state && epoch === this.epoch) {
          this.state =
            this.state.concurrency >= this.maximum
              ? null
              : { retryAt: 0, concurrency: this.state.concurrency + 1, rounds: 0 };
          this.save(this.state);
        }
        return result;
      } catch (error) {
        signal.throwIfAborted();
        const issue = aiRequestIssue(error);
        if (issue?.kind !== "rate_limit") throw error;
        // Concurrent failures from one burst count as one failed recovery round.
        if (epoch === this.epoch) {
          const rounds = (this.state?.rounds || 0) + 1;
          const delay = Math.max(
            30_000 * 2 ** (rounds - 1) + Math.floor(Math.random() * 1000),
            issue.retryAfterMs || 0,
          );
          this.state = { retryAt: Date.now() + delay, concurrency: 1, rounds };
          this.epoch++;
          this.save(this.state);
          diagnostics.record("analysis.rate_limited", { rounds, delayMs: delay, error });
          if (rounds >= MAX_LIMIT_ROUNDS || delay > MAX_AUTOMATIC_WAIT_MS)
            this.stopped = new Error(
              "AI 服务持续限流（HTTP 429），冷却重试仍未恢复或等待时间过长；已保留结果和队列，请稍后继续并检查账号用量。",
              { cause: error },
            );
        } else if (this.state && issue.retryAfterMs) {
          // Responses already in flight may instruct a longer wait than the
          // first failure. They extend the same round, never shorten it.
          const retryAt = Date.now() + issue.retryAfterMs;
          if (retryAt > this.state.retryAt) {
            this.state = { ...this.state, retryAt };
            this.save(this.state);
            diagnostics.record("analysis.rate_limit_delay_extended", { retryAt, error });
          }
          if (issue.retryAfterMs > MAX_AUTOMATIC_WAIT_MS)
            this.stopped = new Error(
              "AI 服务限流（HTTP 429）要求较长冷却，已暂停自动重试；请等冷却结束后再继续。",
              { cause: error },
            );
        }
        if (this.stopped) throw this.stopped;
      } finally {
        this.active--;
        this.wake();
      }
    }
  }
}
