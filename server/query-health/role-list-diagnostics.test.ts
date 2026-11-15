import { expect, it } from "vite-plus/test";
import {
  createRoleListDiagnostic,
  type RoleDiagnosticDriver,
  type RoleDiagnosticSnapshot,
} from "./role-list-diagnostics";
import type { QueryIdentity } from "./store";

const identity: QueryIdentity = {
  schemaVersion: 1,
  category: "role",
  server: "all",
  serverAge: "1,2,3",
  browserSessionEpoch: "session",
  conditions: { server_type: "1,2,3", price_min: "100" },
  page: 2,
  sort: "expire_time DESC",
};
function fixture() {
  const snapshot: RoleDiagnosticSnapshot = {
    conditions: { ...identity.conditions },
    page: 2,
    sort: identity.sort,
    fields: { price_min: "100", price_max: "", level_min: "", level_max: "" },
    revision: "1",
    evidence: { count: 0, loaded: true, committed: true, identityMatched: true, emptyMarker: true },
  };
  const calls: string[] = [];
  const advance = () => {
    snapshot.revision = String(Number(snapshot.revision) + 1);
  };
  const driver: RoleDiagnosticDriver = {
    snapshot: async () => structuredClone(snapshot),
    field: async (field, value) => {
      calls.push("field:" + field + ":" + value);
      snapshot.fields[field] = value;
      advance();
    },
    submit: async () => {
      calls.push("query");
      snapshot.conditions = { server_type: "1,2,3" };
      for (const [key, value] of Object.entries(snapshot.fields))
        if (value) snapshot.conditions[key] = value;
      snapshot.page = 1;
      snapshot.sort = "selling_time DESC";
      advance();
    },
    sort: async (value) => {
      calls.push("sort");
      snapshot.sort = value;
      advance();
    },
    page: async (value) => {
      calls.push("page");
      snapshot.page = value;
      advance();
    },
  };
  return { snapshot, calls, driver };
}
it.each(["unknown-condition", "missing-field", "changed-original", "unsupported-order"])(
  "role diagnostic %s stops before any UI mutation",
  async (scenario) => {
    const x = fixture();
    let original = structuredClone(identity);
    if (scenario === "unknown-condition") {
      original.conditions.unknown_filter = 1;
      x.snapshot.conditions.unknown_filter = 1;
    }
    if (scenario === "missing-field") delete x.snapshot.fields.price_min;
    if (scenario === "changed-original") x.snapshot.conditions.price_min = "200";
    if (scenario === "unsupported-order") original = { ...original, sort: "price ASC" };
    await expect(createRoleListDiagnostic(x.driver, original)(original)).rejects.toThrow();
    expect(x.calls).toEqual([]);
  },
);
it("restoration checks actual controls and committed identity; a failed restore cannot be replayed", async () => {
  const x = fixture();
  const diagnostic = createRoleListDiagnostic(x.driver, identity);
  await diagnostic(identity);
  await diagnostic({ ...identity, page: 1, conditions: { server_type: "1,2,3" } });
  x.driver.submit = async () => {
    x.calls.push("failed-restore");
    throw new Error("unconfirmed");
  };
  await expect(diagnostic.restore!(identity)).rejects.toThrow("unconfirmed");
  await expect(diagnostic.restore!(identity)).rejects.toThrow("拒绝重复");
  expect(x.calls.filter((call) => call === "failed-restore")).toHaveLength(1);
});
it("a new hard block forbids both diagnostic and restoration input", async () => {
  const x = fixture();
  const diagnostic = createRoleListDiagnostic(x.driver, identity);
  x.snapshot.evidence.blocked = true;
  await expect(diagnostic(identity)).rejects.toThrow("明确访问限制");
  await expect(diagnostic.restore!(identity)).rejects.toThrow("明确访问限制");
  expect(x.calls).toEqual([]);
});
