import { describe, expect, it } from "vitest";
import { COUNTER_LIMIT, MAX_MOTION, MAX_POSITION, randomStep } from "../src/game/core/numeric.js";
import { ProtocolError } from "../src/shared/protocol/schema.js";
import { decodeSnapshot, encodeSnapshot } from "../src/shared/protocol/snapshot.js";
import {
  type FullSnapshot,
  MAX_SNAPSHOT_BYTES,
  type SnapshotContext,
} from "../src/shared/protocol/snapshot-schema.js";
import goldens from "./fixtures/protocol-v3/snapshot-golden.json" with { type: "json" };

const context: SnapshotContext = {
  runEpoch: 1,
  connectionEpoch: 2,
  playerId: 1,
  geometryRevision: 7,
  shapeIds: new Set([1, 2, 3, 4]),
};
function fixture(index = 1): FullSnapshot {
  const value = goldens[index];
  if (!value) throw new Error("Missing snapshot golden");
  return structuredClone(value.snapshot) as FullSnapshot;
}
function first<T>(array: T[]): T {
  const value = array[0];
  if (!value) throw new Error("Missing fixture record");
  return value;
}

describe("full v3 snapshot records", () => {
  it("preserves present and removed corpses and refuses inconsistent life/body state", () => {
    const snapshot = fixture();
    const player = first(snapshot.players);
    player.life = "death";
    player.health = 0;
    player.bodyPresence = "present";
    player.action = {
      kind: "ready",
      actionInstanceId: 0,
      stateStartTick: snapshot.tick,
      definitionId: 0,
      nextMarkerIndex: 0,
    };
    expect(decodeSnapshot(encodeSnapshot(snapshot, context), context)).toEqual(snapshot);
    player.bodyPresence = "removed";
    player.locomotion = "airborne";
    Object.assign(player.body, {
      vx: 0,
      vy: 0,
      remainderX: 0,
      remainderY: 0,
      grounded: false,
      supportId: null,
      contacts: [],
    });
    expect(decodeSnapshot(encodeSnapshot(snapshot, context), context)).toEqual(snapshot);
    player.body.vx = 1;
    expect(() => encodeSnapshot(snapshot, context)).toThrow(/body presence/);
    player.body.vx = 0;
    player.life = "respawning";
    player.health = 1;
    expect(decodeSnapshot(encodeSnapshot(snapshot, context), context)).toEqual(snapshot);
    player.life = "alive";
    expect(() => encodeSnapshot(snapshot, context)).toThrow(/body presence/);
    const bytes = encodeSnapshot(fixture(), context);
    new DataView(bytes.buffer).setUint32(304, 1, true); // Removed body on an alive player.
    expect(() => decodeSnapshot(bytes, context)).toThrow(/body presence/);
  });
  it.each(goldens)("matches independently packed $name ($byteLength bytes)", (golden) => {
    const bytes = Buffer.from(golden.hex, "hex");
    expect(encodeSnapshot(golden.snapshot as FullSnapshot, context)).toHaveLength(
      golden.byteLength,
    );
    expect(
      Buffer.from(encodeSnapshot(golden.snapshot as FullSnapshot, context)).toString("hex"),
    ).toBe(golden.hex);
    expect(decodeSnapshot(bytes, context)).toEqual(golden.snapshot);
  });

  it("preserves complete seated-player and controllable-vehicle state", () => {
    const snapshot = fixture();
    const player = first(snapshot.players);
    const vehicle = first(snapshot.vehicles);
    player.vehicleId = vehicle.body.id;
    player.locomotion = "seated";
    player.body.grounded = false;
    player.body.supportId = null;
    player.body.contacts = [];
    vehicle.occupantId = player.body.id;
    vehicle.lifecycle = "occupied";
    vehicle.controlEpoch = player.controlEpoch + 9;
    vehicle.ownerControlEpoch = player.controlEpoch;
    vehicle.heading = 5;
    vehicle.facing = -1;
    vehicle.invulnerableTicks = 30;
    const bytes = encodeSnapshot(snapshot, context);
    const decoded = decodeSnapshot(bytes, context);
    expect(decoded).toEqual(snapshot);
    const owner = first(decoded.players);
    expect(owner.weapon.shotOrdinal).toBe(9);
    expect(owner.jumpBufferTicks).toBe(3);
    expect(owner.ignoredSupportId).toBe(101);
    expect(first(decoded.vehicles).components).toHaveLength(2);
    vehicle.lifecycle = "exiting";
    expect(decodeSnapshot(encodeSnapshot(snapshot, context), context)).toEqual(snapshot);
    vehicle.lifecycle = "destroying";
    expect(decodeSnapshot(encodeSnapshot(snapshot, context), context)).toEqual(snapshot);
  });

  it("round-trips exact signed numerical/counter boundaries without render quantization", () => {
    const snapshot = fixture(0);
    const player = first(snapshot.players);
    const ack = first(snapshot.acknowledgments);
    player.body.x = -MAX_POSITION;
    player.body.y = MAX_POSITION;
    player.body.vx = -MAX_MOTION;
    player.body.vy = MAX_MOTION;
    player.body.remainderX = MAX_MOTION * 2 - 1;
    player.body.remainderY = -(MAX_MOTION * 2 - 1);
    player.action = {
      kind: "fire",
      actionInstanceId: COUNTER_LIMIT - 1,
      definitionId: 65535,
      stateStartTick: COUNTER_LIMIT - 1,
      nextMarkerIndex: 128,
    };
    player.controlEpoch = COUNTER_LIMIT - 1;
    player.processedEdgeIds.fill(COUNTER_LIMIT - 1);
    ack.processedEdgeIds.fill(COUNTER_LIMIT - 1);
    ack.controlEpoch = player.controlEpoch;
    ack.appliedAtServerTick = COUNTER_LIMIT - 1;
    ack.lastProcessedSequence = COUNTER_LIMIT - 1;
    snapshot.tick = COUNTER_LIMIT - 1;
    snapshot.stateHash = 0xffffffff;
    const bytes = encodeSnapshot(snapshot, context);
    const envelope = new Uint8Array(bytes.length + 21).fill(0x99);
    envelope.set(bytes, 7);
    expect(decodeSnapshot(envelope.subarray(7, 7 + bytes.length), context)).toEqual(snapshot);
  });

  it("bounds all section counts and the total allocation at the maximum valid frame", () => {
    const snapshot = fixture();
    const player = first(snapshot.players);
    const ack = first(snapshot.acknowledgments);
    snapshot.players = Array.from({ length: 4 }, (_, i) => ({
      ...structuredClone(player),
      body: { ...structuredClone(player.body), id: 10 + i },
      slot: i,
      playerId: 1 + i,
    }));
    snapshot.acknowledgments = Array.from({ length: 4 }, (_, i) => ({
      ...structuredClone(ack),
      playerId: 1 + i,
    }));
    const vehicle = first(snapshot.vehicles);
    snapshot.vehicles = Array.from({ length: 16 }, (_, i) => ({
      ...structuredClone(vehicle),
      body: { ...structuredClone(vehicle.body), id: 1000 + i },
    }));
    const enemy = first(snapshot.enemies);
    snapshot.enemies = Array.from({ length: 128 }, (_, i) => ({ ...enemy, id: 2000 + i }));
    const projectile = first(snapshot.projectiles);
    snapshot.projectiles = Array.from({ length: 256 }, (_, i) => ({ ...projectile, id: 3000 + i }));
    const platform = first(snapshot.platforms);
    snapshot.platforms = Array.from({ length: 64 }, (_, i) => ({ ...platform, id: 4000 + i }));
    const threat = first(snapshot.threats);
    snapshot.threats = Array.from({ length: 128 }, (_, i) => ({
      ...threat,
      actionInstanceId: 6000 + i,
    }));
    snapshot.removedIds = Array.from({ length: 512 }, (_, i) => 5000 + i);
    snapshot.combat = {
      props: Array.from({ length: 32 }, (_, i) => ({
        id: 9500 + i,
        definitionId: 1,
        health: 8,
        destroyedTick: null,
        destroyerId: null,
        destroyActionId: null,
      })),
      nextEntityId: 10000,
      nextActionId: 10000,
      encounterEventCursor: 1024,
      volumes: Array.from({ length: 64 }, (_, i) => ({
        id: 9000 + Math.floor(i / 4),
        ownerId: 1,
        actionInstanceId: 9000 + Math.floor(i / 4),
        definitionId: 11,
        spawnTick: snapshot.tick,
        endTick: snapshot.tick + 30,
        rect: { x: 0, y: 0, w: 3584, h: 2048 },
        heading: 0 as const,
        lobe: i % 4,
        attached: true,
      })),
      encounterId: snapshot.campaign.encounterId,
      phase: "active",
      members: Array.from({ length: 256 }, (_, i) => ({
        id: 7000 + i,
        required: true,
        critical: false,
        retreatAllowed: true,
        status: "pending",
        activatedTick: null,
        resolvedTick: null,
        reason: null,
        killerId: null,
      })),
      objectives: Array.from({ length: 64 }, (_, i) => ({ id: 8000 + i, completedTick: null })),
      kills: snapshot.players.map((p) => ({ playerId: p.playerId, count: 0 })),
      failure: null,
    };
    snapshot.campaign.remainingEnemies = 320;
    const bytes = encodeSnapshot(snapshot, context);
    expect(bytes.length).toBe(MAX_SNAPSHOT_BYTES);
    expect(bytes.length).toBe(52060);
    expect(decodeSnapshot(bytes, context)).toEqual(snapshot);
    snapshot.projectiles.push({ ...projectile, id: 9000 });
    expect(() => encodeSnapshot(snapshot, context)).toThrow(/count/);
    expect(() => decodeSnapshot(new Uint8Array(MAX_SNAPSHOT_BYTES + 1), context)).toThrow(/size/);
  });

  it("rejects every truncated prefix and trailing data even when declared length is forged", () => {
    const bytes = encodeSnapshot(fixture(), context);
    for (let length = 0; length < bytes.length; length++) {
      const prefix = bytes.slice(0, length);
      if (length >= 8) new DataView(prefix.buffer).setUint16(6, length, true);
      expect(() => decodeSnapshot(prefix, context)).toThrow(ProtocolError);
    }
    const extra = new Uint8Array(bytes.length + 1);
    extra.set(bytes);
    new DataView(extra.buffer).setUint16(6, extra.length, true);
    expect(() => decodeSnapshot(extra, context)).toThrow(/length/);
  });

  it("rejects unknown flags/modes/counts and nonzero unused contact/component storage", () => {
    // Header reserved tail; unused player contact slot; unused vehicle component slot.
    for (const offset of [5, 48, ...Array.from({ length: 15 }, (_, i) => 49 + i), 212, 680]) {
      const bytes = encodeSnapshot(fixture(), context);
      bytes[offset] = 0xff;
      expect(() => decodeSnapshot(bytes, context)).toThrow(ProtocolError);
    }
    for (const offset of [36, 37, 38, 40, 42, 44, 46]) {
      const bytes = encodeSnapshot(fixture(), context);
      bytes[offset] = 0xff;
      bytes[offset + 1] = 0xff;
      expect(() => decodeSnapshot(bytes, context)).toThrow(ProtocolError);
    }
  });

  it("fails closed on missing geometry, shape tables and run/socket/player identity", () => {
    const bytes = encodeSnapshot(fixture(), context);
    for (const patch of [
      { runEpoch: 2 },
      { connectionEpoch: 3 },
      { playerId: 9 },
      { geometryRevision: 8 },
      { shapeIds: new Set([2, 3, 4]) },
    ]) {
      expect(() => decodeSnapshot(bytes, { ...context, ...patch })).toThrow(ProtocolError);
    }
  });

  it("rejects inconsistent controller, acknowledgment, support, seat, threat and removal state", () => {
    const mutations: Array<(s: FullSnapshot) => void> = [
      (s) => {
        first(s.players).body.vx = MAX_MOTION + 1;
      },
      (s) => {
        first(s.players).body.x = MAX_POSITION + 1;
      },
      (s) => {
        first(s.players).body.supportId = 0;
      },
      (s) => {
        first(s.players).body.supportId = null;
      },
      (s) => {
        first(s.players).health = 1.5;
      },
      (s) => {
        first(s.players).geometryRevision = 8;
      },
      (s) => {
        first(s.players).vehicleId = 20;
      },
      (s) => {
        first(s.players).life = "unknown" as "alive";
      },
      (s) => {
        first(s.players).processedEdgeIds[0] = 99;
      },
      (s) => {
        first(s.acknowledgments).appliedAtServerTick = s.tick + 1;
      },
      (s) => {
        first(s.acknowledgments).connectionEpoch = 3;
      },
      (s) => {
        first(s.acknowledgments).lastProcessedSequence = 0;
      },
      (s) => {
        first(first(s.players).body.contacts).normalX = 1;
      },
      (s) => {
        first(first(s.players).body.contacts).toiNumerator = 2;
      },
      (s) => {
        first(s.vehicles).occupantId = 10;
      },
      (s) => {
        first(s.vehicles).components.push(first(first(s.vehicles).components));
      },
      (s) => {
        first(s.threats).activeTick = first(s.threats).endTick;
      },
      (s) => {
        first(s.projectiles).spawnTick = s.tick + 1;
      },
      (s) => {
        first(s.projectiles).id = first(s.enemies).id;
      },
      (s) => {
        s.removedIds.push(100);
      },
      (s) => {
        s.removedIds = [40];
      },
      (s) => {
        s.snapshotId = COUNTER_LIMIT;
      },
    ];
    for (const mutate of mutations) {
      const snapshot = fixture();
      mutate(snapshot);
      expect(() => encodeSnapshot(snapshot, context)).toThrow(ProtocolError);
    }
  });

  it("detects forged record values during decoding, not just trusted encoding", () => {
    for (const [offset, value] of [
      [148, MAX_POSITION + 1],
      [156, MAX_MOTION + 1],
      [184, 5],
      [296, 4],
      [300, COUNTER_LIMIT],
      [304, 3],
      [332, 0],
      [340, 5],
      [344, 181],
      [412, 8],
      [428, 99],
    ]) {
      const bytes = encodeSnapshot(fixture(), context);
      if (offset === undefined || value === undefined) throw new Error("Missing mutation fixture");
      new DataView(bytes.buffer).setUint32(offset, value, true);
      expect(() => decodeSnapshot(bytes, context)).toThrow(ProtocolError);
    }
  });

  it("cannot reserve multiple vehicles for one member", () => {
    const snapshot = fixture();
    const vehicle = first(snapshot.vehicles);
    vehicle.lifecycle = "boarding";
    vehicle.reservedBy = first(snapshot.players).body.id;
    vehicle.ownerControlEpoch = first(snapshot.players).controlEpoch;
    first(snapshot.players).vehicleId = vehicle.body.id;
    first(snapshot.players).locomotion = "seated";
    snapshot.vehicles.push({
      ...structuredClone(vehicle),
      body: { ...structuredClone(vehicle.body), id: 21 },
    });
    expect(() => encodeSnapshot(snapshot, context)).toThrow(/multiple vehicle seats/);
  });

  it("never exposes raw DataView exceptions or partly decoded entities on arbitrary frames", () => {
    let rng = 47321;
    for (let index = 0; index < 500; index++) {
      rng = randomStep(rng);
      const bytes = new Uint8Array(rng % 2000);
      for (let offset = 0; offset < bytes.length; offset++) {
        rng = randomStep(rng);
        bytes[offset] = rng & 255;
      }
      expect(() => decodeSnapshot(bytes, context)).toThrow(ProtocolError);
    }
  });
});
