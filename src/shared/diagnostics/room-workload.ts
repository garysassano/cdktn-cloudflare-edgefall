import { stateHash } from "../../game/core/canonical.js";
import { type AppliedInput, Held, type PlayerAcknowledgment } from "../../game/input/types.js";
import type { Body, ControlledActor } from "../../game/state.js";
import type { GameIdentity } from "../content-id.js";
import type { FullSnapshot, SnapshotContext } from "../protocol/snapshot-schema.js";

/** Diagnostic identities are explicit fixture constants, not production build/content digests. */
export const PROBE_IDENTITY: GameIdentity = {
  simulationVersion: 1,
  simulationBuild: "1".repeat(64),
  contentFormat: 1,
  contentHash: "2".repeat(64),
  presentationBuild: "3".repeat(64),
};
export const PROBE_SHAPES = new Set([1, 2, 3, 4]);
export function probeContext(slot: number): SnapshotContext {
  return {
    runEpoch: 1,
    connectionEpoch: slot + 1,
    playerId: slot + 1,
    geometryRevision: 1,
    shapeIds: PROBE_SHAPES,
  };
}
function body(id: number, shapeId: number): Body {
  return {
    id,
    x: (id % 300) * 256,
    y: 180 * 256,
    vx: 0,
    vy: 0,
    remainderX: 0,
    remainderY: 0,
    shapeId,
    supportId: 10000,
    grounded: true,
    contacts: [
      {
        otherId: 10000,
        normalX: 0,
        normalY: -1,
        toiNumerator: 0,
        toiDenominator: 1,
        kind: "solid",
      },
    ],
  };
}
function action() {
  return {
    kind: "ready" as const,
    actionInstanceId: 0,
    stateStartTick: 0,
    definitionId: 0,
    nextMarkerIndex: 0,
  };
}
function weapon() {
  return {
    id: "sidearm" as const,
    ammo: 0,
    cooldownTicks: 0,
    shotOrdinal: 0,
    lastActionInstanceId: 0,
  };
}
export function probeAck(slot: number): PlayerAcknowledgment {
  return {
    playerId: slot + 1,
    connectionEpoch: slot + 1,
    controlEpoch: 1,
    lastProcessedSequence: 0,
    appliedAtServerTick: 0,
    processedEdgeIds: [0, 0, 0, 0, 0],
  };
}
function player(slot: number): ControlledActor {
  return {
    body: body(slot + 1, 1),
    playerId: slot + 1,
    slot,
    controlEpoch: 1,
    life: "alive",
    locomotion: "grounded",
    action: action(),
    facing: 1,
    aim: 0,
    jumpBufferTicks: 0,
    coyoteTicks: 0,
    ignoredSupportId: null,
    ignoredSupportTicks: 0,
    invulnerableTicks: 0,
    reboardCooldownTicks: 0,
    vehicleSpecialTicks: 0,
    vehicleId: null,
    weapon: weapon(),
    grenadeStock: 5,
    grenadeCooldownTicks: 0,
    meleeCooldownTicks: 0,
    geometryRevision: 1,
    health: 1,
    lives: 3,
    lastRallyMission: 1,
    lifeStartTick: 0,
    processedEdgeIds: [0, 0, 0, 0, 0],
  };
}

