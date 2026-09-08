import type { ActionCatalog } from "../combat/timeline.js";
import { actionPose, stepAction } from "../combat/timeline.js";
import type { ActorDefinition, ShapeDefinition, VehicleDefinition } from "../content/schema.js";
import { stepFootController } from "../controller/foot.js";
import { canonical } from "../core/canonical.js";
import {
  COUNTER_LIMIT,
  MAX_MOTION,
  integer,
  motion,
  nextCounter,
  pixels,
  position,
} from "../core/numeric.js";
import { Held } from "../input/types.js";
import { blockingShapes, startSupport, worldRect, worldSocket } from "../physics/body.js";
import { type CollisionFrame, CollisionGrid, CollisionIndex } from "../physics/grid.js";
import { earliestSweep, sweepAabb, sweepBounds } from "../physics/sweep.js";
import { ARCADE } from "../rules.js";
import type {
  ActionState,
  Body,
  ControlledActor,
  FootActor,
  Point,
  VehicleState,
} from "../state.js";

export interface TankProfile {
  definition: VehicleDefinition;
  locomotion: ActorDefinition;
  exitTimelineId: number;
  fireTimelineIds: readonly number[];
  attackId: number;
  fireCadenceTicks: number;
  turnTicks: number;
  damageProtectionTicks: number;
  reboardTicks: number;
  exitProtectionTicks: number;
  disconnectGraceTicks: number;
  fallBoundary: number;
  hardpoint: Point;
  headings: ReadonlyArray<{ muzzle: Point; velocity: Point }>;
  cannon: TankCannonProfile;
}
export interface TankCannonProfile {
  attackId: number;
  bodyShapeId: number;
  stock: number;
  cadenceTicks: number;
  blastRadius: number;
  fireTimelineIds: readonly number[];
  releaseTick: number;
  recoil: readonly number[];
  hardpoint: Point;
  headings: ReadonlyArray<{ muzzle: Point; velocity: Point }>;
}
export interface TankState extends VehicleState {
  jumpBufferTicks: number;
  coyoteTicks: number;
  turnTicks: number;
  disconnectedTicks: number;
  lastGunOwnerId: number | null;
  lastGunControlEpoch: number | null;
  lastCannonOwnerId: number | null;
  lastCannonControlEpoch: number | null;
}
export interface TankIntent {
  held: number;
  jumpPressed: boolean;
}
export const tankOwner = (tank: TankState) => tank.occupantId ?? tank.reservedBy;
export const idleTankAction = (tick: number): ActionState => ({
  kind: "ready",
  actionInstanceId: 0,
  stateStartTick: tick,
  definitionId: 0,
  nextMarkerIndex: 0,
});
const zero = { x: 0, y: 0 };
export function createTank(
  id: number,
  point: Point,
  supportId: number | null,
  profile: TankProfile,
): TankState {
  return {
    body: {
      id,
      ...point,
      vx: 0,
      vy: 0,
      remainderX: 0,
      remainderY: 0,
      shapeId: profile.locomotion.standingShapeId,
      supportId,
      grounded: supportId !== null,
      contacts: [],
    },
    definitionId: profile.definition.id,
    kind: "tank",
    lifecycle: "available",
    occupantId: null,
    reservedBy: null,
    controlEpoch: 1,
    ownerControlEpoch: null,
    facing: 1,
    heading: 0,
    invulnerableTicks: 0,
    armor: profile.definition.armor,
    action: idleTankAction(0),
    components: [],
    weapon: {
      id: profile.definition.weaponId,
      ammo: 0,
      cooldownTicks: 0,
      shotOrdinal: 0,
      lastActionInstanceId: 0,
    },
    secondary: {
      ammo: profile.cannon.stock,
      shotsFired: 0,
      cooldownTicks: 0,
      shotOrdinal: 0,
      lastActionInstanceId: 0,
      action: idleTankAction(0),
    },
    jumpBufferTicks: 0,
    coyoteTicks: 0,
    turnTicks: 0,
    disconnectedTicks: 0,
    lastGunOwnerId: null,
    lastGunControlEpoch: null,
    lastCannonOwnerId: null,
    lastCannonControlEpoch: null,
  };
}
export function attachTankDriver(tank: TankState, actor: ControlledActor, profile: TankProfile) {
  if (tankOwner(tank) !== actor.playerId) throw new Error("Tank attachment owner mismatch");
  const point = worldSocket(tank.body, profile.definition.seat.socket, tank.facing);
  actor.body = {
    ...actor.body,
    ...point,
    vx: tank.body.vx,
    vy: tank.body.vy,
    remainderX: 0,
    remainderY: 0,
    grounded: false,
    supportId: null,
    contacts: [],
  };
  actor.vehicleId = tank.body.id;
  actor.locomotion = "seated";
  actor.facing = tank.facing;
  actor.jumpBufferTicks = actor.coyoteTicks = actor.ignoredSupportTicks = 0;
  actor.ignoredSupportId = null;
}

