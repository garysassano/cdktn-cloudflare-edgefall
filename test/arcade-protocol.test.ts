import { describe, expect, it } from "vitest";
import { COUNTER_LIMIT, randomStep } from "../src/game/core/numeric.js";
import {
  Edge,
  Held,
  type InputCommand,
  type PlayerAcknowledgment,
} from "../src/game/input/types.js";
import {
  decodeAcknowledgment,
  decodeInputBatch,
  encodeAcknowledgment,
  encodeInputBatch,
} from "../src/shared/protocol/codec.js";
import { type Handshake, decodeHandshake } from "../src/shared/protocol/handshake.js";
import { type InputBatch, ProtocolError } from "../src/shared/protocol/schema.js";
import golden from "./fixtures/protocol-v3/input-golden.json" with { type: "json" };

const identity = { runEpoch: 1, connectionEpoch: 2 };
const command = (): InputCommand => ({
  sequence: 1,
  clientTick: 0,
  controlEpoch: 1,
  held: Held.Fire,
  aim: 0,
  edges: [{ kind: Edge.FireOnset, id: 1 }],
});
const batch = (): InputBatch => ({
  ...identity,
  packetSequence: 1,
  snapshotAck: 0,
  eventAck: 0,
  commands: [command()],
});

describe("v3 input wire contract", () => {
  it.each(golden)("matches independently packed $byteLength-byte $name golden", (fixture) => {
    const input = fixture.input as InputBatch;
    const bytes = Buffer.from(fixture.hex, "hex");
    expect(bytes.length).toBe(fixture.byteLength);
    expect(Buffer.from(encodeInputBatch(input)).toString("hex")).toBe(fixture.hex);
    expect(decodeInputBatch(bytes, identity)).toEqual(input);
  });

  it("accepts a view into a larger buffer without reading unrelated bytes", () => {
    const bytes = encodeInputBatch(batch());
    const envelope = new Uint8Array(bytes.length + 40).fill(0xaa);
    envelope.set(bytes, 19);
    expect(decodeInputBatch(envelope.subarray(19, 19 + bytes.length), identity)).toEqual(batch());
  });

  it("rejects every truncated prefix, mismatched length and trailing data before returning commands", () => {
    const bytes = encodeInputBatch(batch());
    for (let length = 0; length < bytes.length; length++) {
      const prefix = bytes.slice(0, length);
      if (length >= 8) new DataView(prefix.buffer).setUint16(6, length, true);
      expect(() => decodeInputBatch(prefix, identity)).toThrow(ProtocolError);
    }
    const extra = new Uint8Array(bytes.length + 1);
    extra.set(bytes);
    new DataView(extra.buffer).setUint16(6, extra.length, true);
    expect(() => decodeInputBatch(extra, identity)).toThrow(/Trailing/);
    expect(() => decodeInputBatch(new Uint8Array(285), identity)).toThrow(/size/);
  });

  it.each([0, 2, 3, 4, 5, 29, 30, 31, 48, 49, 50, 51, 53, 54, 55])(
    "rejects unknown header/reserved byte at %i",
    (offset) => {
      const bytes = encodeInputBatch(batch());
      bytes[offset] = (bytes[offset] ?? 0) ^ 0x80;
      expect(() => decodeInputBatch(bytes, identity)).toThrow(ProtocolError);
    },
  );

  it.each([28, 47])("rejects excessive count at offset %i", (offset) => {
    const bytes = encodeInputBatch(batch());
    bytes[offset] = 255;
    expect(() => decodeInputBatch(bytes, identity)).toThrow(ProtocolError);
  });

  it("rejects valid frames from old run/socket epochs, including ack-only packets", () => {
    for (const commands of [[], [command()]]) {
      const bytes = encodeInputBatch({ ...batch(), commands });
      expect(() => decodeInputBatch(bytes, { ...identity, connectionEpoch: 3 })).toThrow(/epoch/);
      expect(() => decodeInputBatch(bytes, { ...identity, runEpoch: 2 })).toThrow(/epoch/);
    }
  });

  it("rejects invalid masks, enums, nonintegers, rollover, sequence holes and repeated/changed edges", () => {
    const invalid: InputBatch[] = [];
    for (const value of [NaN, Infinity, -1, 0.5, COUNTER_LIMIT])
      invalid.push({ ...batch(), packetSequence: value });
    for (const held of [64, -1, 0.5])
      invalid.push({ ...batch(), commands: [{ ...command(), held }] });
    invalid.push({ ...batch(), commands: [{ ...command(), aim: 3 as 0 }] });
    invalid.push({
      ...batch(),
      commands: [command(), { ...command(), sequence: 3, clientTick: 1 }],
    });
    invalid.push({
      ...batch(),
      commands: [command(), { ...command(), sequence: 2, clientTick: 1 }],
    });
    invalid.push({
      ...batch(),
      commands: [
        {
          ...command(),
          edges: [
            { kind: 5, id: 1 },
            { kind: 5, id: 258 },
          ],
        },
      ],
    });
    for (const input of invalid) expect(() => encodeInputBatch(input)).toThrow(ProtocolError);
    // All validation also runs on decoded data, not just on a trusted sender.
    const bytes = encodeInputBatch(batch());
    bytes[44] = 64;
    expect(() => decodeInputBatch(bytes, identity)).toThrow(/held/);
  });

  it("round-trips bounded generated streams and never leaks DataView errors on arbitrary bytes", () => {
    let rng = 47321;
    for (let index = 0; index < 1000; index++) {
      rng = randomStep(rng);
      const input = batch();
      const cmd = input.commands[0];
      if (!cmd) throw new Error("missing fixture command");
      cmd.held = rng & 63;
      cmd.aim = (rng % 3) as 0 | 1 | 2;
      cmd.clientTick = rng % (COUNTER_LIMIT - 1);
      expect(decodeInputBatch(encodeInputBatch(input), identity)).toEqual(input);
      const fuzz = new Uint8Array(rng % 300);
      for (let offset = 0; offset < fuzz.length; offset++) {
        rng = randomStep(rng);
        fuzz[offset] = rng & 255;
      }
      try {
        decodeInputBatch(fuzz, identity);
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
      }
    }
  });
});

