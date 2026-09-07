import { MAX_MOTION, MAX_POSITION } from "../../game/core/numeric.js";
import type { PlayerAcknowledgment } from "../../game/input/types.js";
import type { ActionState, Body } from "../../game/state.js";
import { Reader, Writer } from "./binary.js";
import {
  COMBAT_HEADER_BYTES,
  combatRecordBytes,
  readCombat,
  validateCombat,
  writeCombat,
} from "./combat-record.js";
import { readPlayer, readVehicle, writePlayer, writeVehicle } from "./controller-record.js";
import { ACK_BYTES, MAGIC, PROTOCOL_MAJOR, PROTOCOL_MINOR } from "./limits.js";
import { ProtocolError } from "./schema.js";
import {
  CAMPAIGN_BYTES,
  ENEMY_BYTES,
  type EnemySnapshot,
  type FullSnapshot,
  MAX_SNAPSHOT_BYTES,
  MIN_SNAPSHOT_BYTES,
  PLATFORM_BYTES,
  PLAYER_BYTES,
  PROJECTILE_BYTES,
  type PlatformSnapshot,
  type ProjectileSnapshot,
  ROOM_MODES,
  SNAPSHOT_CAPS,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_TYPE,
  type SnapshotContext,
  THREAT_BYTES,
  type ThreatSnapshot,
  VEHICLE_BYTES,
} from "./snapshot-schema.js";

const RULESETS = ["classic", "accessible"] as const;
const PHASES = ["playing", "wipe", "intermission", "victory", "defeat"] as const;
const THREAT_MOTION = ["linear", "locked", "authored"] as const;
type Counts = Record<keyof typeof SNAPSHOT_CAPS, number>;

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ProtocolError("malformed", message);
}
function frameLength(counts: Counts): number {
  for (const key of Object.keys(SNAPSHOT_CAPS) as Array<keyof Counts>)
    check(
      Number.isInteger(counts[key]) &&
        counts[key] >= (key === "players" ? 1 : 0) &&
        counts[key] <= SNAPSHOT_CAPS[key],
      `Invalid ${key} snapshot count`,
    );
  return (
    SNAPSHOT_HEADER_BYTES +
    CAMPAIGN_BYTES +
    counts.players * (PLAYER_BYTES + ACK_BYTES) +
    counts.vehicles * VEHICLE_BYTES +
    counts.enemies * ENEMY_BYTES +
    counts.projectiles * PROJECTILE_BYTES +
    counts.platforms * PLATFORM_BYTES +
    counts.threats * THREAT_BYTES +
    counts.removedIds * 4
  );
}
function ordered(ids: readonly number[], label: string): void {
  for (let index = 1; index < ids.length; index++)
    check((ids[index] ?? 0) > (ids[index - 1] ?? 0), `Unordered/duplicate ${label}`);
}

