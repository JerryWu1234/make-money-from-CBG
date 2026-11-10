import type { CrawlStatus } from "./types";

export class CrawlFailureLimitError extends Error {
  readonly code = "CRAWL_FAILURE_LIMIT";
  constructor(readonly failures: number) {
    super(
      `连续 ${failures} 件采集失败，整轮采集已暂停；请检查失败原因后手动继续，已保存资料和待采任务保留。`,
    );
    this.name = "CrawlFailureLimitError";
  }
}

/** Count completed failures, not repeated progress notifications or internal navigation attempts. */
export function createCaptureFailureBudget(limit = 3) {
  let saved = 0,
    failed = 0,
    consecutive = 0;
  return (update: Partial<CrawlStatus>) => {
    if (update.saved !== undefined && update.saved > saved) {
      saved = update.saved;
      consecutive = 0;
    }
    if (update.failed !== undefined && update.failed > failed) {
      consecutive += update.failed - failed;
      failed = update.failed;
    }
    if (consecutive >= limit) return new CrawlFailureLimitError(consecutive);
  };
}
