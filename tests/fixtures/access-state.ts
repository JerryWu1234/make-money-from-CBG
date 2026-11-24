import { DEFAULT_ACCESS_POLICY, type AccessState } from "../../server/access";
/** Stable, offline UI fixture; never opens a browser or reads the application's database. */
export const accessState: AccessState = {
  schemaVersion: 1,
  siteKey: "cbg",
  revision: 0,
  stopEpoch: 0,
  state: "ready",
  reasons: [],
  occurredAt: null,
  retryNotBefore: null,
  lastEvidenceId: null,
  policyVersion: 1,
  policy: { ...DEFAULT_ACCESS_POLICY },
  updatedAt: 0,
  lastWallAt: 0,
  lastDispatchAt: null,
};
