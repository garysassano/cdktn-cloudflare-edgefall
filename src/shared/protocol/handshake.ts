import { COUNTER_LIMIT } from "../../game/core/numeric.js";
import { ARCADE } from "../../game/rules.js";
import type { GameIdentity } from "../content-id.js";
import { MAX_CLIENT_FRAME_BYTES, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./limits.js";
import { ProtocolError } from "./schema.js";

export interface Handshake extends GameIdentity {
  type: "welcome";
  protocolMajor: 3;
  protocolMinor: 0;
  runId: string;
  runEpoch: number;
  connectionEpoch: number;
  playerId: number;
  entityId: number;
  simulationHz: 60;
  snapshotHz: 20;
  initialServerTick: number;
  capabilities: 0 | 1;
  baselineSnapshotId: number;
  baselineEventCursor: number;
  /** Deployment provenance; compatibility uses simulation/content/presentation identities. */
  buildId: string;
}

const FIELDS = [
  "type",
  "protocolMajor",
  "protocolMinor",
  "runId",
  "runEpoch",
  "connectionEpoch",
  "playerId",
  "entityId",
  "simulationHz",
  "snapshotHz",
  "initialServerTick",
  "capabilities",
  "baselineSnapshotId",
  "baselineEventCursor",
  "buildId",
  "simulationVersion",
  "simulationBuild",
  "contentFormat",
  "contentHash",
  "presentationBuild",
].sort();

export function decodeHandshake(raw: string, expected: GameIdentity): Handshake {
  if (
    raw.length > MAX_CLIENT_FRAME_BYTES ||
    new TextEncoder().encode(raw).byteLength > MAX_CLIENT_FRAME_BYTES
  )
    throw new ProtocolError("malformed", "Handshake too large");
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ProtocolError("malformed", "Invalid handshake JSON");
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new ProtocolError("malformed", "Invalid handshake object");
  const record = data as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== FIELDS.join(","))
    throw new ProtocolError("malformed", "Unexpected/missing handshake fields");
  for (const field of ["simulationBuild", "contentHash", "presentationBuild", "buildId"]) {
    if (typeof record[field] !== "string" || !/^[a-f0-9]{64}$/u.test(record[field]))
      throw new ProtocolError("malformed", `Invalid ${field} digest`);
  }
  for (const field of [
    "runEpoch",
    "connectionEpoch",
    "playerId",
    "entityId",
    "baselineSnapshotId",
    "simulationVersion",
    "contentFormat",
    "initialServerTick",
    "baselineEventCursor",
  ]) {
    const value = record[field];
    const minimum = field === "initialServerTick" || field === "baselineEventCursor" ? 0 : 1;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value >= COUNTER_LIMIT
    )
      throw new ProtocolError("malformed", `Invalid handshake ${field}`);
  }
  if (
    record.type !== "welcome" ||
    record.protocolMajor !== PROTOCOL_MAJOR ||
    record.protocolMinor !== PROTOCOL_MINOR ||
    record.simulationHz !== ARCADE.simulationHz ||
    record.snapshotHz !== ARCADE.snapshotHz ||
    (record.capabilities !== 0 && record.capabilities !== 1) ||
    typeof record.runId !== "string" ||
    !/^[a-z0-9-]{8,80}$/u.test(record.runId)
  )
    throw new ProtocolError("malformed", "Unsupported handshake contract");
  for (const field of [
    "simulationVersion",
    "simulationBuild",
    "contentFormat",
    "contentHash",
    "presentationBuild",
  ] as const) {
    if (record[field] !== expected[field])
      throw new ProtocolError("identity-mismatch", `Reload required: incompatible ${field}`);
  }
  return record as unknown as Handshake;
}