/** The shared grounded solver owns support, moving-platform carry, ceilings and swept motion. */
export function moveTank(
  current: TankState,
  intent: TankIntent,
  profile: TankProfile,
  shapes: ReadonlyMap<number, ShapeDefinition>,
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  const tank = structuredClone(current);
  if (tank.lifecycle === "wreck" || tank.lifecycle === "destroying")
    return { tank, jumpAccepted: false, fault: null };
  tank.invulnerableTicks = Math.max(0, tank.invulnerableTicks - 1);
  tank.weapon.cooldownTicks = Math.max(0, tank.weapon.cooldownTicks - 1);
  tank.secondary.cooldownTicks = Math.max(0, tank.secondary.cooldownTicks - 1);
  tank.turnTicks = Math.max(0, tank.turnTicks - 1);
  const driving = tank.lifecycle === "occupied";
  const actor: FootActor = {
    body: tank.body,
    life: "alive",
    locomotion: tank.body.grounded ? "grounded" : "airborne",
    action: idleTankAction(frame.tick),
    facing: tank.facing,
    aim: 0,
    jumpBufferTicks: tank.jumpBufferTicks,
    coyoteTicks: tank.coyoteTicks,
    ignoredSupportId: null,
    ignoredSupportTicks: 0,
    vehicleId: null,
    geometryRevision: frame.geometryRevision,
  };
  const result = stepFootController(
    actor,
    {
      held: driving ? intent.held & (Held.Left | Held.Right) : 0,
      jumpPressed: driving && intent.jumpPressed,
    },
    profile.locomotion,
    shapes,
    index,
    frame,
  );
  if (result.status === "failed") return { tank, jumpAccepted: false, fault: result.physics };
  tank.body = result.actor.body;
  tank.facing = result.actor.facing;
  tank.jumpBufferTicks = result.actor.jumpBufferTicks;
  tank.coyoteTicks = result.actor.coyoteTicks;
  if (driving && tank.turnTicks === 0) {
    const x = Number(Boolean(intent.held & Held.Right)) - Number(Boolean(intent.held & Held.Left));
    const y = Number(Boolean(intent.held & Held.Down)) - Number(Boolean(intent.held & Held.Up));
    const target =
      y < 0
        ? x > 0
          ? 1
          : x < 0
            ? 3
            : 2
        : y > 0
          ? x > 0
            ? 7
            : x < 0
              ? 5
              : 6
          : x < 0
            ? 4
            : x > 0
              ? 0
              : tank.heading;
    if (target !== tank.heading) {
      const clockwise = (target - tank.heading + 8) % 8;
      tank.heading = (tank.heading + (clockwise <= 4 ? 1 : 7)) % 8;
      tank.turnTicks = profile.turnTicks;
    }
  }
  return {
    tank,
    jumpAccepted:
      result.status === "complete" && ["consumed", "buffered"].includes(result.jumpRequest),
    fault: null,
  };
}