/** Shared encoder/decoder invariants; complete validation precedes exposure to prediction. */
function validate(snapshot: FullSnapshot, context: SnapshotContext): void {
  validateCombat(snapshot);
  if (
    snapshot.runEpoch !== context.runEpoch ||
    snapshot.connectionEpoch !== context.connectionEpoch
  )
    throw new ProtocolError("identity-mismatch", "Snapshot belongs to another run/socket");
  if (snapshot.geometryRevision !== context.geometryRevision)
    throw new ProtocolError("resync-required", "Snapshot geometry is not loaded");
  check(
    snapshot.acknowledgments.length === snapshot.players.length,
    "Missing player acknowledgments",
  );
  const shape = (id: number) => {
    if (!context.shapeIds.has(id))
      throw new ProtocolError("resync-required", "Snapshot shape is not loaded");
  };
  const ids: number[] = [];
  const groups = [
    snapshot.players.map((p) => p.body.id),
    snapshot.vehicles.map((v) => v.body.id),
    snapshot.enemies.map((e) => e.id),
    snapshot.projectiles.map((p) => p.id),
    snapshot.platforms.map((p) => p.id),
  ];
  for (const group of groups) {
    ordered(group, "entity IDs");
    ids.push(...group);
  }
  const liveIds = new Set(ids);
  check(liveIds.size === ids.length, "Entity ID reused across snapshot sections");
  ordered(snapshot.removedIds, "removal IDs");
  check(
    snapshot.removedIds.every((id) => !liveIds.has(id)),
    "Live entity also removed",
  );
  ordered(
    snapshot.threats.map((threat) => threat.actionInstanceId),
    "threat action IDs",
  );
  check(
    new Set(snapshot.players.map((p) => p.playerId)).size === snapshot.players.length &&
      new Set(snapshot.players.map((p) => p.slot)).size === snapshot.players.length,
    "Duplicate player/slot",
  );
  check(
    snapshot.players.some((p) => p.playerId === context.playerId),
    "Local player missing from baseline",
  );
  const removed = new Set(snapshot.removedIds);
  function body(value: Body) {
    check(value.contacts.length <= 4, "Contact count limit");
    shape(value.shapeId);
    check(value.grounded === (value.supportId !== null), "Ground/support mismatch");
    if (value.supportId !== null)
      check(!removed.has(value.supportId), "Body stands on removed support");
    const keys = new Set<string>();
    for (const contact of value.contacts) {
      check(
        Math.abs(contact.normalX) + Math.abs(contact.normalY) === 1,
        "Noncardinal contact normal",
      );
      check(contact.toiNumerator <= contact.toiDenominator, "Contact outside tick interval");
      check(!removed.has(contact.otherId), "Contact with removed geometry");
      const key = `${contact.otherId}:${contact.normalX}:${contact.normalY}`;
      check(!keys.has(key), "Duplicate contact");
      keys.add(key);
    }
  }
  function action(value: ActionState) {
    check(value.stateStartTick <= snapshot.tick, "Future action state");
    if (value.kind !== "ready")
      check(value.actionInstanceId > 0 && value.definitionId > 0, "Active action has no identity");
  }
  for (const [index, player] of snapshot.players.entries()) {
    body(player.body);
    action(player.action);
    check(player.lifeStartTick <= snapshot.tick, "Future life phase");
    check(player.facing === -1 || player.facing === 1, "Invalid facing");
    check(player.geometryRevision === snapshot.geometryRevision, "Controller geometry mismatch");
    check(
      (player.locomotion === "seated") === (player.vehicleId !== null),
      "Controller seat mismatch",
    );
    if (player.ignoredSupportId !== null)
      check(!removed.has(player.ignoredSupportId), "Ignored support has been removed");
    const ack = snapshot.acknowledgments[index];
    check(
      Boolean(ack && ack.playerId === player.playerId && ack.controlEpoch === player.controlEpoch),
      "Controller/acknowledgment identity mismatch",
    );
    if (!ack) throw new ProtocolError("malformed", "Missing acknowledgment");
    if (player.playerId === context.playerId && ack.connectionEpoch !== context.connectionEpoch)
      throw new ProtocolError("identity-mismatch", "Local acknowledgment socket mismatch");
    check(ack.appliedAtServerTick <= snapshot.tick, "Acknowledgment is in the future");
    check(
      ack.lastProcessedSequence !== 0 ||
        (ack.appliedAtServerTick === 0 && ack.processedEdgeIds.every((value) => value === 0)),
      "Unprocessed command has processing cursors",
    );
    check(
      ack.processedEdgeIds.length === 5 &&
        ack.processedEdgeIds.every((value, edge) => value === player.processedEdgeIds[edge]),
      "Controller/acknowledgment edge mismatch",
    );
    if (player.vehicleId !== null) {
      const vehicle = snapshot.vehicles.find((v) => v.body.id === player.vehicleId);
      check(
        Boolean(
          vehicle &&
            (vehicle.occupantId ?? vehicle.reservedBy) === player.body.id &&
            vehicle.ownerControlEpoch === player.controlEpoch,
        ),
        "Unowned controller vehicle",
      );
    }
  }
  const seatClaims = new Set<number>();
  for (const vehicle of snapshot.vehicles) {
    check(vehicle.facing === -1 || vehicle.facing === 1, "Invalid vehicle facing");
    check(
      (vehicle.ownerControlEpoch !== null) ===
        (vehicle.occupantId !== null || vehicle.reservedBy !== null),
      "Vehicle owner input generation mismatch",
    );
    check(vehicle.components.length <= 8, "Vehicle component count limit");
    body(vehicle.body);
    action(vehicle.action);
    ordered(
      vehicle.components.map((component) => component.id),
      "vehicle components",
    );
    check(
      vehicle.occupantId === null || vehicle.reservedBy === null,
      "Occupied seat is also reserved",
    );
    check(
      vehicle.occupantId === null
        ? !["occupied", "exiting"].includes(vehicle.lifecycle)
        : ["occupied", "exiting", "destroying"].includes(vehicle.lifecycle),
      "Vehicle occupancy lifecycle mismatch",
    );
    check(
      (vehicle.lifecycle === "boarding") === (vehicle.reservedBy !== null),
      "Vehicle reservation lifecycle mismatch",
    );
    for (const id of [vehicle.occupantId, vehicle.reservedBy]) {
      if (id !== null) {
        check(!seatClaims.has(id), "Member claims multiple vehicle seats");
        check(
          snapshot.players.some(
            (p) =>
              p.body.id === id &&
              p.life === "alive" &&
              p.vehicleId === vehicle.body.id &&
              p.controlEpoch === vehicle.ownerControlEpoch,
          ),
          "Unknown vehicle member",
        );
        seatClaims.add(id);
      }
    }
    if (vehicle.occupantId !== null)
      check(
        snapshot.players.some(
          (p) => p.body.id === vehicle.occupantId && p.vehicleId === vehicle.body.id,
        ),
        "Vehicle occupant is elsewhere",
      );
  }
  for (const enemy of snapshot.enemies) {
    shape(enemy.shapeId);
    check(enemy.facing === -1 || enemy.facing === 1, "Invalid enemy facing");
    check(
      enemy.stateStartTick <= snapshot.tick && enemy.geometryRevision === snapshot.geometryRevision,
      "Enemy state/geometry mismatch",
    );
    if (enemy.supportId !== null)
      check(!removed.has(enemy.supportId), "Enemy stands on removed geometry");
  }
  for (const projectile of snapshot.projectiles) {
    shape(projectile.shapeId);
    check(projectile.spawnTick <= snapshot.tick, "Future projectile spawn");
  }
  for (const platform of snapshot.platforms) shape(platform.shapeId);
  for (const threat of snapshot.threats) {
    shape(threat.shapeId);
    check(
      threat.telegraphTick <= threat.activeTick && threat.activeTick < threat.endTick,
      "Invalid threat activation interval",
    );
  }
}

