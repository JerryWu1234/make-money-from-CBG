import type { DatabaseSync } from "node:sqlite";

export interface BridgeEnvelope {
  version: 1;
  connectionEpoch: string;
  messageId: string;
  sequence: number;
  kind: string;
  payload: unknown;
}
export class BridgeProtocolError extends Error {
  constructor(readonly code: string) {
    super(`扩展桥接拒绝消息：${code}`);
    this.name = "BridgeProtocolError";
  }
}
export function validateBridgeEnvelope(value: unknown): BridgeEnvelope {
  if (!value || typeof value !== "object") throw new BridgeProtocolError("schema");
  const v = value as BridgeEnvelope;
  if (
    v.version !== 1 ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(v.connectionEpoch) ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(v.messageId) ||
    !Number.isSafeInteger(v.sequence) ||
    v.sequence < 1 ||
    !["snapshot", "proof", "result", "status"].includes(v.kind)
  )
    throw new BridgeProtocolError("schema");
  if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024) throw new BridgeProtocolError("size");
  return v;
}
/** SQLite receipts are committed before ACK; a duplicate never executes a consumer twice. */
export class BridgeStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS access_bridge_receipts (epoch TEXT NOT NULL, message_id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, received_at TEXT NOT NULL, PRIMARY KEY(epoch,message_id), UNIQUE(epoch,sequence)); CREATE TABLE IF NOT EXISTS access_bridge_commands(action_id TEXT PRIMARY KEY, state TEXT NOT NULL, plan TEXT NOT NULL, result TEXT, updated_at TEXT NOT NULL);`,
    );
  }
  receive(message: BridgeEnvelope): "new" | "duplicate" {
    const prior = this.db
      .prepare(
        "SELECT sequence, payload, kind FROM access_bridge_receipts WHERE epoch=? AND message_id=?",
      )
      .get(message.connectionEpoch, message.messageId);
    if (prior) {
      if (
        prior.sequence !== message.sequence ||
        prior.kind !== message.kind ||
        prior.payload !== JSON.stringify(message.payload)
      )
        throw new BridgeProtocolError("conflicting-duplicate");
      return "duplicate";
    }
    const last = this.db
      .prepare("SELECT MAX(sequence) AS sequence FROM access_bridge_receipts WHERE epoch=?")
      .get(message.connectionEpoch)?.sequence;
    if (Number(last || 0) + 1 !== message.sequence) throw new BridgeProtocolError("sequence-gap");
    this.db
      .prepare("INSERT INTO access_bridge_receipts VALUES(?,?,?,?,?,?)")
      .run(
        message.connectionEpoch,
        message.messageId,
        message.sequence,
        message.kind,
        JSON.stringify(message.payload),
        new Date().toISOString(),
      );
    return "new";
  }
  authorize(actionId: string, plan: unknown) {
    this.db
      .prepare("INSERT INTO access_bridge_commands VALUES(?, 'dispatch_authorized', ?, NULL, ?)")
      .run(actionId, JSON.stringify(plan), new Date().toISOString());
  }
  result(actionId: string, result: unknown) {
    this.db
      .prepare(
        "UPDATE access_bridge_commands SET state='completed',result=?,updated_at=? WHERE action_id=? AND state='dispatch_authorized'",
      )
      .run(JSON.stringify(result), new Date().toISOString(), actionId);
  }
  unknownCommands() {
    return this.db
      .prepare(
        "SELECT action_id AS actionId,plan FROM access_bridge_commands WHERE state IN ('dispatch_authorized','unknown')",
      )
      .all();
  }
  reviewUnknown() {
    this.db
      .prepare(
        "UPDATE access_bridge_commands SET state='reviewed',updated_at=? WHERE state IN ('dispatch_authorized','unknown')",
      )
      .run(new Date().toISOString());
  }
  recover() {
    this.db
      .prepare(
        "UPDATE access_bridge_commands SET state='unknown' WHERE state='dispatch_authorized'",
      )
      .run();
    return this.unknownCommands();
  }
}
