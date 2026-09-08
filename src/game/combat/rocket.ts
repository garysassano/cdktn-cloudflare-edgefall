import type { AttackDefinition, ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, MAX_MOTION, divide, integer, motion, position } from "../core/numeric.js";
import { worldRect } from "../physics/body.js";
import { type SweepTarget, sweepAabb, sweepBounds, validateSweepTarget } from "../physics/sweep.js";
import type { Point } from "../state.js";
import {
  type BallisticProjectile,
  type HurtTarget,
  type Impact,
  projectileImpact,
} from "./projectile.js";
import { type AttackSource, explosionHits } from "./volume.js";

/** 32 Q14 unit vectors, clockwise from right; only these authored headings can be selected. */
const QUADRANT = [
  [16384, 0],
  [16069, 3196],
  [15137, 6270],
  [13623, 9102],
  [11585, 11585],
  [9102, 13623],
  [6270, 15137],
  [3196, 16069],
] as const;
const HEADINGS = [0, 1, 2, 3].flatMap((quadrant) =>
  QUADRANT.map(([x, y]) =>
    quadrant === 0 ? [x, y] : quadrant === 1 ? [-y, x] : quadrant === 2 ? [-x, -y] : [y, -x],
  ),
);
export interface RocketProfile {
  bodyShapeId: number;
  launchSpeed: number;
  acceleration: number;
  maximumSpeed: number;
  lifetimeTicks: number;
  blastRadius: number;
  acquireRange: number;
  retainRange: number;
  /** Cone widths and the launch leash use integer heading steps, not free angles. */
  acquireSteps: number;
  retainSteps: number;
  launchLeashSteps: number;
  acquireIntervalTicks: number;
  turnIntervalTicks: number;
}
export interface Rocket extends BallisticProjectile {
  tick: number;
  launchHeading: number;
  heading: number;
  speed: number;
  targetId: number | null;
  nextAcquireTick: number;
  nextTurnTick: number;
}
export type RocketStep =
  | { status: "active"; rocket: Rocket }
  | { status: "detonated"; contact: Impact; impacts: Impact[] }
  | { status: "expired"; position: Point };

const difference = (from: number, to: number) => ((to - from + 48) % 32) - 16;
function velocity(heading: number, speed: number): Point {
  const vector = HEADINGS[integer(heading, 0, 31, "rocket heading")];
  if (!vector || vector[0] === undefined || vector[1] === undefined)
    throw new Error("Missing rocket heading");
  return {
    x: divide(vector[0] * speed, 16384).quotient,
    y: divide(vector[1] * speed, 16384).quotient,
  };
}
function headingTo(delta: Point, fallback: number): number {
  if (delta.x === 0 && delta.y === 0) return fallback;
  let best = 0,
    score = -Infinity;
  for (const [heading, vector] of HEADINGS.entries()) {
    const dot = (vector[0] ?? 0) * delta.x + (vector[1] ?? 0) * delta.y;
    if (dot > score) {
      best = heading;
      score = dot;
    }
  }
  return best;
}

export function validateRocketProfile(profile: RocketProfile) {
  integer(profile.bodyShapeId, 1, COUNTER_LIMIT - 1, "rocket shape");
  integer(profile.launchSpeed, 1, MAX_MOTION, "rocket launch speed");
  integer(profile.maximumSpeed, profile.launchSpeed, MAX_MOTION, "rocket maximum speed");
  integer(profile.acceleration, 1, MAX_MOTION, "rocket acceleration");
  integer(profile.lifetimeTicks, 1, 3600, "rocket lifetime");
  integer(profile.blastRadius, 1, 2 ** 16, "rocket blast radius");
  integer(profile.acquireRange, 1, MAX_MOTION, "rocket acquisition range");
  integer(profile.retainRange, profile.acquireRange, MAX_MOTION, "rocket retention range");
  integer(profile.acquireSteps, 0, 7, "rocket acquisition cone");
  integer(profile.retainSteps, profile.acquireSteps, 7, "rocket retention cone");
  integer(profile.launchLeashSteps, 0, 7, "rocket launch leash");
  integer(profile.acquireIntervalTicks, 1, 60, "rocket acquisition interval");
  integer(profile.turnIntervalTicks, 1, 60, "rocket turn interval");
}

