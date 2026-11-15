import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vite-plus/test";
const source = readFileSync(
  new URL("../../native/cbg-access/activity-authority.mjs", import.meta.url),
  "utf8",
);
function fixture() {
  const world: Record<string, any> = {};
  runInNewContext(
    source.replaceAll("export const ", "const ").replaceAll("export class ", "class ") +
      "\nglobalThis.Authority=ActivityAuthority",
    world,
  );
  let now = 100000;
  const authority = { generation: 1, stopEpoch: 0, sessionEpoch: "session", stopped: false };
  const activity = new world.Authority(() => now);
  const lease = {
    activityId: "workflow",
    authorizationEpoch: 1,
    stopEpoch: 0,
    browserSessionEpoch: "session",
    expiresAt: now + 15000,
    progressExpiresAt: now + 60000,
    progressSequence: 0,
  };
  return {
    authority,
    activity,
    lease,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it("binding and idle grant no activity; input requires a successful assertion ACK", () => {
  const x = fixture();
  expect(x.activity.accepts(x.lease, x.authority)).toBe(false);
  x.activity.begin(x.lease, x.authority);
  expect(x.activity.accepts(x.lease, x.authority)).toBe(false);
  x.activity.granted(x.lease, x.authority);
  expect(x.activity.accepts(x.lease, x.authority)).toBe(true);
  x.activity.end(x.lease, x.authority);
  expect(x.activity.current).toBeNull();
});
it("heartbeat keeps a bounded page wait alive but cannot extend the no-progress deadline", () => {
  const x = fixture();
  x.activity.begin(x.lease, x.authority);
  x.activity.granted(x.lease, x.authority);
  for (let index = 0; index < 19; index++) {
    x.advance(3000);
    x.activity.renew({ ...x.lease, expiresAt: x.now() + 15000 }, x.authority);
    expect(x.activity.accepts(x.lease, x.authority)).toBe(true);
  }
  expect(() =>
    x.activity.renew(
      { ...x.lease, expiresAt: x.now() + 15000, progressExpiresAt: x.now() + 60000 },
      x.authority,
    ),
  ).toThrow("heartbeat-cannot");
  x.advance(3001);
  expect(x.activity.accepts(x.lease, x.authority)).toBe(false);
  expect(() => x.activity.renew({ ...x.lease, expiresAt: x.now() + 15000 }, x.authority)).toThrow();
});
it("only a newly completed action can credit business progress, never repeated heartbeat credit", () => {
  const x = fixture();
  x.activity.begin(x.lease, x.authority);
  x.activity.granted(x.lease, x.authority);
  x.advance(10000);
  const progressed = {
    ...x.lease,
    expiresAt: x.now() + 15000,
    progressExpiresAt: x.now() + 60000,
    progressSequence: 1,
    progressActionId: "action",
  };
  expect(() => x.activity.renew(progressed, x.authority, "different")).toThrow("unverified");
  x.activity.renew(progressed, x.authority, "action");
  x.advance(1000);
  expect(() =>
    x.activity.renew(
      { ...progressed, progressSequence: 2, progressExpiresAt: x.now() + 60000 },
      x.authority,
      "action",
    ),
  ).toThrow("unverified");
});
it.each(["expired", "stop", "generation", "session", "clock"])(
  "%s invalidates the old activity",
  (scenario) => {
    const x = fixture();
    x.activity.begin(x.lease, x.authority);
    x.activity.granted(x.lease, x.authority);
    if (scenario === "expired") x.advance(15000);
    if (scenario === "stop") x.authority.stopped = true;
    if (scenario === "generation") x.authority.generation++;
    if (scenario === "session") x.authority.sessionEpoch = "other";
    if (scenario === "clock") x.advance(-1);
    if (scenario === "clock")
      expect(() => x.activity.accepts(x.lease, x.authority)).toThrow("clock");
    else expect(x.activity.accepts(x.lease, x.authority)).toBe(false);
  },
);
it("a stale release or grant cannot affect a later authorized activity", () => {
  const x = fixture();
  x.activity.begin(x.lease, x.authority);
  x.activity.granted(x.lease, x.authority);
  x.activity.end(x.lease, x.authority);
  const next = { ...x.lease, activityId: "next", authorizationEpoch: 2 };
  x.activity.begin(next, x.authority);
  x.activity.granted(next, x.authority);
  expect(() => x.activity.end(x.lease, x.authority)).toThrow("stale");
  expect(() => x.activity.granted(x.lease, x.authority)).toThrow("stale");
  expect(x.activity.accepts(next, x.authority)).toBe(true);
  x.activity.stop();
  expect(x.activity.current).toBeNull();
  expect(() => x.activity.begin(x.lease, x.authority)).toThrow("stale");
});
