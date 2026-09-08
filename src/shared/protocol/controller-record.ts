import { MAX_MOTION, MAX_POSITION } from "../../game/core/numeric.js";
import type {
  ActionState,
  Body,
  ControlledActor,
  VehicleState,
  WeaponState,
} from "../../game/state.js";
import type { Reader, Writer } from "./binary.js";
import { ProtocolError } from "./schema.js";

const CONTACTS = ["solid", "one-way", "platform"] as const;
const ACTIONS = ["ready", "fire", "melee", "grenade", "enter", "exit", "hurt"] as const;
export const WEAPONS = [
  "sidearm",
  "heavy-machine-gun",
  "shotgun",
  "rocket-launcher",
  "flamethrower",
  "laser",
] as const;
const LIFE = ["alive", "death", "respawning", "spectating"] as const;
const BODY_PRESENCE = ["present", "removed"] as const;
const LOCOMOTION = ["grounded", "airborne", "crouched", "seated"] as const;
const VEHICLES = ["tank", "walker", "aircraft"] as const;
const LIFECYCLE = ["available", "boarding", "occupied", "exiting", "destroying", "wreck"] as const;

export function writeBody(writer: Writer, body: Body): void {
  writer.u32(body.id, 1);
  writer.i32(body.x, MAX_POSITION);
  writer.i32(body.y, MAX_POSITION);
  writer.i32(body.vx, MAX_MOTION);
  writer.i32(body.vy, MAX_MOTION);
  writer.i32(body.remainderX, MAX_MOTION * 2 - 1);
  writer.i32(body.remainderY, MAX_MOTION * 2 - 1);
  writer.u32(body.shapeId, 1, 65535);
  writer.optionalId(body.supportId);
  writer.bool(body.grounded);
  writer.u32(body.contacts.length, 0, 4);
  for (const contact of body.contacts) {
    writer.u32(contact.otherId, 1);
    writer.i32(contact.normalX, 1);
    writer.i32(contact.normalY, 1);
    writer.u32(contact.toiNumerator, 0, 2 ** 26);
    writer.u32(contact.toiDenominator, 1, 2 ** 17);
    writer.choice(CONTACTS, contact.kind);
  }
  writer.zero((4 - body.contacts.length) * 24);
}
export function readBody(reader: Reader): Body {
  const body: Body = {
    id: reader.u32(1),
    x: reader.i32(MAX_POSITION),
    y: reader.i32(MAX_POSITION),
    vx: reader.i32(MAX_MOTION),
    vy: reader.i32(MAX_MOTION),
    remainderX: reader.i32(MAX_MOTION * 2 - 1),
    remainderY: reader.i32(MAX_MOTION * 2 - 1),
    shapeId: reader.u32(1, 65535),
    supportId: reader.u32() || null,
    grounded: reader.bool(),
    contacts: [],
  };
  const count = reader.u32(0, 4);
  for (let index = 0; index < count; index++)
    body.contacts.push({
      otherId: reader.u32(1),
      normalX: reader.i32(1) as -1 | 0 | 1,
      normalY: reader.i32(1) as -1 | 0 | 1,
      toiNumerator: reader.u32(0, 2 ** 26),
      toiDenominator: reader.u32(1, 2 ** 17),
      kind: reader.choice(CONTACTS),
    });
  reader.zero((4 - count) * 24);
  return body;
}
function writeAction(writer: Writer, action: ActionState): void {
  writer.choice(ACTIONS, action.kind);
  writer.u32(action.actionInstanceId);
  writer.u32(action.stateStartTick);
  writer.u32(action.definitionId, 0, 65535);
  writer.u32(action.nextMarkerIndex, 0, 128);
}
function readAction(reader: Reader): ActionState {
  return {
    kind: reader.choice(ACTIONS),
    actionInstanceId: reader.u32(),
    stateStartTick: reader.u32(),
    definitionId: reader.u32(0, 65535),
    nextMarkerIndex: reader.u32(0, 128),
  };
}
function writeWeapon(writer: Writer, weapon: WeaponState): void {
  writer.choice(WEAPONS, weapon.id);
  writer.u32(weapon.ammo, 0, 65535);
  writer.u32(weapon.cooldownTicks, 0, 65535);
  writer.u32(weapon.shotOrdinal);
  writer.u32(weapon.lastActionInstanceId);
}
function readWeapon(reader: Reader): WeaponState {
  return {
    id: reader.choice(WEAPONS),
    ammo: reader.u32(0, 65535),
    cooldownTicks: reader.u32(0, 65535),
    shotOrdinal: reader.u32(),
    lastActionInstanceId: reader.u32(),
  };
}