/** Private continuation state includes lock identity and both guidance clocks. */
export function validateRocket(rocket: Rocket, profile: RocketProfile) {
  for (const id of [rocket.id, rocket.ownerId, rocket.actionInstanceId, rocket.definitionId])
    integer(id, 1, COUNTER_LIMIT - 1, "rocket identity");
  integer(rocket.team, 1, 255, "rocket team");
  const tail =
    profile.lifetimeTicks + Math.max(profile.acquireIntervalTicks, profile.turnIntervalTicks);
  integer(rocket.spawnTick, 1, COUNTER_LIMIT - 1 - tail, "rocket birth tick");
  integer(
    rocket.tick,
    rocket.spawnTick,
    rocket.spawnTick + profile.lifetimeTicks - 1,
    "rocket tick",
  );
  integer(rocket.launchHeading, 0, 31, "rocket launch heading");
  integer(rocket.heading, 0, 31, "rocket heading");
  if (Math.abs(difference(rocket.launchHeading, rocket.heading)) > profile.launchLeashSteps)
    throw new Error("Rocket exceeded its launch leash");
  const speed = Math.min(
    profile.maximumSpeed,
    profile.launchSpeed + (rocket.tick - rocket.spawnTick) * profile.acceleration,
  );
  if (rocket.speed !== speed) throw new Error("Rocket speed disagrees with its age");
  const expected = velocity(rocket.heading, speed);
  if (rocket.velocity.x !== expected.x || rocket.velocity.y !== expected.y)
    throw new Error("Rocket velocity disagrees with its heading");
  position(rocket.position.x);
  position(rocket.position.y);
  if (rocket.targetId !== null) {
    integer(rocket.targetId, 1, COUNTER_LIMIT - 1, "rocket target");
    if (rocket.targetId === rocket.ownerId) throw new Error("Rocket cannot lock its owner");
  }
  integer(
    rocket.nextAcquireTick,
    rocket.tick + 1,
    rocket.tick + profile.acquireIntervalTicks,
    "rocket acquisition clock",
  );
  integer(
    rocket.nextTurnTick,
    rocket.tick + 1,
    rocket.tick + profile.turnIntervalTicks,
    "rocket turn clock",
  );
  if (
    (rocket.nextAcquireTick - rocket.spawnTick - 1) % profile.acquireIntervalTicks !== 0 ||
    (rocket.nextTurnTick - rocket.spawnTick) % profile.turnIntervalTicks !== 0
  )
    throw new Error("Rocket guidance clock phase disagrees with its birth");
}

export function createRocket(
  source: AttackSource,
  origin: Point,
  heading: number,
  tick: number,
  profile: RocketProfile,
): Rocket {
  validateRocketProfile(profile);
  const rocket: Rocket = {
    ...source,
    position: { ...origin },
    velocity: velocity(heading, profile.launchSpeed),
    spawnTick: tick,
    tick,
    launchHeading: heading,
    heading,
    speed: profile.launchSpeed,
    targetId: null,
    nextAcquireTick: tick + 1,
    nextTurnTick: tick + profile.turnIntervalTicks,
  };
  validateRocket(rocket, profile);
  return rocket;
}

function validateCandidates(terrain: readonly SweepTarget[], hurtboxes: readonly HurtTarget[]) {
  integer(terrain.length + hurtboxes.length, 0, 4096, "rocket candidates");
  const ids = new Set<number>();
  for (const target of terrain) validateSweepTarget(target);
  for (const target of hurtboxes) {
    integer(target.id, 1, COUNTER_LIMIT - 1, "rocket collision ID");
    integer(target.entityId, 1, COUNTER_LIMIT - 1, "rocket hurt entity");
    integer(target.team, 0, 255, "rocket hurt team");
    if (target.kind !== "body" && target.kind !== "shield")
      throw new Error("Invalid rocket hurt kind");
    if (target.solid !== undefined && typeof target.solid !== "boolean")
      throw new Error("Invalid rocket solid flag");
    sweepBounds(target.rect, target.delta);
    integer(target.rect.w, 1, 2 ** 24, "rocket hurt width");
    integer(target.rect.h, 1, 2 ** 24, "rocket hurt height");
  }
  for (const target of [...terrain, ...hurtboxes]) {
    if (ids.has(target.id)) throw new Error("Duplicate rocket collision ID");
    ids.add(target.id);
  }
}

