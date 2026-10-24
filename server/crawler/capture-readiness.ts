import { CAPTURE_VERSION, hasUnconfirmedEmptyEquipment } from "./compact";
import type { Listing, RoleDetail } from "./types";
import { completeSchoolSkillsFromText } from "./school-skills";
import { isCurrentRoleCapture, roleIdentityIssues } from "./role-identity";

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

// 同一详情重新导航可沿用本轮有界重读；其他地址可能是登录或商品身份变化。
function isSameDetailNavigationInterrupted(error: Error): boolean {
  const match = error.message.match(
    /^page\.goto: Navigation to "([^"\r\n]+)" is interrupted by another navigation to "([^"\r\n]+)"(?:\r?\n|$)/,
  );
  if (!match || match[1] !== match[2]) return false;
  try {
    const url = new URL(match[1]);
    return (
      url.origin === "https://xyq.cbg.163.com" &&
      !url.username &&
      !url.password &&
      url.pathname === "/equip" &&
      /^\d+$/.test(url.searchParams.get("s") || "") &&
      /^[\w-]+$/.test(url.searchParams.get("eid") || "")
    );
  } catch {
    return false;
  }
}

function hasSchoolSkillContract(detail: RoleDetail) {
  return (
    (detail.captureMode === "all" || detail.captureMode === "body") &&
    detail.captureVersion === CAPTURE_VERSION &&
    !!detail.valuation
  );
}

function normalizeSchoolSkillCapture(detail: RoleDetail): RoleDetail {
  if (!hasSchoolSkillContract(detail)) return detail;
  const tabs = detail.tabs.map(completeSchoolSkillsFromText);
  // 这里只补已被原文证明的师门项；源码与元素须保留至 store.archive，不能提前 compact。
  return tabs.some((tab, index) => tab !== detail.tabs[index]) ? { ...detail, tabs } : detail;
}

/** Partial snapshots remain useful, but are not complete collection evidence. */
export function captureIssues(
  detail: RoleDetail,
  requireEvidence = false,
  includeAssets = true,
  listing?: Pick<Listing, "serverId" | "eid">,
): string[] {
  const issues = [...(detail.valuation?.issues || [])];
  if (requireEvidence && detail.captureVersion !== CAPTURE_VERSION)
    issues.push("角色资料采集版本过旧，需重新核验");
  if (requireEvidence && !detail.valuation) issues.push("角色本体资料未核验");
  if (isCurrentRoleCapture(detail))
    issues.push(...roleIdentityIssues(detail.valuation?.source, listing));
  if (hasSchoolSkillContract(detail)) {
    const tabs = normalizeSchoolSkillCapture(detail).tabs.filter((tab) => tab.name === "技能");
    const school = tabs.flatMap((tab) =>
      (tab.items || []).filter((item) => item.category === "师门技能"),
    );
    const names = school.map((item) => (typeof item.name === "string" ? item.name.trim() : ""));
    if (
      tabs.length !== 1 ||
      school.length !== 7 ||
      new Set(names).size !== 7 ||
      names.some((name) => !name) ||
      school.some(
        (item) =>
          item.kind !== "skill" ||
          typeof item.level !== "string" ||
          !/^\d+$/.test(item.level) ||
          !Number.isSafeInteger(Number(item.level)),
      )
    )
      issues.push("师门技能未完整读取：须核对7项不重复技能及明确非负整数等级");
  }
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
  listing?: Pick<Listing, "serverId" | "eid">,
): Promise<RoleDetail> {
  let last: Error | undefined;
  let partial: RoleDetail | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    try {
      const captured = await read();
      signal.throwIfAborted();
      const detail = normalizeSchoolSkillCapture(captured);
      const issues = captureIssues(detail, true, true, listing);
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
        (!["IncompleteDetailError", "TimeoutError"].includes(error.name) &&
          !isSameDetailNavigationInterrupted(error))
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
