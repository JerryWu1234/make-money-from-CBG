import type { SavedRoleRecord } from "../crawler/types";
import { createRoleSource, publicRoleArguments } from "./browser-role-source";
import {
  blockedRolePricing,
  buildRolePricingSnapshot,
  validateRolePricing,
  type RolePricingSnapshot,
} from "./role-pricing";

/** Recover at the role-search stage; successful evidence is reused without repeating UI queries. */
export async function searchRolePricing(
  record: SavedRoleRecord,
  signal: AbortSignal,
  previous?: RolePricingSnapshot,
): Promise<RolePricingSnapshot> {
  signal.throwIfAborted();
  if (validateRolePricing(previous, record)) return previous!;
  const blocked = blockedRolePricing(record);
  if (blocked.issues.length) return blocked;
  const source = await createRoleSource(signal);
  try {
    const result = await source.search(record);
    signal.throwIfAborted();
    return buildRolePricingSnapshot(record, {
      ...result,
      queryArgs: publicRoleArguments(result.queryArgs),
    });
  } finally {
    await source.close();
  }
}
