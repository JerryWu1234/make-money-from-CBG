import { CAPTURE_VERSION, hasUnconfirmedEmptyEquipment } from "./compact";
import type { RoleDetail } from "./types";

export class IncompleteCaptureError extends Error {
  constructor(
    message: string,
    readonly detail: RoleDetail,
    cause: Error,
  ) {
    super(message, { cause });
    this.name = "IncompleteDetailError";
  }
}

/** Partial snapshots remain useful, but are not complete collection evidence. */
export function captureIssues(
  detail: RoleDetail,
  requireEvidence = false,
  includeAssets = detail.captureMode !== "body",
): string[] {
  const issues = [...(detail.valuation?.issues || [])];
  if (requireEvidence && detail.captureVersion !== CAPTURE_VERSION)
    issues.push("角色资料采集版本过旧，需重新核验");
  if (requireEvidence && !detail.valuation) issues.push("角色本体资料未核验");
  if (!includeAssets) {
    if (detail.captureMode === "body") {
      if (detail.captureVersion !== CAPTURE_VERSION || !detail.valuation)
        issues.push("裸号资料未核验");
      for (const name of ["人物/修炼", "技能", "道具/法宝", "坐骑"])
        if (!detail.tabs.some((tab) => tab.name === name)) issues.push(`裸号缺少「${name}」标签`);
    }
    return [...new Set(issues)];
  }
  if (detail.captureMode === "body") issues.push("本次仅采集裸号，装备和宝宝尚未核验");
  for (const [capture, label] of [
    [detail.equipmentCapture, "装备"],
    [detail.petCapture, "宝宝"],
  ] as const) {
    if (!capture) {
      if (requireEvidence) issues.push(`${label}完整性未核验`);
      continue;
    }
    issues.push(...capture.issues);
    if (!capture.complete && !capture.issues.length) issues.push(`${label}资料未完整采集`);
  }
  if (
    hasUnconfirmedEmptyEquipment(detail) &&
    !issues.some((issue) => issue.includes("装备库存是否为空"))
  )
    issues.push("人物装备库存是否为空尚未核验");
  return [...new Set(issues)];
}

export async function collectCompleteCapture(
  read: () => Promise<RoleDetail>,
  signal: AbortSignal,
  report: (message: string) => void,
): Promise<RoleDetail> {
  let last: Error | undefined;
  let partial: RoleDetail | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    try {
      const detail = await read();
      signal.throwIfAborted();
      const issues = captureIssues(detail, true);
      if (!issues.length) return detail;
      partial = detail;
      throw Object.assign(new Error("角色资料采集未完成：" + issues.join("；")), {
        name: "IncompleteDetailError",
      });
    } catch (error) {
      signal.throwIfAborted();
      if (
        !(error instanceof Error) ||
        /登录|验证码|安全验证|频繁|繁忙|权限|禁止/i.test(error.message) ||
        !["IncompleteDetailError", "TimeoutError"].includes(error.name)
      )
        throw error;
      last = error;
      if (attempt < 3)
        report(`资料尚未核验完整，正在本轮内自动重读 ${attempt}/2：${error.message}`);
    }
  }
  if (partial)
    throw new IncompleteCaptureError(
      "本轮采集重读后仍未完整，未进入角色分析：" + last!.message,
      partial,
      last!,
    );
  throw Object.assign(new Error("本轮采集重读后仍未完整，未进入角色分析：" + last!.message), {
    name: "IncompleteDetailError",
    cause: last,
  });
}