function clearPath(
  actor: ControlledActor,
  point: Point,
  shape: ShapeDefinition,
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  if (blockingShapes(point, shape.rect, actor.facing, index, frame, "end").length) return false;
  const start = worldRect(actor.body, shape.rect, actor.facing),
    delta = { x: point.x - actor.body.x, y: point.y - actor.body.y };
  const terrain = index
    .query(sweepBounds(start, delta))
    .filter((target) => target.kind === "solid")
    .map((target) => ({
      ...target,
      rect: {
        ...target.rect,
        x: target.rect.x + target.delta.x,
        y: target.rect.y + target.delta.y,
      },
      delta: zero,
    }));
  const result = earliestSweep(start, delta, terrain);
  return (
    result.overlaps.length === 0 &&
    result.contacts.every((contact) => contact.time.numerator === contact.time.denominator)
  );
}
/** Declared side/opposite/upper candidates, full-collider path and final terrain clearance. */
export function tankExitBody(
  tank: TankState,
  actor: ControlledActor,
  profile: TankProfile,
  shape: ShapeDefinition,
  index: CollisionIndex,
  frame: CollisionFrame,
): Body | null {
  const candidates = profile.definition.seat.ejectionCandidates;
  for (const [candidateIndex, offset] of candidates.entries()) {
    const point = worldSocket(tank.body, offset, tank.facing);
    if (point.y > profile.fallBoundary || !clearPath(actor, point, shape, index, frame)) continue;
    const body: Body = {
      ...actor.body,
      ...point,
      shapeId: shape.id,
      vx: 0,
      vy: 0,
      remainderX: 0,
      remainderY: 0,
      supportId: null,
      grounded: false,
      contacts: [],
    };
    const bounds = sweepBounds(worldRect(body, shape.rect, actor.facing));
    const endTerrain = index
      .query({
        minX: bounds.minX - 1,
        minY: bounds.minY - 1,
        maxX: bounds.maxX + 1,
        maxY: bounds.maxY + 1,
      })
      .map((target) => ({
        ...target,
        rect: {
          ...target.rect,
          x: target.rect.x + target.delta.x,
          y: target.rect.y + target.delta.y,
        },
        delta: zero,
      }));
    const endIndex = new CollisionIndex(new CollisionGrid(endTerrain), [], frame);
    const supportId = startSupport(body, shape, actor.facing, endIndex, frame, null);
    // Side landing pads need support. The final authored upper candidate is an airborne ejection.
    if (candidateIndex < candidates.length - 1 && supportId === null) continue;
    body.supportId = supportId;
    body.grounded = supportId !== null;
    return body;
  }
  return null;
}