function writeAck(w: Writer, ack: PlayerAcknowledgment) {
  w.u32(ack.playerId, 1);
  w.u32(ack.connectionEpoch, 1);
  w.u32(ack.controlEpoch, 1);
  w.u32(ack.lastProcessedSequence);
  w.u32(ack.appliedAtServerTick);
  check(ack.processedEdgeIds.length === 5, "Five acknowledgment edge cursors required");
  for (const value of ack.processedEdgeIds) w.u32(value);
}
function readAck(r: Reader): PlayerAcknowledgment {
  return {
    playerId: r.u32(1),
    connectionEpoch: r.u32(1),
    controlEpoch: r.u32(1),
    lastProcessedSequence: r.u32(),
    appliedAtServerTick: r.u32(),
    processedEdgeIds: [r.u32(), r.u32(), r.u32(), r.u32(), r.u32()],
  };
}
function writeEnemy(w: Writer, e: EnemySnapshot) {
  w.u32(e.id, 1);
  w.u32(e.definitionId, 1, 65535);
  w.i32(e.x, MAX_POSITION);
  w.i32(e.y, MAX_POSITION);
  w.i32(e.vx, MAX_MOTION);
  w.i32(e.vy, MAX_MOTION);
  w.u32(e.shapeId, 1, 65535);
  w.i32(e.facing, 1);
  w.u32(e.health, 0, 65535);
  w.u32(e.mode, 0, 31);
  w.u32(e.stateStartTick);
  w.u32(e.actionInstanceId);
  w.u32(e.actionDefinitionId, 0, 65535);
  w.u32(e.modeTicks, 0, 65535);
  w.optionalId(e.supportId);
  w.u32(e.geometryRevision, 1);
}
function readEnemy(r: Reader): EnemySnapshot {
  return {
    id: r.u32(1),
    definitionId: r.u32(1, 65535),
    x: r.i32(MAX_POSITION),
    y: r.i32(MAX_POSITION),
    vx: r.i32(MAX_MOTION),
    vy: r.i32(MAX_MOTION),
    shapeId: r.u32(1, 65535),
    facing: r.i32(1) as -1 | 1,
    health: r.u32(0, 65535),
    mode: r.u32(0, 31),
    stateStartTick: r.u32(),
    actionInstanceId: r.u32(),
    actionDefinitionId: r.u32(0, 65535),
    modeTicks: r.u32(0, 65535),
    supportId: r.u32() || null,
    geometryRevision: r.u32(1),
  };
}
function writeProjectile(w: Writer, p: ProjectileSnapshot) {
  w.u32(p.id, 1);
  w.u32(p.ownerId, 1);
  w.u32(p.actionInstanceId, 1);
  w.u32(p.definitionId, 1, 65535);
  w.i32(p.x, MAX_POSITION);
  w.i32(p.y, MAX_POSITION);
  w.i32(p.vx, MAX_MOTION);
  w.i32(p.vy, MAX_MOTION);
  w.u32(p.spawnTick);
  w.u32(p.lifetimeTicks, 1, 65535);
  w.u32(p.heading, 0, 255);
  w.u32(p.shapeId, 1, 65535);
}
function readProjectile(r: Reader): ProjectileSnapshot {
  return {
    id: r.u32(1),
    ownerId: r.u32(1),
    actionInstanceId: r.u32(1),
    definitionId: r.u32(1, 65535),
    x: r.i32(MAX_POSITION),
    y: r.i32(MAX_POSITION),
    vx: r.i32(MAX_MOTION),
    vy: r.i32(MAX_MOTION),
    spawnTick: r.u32(),
    lifetimeTicks: r.u32(1, 65535),
    heading: r.u32(0, 255),
    shapeId: r.u32(1, 65535),
  };
}
function writePlatform(w: Writer, p: PlatformSnapshot) {
  w.u32(p.id, 1);
  w.i32(p.x, MAX_POSITION);
  w.i32(p.y, MAX_POSITION);
  w.i32(p.vx, MAX_MOTION);
  w.i32(p.vy, MAX_MOTION);
  w.u32(p.shapeId, 1, 65535);
  w.u32(p.trajectoryId, 0, 65535);
  w.u32(p.trajectoryTick);
}
function readPlatform(r: Reader): PlatformSnapshot {
  return {
    id: r.u32(1),
    x: r.i32(MAX_POSITION),
    y: r.i32(MAX_POSITION),
    vx: r.i32(MAX_MOTION),
    vy: r.i32(MAX_MOTION),
    shapeId: r.u32(1, 65535),
    trajectoryId: r.u32(0, 65535),
    trajectoryTick: r.u32(),
  };
}
function writeThreat(w: Writer, t: ThreatSnapshot) {
  w.u32(t.actionInstanceId, 1);
  w.u32(t.sourceId, 1);
  w.u32(t.definitionId, 1, 65535);
  w.u32(t.telegraphTick);
  w.u32(t.activeTick);
  w.u32(t.endTick);
  w.i32(t.x, MAX_POSITION);
  w.i32(t.y, MAX_POSITION);
  w.i32(t.vx, MAX_MOTION);
  w.i32(t.vy, MAX_MOTION);
  w.u32(t.heading, 0, 255);
  w.optionalId(t.targetId);
  w.choice(THREAT_MOTION, t.motion);
  w.bool(t.cancelled);
  w.u32(t.stateVersion, 1);
  w.u32(t.shapeId, 1, 65535);
}
function readThreat(r: Reader): ThreatSnapshot {
  return {
    actionInstanceId: r.u32(1),
    sourceId: r.u32(1),
    definitionId: r.u32(1, 65535),
    telegraphTick: r.u32(),
    activeTick: r.u32(),
    endTick: r.u32(),
    x: r.i32(MAX_POSITION),
    y: r.i32(MAX_POSITION),
    vx: r.i32(MAX_MOTION),
    vy: r.i32(MAX_MOTION),
    heading: r.u32(0, 255),
    targetId: r.u32() || null,
    motion: r.choice(THREAT_MOTION),
    cancelled: r.bool(),
    stateVersion: r.u32(1),
    shapeId: r.u32(1, 65535),
  };
}

