import { COUNTER_LIMIT } from "../../game/core/numeric.js";
import {
  type ActionEdge,
  type Aim,
  type EdgeKind,
  HELD_MASK,
  type InputCommand,
  type PlayerAcknowledgment,
} from "../../game/input/types.js";
import {
  ACK_BYTES,
  COMMAND_BYTES,
  EDGE_BYTES,
  INPUT_HEADER_BYTES,
  INPUT_TYPE,
  MAGIC,
  MAX_COMMANDS,
  MAX_EDGES_PER_COMMAND,
  MAX_EDGE_ADVANCE,
  MAX_INPUT_BYTES,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
} from "./limits.js";
import { type InputBatch, type InputIdentity, ProtocolError } from "./schema.js";

function requireValid(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ProtocolError("malformed", message);
}
function bounded(value: number, min: number, max: number, field: string): void {
  requireValid(Number.isSafeInteger(value) && value >= min && value <= max, `Invalid ${field}`);
}
function counter(value: number, field: string, allowZero = false): void {
  bounded(value, allowZero ? 0 : 1, COUNTER_LIMIT - 1, field);
}

export function validateInputBatch(batch: InputBatch): void {
  counter(batch.runEpoch, "runEpoch");
  counter(batch.connectionEpoch, "connectionEpoch");
  counter(batch.packetSequence, "packetSequence");
  counter(batch.snapshotAck, "snapshotAck", true);
  counter(batch.eventAck, "eventAck", true);
  requireValid(
    Array.isArray(batch.commands) && batch.commands.length <= MAX_COMMANDS,
    "Invalid command count",
  );
  let previous: InputCommand | undefined;
  const edgeHighWater = new Map<EdgeKind, number>();
  for (const command of batch.commands) {
    counter(command.sequence, "sequence");
    counter(command.clientTick, "clientTick", true);
    counter(command.controlEpoch, "controlEpoch");
    bounded(command.held, 0, HELD_MASK, "held bits");
    bounded(command.aim, 0, 2, "aim");
    requireValid(
      Array.isArray(command.edges) && command.edges.length <= MAX_EDGES_PER_COMMAND,
      "Invalid edge count",
    );
    if (previous) {
      requireValid(command.sequence === previous.sequence + 1, "Noncontiguous command sequence");
      requireValid(command.clientTick === previous.clientTick + 1, "Noncontiguous client tick");
    }
    previous = command;
    for (const edge of command.edges) {
      bounded(edge.kind, 1, 5, "edge kind");
      counter(edge.id, "edge ID");
      const before = edgeHighWater.get(edge.kind);
      if (before !== undefined)
        requireValid(
          edge.id > before && edge.id - before <= MAX_EDGE_ADVANCE,
          "Nonmonotonic edge ID",
        );
      edgeHighWater.set(edge.kind, edge.id);
    }
  }
}

/** v3.0 little-endian InputBatch. Validation completes before output allocation. */
export function encodeInputBatch(batch: InputBatch): Uint8Array {
  validateInputBatch(batch);
  const length =
    INPUT_HEADER_BYTES +
    batch.commands.reduce(
      (size, command) => size + COMMAND_BYTES + EDGE_BYTES * command.edges.length,
      0,
    );
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, MAGIC, true);
  view.setUint8(2, PROTOCOL_MAJOR);
  view.setUint8(3, PROTOCOL_MINOR);
  view.setUint8(4, INPUT_TYPE);
  view.setUint16(6, length, true);
  [
    batch.runEpoch,
    batch.connectionEpoch,
    batch.packetSequence,
    batch.snapshotAck,
    batch.eventAck,
  ].forEach((value, index) => {
    view.setUint32(8 + index * 4, value, true);
  });
  view.setUint8(28, batch.commands.length);
  let offset = INPUT_HEADER_BYTES;
  for (const command of batch.commands) {
    view.setUint32(offset, command.sequence, true);
    view.setUint32(offset + 4, command.clientTick, true);
    view.setUint32(offset + 8, command.controlEpoch, true);
    view.setUint16(offset + 12, command.held, true);
    view.setUint8(offset + 14, command.aim);
    view.setUint8(offset + 15, command.edges.length);
    offset += COMMAND_BYTES;
    for (const edge of command.edges) {
      view.setUint8(offset, edge.kind);
      view.setUint32(offset + 4, edge.id, true);
      offset += EDGE_BYTES;
    }
  }
  return bytes;
}

