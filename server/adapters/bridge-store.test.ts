import { describe, expect, it } from "vite-plus/test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BridgeStore, validateBridgeEnvelope, type BridgeEnvelope } from "./bridge-store";
const message = (sequence = 1): BridgeEnvelope => ({
  version: 1,
  connectionEpoch: "connection-1",
  messageId: `message-${sequence}`,
  sequence,
  kind: "snapshot",
  payload: { pageId: "page-1" },
});
describe("durable extension bridge", () => {
  it("deduplicates across database reopen and rejects a conflicting retransmit", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "cbg-bridge-"));
    const file = path.join(root, "state.sqlite");
    let db = new DatabaseSync(file);
    try {
      expect(new BridgeStore(db).receive(message())).toBe("new");
      db.close();
      db = new DatabaseSync(file);
      const store = new BridgeStore(db);
      expect(store.receive(message())).toBe("duplicate");
      expect(() => store.receive({ ...message(), payload: { pageId: "other" } })).toThrow(
        "conflicting-duplicate",
      );
      expect(() => store.receive(message(3))).toThrow("sequence-gap");
      expect(store.receive(message(2))).toBe("new");
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("persists unknown commands on restart and never offers a resend queue", () => {
    const db = new DatabaseSync(":memory:");
    const first = new BridgeStore(db);
    first.authorize("click-1", { target: "next-page" });
    const second = new BridgeStore(db);
    expect(second.recover()).toEqual([expect.objectContaining({ actionId: "click-1" })]);
    expect(db.prepare("SELECT state FROM access_bridge_commands").get()?.state).toBe("unknown");
    expect(() => second.authorize("click-1", {})).toThrow();
    db.close();
  });
  it("validates protocol, bounds and finite message sequences", () => {
    expect(validateBridgeEnvelope(message())).toEqual(message());
    for (const value of [
      { ...message(), version: 2 },
      { ...message(), sequence: NaN },
      { ...message(), kind: "execute-script" },
      { ...message(), payload: "x".repeat(512 * 1024) },
    ])
      expect(() => validateBridgeEnvelope(value)).toThrow();
  });
});