export function encodeSnapshot(snapshot: FullSnapshot, context: SnapshotContext): Uint8Array {
  const counts: Counts = {
    players: snapshot.players.length,
    vehicles: snapshot.vehicles.length,
    enemies: snapshot.enemies.length,
    projectiles: snapshot.projectiles.length,
    platforms: snapshot.platforms.length,
    threats: snapshot.threats.length,
    removedIds: snapshot.removedIds.length,
  };
  const length = frameLength(counts) + combatRecordBytes(snapshot.combat);
  validate(snapshot, context);
  const w = new Writer(length);
  w.u16(MAGIC);
  w.u8(PROTOCOL_MAJOR);
  w.u8(PROTOCOL_MINOR);
  w.u8(SNAPSHOT_TYPE);
  w.u8(snapshot.combat === null ? 0 : 1);
  w.u16(length);
  w.u32(snapshot.runEpoch, 1);
  w.u32(snapshot.connectionEpoch, 1);
  w.u32(snapshot.snapshotId, 1);
  w.u32(snapshot.tick);
  w.u32(snapshot.baselineEventCursor);
  w.u32(snapshot.geometryRevision, 1);
  w.u32(snapshot.stateHash, 0, 0xffffffff);
  w.u8(counts.players);
  w.u8(counts.vehicles);
  w.u16(counts.enemies);
  w.u16(counts.projectiles);
  w.u16(counts.platforms);
  w.u16(counts.threats);
  w.u16(counts.removedIds);
  w.u8(ROOM_MODES.indexOf(snapshot.roomMode));
  w.zero(15);
  w.i32(snapshot.camera.x, MAX_POSITION);
  w.i32(snapshot.camera.y, MAX_POSITION);
  w.choice(RULESETS, snapshot.campaign.ruleset);
  w.u32(snapshot.campaign.mission, 1, 255);
  w.u32(snapshot.campaign.checkpointId, 1);
  w.u32(snapshot.campaign.continuesRemaining, 0, 65535);
  w.u32(snapshot.campaign.continuesUsed, 0, 65535);
  w.choice(PHASES, snapshot.campaign.phase);
  w.u32(snapshot.campaign.encounterId, 1);
  w.u32(snapshot.campaign.remainingEnemies, 0, 320);
  for (const ack of snapshot.acknowledgments) writeAck(w, ack);
  for (const player of snapshot.players) writePlayer(w, player);
  for (const vehicle of snapshot.vehicles) writeVehicle(w, vehicle);
  for (const enemy of snapshot.enemies) writeEnemy(w, enemy);
  for (const projectile of snapshot.projectiles) writeProjectile(w, projectile);
  for (const platform of snapshot.platforms) writePlatform(w, platform);
  for (const threat of snapshot.threats) writeThreat(w, threat);
  for (const id of snapshot.removedIds) w.u32(id, 1);
  if (snapshot.combat !== null) writeCombat(w, snapshot.combat);
  check(w.offset === length, "Snapshot encoder record size mismatch");
  return w.bytes;
}