function guidanceTargets(
  rocket: Rocket,
  profile: RocketProfile,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
  retaining: boolean,
) {
  const range = retaining ? profile.retainRange : profile.acquireRange,
    steps = retaining ? profile.retainSteps : profile.acquireSteps;
  const candidates = hurtboxes
    .flatMap((target) => {
      if (
        target.kind !== "body" ||
        target.solid ||
        target.team === 0 ||
        target.team === rocket.team ||
        target.entityId === rocket.ownerId ||
        (retaining && target.entityId !== rocket.targetId)
      )
        return [];
      const center = {
          x: target.rect.x + divide(target.rect.w, 2).quotient,
          y: target.rect.y + divide(target.rect.h, 2).quotient,
        },
        delta = { x: center.x - rocket.position.x, y: center.y - rocket.position.y },
        distance = delta.x * delta.x + delta.y * delta.y,
        heading = headingTo(delta, rocket.heading);
      if (
        distance > range * range ||
        Math.abs(difference(rocket.heading, heading)) > steps ||
        Math.abs(difference(rocket.launchHeading, heading)) > profile.launchLeashSteps
      )
        return [];
      return [{ target, delta, distance, heading }];
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        a.target.entityId - b.target.entityId ||
        a.target.id - b.target.id,
    );
  const blockers = [
    ...terrain,
    ...hurtboxes.filter(
      (target) =>
        target.solid ||
        (target.kind === "shield" &&
          target.team !== rocket.team &&
          target.entityId !== rocket.ownerId),
    ),
  ];
  for (const candidate of candidates) {
    if (
      !blockers.some((target) =>
        sweepAabb({ ...rocket.position, w: 0, h: 0 }, candidate.delta, target.rect),
      )
    )
      return candidate;
  }
  return null;
}

/** Birth is already painted at its accepted muzzle. First motion occurs on the next tick. */
export function stepRocket(
  current: Rocket,
  tick: number,
  definition: AttackDefinition,
  shape: ShapeDefinition,
  profile: RocketProfile,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
): RocketStep {
  validateRocketProfile(profile);
  validateRocket(current, profile);
  if (tick !== current.tick + 1) throw new Error("Rocket requires consecutive ticks");
  if (
    definition.id !== current.definitionId ||
    definition.kind !== "explosion" ||
    definition.material !== "explosive" ||
    definition.lifetimeTicks !== profile.lifetimeTicks ||
    definition.speed !== profile.launchSpeed ||
    definition.repeatDamageTicks !== 0 ||
    shape.id !== profile.bodyShapeId
  )
    throw new Error("Invalid rocket attack policy");
  integer(definition.damage, 1, 65535, "rocket damage");
  integer(definition.maxTargets, 1, 64, "rocket blast targets");
  worldRect(current.position, shape.rect, 1);
  const extentX = Math.max(Math.abs(shape.rect.x), Math.abs(shape.rect.x + shape.rect.w)),
    extentY = Math.max(Math.abs(shape.rect.y), Math.abs(shape.rect.y + shape.rect.h));
  if (extentX * extentX + extentY * extentY > profile.blastRadius * profile.blastRadius)
    throw new Error("Rocket blast must enclose its flight body");
  validateCandidates(terrain, hurtboxes);
  const rocket = structuredClone(current);
  let lock =
    rocket.targetId === null ? null : guidanceTargets(rocket, profile, terrain, hurtboxes, true);
  if (!lock) rocket.targetId = null;
  if (tick >= rocket.nextAcquireTick) {
    if (!lock) lock = guidanceTargets(rocket, profile, terrain, hurtboxes, false);
    rocket.nextAcquireTick = tick + profile.acquireIntervalTicks;
  }
  rocket.targetId = lock?.target.entityId ?? null;
  if (tick >= rocket.nextTurnTick) {
    if (lock)
      rocket.heading =
        (rocket.heading + Math.sign(difference(rocket.heading, lock.heading)) + 32) % 32;
    rocket.nextTurnTick = tick + profile.turnIntervalTicks;
  }
  rocket.speed = Math.min(profile.maximumSpeed, rocket.speed + profile.acceleration);
  rocket.velocity = velocity(rocket.heading, rocket.speed);
  const contact = projectileImpact(rocket, shape, 0, terrain, hurtboxes);
  if (contact)
    return {
      status: "detonated",
      contact,
      // Contact selects the blast origin/time; it never grants a second direct-hit debit.
      impacts: explosionHits(
        rocket,
        definition,
        contact.position,
        profile.blastRadius,
        terrain,
        hurtboxes,
        { time: contact.time, primaryTarget: contact.entityId },
      ),
    };
  rocket.position = {
    x: position(rocket.position.x + motion(rocket.velocity.x)),
    y: position(rocket.position.y + motion(rocket.velocity.y)),
  };
  rocket.tick = tick;
  return tick - rocket.spawnTick >= profile.lifetimeTicks
    ? { status: "expired", position: rocket.position }
    : { status: "active", rocket };
}