/** Called only on the staged world. No state changes occur on a rejected reservation. */
export function reserveTank(
  tank: TankState,
  actor: ControlledActor,
  tick: number,
  actionId: number,
  profile: TankProfile,
  shapes: ReadonlyMap<number, ShapeDefinition>,
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  if (
    actor.life !== "alive" ||
    actor.vehicleId !== null ||
    actor.reboardCooldownTicks > 0 ||
    !["ready", "fire"].includes(actor.action.kind) ||
    !actor.body.grounded ||
    tank.lifecycle !== "available" ||
    tank.armor === 0 ||
    !tank.body.grounded ||
    Math.abs(tank.body.vx) > pixels(1)
  )
    return false;
  const sensor = shapes.get(profile.definition.seat.boardingSensorShapeId),
    shape = shapes.get(actor.body.shapeId);
  if (!sensor || !shape) throw new Error("Missing tank boarding geometry");
  if (
    sweepAabb(
      worldRect(actor.body, shape.rect, actor.facing),
      zero,
      worldRect(tank.body, sensor.rect, tank.facing),
    )?.kind !== "overlap"
  )
    return false;
  const seat = worldSocket(tank.body, profile.definition.seat.socket, tank.facing);
  if (!clearPath(actor, seat, shape, index, frame)) return false;
  tank.lifecycle = "boarding";
  tank.reservedBy = actor.playerId;
  tank.controlEpoch = nextCounter(tank.controlEpoch);
  tank.ownerControlEpoch = actor.controlEpoch;
  tank.action = {
    kind: "enter",
    actionInstanceId: actionId,
    stateStartTick: tick,
    definitionId: profile.definition.seat.boardingTimelineId,
    nextMarkerIndex: 0,
  };
  actor.action = { ...tank.action };
  attachTankDriver(tank, actor, profile);
  return true;
}
export function requestTankExit(
  tank: TankState,
  actor: ControlledActor,
  tick: number,
  actionId: number,
  profile: TankProfile,
  shape: ShapeDefinition,
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  if (
    tank.lifecycle !== "occupied" ||
    tank.occupantId !== actor.playerId ||
    !tankExitBody(tank, actor, profile, shape, index, frame)
  )
    return false;
  tank.lifecycle = "exiting";
  tank.secondary.action = idleTankAction(tick);
  tank.action = {
    kind: "exit",
    actionInstanceId: actionId,
    stateStartTick: tick,
    definitionId: profile.exitTimelineId,
    nextMarkerIndex: 0,
  };
  actor.action = { ...tank.action };
  return true;
}
/** Always settles both entities; caller applies ordinary death if an emergency has no safe body. */
export function releaseTank(
  tank: TankState,
  actor: ControlledActor,
  tick: number,
  profile: TankProfile,
  shape: ShapeDefinition,
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  if (tankOwner(tank) !== actor.playerId) throw new Error("Tank release owner mismatch");
  const body = tankExitBody(tank, actor, profile, shape, index, frame);
  tank.occupantId = tank.reservedBy = null;
  tank.ownerControlEpoch = null;
  tank.controlEpoch = nextCounter(tank.controlEpoch);
  tank.lifecycle = tank.armor > 0 ? "available" : "wreck";
  tank.action = idleTankAction(tick);
  tank.secondary.action = idleTankAction(tick);
  tank.jumpBufferTicks = tank.coyoteTicks = tank.disconnectedTicks = 0;
  actor.vehicleId = null;
  actor.body = body ?? {
    ...actor.body,
    vx: 0,
    vy: 0,
    supportId: null,
    grounded: false,
    contacts: [],
  };
  actor.locomotion = actor.body.grounded ? "grounded" : "airborne";
  actor.action = idleTankAction(tick);
  actor.reboardCooldownTicks = profile.reboardTicks;
  actor.invulnerableTicks = Math.max(actor.invulnerableTicks, profile.exitProtectionTicks);
  return body !== null;
}

export function stepTankTransfer(
  tank: TankState,
  actor: ControlledActor,
  tick: number,
  profile: TankProfile,
  catalog: ActionCatalog,
  shape: ShapeDefinition,
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  if (tank.lifecycle !== "boarding" && tank.lifecycle !== "exiting") return null;
  const step = stepAction(tank.action, tick, catalog);
  tank.action = step.action;
  actor.action = { ...step.action };
  if (!step.markers.some(({ marker }) => marker.kind === "seat-transfer")) return null;
  if (tank.lifecycle === "boarding") {
    tank.occupantId = tank.reservedBy;
    tank.reservedBy = null;
    tank.lifecycle = "occupied";
    tank.action = actor.action = idleTankAction(tick);
    return "board" as const;
  }
  if (!tankExitBody(tank, actor, profile, shape, index, frame)) {
    tank.lifecycle = "occupied";
    tank.action = actor.action = idleTankAction(tick);
    return "exit-blocked" as const;
  }
  releaseTank(tank, actor, tick, profile, shape, index, frame);
  return "exit" as const;
}

