import { expect, it } from "vite-plus/test";
import {
  createRoleListDiagnostic,
  ROLE_DIAGNOSTIC_FIELDS,
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

it.each([
  { field: "price_min", value: "-1" },
  { field: "price_max", value: "100.123" },
  { field: "level_min", value: "100.5" },
  { field: "level_max", value: "999999999" },
  { field: "server_type", value: "1,4" },
  { field: "serverid", value: "not-a-server" },
  { field: "unknown_empty_filter", value: "" },
])("explicitly reports unsupported $field before mutation", async ({ field, value }) => {
  const x = fixture();
  const original = { ...identity, conditions: { ...identity.conditions, [field]: value } };
  x.snapshot.conditions = { ...original.conditions };
  await expect(createRoleListDiagnostic(x.driver, original).prepare!()).rejects.toMatchObject({
    code: "unsupported_condition",
    fields: expect.arrayContaining([field]),
  });
  expect(x.calls).toEqual([]);
});

it("restores all four observed filters, order and page after the same-server broad control", async () => {
  const x = fixture();
  const original = {
    ...identity,
    conditions: {
      server_type: "1,2,3",
      price_min: "100.50",
      price_max: "200",
      level_min: "69",
      level_max: "175",
    },
  };
  x.snapshot.conditions = { ...original.conditions };
  x.snapshot.fields = { price_min: "100.50", price_max: "200", level_min: "69", level_max: "175" };
  x.snapshot.controls = Object.fromEntries(
    ROLE_DIAGNOSTIC_FIELDS.map((field) => [
      field,
      {
        value: x.snapshot.fields[field]!,
        min: "0",
        max: field.startsWith("price_") ? "99999" : "175",
        step: field.startsWith("price_") ? "0.01" : "1",
      },
    ]),
  );
  const diagnostic = createRoleListDiagnostic(x.driver, original);
  await diagnostic.prepare!();
  await diagnostic({ ...original, page: 1, conditions: { server_type: "1,2,3" } });
  await diagnostic.restore!(original);
  expect(x.snapshot.conditions).toEqual(original.conditions);
  expect(x.snapshot.fields).toEqual({
    price_min: "100.50",
    price_max: "200",
    level_min: "69",
    level_max: "175",
  });
  expect(x.snapshot.page).toBe(original.page);
  expect(x.snapshot.sort).toBe(original.sort);
});

it.each(["bounds", "step", "reversed"])(
  "rejects %s before any control changes",
  async (scenario) => {
    const x = fixture();
    x.snapshot.controls = {
      price_min: {
        value: "100",
        min: "0",
        max: scenario === "bounds" ? "99" : "200",
        step: scenario === "step" ? "30" : "1",
      },
    };
    const original =
      scenario === "reversed"
        ? { ...identity, conditions: { ...identity.conditions, price_max: "99" } }
        : identity;
    await expect(createRoleListDiagnostic(x.driver, original).prepare!()).rejects.toMatchObject({
      code: "unsupported_condition",
    });
    expect(x.calls).toEqual([]);
  },
);
it("refuses to submit when a visible fixed-dimension form differs from its committed query", async () => {
  const x = fixture();
  x.snapshot.dimensions = { server_type: "3", serverid: "" };
  await expect(createRoleListDiagnostic(x.driver, identity).prepare!()).rejects.toMatchObject({
    code: "unsupported_condition",
    fields: ["server_type"],
  });
  expect(x.calls).toEqual([]);
});

it("preflights a field that disappeared before clearing a nonempty filter, before mutating any other field", async () => {
  const x = fixture();
  const diagnostic = createRoleListDiagnostic(x.driver, identity);
  await diagnostic.prepare!();
  delete x.snapshot.fields.price_min;
  await expect(
    diagnostic({ ...identity, page: 1, conditions: { server_type: "1,2,3", level_min: "69" } }),
  ).rejects.toMatchObject({ code: "unsupported_condition", fields: ["price_min"] });
  expect(x.calls).toEqual([]);
});
