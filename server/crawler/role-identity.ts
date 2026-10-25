import { CAPTURE_VERSION } from "./compact";
import type { Listing, RoleDetail } from "./types";

// Historical snapshots without this explicit current contract remain readable, never upgraded here.
export function isCurrentRoleCapture(detail: RoleDetail | null | undefined): boolean {
  return (
    !!detail &&
    (detail.captureMode === "all" || detail.captureMode === "body") &&
    detail.captureVersion === CAPTURE_VERSION
  );
}

/** Observed source identity is required; expected listing values never supply missing evidence. */
export function roleIdentityIssues(
  source: unknown,
  listing?: Pick<Listing, "serverId" | "eid">,
): string[] {
  const value =
    source && typeof source === "object" && !Array.isArray(source)
      ? (source as Record<string, unknown>)
      : {};
  const server =
    typeof value.serverId === "string" &&
    /^[1-9]\d*$/.test(value.serverId) &&
    Number.isSafeInteger(Number(value.serverId));
  const eid = typeof value.eid === "string" && /^[\w-]+$/.test(value.eid);
  const issues: string[] = [];
  if (!server) issues.push("角色来源服务器身份缺失或无效");
  if (!eid) issues.push("角色来源商品身份缺失或无效");
  if (
    server &&
    eid &&
    listing &&
    (value.serverId !== listing.serverId || value.eid !== listing.eid)
  )
    issues.push("角色来源身份与目标商品不一致");
  return issues;
}