/** The hull's infinite primary feed has its own cadence and action cursor. */
export function stepTankGun(
  tank: TankState,
  intent: { held: number; firePressed: boolean },
  tick: number,
  nextActionId: number,
  profile: TankProfile,
  catalog: ActionCatalog,
) {
  const requested = intent.firePressed || Boolean(intent.held & Held.Fire);
  let outcome: "none" | "applied" | "cooldown" | "unavailable" = "none";
  const markers: ReturnType<typeof stepAction>["markers"] = [];
  if (tank.lifecycle !== "occupied" || tank.occupantId === null)
    return { outcome: requested ? ("unavailable" as const) : outcome, nextActionId, markers };
  if (tank.action.kind === "fire") {
    const step = stepAction(tank.action, tick, catalog);
    tank.action = step.finished ? idleTankAction(tick) : step.action;
    markers.push(...step.markers);
  }
  if (requested) {
    if (tank.action.kind !== "ready" || tank.weapon.cooldownTicks > 0) outcome = "cooldown";
    else {
      integer(
        nextActionId,
        Math.max(tank.weapon.lastActionInstanceId, tank.secondary.lastActionInstanceId) + 1,
        COUNTER_LIMIT - 2,
        "tank gun allocation",
      );
      const definitionId = profile.fireTimelineIds[tank.heading];
      if (definitionId === undefined) throw new Error("Missing tank gun heading");
      tank.action = {
        kind: "fire",
        actionInstanceId: nextActionId,
        stateStartTick: tick,
        definitionId,
        nextMarkerIndex: 0,
      };
      tank.weapon.cooldownTicks = profile.fireCadenceTicks;
      tank.weapon.shotOrdinal = nextCounter(
        Math.max(tank.weapon.shotOrdinal, tank.secondary.shotOrdinal),
      );
      tank.weapon.lastActionInstanceId = nextActionId;
      tank.lastGunOwnerId = tank.occupantId;
      tank.lastGunControlEpoch = tank.ownerControlEpoch;
      nextActionId = nextCounter(nextActionId);
      const step = stepAction(tank.action, tick, catalog);
      tank.action = step.action;
      markers.push(...step.markers);
      outcome = "applied";
    }
  }
  return { outcome, nextActionId, markers };
}

/** Independent finite cannon: one grenade edge pays one shell, even if release is canceled. */
export function stepTankCannon(
  tank: TankState,
  requested: boolean,
  tick: number,
  nextActionId: number,
  profile: TankProfile,
  catalog: ActionCatalog,
) {
  const cannon = tank.secondary;
  const markers: ReturnType<typeof stepAction>["markers"] = [];
  let outcome: "none" | "applied" | "cooldown" | "unavailable" = "none";
  if (tank.lifecycle !== "occupied" || tank.occupantId === null) {
    cannon.action = idleTankAction(tick);
    return { outcome: requested ? ("unavailable" as const) : outcome, nextActionId, markers };
  }
  if (cannon.action.kind === "fire") {
    const step = stepAction(cannon.action, tick, catalog);
    cannon.action = step.finished ? idleTankAction(tick) : step.action;
    markers.push(...step.markers);
  }
  if (requested) {
    if (cannon.ammo === 0) outcome = "unavailable";
    else if (cannon.action.kind !== "ready" || cannon.cooldownTicks > 0) outcome = "cooldown";
    else {
      integer(
        nextActionId,
        Math.max(tank.weapon.lastActionInstanceId, cannon.lastActionInstanceId) + 1,
        COUNTER_LIMIT - 2,
        "cannon allocation",
      );
      const definitionId = profile.cannon.fireTimelineIds[tank.heading];
      if (definitionId === undefined) throw new Error("Missing cannon heading");
      cannon.action = {
        kind: "fire",
        actionInstanceId: nextActionId,
        stateStartTick: tick,
        definitionId,
        nextMarkerIndex: 0,
      };
      cannon.ammo--;
      cannon.shotsFired++;
      cannon.cooldownTicks = profile.cannon.cadenceTicks;
      cannon.shotOrdinal = nextCounter(Math.max(tank.weapon.shotOrdinal, cannon.shotOrdinal));
      cannon.lastActionInstanceId = nextActionId;
      tank.lastCannonOwnerId = tank.occupantId;
      tank.lastCannonControlEpoch = tank.ownerControlEpoch;
      nextActionId = nextCounter(nextActionId);
      const step = stepAction(cannon.action, tick, catalog);
      cannon.action = step.action;
      markers.push(...step.markers);
      outcome = "applied";
    }
  }
  return { outcome, nextActionId, markers };
}