export function writePlayer(writer: Writer, player: ControlledActor): void {
  writeBody(writer, player.body);
  writer.u32(player.playerId, 1);
  writer.u32(player.slot, 0, 3);
  writer.u32(player.controlEpoch, 1);
  writer.choice(LIFE, player.life);
  writer.u32(player.lifeStartTick);
  writer.choice(BODY_PRESENCE, player.bodyPresence);
  writer.choice(LOCOMOTION, player.locomotion);
  writeAction(writer, player.action);
  writer.i32(player.facing, 1);
  writer.u32(player.aim, 0, 2);
  writer.i32(player.firearmAim.pitch, 4);
  writer.u32(player.firearmAim.nextStepTick);
  writer.u32(player.jumpBufferTicks, 0, 65535);
  writer.u32(player.coyoteTicks, 0, 65535);
  writer.optionalId(player.ignoredSupportId);
  writer.u32(player.ignoredSupportTicks, 0, 65535);
  writer.u32(player.invulnerableTicks, 0, 65535);
  writer.u32(player.reboardCooldownTicks, 0, 65535);
  writer.u32(player.vehicleSpecialTicks, 0, 65535);
  writer.optionalId(player.vehicleId);
  writeWeapon(writer, player.weapon);
  writer.u32(player.grenadeStock, 0, 65535);
  writer.u32(player.grenadeCooldownTicks, 0, 65535);
  writer.u32(player.meleeCooldownTicks, 0, 65535);
  writer.u32(player.geometryRevision, 1);
  writer.u32(player.health, 0, 65535);
  writer.u32(player.lives, 0, 65535);
  writer.u32(player.lastRallyMission, 0, 65535);
  if (player.processedEdgeIds.length !== 5)
    throw new ProtocolError("malformed", "Five controller edge cursors required");
  for (const edge of player.processedEdgeIds) writer.u32(edge);
}
export function readPlayer(reader: Reader): ControlledActor {
  return {
    body: readBody(reader),
    playerId: reader.u32(1),
    slot: reader.u32(0, 3),
    controlEpoch: reader.u32(1),
    life: reader.choice(LIFE),
    lifeStartTick: reader.u32(),
    bodyPresence: reader.choice(BODY_PRESENCE),
    locomotion: reader.choice(LOCOMOTION),
    action: readAction(reader),
    facing: reader.i32(1) as -1 | 1,
    aim: reader.u32(0, 2) as 0 | 1 | 2,
    firearmAim: { pitch: reader.i32(4), nextStepTick: reader.u32() },
    jumpBufferTicks: reader.u32(0, 65535),
    coyoteTicks: reader.u32(0, 65535),
    ignoredSupportId: reader.u32() || null,
    ignoredSupportTicks: reader.u32(0, 65535),
    invulnerableTicks: reader.u32(0, 65535),
    reboardCooldownTicks: reader.u32(0, 65535),
    vehicleSpecialTicks: reader.u32(0, 65535),
    vehicleId: reader.u32() || null,
    weapon: readWeapon(reader),
    grenadeStock: reader.u32(0, 65535),
    grenadeCooldownTicks: reader.u32(0, 65535),
    meleeCooldownTicks: reader.u32(0, 65535),
    geometryRevision: reader.u32(1),
    health: reader.u32(0, 65535),
    lives: reader.u32(0, 65535),
    lastRallyMission: reader.u32(0, 65535),
    processedEdgeIds: [reader.u32(), reader.u32(), reader.u32(), reader.u32(), reader.u32()],
  };
}
export function writeVehicle(writer: Writer, vehicle: VehicleState): void {
  writeBody(writer, vehicle.body);
  writer.u32(vehicle.definitionId, 1, 65535);
  writer.choice(VEHICLES, vehicle.kind);
  writer.choice(LIFECYCLE, vehicle.lifecycle);
  writer.optionalId(vehicle.occupantId);
  writer.optionalId(vehicle.reservedBy);
  writer.u32(vehicle.controlEpoch, 1);
  writer.u32(vehicle.armor, 0, 65535);
  writeAction(writer, vehicle.action);
  writeWeapon(writer, vehicle.weapon);
  writer.u32(vehicle.components.length, 0, 8);
  for (const component of vehicle.components) {
    writer.u32(component.id, 1);
    writer.u32(component.health, 0, 65535);
    writer.bool(component.broken);
  }
  writer.zero((8 - vehicle.components.length) * 12);
  writer.optionalId(vehicle.ownerControlEpoch);
  writer.i32(vehicle.facing, 1);
  writer.u32(vehicle.heading, 0, 7);
  writer.u32(vehicle.invulnerableTicks, 0, 65535);
  writer.u32(vehicle.secondary.ammo, 0, 65535);
  writer.u32(vehicle.secondary.shotsFired, 0, 65535);
  writer.u32(vehicle.secondary.cooldownTicks, 0, 65535);
  writer.u32(vehicle.secondary.shotOrdinal);
  writer.u32(vehicle.secondary.lastActionInstanceId);
  writeAction(writer, vehicle.secondary.action);
}
export function readVehicle(reader: Reader): VehicleState {
  const vehicle: Omit<VehicleState, "secondary"> = {
    body: readBody(reader),
    definitionId: reader.u32(1, 65535),
    kind: reader.choice(VEHICLES),
    lifecycle: reader.choice(LIFECYCLE),
    occupantId: reader.u32() || null,
    reservedBy: reader.u32() || null,
    controlEpoch: reader.u32(1),
    ownerControlEpoch: null,
    facing: 1,
    heading: 0,
    invulnerableTicks: 0,
    armor: reader.u32(0, 65535),
    action: readAction(reader),
    weapon: readWeapon(reader),
    components: [],
  };
  const count = reader.u32(0, 8);
  for (let index = 0; index < count; index++)
    vehicle.components.push({
      id: reader.u32(1),
      health: reader.u32(0, 65535),
      broken: reader.bool(),
    });
  reader.zero((8 - count) * 12);
  vehicle.ownerControlEpoch = reader.u32() || null;
  vehicle.facing = reader.i32(1) as -1 | 1;
  vehicle.heading = reader.u32(0, 7);
  vehicle.invulnerableTicks = reader.u32(0, 65535);
  const secondary = {
    ammo: reader.u32(0, 65535),
    shotsFired: reader.u32(0, 65535),
    cooldownTicks: reader.u32(0, 65535),
    shotOrdinal: reader.u32(),
    lastActionInstanceId: reader.u32(),
    action: readAction(reader),
  };
  return { ...vehicle, secondary };
}
