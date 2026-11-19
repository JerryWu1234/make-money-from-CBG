import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { QueryHealthStore, type QueryIdentity } from "./store";
import { successfulQueryEvidence } from "./runtime";

const dbs: DatabaseSync[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function fixture() {
  const db = new DatabaseSync(":memory:");
  dbs.push(db);
  let time = 1000;
  return {
    db,
    store: new QueryHealthStore(db, () => time),
    tick: (ms: number) => {
      time += ms;
    },
  };
}
const identity = (
  conditions: QueryIdentity["conditions"] = { serverid: "367", kind: "weapon", min_damage: 600 },
): QueryIdentity => ({
  schemaVersion: 1,
  category: "equipment",
  server: "367",
  serverAge: "3",
  conditions,
  page: 1,
  sort: "price ASC",
  browserSessionEpoch: "browser-1",
});
it("QRY-01 keeps successful narrow empty separate from missing/old/unfinished evidence", () => {
  const { store } = fixture();
  expect(store.observe(store.begin(identity()), successfulQueryEvidence(0), 100)).toEqual({
    result: "empty",
    access: "observed_normal",
    accepted: true,
  });
  for (const failure of [
    { loaded: false },
    { committed: false },
    { identityMatched: false },
    { emptyMarker: false },
  ])
    expect(
      store.observe(store.begin(identity()), { ...successfulQueryEvidence(0), ...failure }, 100),
    ).toEqual({ result: "unknown", access: "suspect", accepted: false });
});
it("T08 freezes the first empty that conflicts with a recent identical successful target", () => {
  const { store } = fixture();
  store.observe(store.begin(identity()), successfulQueryEvidence(2), 1000);
  expect(store.observe(store.begin(identity()), successfulQueryEvidence(0), 1000)).toEqual({
    result: "empty",
    access: "suspect",
    accepted: false,
  });
  expect(
    store.observe(store.begin(identity()), { ...successfulQueryEvidence(1), blocked: true }, 1000),
  ).toEqual({ result: "data", access: "blocked", accepted: false });
});
it("QRY-02 broad data alone does not make a narrow empty suspicious; baseline must be real and compatible", () => {
  const x = fixture();
  const broad = identity({ serverid: "367", kind: "weapon" });
  x.store.observe(x.store.begin(broad), successfulQueryEvidence(4), 1000);
  expect(
    x.store.observe(x.store.begin(identity()), successfulQueryEvidence(0), 1000).accepted,
  ).toBe(true);
  expect(x.store.broadBaseline(identity(), 1000)).toEqual(broad);
  expect(
    x.store.broadBaseline({ ...identity(), browserSessionEpoch: "other" }, 1000),
  ).toBeUndefined();
  expect(x.store.broadBaseline({ ...identity(), category: "pet" }, 1000)).toBeUndefined();
  expect(x.store.broadBaseline({ ...identity(), server: "2008" }, 1000)).toBeUndefined();
  x.tick(1001);
  expect(x.store.broadBaseline(identity(), 1000)).toBeUndefined();
});
it("T09 diagnostic results never become baselines and claims survive reopening the health store", () => {
  const { db, store } = fixture();
  const target = store.begin(identity());
  const event = store.event(target, 4, { modeIndex: 2, pageNumber: 9 });
  expect(store.claim(event, "canary")).toBe(false);
  expect(store.claim(event, "target")).toBe(true);
  const reopened = new QueryHealthStore(db, () => 1000);
  expect(reopened.event(target, 4)).toBe(event);
  expect(reopened.claim(event, "target")).toBe(false);
  expect(reopened.claim(event, "canary")).toBe(true);
  expect(store.claim(event, "canary")).toBe(false);
  const diagnostic = store.begin(identity({ serverid: "367" }), "canary", event);
  expect(store.observe(diagnostic, successfulQueryEvidence(50), 1000).accepted).toBe(false);
  expect(store.broadBaseline(identity(), 1000)).toBeUndefined();
  reopened.finish(event, "manual_verification");
  expect(store.claim(event, "target")).toBe(false);
});
it("normalization associates reordered public filters but separates page/sort/condition changes", () => {
  const { store } = fixture();
  store.observe(store.begin(identity({ b: 1, a: 2 })), successfulQueryEvidence(1), 1000);
  expect(store.targetBaseline(identity({ a: 2, b: 1 }), 1000)).toBeTruthy();
  for (const changed of [{ page: 2 }, { sort: "time DESC" }, { conditions: { a: 3, b: 1 } }])
    expect(store.targetBaseline({ ...identity({ a: 2, b: 1 }), ...changed }, 1000)).toBeUndefined();
  expect(() => store.begin(identity({ token: "secret" }))).toThrow("非公开字段");
  dbs[0].prepare("UPDATE query_health_schema SET version=99").run();
  expect(() => new QueryHealthStore(dbs[0])).toThrow("schema");
});

it("T09 two database connections spend each event claim once and a process-style reopen cannot reset it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cbg-query-claims-"));
  const path = join(directory, "query.sqlite");
  let first = new DatabaseSync(path);
  let second = new DatabaseSync(path);
  try {
    const a = new QueryHealthStore(first);
    const b = new QueryHealthStore(second);
    const query = a.begin(identity());
    const event = a.event(query, 7, { pageNumber: 2, exhausted: false });
    expect(b.event(query, 7)).toBe(event);
    for (const step of ["target", "canary", "restoration"] as const) {
      const attempts = await Promise.all([
        Promise.resolve().then(() => a.claim(event, step)),
        Promise.resolve().then(() => b.claim(event, step)),
      ]);
      expect(attempts.filter(Boolean)).toHaveLength(1);
    }
    a.saveOriginalSnapshot(event, {
      revision: "page:generation:8",
      page: 2,
      fields: { price_min: "100" },
    });
    expect(() => b.saveOriginalSnapshot(event, { revision: "cannot-overwrite" })).toThrow(
      "拒绝覆盖",
    );
    first.close();
    second.close();
    first = new DatabaseSync(path);
    second = new DatabaseSync(path);
    const reopened = new QueryHealthStore(first),
      peer = new QueryHealthStore(second);
    expect(reopened.event(query, 7)).toBe(event);
    for (const step of ["target", "canary", "restoration"] as const) {
      expect(reopened.claim(event, step)).toBe(false);
      expect(peer.claim(event, step)).toBe(false);
    }
    expect(
      first.prepare("SELECT cursor_json FROM query_diagnostic_events WHERE event_id=?").get(event)
        ?.cursor_json,
    ).toBe('{"pageNumber":2,"exhausted":false}');
    expect(
      JSON.parse(
        String(
          first
            .prepare("SELECT original_snapshot_json FROM query_diagnostic_events WHERE event_id=?")
            .get(event)?.original_snapshot_json,
        ),
      ),
    ).toEqual({ revision: "page:generation:8", page: 2, fields: { price_min: "100" } });
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