export function publicTankState(tank: TankState): VehicleState {
  return structuredClone({
    body: tank.body,
    definitionId: tank.definitionId,
    kind: tank.kind,
    lifecycle: tank.lifecycle,
    occupantId: tank.occupantId,
    reservedBy: tank.reservedBy,
    controlEpoch: tank.controlEpoch,
    ownerControlEpoch: tank.ownerControlEpoch,
    facing: tank.facing,
    heading: tank.heading,
    invulnerableTicks: tank.invulnerableTicks,
    armor: tank.armor,
    action: tank.action,
    components: tank.components,
    weapon: tank.weapon,
    secondary: tank.secondary,
  });
}

export function validateTankState(
  tank: TankState,
  tick: number,
  players: readonly ControlledActor[],
  profile: TankProfile,
  catalog: ActionCatalog,
) {
  const check = (ok: unknown, message: string) => {
    if (!ok) throw new Error(`Tank state: ${message}`);
  };
  check(
    tank.kind === "tank" &&
      tank.definitionId === profile.definition.id &&
      tank.body.shapeId === profile.locomotion.standingShapeId &&
      tank.components.length === 0,
    "definition",
  );
  integer(tank.armor, 0, profile.definition.armor, "tank armor");
  check((tank.armor === 0) === (tank.lifecycle === "wreck"), "wreck armor");
  integer(tank.heading, 0, 7, "tank heading");
  check(tank.facing === -1 || tank.facing === 1, "facing");
  integer(tank.invulnerableTicks, 0, profile.damageProtectionTicks, "tank protection");
  integer(tank.turnTicks, 0, profile.turnTicks, "tank turn timer");
  integer(tank.jumpBufferTicks, 0, ARCADE.jumpBufferTicks, "tank jump buffer");
  integer(tank.coyoteTicks, 0, ARCADE.coyoteTicks, "tank coyote timer");
  integer(tank.disconnectedTicks, 0, profile.disconnectGraceTicks - 1, "tank disconnect grace");
  check(tank.weapon.id === profile.definition.weaponId && tank.weapon.ammo === 0, "primary feed");
  integer(tank.weapon.cooldownTicks, 0, profile.fireCadenceTicks, "tank gun cadence");
  const secondary = tank.secondary;
  integer(secondary.ammo, 0, profile.cannon.stock, "cannon ammo");
  integer(secondary.shotsFired, 0, profile.cannon.stock, "cannon expenditure");
  integer(secondary.shotOrdinal, 0, COUNTER_LIMIT - 1, "cannon ordinal");
  integer(secondary.cooldownTicks, 0, profile.cannon.cadenceTicks, "cannon cadence");
  integer(secondary.action.stateStartTick, 0, tick, "cannon action start");
  check(
    secondary.ammo + secondary.shotsFired === profile.cannon.stock,
    "cannon stock conservation",
  );
  check((secondary.shotsFired === 0) === (secondary.shotOrdinal === 0), "cannon spent ordinal");
  check(
    secondary.shotOrdinal === 0 || secondary.shotOrdinal !== tank.weapon.shotOrdinal,
    "hardpoint ordinal reuse",
  );
  check(
    secondary.lastActionInstanceId === 0 ||
      secondary.lastActionInstanceId !== tank.weapon.lastActionInstanceId,
    "hardpoint action reuse",
  );
  const cannonOwner = players.find((player) => player.playerId === tank.lastCannonOwnerId);
  check(
    secondary.shotOrdinal === 0
      ? secondary.lastActionInstanceId === 0 &&
          tank.lastCannonOwnerId === null &&
          tank.lastCannonControlEpoch === null
      : cannonOwner &&
          secondary.lastActionInstanceId > 0 &&
          tank.lastCannonControlEpoch !== null &&
          tank.lastCannonControlEpoch > 0 &&
          tank.lastCannonControlEpoch <= cannonOwner.controlEpoch,
    "last cannon owner",
  );
  const gunOwner = players.find((player) => player.playerId === tank.lastGunOwnerId);
  check(
    tank.weapon.shotOrdinal === 0
      ? tank.weapon.lastActionInstanceId === 0 &&
          tank.lastGunOwnerId === null &&
          tank.lastGunControlEpoch === null
      : gunOwner &&
          tank.lastGunControlEpoch !== null &&
          tank.lastGunControlEpoch > 0 &&
          tank.lastGunControlEpoch <= gunOwner.controlEpoch &&
          tank.weapon.lastActionInstanceId > 0,
    "last gun owner",
  );
  const ownerId = tankOwner(tank),
    owner = players.find((player) => player.playerId === ownerId);
  check(
    ownerId === null
      ? tank.ownerControlEpoch === null && tank.disconnectedTicks === 0
      : owner?.life === "alive" &&
          owner.vehicleId === tank.body.id &&
          owner.controlEpoch === tank.ownerControlEpoch,
    "seat owner",
  );
  if (owner) {
    const seat = worldSocket(tank.body, profile.definition.seat.socket, tank.facing);
    check(
      owner.body.x === seat.x &&
        owner.body.y === seat.y &&
        owner.body.vx === tank.body.vx &&
        owner.body.vy === tank.body.vy &&
        !owner.body.grounded &&
        owner.body.supportId === null,
      "seat attachment",
    );
  }
  if (secondary.action.kind === "ready") {
    check(
      secondary.action.actionInstanceId === 0 &&
        secondary.action.definitionId === 0 &&
        secondary.action.nextMarkerIndex === 0,
      "idle cannon action",
    );
  } else {
    const timeline = catalog.timelines.get(secondary.action.definitionId),
      age = tick - secondary.action.stateStartTick;
    check(
      tank.lifecycle === "occupied" &&
        secondary.action.kind === "fire" &&
        profile.cannon.fireTimelineIds.includes(secondary.action.definitionId) &&
        secondary.action.actionInstanceId === secondary.lastActionInstanceId &&
        tank.lastCannonOwnerId === ownerId &&
        tank.lastCannonControlEpoch === tank.ownerControlEpoch,
      "cannon action owner",
    );
    check(
      timeline &&
        age >= 0 &&
        age < timeline.durationTicks &&
        secondary.action.nextMarkerIndex ===
          timeline.markers.filter((marker) => marker.tickOffset <= age).length &&
        secondary.cooldownTicks === profile.cannon.cadenceTicks - age,
      "cannon action cursor",
    );
  }
  if (tank.action.kind === "ready") {
    check(
      ["available", "occupied", "wreck"].includes(tank.lifecycle) &&
        tank.action.actionInstanceId === 0 &&
        tank.action.definitionId === 0 &&
        tank.action.nextMarkerIndex === 0,
      "idle action",
    );
  } else {
    const timeline = catalog.timelines.get(tank.action.definitionId),
      age = tick - tank.action.stateStartTick;
    check(
      timeline &&
        age >= 0 &&
        age < timeline.durationTicks &&
        tank.action.nextMarkerIndex ===
          timeline.markers.filter((marker) => marker.tickOffset <= age).length,
      "action cursor",
    );
    if (tank.lifecycle === "boarding" || tank.lifecycle === "exiting") {
      check(
        tank.action.kind === (tank.lifecycle === "boarding" ? "enter" : "exit") &&
          tank.action.definitionId ===
            (tank.lifecycle === "boarding"
              ? profile.definition.seat.boardingTimelineId
              : profile.exitTimelineId) &&
          owner &&
          canonical(owner.action) === canonical(tank.action),
        "transfer action",
      );
    } else {
      check(
        tank.lifecycle === "occupied" &&
          tank.action.kind === "fire" &&
          profile.fireTimelineIds.includes(tank.action.definitionId) &&
          tank.action.actionInstanceId === tank.weapon.lastActionInstanceId &&
          tank.lastGunOwnerId === ownerId,
        "gun action",
      );
    }
  }
}

