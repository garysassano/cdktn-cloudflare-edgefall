import { describe, expect, it } from "vitest";
import { Held } from "../src/game/input/types.js";
import {
  createRoomWorkload,
  probeContext,
  roomWorkloadHash,
  stepRoomWorkload,
} from "../src/shared/diagnostics/room-workload.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";

describe("populated protocol workload", () => {
  it.each([
    { multiplier: 1 as const, bytes: 11480 },
    { multiplier: 2 as const, bytes: 21480 },
  ])("round-trips all four recipient baselines at $bytes bytes", ({ multiplier, bytes }) => {
    const world = createRoomWorkload(multiplier);
    expect(world.players).toHaveLength(4);
    expect(world.enemies).toHaveLength(32 * multiplier);
    expect(world.projectiles).toHaveLength(96 * multiplier);
    world.stateHash = roomWorkloadHash(world);
    for (let slot = 0; slot < 4; slot++) {
      world.connectionEpoch = slot + 1;
      world.snapshotId++;
      const encoded = encodeSnapshot(world, probeContext(slot));
      expect(encoded.byteLength).toBe(bytes);
      const decoded = decodeSnapshot(encoded, probeContext(slot));
      expect(roomWorkloadHash(decoded)).toBe(world.stateHash);
      expect(decoded).toEqual(world);
    }
  });
  it("changes its diagnostic digest with actual world/ack state, excluding only delivery identity", () => {
    const world = createRoomWorkload(1);
    const initialHash = roomWorkloadHash(world);
    stepRoomWorkload(world, 1, [
      {
        playerId: 1,
        serverTick: 1,
        outcome: "applied",
        repeatedHeld: false,
        submittedCommand: null,
        command: {
          sequence: 1,
          clientTick: 0,
          controlEpoch: 1,
          held: Held.Right,
          aim: 0,
          edges: [],
        },
      },
    ]);
    expect(world.players[0]?.body.x).toBe(512);
    expect(world.projectiles[0]?.x).toBe(1024);
    expect(roomWorkloadHash(world)).not.toBe(initialHash);
    expect(() => stepRoomWorkload(world, 3, [])).toThrow(/Nonconsecutive/);
    const hash = roomWorkloadHash(world);
    const ack = world.acknowledgments[0];
    if (!ack) throw new Error("Missing acknowledgment");
    ack.lastProcessedSequence = 1;
    ack.appliedAtServerTick = 1;
    expect(roomWorkloadHash(world)).not.toBe(hash);
  });
});
