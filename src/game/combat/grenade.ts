import type { ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, divide, integer, motion } from "../core/numeric.js";
import { stepBody } from "../physics/body.js";
import type { CollisionFrame, CollisionIndex } from "../physics/grid.js";
import type { Body } from "../state.js";
import type { AttackSource } from "./volume.js";

export interface GrenadeProfile {
  bodyShapeId: number;
  fuseTicks: number;
  gravity: number;
  terminalVelocity: number;
  maximumBounces: number;
  radius: number;
  standingVelocity: { x: number; y: number };
  crouchedVelocity: { x: number; y: number };
}
export interface Grenade extends AttackSource {
  body: Body;
  spawnTick: number;
  bounces: number;
}

/** A conservative terrain step; rebound velocity applies on the following tick. */
export function stepGrenade(
  current: Grenade,
  profile: GrenadeProfile,
  shape: ShapeDefinition,
  index: CollisionIndex,
  frame: CollisionFrame,
) {
  integer(current.spawnTick, 1, frame.tick, "grenade birth");
  integer(current.id, 1, COUNTER_LIMIT - 1, "grenade ID");
  integer(current.bounces, 0, profile.maximumBounces, "grenade bounce count");
  if (shape.id !== profile.bodyShapeId || current.body.id !== current.id)
    throw new Error("Grenade body identity");
  const grenade = structuredClone(current);
  if (frame.tick === current.spawnTick) return { grenade, detonated: false };
  const vx = grenade.body.vx,
    vy = motion(Math.min(profile.terminalVelocity, grenade.body.vy + profile.gravity));
  grenade.body.vy = vy;
  const result = stepBody(grenade.body, shape, 1, index, { frame });
  if (result.status !== "complete") throw new Error(`Grenade terrain: ${result.reason}`);
  grenade.body = result.body;
  const horizontal = result.movement.contacts.some((contact) => contact.normal.x !== 0);
  const vertical = result.movement.contacts.some((contact) => contact.normal.y !== 0);
  if ((horizontal || vertical) && grenade.bounces < profile.maximumBounces) {
    grenade.bounces++;
    if (horizontal) grenade.body.vx = -divide(vx, 2).quotient;
    if (vertical) {
      grenade.body.vy = -divide(vy, 2).quotient;
      grenade.body.vx = divide(grenade.body.vx * 3, 4).quotient;
    }
    if (grenade.body.vy < 0) {
      grenade.body.grounded = false;
      grenade.body.supportId = null;
    }
  } else if (vertical && grenade.body.grounded)
    grenade.body.vx = divide(grenade.body.vx * 3, 4).quotient;
  return { grenade, detonated: frame.tick - current.spawnTick >= profile.fuseTicks };
}
