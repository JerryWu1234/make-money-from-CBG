import type { Page } from "playwright-core";
import { roleIdentityIssues } from "./role-identity";

// Page-level let/const declarations need not be properties of window.
declare const EquipInfo: unknown;
declare const equip: unknown;

/** Only explicit detail objects supply identity; neither the URL nor the expected Listing does. */
export async function readDetailIdentity(page: Page) {
  const observations = await page.evaluate(() => {
    const scalar = (value: unknown) =>
      typeof value === "string" || typeof value === "number" ? String(value) : "";
    return [
      { source: "EquipInfo", value: typeof EquipInfo === "undefined" ? undefined : EquipInfo },
      { source: "equip", value: typeof equip === "undefined" ? undefined : equip },
    ].flatMap(({ source, value }) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const data = value as Record<string, unknown>;
      return [{ source, serverId: scalar(data.server_id), eid: scalar(data.eid) }];
    });
  });
  const complete = observations.find((value) => !roleIdentityIssues(value).length);
  const identity = complete || observations[0] || { serverId: "", eid: "" };
  const issues = roleIdentityIssues(identity);
  if (
    complete &&
    observations.some(
      (value) =>
        (value.serverId && value.serverId !== complete.serverId) ||
        (value.eid && value.eid !== complete.eid),
    )
  )
    issues.push("详情商品身份数据来源冲突");
  return {
    serverId: identity.serverId,
    eid: identity.eid,
    observations,
    issues,
  };
}
