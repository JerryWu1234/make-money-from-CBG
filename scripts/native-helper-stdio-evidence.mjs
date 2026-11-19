import assert from "node:assert/strict";

export function helperMessages(rows) {
  const buffers = new Map(),
    messages = [];
  for (const [rowIndex, row] of rows.entries()) {
    if (row.event !== "data") continue;
    const key = `${row.observerPid}:${row.helperPid}:${row.direction}`;
    const prior = buffers.get(key);
    let bytes = Buffer.concat([prior?.bytes || Buffer.alloc(0), Buffer.from(row.bytes, "base64")]);
    let startRowIndex = prior?.bytes.length ? prior.startRowIndex : rowIndex;
    let end;
    while ((end = bytes.indexOf(10)) >= 0) {
      messages.push({
        ...row,
        rowIndex,
        startRowIndex,
        message: JSON.parse(bytes.subarray(0, end).toString("utf8")),
      });
      bytes = bytes.subarray(end + 1);
      startRowIndex = rowIndex;
    }
    buffers.set(key, { bytes, startRowIndex });
  }
  return messages;
}

// Validate the complete inbound stream, including grant-chunk tails/pre-ACK data.
export function assertHelperExpiryInput(
  rows,
  { request, ack, expired, pausedAt, pauseRowCount, statusActionId },
) {
  for (const key of ["observerPid", "hostPid", "helperPid"]) {
    assert.equal(request[key], ack[key], `Wrong grant ACK ${key}`);
    assert.equal(expired[key], ack[key], `Wrong expiry ${key}`);
  }
  assert(
    Number.isInteger(request.startRowIndex) &&
      request.startRowIndex >= 0 &&
      request.startRowIndex <= request.rowIndex,
  );
  assert(request.rowIndex < ack.rowIndex && ack.rowIndex < expired.rowIndex);
  const scoped = rows
    .map((row, rowIndex) => ({ ...row, rowIndex }))
    .filter(
      (row) =>
        row.observerPid === request.observerPid &&
        row.hostPid === request.hostPid &&
        row.rowIndex <= expired.rowIndex,
    );
  assert(
    scoped
      .filter((row) => row.rowIndex >= request.startRowIndex)
      .every((row) => row.event === "data"),
    "Signal, EOF, exit or transport failure preceded helper expiry",
  );
  const inbound = scoped.filter(
    (row) => row.event === "data" && row.direction === "host-to-helper",
  );
  assert(
    inbound.every((row) => row.helperPid === request.helperPid),
    "Wrong helper input identity",
  );
  assert(
    !inbound.some((row) => row.receivedAt >= pausedAt || row.rowIndex >= pauseRowCount),
    "Helper inbound bytes arrived after host pause",
  );
  const bytes = Buffer.concat(inbound.map((row) => Buffer.from(row.bytes, "base64")));
  assert(bytes.length > 0 && bytes.at(-1) === 10, "Unparsed partial helper input before expiry");
  const commands = bytes
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const grants = commands
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => message.actionId === request.message.actionId);
  assert.equal(grants.length, 1, "The paired grant is not unique in the actual inbound stream");
  assert.deepEqual(grants[0].message, request.message);
  const afterGrant = commands.slice(grants[0].index + 1);
  assert(
    afterGrant.every(
      (message) => message.command === "status" && message.actionId === statusActionId,
    ),
    "A non-read-only command followed the last real grant request",
  );
  return afterGrant;
}
