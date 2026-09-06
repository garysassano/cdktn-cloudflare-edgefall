import { COUNTER_LIMIT } from "../../game/core/numeric.js";
import { ProtocolError } from "./schema.js";
import type { FullSnapshot } from "./snapshot-schema.js";

export const INPUT_MAPPING_CAPABILITY = 1;
export interface InputMapping {
  type: "input-mapping";
  runEpoch: number;
  connectionEpoch: number;
  playerId: number;
  snapshotId: number;
  snapshotTick: number;
  nextSequence: number;
  nextCommandTick: number;
}
const fields = [
  "type",
  "runEpoch",
  "connectionEpoch",
  "playerId",
  "snapshotId",
  "snapshotTick",
  "nextSequence",
  "nextCommandTick",
]
  .sort()
  .join(",");
export function validateInputMapping(value: unknown): InputMapping {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== fields
  )
    throw new ProtocolError("malformed", "Invalid input mapping fields");
  const record = value as Record<string, unknown>;
  if (record.type !== "input-mapping")
    throw new ProtocolError("malformed", "Invalid input mapping type");
  for (const key of [
    "runEpoch",
    "connectionEpoch",
    "playerId",
    "snapshotId",
    "snapshotTick",
    "nextSequence",
    "nextCommandTick",
  ]) {
    const n = record[key];
    if (
      typeof n !== "number" ||
      !Number.isSafeInteger(n) ||
      n < (key === "snapshotTick" ? 0 : 1) ||
      n >= COUNTER_LIMIT
    )
      throw new ProtocolError("malformed", "Invalid input mapping counter");
  }
  if (record.nextCommandTick !== Number(record.snapshotTick) + 1)
    throw new ProtocolError("malformed", "Mapping must start after its snapshot boundary");
  return { ...record } as unknown as InputMapping;
}
export function decodeInputMapping(raw: string): InputMapping {
  if (raw.length > 512 || new TextEncoder().encode(raw).byteLength > 512)
    throw new ProtocolError("malformed", "Input mapping too large");
  try {
    return validateInputMapping(JSON.parse(raw));
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError("malformed", "Invalid input mapping JSON");
  }
}
export function mappingForSnapshot(snapshot: FullSnapshot, playerId: number): InputMapping {
  const ack = snapshot.acknowledgments.find((value) => value.playerId === playerId);
  if (!ack || ack.connectionEpoch !== snapshot.connectionEpoch)
    throw new ProtocolError("malformed", "Missing mapping owner");
  return validateInputMapping({
    type: "input-mapping",
    runEpoch: snapshot.runEpoch,
    connectionEpoch: snapshot.connectionEpoch,
    playerId,
    snapshotId: snapshot.snapshotId,
    snapshotTick: snapshot.tick,
    nextSequence: ack.lastProcessedSequence + 1,
    nextCommandTick: snapshot.tick + 1,
  });
}
