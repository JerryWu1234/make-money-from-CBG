import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vite-plus/test";
const source = readFileSync(
  new URL("../../native/cbg-access/command-authority.mjs", import.meta.url),
  "utf8",
);
function fixture() {
  const world: Record<string, any> = {};
  runInNewContext(
    source.replaceAll("export class ", "class ") +
      "\nglobalThis.Authority=CommandAuthority;globalThis.Barrier=ResumeAcknowledgement;",
    world,
  );
  return new world.Authority("host-instance");
}
const plan = {
  actionId: "action",
  pageId: "page",
  pageGeneration: 1,
  stopEpoch: 0,
  browserSessionEpoch: "session",
  target: { kind: "next-page", currentPage: 1 },
};
const proof = { actionId: "action", pageId: "page", pageGeneration: 1, semantic: plan.target };
describe("native host local dispatch authority", () => {
  it("invalidates a delayed old proof across stop and same-session manual resume", () => {
    const authority = fixture();
    authority.resume({ stopEpoch: 0, browserSessionEpoch: "session" });
    authority.reserve(plan);
    authority.stop();
    authority.resume({ stopEpoch: 1, browserSessionEpoch: "session" });
    expect(authority.dispatch("action", proof)).toBeNull();
    expect(() => authority.reserve(plan)).toThrow("stale-or-busy");
    expect(authority.pending.size).toBe(0);
  });
  it("fences a same-stop-epoch restart with a new local generation and session", () => {
    const authority = fixture();
    authority.resume({ stopEpoch: 0, browserSessionEpoch: "session" });
    authority.reserve(plan);
    const old = authority.generation;
    authority.stop();
    authority.resume({ stopEpoch: 0, browserSessionEpoch: "new-session" });
    expect(authority.generation).toBeGreaterThan(old);
    expect(authority.dispatch("action", proof)).toBeNull();
  });
  it("emits one fenced helper command and rejects mismatched proof semantics", () => {
    const authority = fixture();
    authority.resume({ stopEpoch: 0, browserSessionEpoch: "session" });
    authority.reserve(plan);
    expect(() => authority.dispatch("action", { ...proof, semantic: { kind: "query" } })).toThrow(
      "proof-plan",
    );
    const command = authority.dispatch("action", proof);
    expect(command.hostGeneration).toBe(authority.generation);
    expect(command.hostInstanceEpoch).toBe("host-instance");
    expect(command.plan.stopEpoch).toBe(0);
    expect(authority.dispatch("action", proof)).toBeNull();
    authority.stop();
    expect(authority.dispatch("action", proof)).toBeNull();
  });
  it("does not let an old resume lower the accepted stop epoch", () => {
    const authority = fixture();
    authority.resume({ stopEpoch: 2, browserSessionEpoch: "session" });
    expect(() => authority.resume({ stopEpoch: 1, browserSessionEpoch: "session" })).toThrow(
      "resume-authority",
    );
    expect(authority.stopEpoch).toBe(2);
  });
});

it("resume is not acknowledged until helper and SW both approve the same generation", () => {
  const world: Record<string, any> = {};
  runInNewContext(
    source.replaceAll("export class ", "class ") + "\nglobalThis.Barrier=ResumeAcknowledgement;",
    world,
  );
  const first = new world.Barrier(2);
  expect(first.accept("extension", { ok: true }, 2)).toBeNull();
  expect(first.accept("helper", { ok: false, error: "input-monitor-disabled" }, 2)).toMatchObject({
    ok: false,
    error: "input-monitor-disabled",
  });
  expect(first.accept("helper", { ok: true }, 2)).toBeNull();
  const second = new world.Barrier(3);
  expect(second.accept("helper", { ok: true }, 2)).toBeNull();
  expect(second.accept("helper", { ok: true }, 3)).toBeNull();
  expect(second.accept("extension", { ok: true }, 3)).toEqual({ ok: true });
});