/** No state mutation on failure. Socket/run binding is mandatory, including ack-only frames. */
export function decodeInputBatch(bytes: Uint8Array, expected: InputIdentity): InputBatch {
  requireValid(
    bytes.byteLength >= INPUT_HEADER_BYTES && bytes.byteLength <= MAX_INPUT_BYTES,
    "Input frame size",
  );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  requireValid(
    view.getUint16(0, true) === MAGIC &&
      view.getUint8(2) === PROTOCOL_MAJOR &&
      view.getUint8(3) === PROTOCOL_MINOR &&
      view.getUint8(4) === INPUT_TYPE,
    "Unsupported frame header",
  );
  requireValid(
    view.getUint8(5) === 0 && view.getUint16(6, true) === bytes.byteLength,
    "Invalid flags/length",
  );
  requireValid(view.getUint8(29) === 0 && view.getUint16(30, true) === 0, "Reserved header bits");
  const count = view.getUint8(28);
  requireValid(count <= MAX_COMMANDS, "Command count");
  const batch: InputBatch = {
    runEpoch: view.getUint32(8, true),
    connectionEpoch: view.getUint32(12, true),
    packetSequence: view.getUint32(16, true),
    snapshotAck: view.getUint32(20, true),
    eventAck: view.getUint32(24, true),
    commands: [],
  };
  if (batch.runEpoch !== expected.runEpoch || batch.connectionEpoch !== expected.connectionEpoch)
    throw new ProtocolError("identity-mismatch", "Input belongs to another run/socket epoch");
  let offset = INPUT_HEADER_BYTES;
  for (let index = 0; index < count; index++) {
    requireValid(offset + COMMAND_BYTES <= bytes.byteLength, "Truncated command");
    const edgeCount = view.getUint8(offset + 15);
    requireValid(
      edgeCount <= MAX_EDGES_PER_COMMAND && view.getUint32(offset + 16, true) === 0,
      "Edge count/reserved command bits",
    );
    const command: InputCommand = {
      sequence: view.getUint32(offset, true),
      clientTick: view.getUint32(offset + 4, true),
      controlEpoch: view.getUint32(offset + 8, true),
      held: view.getUint16(offset + 12, true),
      aim: view.getUint8(offset + 14) as Aim,
      edges: [],
    };
    offset += COMMAND_BYTES;
    requireValid(offset + edgeCount * EDGE_BYTES <= bytes.byteLength, "Truncated edges");
    for (let edgeIndex = 0; edgeIndex < edgeCount; edgeIndex++) {
      requireValid(
        view.getUint8(offset + 1) === 0 && view.getUint16(offset + 2, true) === 0,
        "Reserved edge bits",
      );
      const edge: ActionEdge = {
        kind: view.getUint8(offset) as EdgeKind,
        id: view.getUint32(offset + 4, true),
      };
      command.edges.push(edge);
      offset += EDGE_BYTES;
    }
    batch.commands.push(command);
  }
  requireValid(offset === bytes.byteLength, "Trailing input bytes");
  validateInputBatch(batch);
  return batch;
}

export function encodeAcknowledgment(ack: PlayerAcknowledgment): Uint8Array {
  const fields = [
    ack.playerId,
    ack.connectionEpoch,
    ack.controlEpoch,
    ack.lastProcessedSequence,
    ack.appliedAtServerTick,
    ...ack.processedEdgeIds,
  ];
  requireValid(ack.processedEdgeIds.length === 5, "Acknowledgment edge cursors");
  const bytes = new Uint8Array(ACK_BYTES);
  const view = new DataView(bytes.buffer);
  fields.forEach((value, index) => {
    counter(value, "acknowledgment field", index >= 3);
    view.setUint32(index * 4, value, true);
  });
  return bytes;
}

export function decodeAcknowledgment(
  bytes: Uint8Array,
  expected: { playerId: number; connectionEpoch: number },
): PlayerAcknowledgment {
  requireValid(bytes.byteLength === ACK_BYTES, "Acknowledgment size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fields = Array.from({ length: 10 }, (_, index) => view.getUint32(index * 4, true));
  const ack: PlayerAcknowledgment = {
    playerId: fields[0] ?? 0,
    connectionEpoch: fields[1] ?? 0,
    controlEpoch: fields[2] ?? 0,
    lastProcessedSequence: fields[3] ?? 0,
    appliedAtServerTick: fields[4] ?? 0,
    processedEdgeIds: [
      fields[5] ?? 0,
      fields[6] ?? 0,
      fields[7] ?? 0,
      fields[8] ?? 0,
      fields[9] ?? 0,
    ],
  };
  if (ack.playerId !== expected.playerId || ack.connectionEpoch !== expected.connectionEpoch)
    throw new ProtocolError("identity-mismatch", "Acknowledgment belongs to another player/socket");
  encodeAcknowledgment(ack);
  return ack;
}