describe("processed-command acknowledgment", () => {
  const ack: PlayerAcknowledgment = {
    playerId: 1,
    connectionEpoch: 2,
    controlEpoch: 3,
    lastProcessedSequence: 4,
    appliedAtServerTick: 5,
    processedEdgeIds: [6, 7, 8, 9, 10],
  };
  it("matches the fixed forty-byte little-endian field order", () => {
    const bytes = encodeAcknowledgment(ack);
    expect(Buffer.from(bytes).toString("hex")).toBe(
      "0100000002000000030000000400000005000000060000000700000008000000090000000a000000",
    );
    expect(decodeAcknowledgment(bytes, ack)).toEqual(ack);
  });
  it("rejects a different socket/player and zero identity or rollover", () => {
    const bytes = encodeAcknowledgment(ack);
    expect(() => decodeAcknowledgment(bytes, { ...ack, playerId: 9 })).toThrow(/another/);
    expect(() => decodeAcknowledgment(bytes, { ...ack, connectionEpoch: 9 })).toThrow(/another/);
    expect(() => encodeAcknowledgment({ ...ack, controlEpoch: 0 })).toThrow(ProtocolError);
    expect(() => encodeAcknowledgment({ ...ack, lastProcessedSequence: COUNTER_LIMIT })).toThrow(
      ProtocolError,
    );
  });
});

describe("build and content handshake", () => {
  const hello: Handshake = {
    type: "welcome",
    protocolMajor: 3,
    protocolMinor: 2,
    runId: "contract-fixture",
    runEpoch: 1,
    connectionEpoch: 2,
    playerId: 3,
    entityId: 4,
    simulationHz: 60,
    snapshotHz: 20,
    initialServerTick: 0,
    capabilities: 0,
    baselineSnapshotId: 1,
    baselineEventCursor: 0,
    buildId: "a".repeat(64),
    simulationVersion: 1,
    simulationBuild: "b".repeat(64),
    contentFormat: 1,
    contentHash: "c".repeat(64),
    presentationBuild: "d".repeat(64),
  };
  it("requires independent simulation/content/presentation identity before ready", () => {
    expect(decodeHandshake(JSON.stringify(hello), hello)).toEqual(hello);
    for (const key of ["simulationBuild", "contentHash", "presentationBuild"] as const) {
      expect(() =>
        decodeHandshake(JSON.stringify({ ...hello, [key]: "e".repeat(64) }), hello),
      ).toThrow(/Reload/);
    }
    expect(
      decodeHandshake(JSON.stringify({ ...hello, buildId: "e".repeat(64) }), hello).buildId,
    ).toBe("e".repeat(64));
  });
  it("accepts input mappings alone and with acknowledged gameplay events", () => {
    for (const capabilities of [1, 3] as const) {
      const mapped = { ...hello, capabilities };
      expect(decodeHandshake(JSON.stringify(mapped), hello)).toEqual(mapped);
    }
  });
  it("rejects missing/extra fields, oversized payloads and unsupported contract values", () => {
    for (const patch of [
      { protocolMajor: 2 },
      { protocolMinor: 1 },
      { simulationHz: 30 },
      { snapshotHz: 30 },
      { capabilities: 2 },
      { capabilities: 4 },
      { controlEpoch: 1 },
      { connectionEpoch: 0 },
      { runId: "../unsafe" },
      { contentHash: "unhashed" },
    ]) {
      expect(() => decodeHandshake(JSON.stringify({ ...hello, ...patch }), hello)).toThrow(
        ProtocolError,
      );
    }
    expect(() => decodeHandshake(" ".repeat(2049), hello)).toThrow(ProtocolError);
    expect(() => decodeHandshake("null", hello)).toThrow(ProtocolError);
    expect(() => decodeHandshake("{}", hello)).toThrow(ProtocolError);
  });
});