/** Populated protocol fixture. Its simple motion is intentionally NOT the future physics/combat kernel. */
export function createRoomWorkload(multiplier: 1 | 2): FullSnapshot {
  if (multiplier !== 1 && multiplier !== 2) throw new RangeError("Unknown diagnostic workload");
  return {
    runEpoch: 1,
    connectionEpoch: 1,
    snapshotId: 1,
    tick: 0,
    baselineEventCursor: 0,
    geometryRevision: 1,
    stateHash: 0,
    roomMode: "loading",
    combat: null,
    camera: { x: 0, y: 0 },
    campaign: {
      ruleset: "classic",
      mission: 1,
      checkpointId: 1,
      continuesRemaining: 3,
      continuesUsed: 0,
      phase: "playing",
      encounterId: 1,
      remainingEnemies: 32 * multiplier,
    },
    players: Array.from({ length: 4 }, (_, slot) => player(slot)),
    acknowledgments: Array.from({ length: 4 }, (_, slot) => probeAck(slot)),
    vehicles: Array.from({ length: 4 * multiplier }, (_, index) => ({
      body: body(100 + index, 2),
      definitionId: 1,
      kind: "tank",
      lifecycle: "available",
      occupantId: null,
      reservedBy: null,
      controlEpoch: 1,
      ownerControlEpoch: null,
      facing: 1,
      heading: 0,
      invulnerableTicks: 0,
      armor: 100,
      action: action(),
      components: [{ id: 1, health: 100, broken: false }],
      weapon: weapon(),
    })),
    enemies: Array.from({ length: 32 * multiplier }, (_, index) => ({
      id: 200 + index,
      definitionId: 1,
      x: index * 256,
      y: 180 * 256,
      vx: index % 2 ? 128 : -128,
      vy: 0,
      shapeId: 1,
      facing: 1,
      health: 3,
      mode: 0,
      stateStartTick: 0,
      actionInstanceId: 0,
      actionDefinitionId: 0,
      modeTicks: 0,
      supportId: 10000,
      geometryRevision: 1,
    })),
    projectiles: Array.from({ length: 96 * multiplier }, (_, index) => ({
      id: 400 + index,
      ownerId: 1,
      actionInstanceId: index + 1,
      definitionId: 1,
      x: index * 256,
      y: 100 * 256,
      vx: 1024,
      vy: 0,
      spawnTick: 0,
      lifetimeTicks: 65535,
      heading: 0,
      shapeId: 3,
    })),
    platforms: Array.from({ length: 16 * multiplier }, (_, index) => ({
      id: 800 + index,
      x: index * 256,
      y: 100 * 256,
      vx: 64,
      vy: 0,
      shapeId: 4,
      trajectoryId: 1,
      trajectoryTick: 0,
    })),
    threats: Array.from({ length: 24 * multiplier }, (_, index) => ({
      actionInstanceId: 1000 + index,
      sourceId: 200 + index,
      definitionId: 1,
      telegraphTick: 0,
      activeTick: 30,
      endTick: 65535,
      x: index * 256,
      y: 100 * 256,
      vx: 0,
      vy: 0,
      heading: 0,
      targetId: (index % 4) + 1,
      motion: "linear",
      cancelled: false,
      stateVersion: 1,
      shapeId: 3,
    })),
    removedIds: [],
  };
}

export function stepRoomWorkload(
  world: FullSnapshot,
  tick: number,
  inputs: readonly AppliedInput[],
): void {
  if (tick !== world.tick + 1) throw new Error("Nonconsecutive diagnostic world tick");
  for (const input of inputs) {
    const actor = world.players.find((value) => value.playerId === input.playerId);
    if (!actor) throw new Error("Unknown diagnostic player");
    actor.body.vx =
      ((input.command.held & Held.Right ? 1 : 0) - (input.command.held & Held.Left ? 1 : 0)) * 256;
    actor.body.x = (actor.body.x + actor.body.vx + 384 * 256) % (384 * 256);
    actor.aim = input.command.aim;
  }
  for (const entity of [...world.enemies, ...world.projectiles, ...world.platforms]) {
    entity.x = (entity.x + entity.vx + 384 * 256) % (384 * 256);
  }
  world.tick = tick;
}

/** Excludes per-recipient delivery header, so independent decoders can verify the same world. */
export function roomWorkloadHash(world: FullSnapshot): number {
  const { connectionEpoch: _connection, snapshotId: _snapshot, stateHash: _hash, ...state } = world;
  return Number.parseInt(stateHash(state), 16);
}
