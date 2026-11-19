import { expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { QueryHealthStore, type QueryIdentity } from "./store";
import { createRoleListDiagnostic, type RoleDiagnosticSnapshot } from "./role-list-diagnostics";

it("finds the same-server broad role baseline when the legal age set order changes", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const store = new QueryHealthStore(db, () => 1000);
    const broad: QueryIdentity = {
      schemaVersion: 1,
      category: "role",
      server: "all",
      serverAge: "1,2,3",
      conditions: { server_type: "1,2,3" },
      page: 1,
      sort: "selling_time DESC",
      browserSessionEpoch: "review-session",
    };
    const target: QueryIdentity = {
      ...broad,
      serverAge: "3,1,2",
      conditions: { server_type: "3,1,2", price_min: "100" },
    };
    store.observe(
      store.begin(broad),
      {
        loaded: true,
        committed: true,
        identityMatched: true,
        emptyMarker: false,
        count: 4,
      },
      1000,
    );
    expect(store.broadBaseline(target, 1000)).toEqual(broad);
    expect(store.broadBaseline({ ...target, serverAge: "1,2" }, 1000)).toBeUndefined();
    expect(
      store.broadBaseline(
        { ...target, conditions: { server_type: "1,2", price_min: "100" } },
        1000,
      ),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});

it("can probe a broad role identity with an equivalent server-age set order", async () => {
  const original: QueryIdentity = {
    schemaVersion: 1,
    category: "role",
    server: "all",
    serverAge: "3,1,2",
    conditions: { server_type: "3,1,2", price_min: "100" },
    page: 1,
    sort: "selling_time DESC",
    browserSessionEpoch: "review-session",
  };
  const snapshot: RoleDiagnosticSnapshot = {
    conditions: { ...original.conditions },
    page: 1,
    sort: original.sort,
    fields: { price_min: "100", price_max: "", level_min: "", level_max: "" },
    revision: "1",
    evidence: { loaded: true, committed: true, identityMatched: true, emptyMarker: true, count: 0 },
  };
  let mutations = 0;
  const diagnostic = createRoleListDiagnostic(
    {
      snapshot: async () => structuredClone(snapshot),
      field: async (field, value) => {
        mutations++;
        snapshot.fields[field] = value;
        snapshot.revision += "f";
      },
      submit: async () => {
        mutations++;
        snapshot.conditions = { server_type: "3,1,2" };
        for (const [key, value] of Object.entries(snapshot.fields))
          if (value) snapshot.conditions[key] = value;
        snapshot.revision += "q";
        snapshot.evidence = { ...snapshot.evidence, count: 4, emptyMarker: false };
      },
      sort: async () => {},
      page: async () => {},
    },
    original,
  );
  await expect(
    diagnostic({ ...original, serverAge: "1,2,3", conditions: { server_type: "1,2,3" } }),
  ).resolves.toMatchObject({ count: 4, identityMatched: true });
  const completedMutations = mutations;
  for (const changed of [
    { ...original, serverAge: "1,2" },
    { ...original, conditions: { server_type: "1,2" } },
  ])
    await expect(diagnostic(changed)).rejects.toMatchObject({ code: "unsupported_condition" });
  expect(mutations).toBe(completedMutations);
});
