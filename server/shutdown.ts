import { crawlActivity, stopCrawl } from "./crawler/controller";
import { shutdownScanSchedule } from "./crawler/schedule";
import { shutdownAnalysis } from "./analysis/controller";
import { shutdownAiConnections } from "./ai-connection";
import { beginServiceShutdown } from "./service-lifecycle";

export async function shutdownLocalService() {
  beginServiceShutdown();
  // 先禁止定时器发起新任务，再让采集和分析各自保存退出状态、释放租约。
  const schedule = shutdownScanSchedule();
  const capture = crawlActivity();
  stopCrawl();
  const results = await Promise.allSettled([schedule, capture?.completion, shutdownAnalysis()]);
  // 某一路退出失败时，也必须等待其他任务并关闭 AI 连接。
  results.push(...(await Promise.allSettled([shutdownAiConnections()])));
  const failures = results.filter((result) => result.status === "rejected");
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      "本地服务未能完整关闭全部后台任务",
    );
}

export function createLocalServiceShutdown(requestsClosed: () => Promise<void>) {
  let closing: Promise<void> | undefined;
  return {
    get started() {
      return closing !== undefined;
    },
    close() {
      return (closing ??= (async () => {
        const results = await Promise.allSettled([shutdownLocalService()]);
        results.push(...(await Promise.allSettled([requestsClosed()])));
        // 已进入浏览器检查的启动请求可能晚于第一轮暂停创建任务；HTTP 排空后再收尾。
        results.push(...(await Promise.allSettled([shutdownLocalService()])));
        const failures = results.filter((result) => result.status === "rejected");
        if (failures.length)
          throw new AggregateError(
            failures.map((result) => result.reason),
            "本地服务关停失败",
          );
      })());
    },
  };
}