export function decodeSnapshot(bytes: Uint8Array, context: SnapshotContext): FullSnapshot {
  check(
    bytes.byteLength >= MIN_SNAPSHOT_BYTES && bytes.byteLength <= MAX_SNAPSHOT_BYTES,
    "Snapshot size limit",
  );
  const r = new Reader(bytes);
  check(
    r.u16() === MAGIC &&
      r.u8() === PROTOCOL_MAJOR &&
      r.u8() === PROTOCOL_MINOR &&
      r.u8() === SNAPSHOT_TYPE,
    "Snapshot frame header",
  );
  const flags = r.u8();
  check(flags <= 1 && r.u16() === bytes.byteLength, "Snapshot frame header");
  const header = {
    runEpoch: r.u32(1),
    connectionEpoch: r.u32(1),
    snapshotId: r.u32(1),
    tick: r.u32(),
    baselineEventCursor: r.u32(),
    geometryRevision: r.u32(1),
    stateHash: r.u32(0, 0xffffffff),
  };
  if (header.runEpoch !== context.runEpoch || header.connectionEpoch !== context.connectionEpoch)
    throw new ProtocolError("identity-mismatch", "Snapshot belongs to another run/socket");
  if (header.geometryRevision !== context.geometryRevision)
    throw new ProtocolError("resync-required", "Snapshot geometry is not loaded");
  const counts: Counts = {
    players: r.u8(),
    vehicles: r.u8(),
    enemies: r.u16(),
    projectiles: r.u16(),
    platforms: r.u16(),
    threats: r.u16(),
    removedIds: r.u16(),
  };
  const baseLength = frameLength(counts);
  check(
    flags === 0
      ? baseLength === bytes.byteLength
      : baseLength + COMBAT_HEADER_BYTES <= bytes.byteLength,
    "Snapshot section lengths do not match frame",
  );
  const roomMode = ROOM_MODES[r.u8()];
  check(roomMode !== undefined, "Unknown room mode");
  r.zero(15);
  const snapshot: FullSnapshot = {
    ...header,
    roomMode,
    camera: { x: r.i32(MAX_POSITION), y: r.i32(MAX_POSITION) },
    campaign: {
      ruleset: r.choice(RULESETS),
      mission: r.u32(1, 255),
      checkpointId: r.u32(1),
      continuesRemaining: r.u32(0, 65535),
      continuesUsed: r.u32(0, 65535),
      phase: r.choice(PHASES),
      encounterId: r.u32(1),
      remainingEnemies: r.u32(0, 320),
    },
    combat: null,
    acknowledgments: [],
    players: [],
    vehicles: [],
    enemies: [],
    projectiles: [],
    platforms: [],
    threats: [],
    removedIds: [],
  };
  for (let index = 0; index < counts.players; index++) snapshot.acknowledgments.push(readAck(r));
  for (let index = 0; index < counts.players; index++) snapshot.players.push(readPlayer(r));
  for (let index = 0; index < counts.vehicles; index++) snapshot.vehicles.push(readVehicle(r));
  for (let index = 0; index < counts.enemies; index++) snapshot.enemies.push(readEnemy(r));
  for (let index = 0; index < counts.projectiles; index++)
    snapshot.projectiles.push(readProjectile(r));
  for (let index = 0; index < counts.platforms; index++) snapshot.platforms.push(readPlatform(r));
  for (let index = 0; index < counts.threats; index++) snapshot.threats.push(readThreat(r));
  for (let index = 0; index < counts.removedIds; index++) snapshot.removedIds.push(r.u32(1));
  if (flags === 1) snapshot.combat = readCombat(r);
  check(r.offset === bytes.byteLength, "Trailing snapshot bytes");
  validate(snapshot, context);
  return snapshot;
}