export function validateTankProfile(
  profile: TankProfile,
  shapes: ReadonlyMap<number, ShapeDefinition>,
  catalog: ActionCatalog,
) {
  if (
    profile.definition.kind !== "tank" ||
    profile.definition.actorId !== profile.locomotion.id ||
    profile.locomotion.standingShapeId !== profile.locomotion.crouchedShapeId
  )
    throw new Error("Invalid tank controller definition");
  integer(profile.headings.length, 8, 8, "tank headings");
  integer(profile.fireTimelineIds.length, 8, 8, "tank fire poses");
  for (const id of [
    profile.definition.seat.boardingSensorShapeId,
    profile.locomotion.standingShapeId,
  ])
    if (!shapes.has(id)) throw new Error("Missing tank shape");
  for (const id of [
    profile.definition.seat.boardingTimelineId,
    profile.exitTimelineId,
    ...profile.fireTimelineIds,
  ])
    if (!catalog.timelines.has(id)) throw new Error("Missing tank timeline");
  for (const ticks of [
    profile.fireCadenceTicks,
    profile.turnTicks,
    profile.damageProtectionTicks,
    profile.reboardTicks,
    profile.exitProtectionTicks,
    profile.disconnectGraceTicks,
  ])
    integer(ticks, 1, 120, "tank timing");
  const cannon = profile.cannon;
  integer(cannon.stock, 1, 65535, "cannon stock");
  integer(cannon.recoil.length, 1, 120, "cannon action duration");
  integer(cannon.cadenceTicks, cannon.recoil.length, 120, "cannon cadence");
  integer(cannon.releaseTick, 0, cannon.recoil.length - 1, "cannon release tick");
  integer(cannon.blastRadius, 1, 2 ** 16, "cannon blast radius");
  integer(cannon.headings.length, 8, 8, "cannon headings");
  integer(cannon.fireTimelineIds.length, 8, 8, "cannon fire poses");
  if (
    !shapes.has(cannon.bodyShapeId) ||
    new Set([...profile.fireTimelineIds, ...cannon.fireTimelineIds]).size !== 16
  )
    throw new Error("Invalid cannon content identity");
  position(cannon.hardpoint.x);
  position(cannon.hardpoint.y);
  for (const [age, recoil] of cannon.recoil.entries()) {
    integer(recoil, 0, pixels(16), "cannon recoil");
    if (age <= cannon.releaseTick && recoil !== 0) throw new Error("Cannon recoils before release");
  }
  for (const [index, heading] of cannon.headings.entries()) {
    position(heading.muzzle.x);
    position(heading.muzzle.y);
    motion(heading.velocity.x);
    motion(heading.velocity.y);
    integer(
      Math.abs(heading.velocity.x) + Math.abs(heading.velocity.y),
      1,
      MAX_MOTION,
      "cannon flight speed",
    );
    const id = cannon.fireTimelineIds[index],
      timeline = id === undefined ? undefined : catalog.timelines.get(id);
    if (
      !timeline ||
      timeline.durationTicks !== cannon.recoil.length ||
      timeline.markers.length !== 2 ||
      timeline.markers.some(
        (marker, i) =>
          marker.kind !== (i === 0 ? "spawn-attack" : "sound") ||
          marker.tickOffset !== cannon.releaseTick ||
          marker.payloadId !== cannon.attackId ||
          marker.socket !== "muzzle",
      )
    )
      throw new Error("Invalid cannon release timeline");
    const socket = actionPose(catalog, timeline.id, cannon.releaseTick)?.sockets.find(
      (socket) => socket.name === "muzzle",
    );
    if (!socket || canonical(socket.point) !== canonical(heading.muzzle))
      throw new Error("Cannon release socket mismatch");
  }
}
