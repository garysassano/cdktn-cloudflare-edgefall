import type { ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, divide, integer, motion, position } from "../core/numeric.js";
import { startSupport, stepBody } from "../physics/body.js";
import type { CollisionFrame, CollisionIndex } from "../physics/grid.js";
import type { Body, ControlledActor, Point } from "../state.js";
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
  /** Maximum inherited world velocity per axis, before adding the authored throw impulse. */
  inheritedVelocityLimit: Point;
}
export interface Grenade extends AttackSource {
  body: Body;
  spawnTick: number;
  bounces: number;
}

export function grenadeVelocityBounds(profile: GrenadeProfile) {
  return {
    x:
      Math.max(profile.standingVelocity.x, profile.crouchedVelocity.x) +
      profile.inheritedVelocityLimit.x,
    up:
      Math.max(-profile.standingVelocity.y, -profile.crouchedVelocity.y) +
      profile.inheritedVelocityLimit.y,
  };
}
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

/** Called after accepted locomotion: inherit own velocity and the current support's carry once. */
export function grenadeLaunchVelocity(
  actor: Pick<ControlledActor, "body" | "facing" | "locomotion">,
  profile: GrenadeProfile,
  index: CollisionIndex,
  frame: CollisionFrame,
): Point {
  index.assertFrame(frame);
  const support = actor.body.supportId === null ? undefined : index.get(actor.body.supportId);
  if (actor.body.grounded !== (actor.body.supportId !== null) || (actor.body.grounded && !support))
    throw new Error("Grenade launch requires accepted support");
  if (actor.facing !== 1 && actor.facing !== -1) throw new Error("Grenade launch facing");
  const impulse =
    actor.locomotion === "crouched" ? profile.crouchedVelocity : profile.standingVelocity;
  return {
    x: motion(
      impulse.x * actor.facing +
        clamp(motion(actor.body.vx) + (support?.delta.x ?? 0), profile.inheritedVelocityLimit.x),
    ),
    y: motion(
      Math.min(
        profile.terminalVelocity,
        impulse.y +
          clamp(motion(actor.body.vy) + (support?.delta.y ?? 0), profile.inheritedVelocityLimit.y),
      ),
    ),
  };
}

export type GrenadeStep =
  | { status: "active"; grenade: Grenade }
  | { status: "detonated"; position: Point }
  | { status: "crushed"; position: Point; colliderIds: number[] };

/** A conservative terrain step; rebound velocity applies on the following tick. */
export function stepGrenade(
  current: Grenade,
  profile: GrenadeProfile,
  shape: ShapeDefinition,
  index: CollisionIndex,
  frame: CollisionFrame,
): GrenadeStep {
  integer(current.spawnTick, 1, frame.tick, "grenade birth");
  integer(current.id, 1, COUNTER_LIMIT - 1, "grenade ID");
  integer(current.bounces, 0, profile.maximumBounces, "grenade bounce count");
  if (shape.id !== profile.bodyShapeId || current.body.id !== current.id)
    throw new Error("Grenade body identity");
  const grenade = structuredClone(current);
  index.assertFrame(frame);
  if (frame.tick === current.spawnTick) return { grenade, status: "active" };
  const vx = grenade.body.vx,
    vy = motion(Math.min(profile.terminalVelocity, grenade.body.vy + profile.gravity));
  grenade.body.vy = vy;
  const supportId =
    vy < 0 || !current.body.grounded
      ? null
      : startSupport(grenade.body, shape, 1, index, frame, null);
  const carry = supportId === null ? undefined : index.get(supportId)?.delta;
  const result = stepBody(grenade.body, shape, 1, index, {
    frame,
    carrySupport: current.body.grounded,
  });
  if (result.status !== "complete") {
    if (result.reason !== "crushed") throw new Error(`Grenade terrain: ${result.reason}`);
    // A proved crush destroys the grenade without a blast or stock refund. This
    // terminal contact point is never returned as an accepted surviving body.
    return {
      status: "crushed",
      position: {
        x: position(result.movement.rect.x - shape.rect.x),
        y: position(result.movement.rect.y - shape.rect.y),
      },
      colliderIds: result.movement.diagnosticIds,
    };
  }
  grenade.body = result.body;
  const horizontal = result.movement.contacts.find((contact) => contact.normal.x !== 0);
  const vertical = result.movement.contacts.find((contact) => contact.normal.y !== 0);
  if ((horizontal || vertical) && grenade.bounces < profile.maximumBounces) {
    grenade.bounces++;
    let reboundX = vx + (carry?.x ?? 0),
      reboundY = vy + (carry?.y ?? 0);
    if (horizontal) {
      const target = index.get(horizontal.otherId);
      if (!target) throw new Error("Missing grenade horizontal contact");
      reboundX = target.delta.x - divide(reboundX - target.delta.x, 2).quotient;
    }
    if (vertical) {
      const target = index.get(vertical.otherId);
      if (!target) throw new Error("Missing grenade vertical contact");
      reboundY = target.delta.y - divide(reboundY - target.delta.y, 2).quotient;
      reboundX = target.delta.x + divide((reboundX - target.delta.x) * 3, 4).quotient;
    }
    const bounds = grenadeVelocityBounds(profile);
    grenade.body.vx = motion(clamp(reboundX, bounds.x));
    grenade.body.vy = motion(Math.max(-bounds.up, Math.min(profile.terminalVelocity, reboundY)));
    // The rebound is a world velocity. Keeping support here would add carry again.
    grenade.body.grounded = false;
    grenade.body.supportId = null;
  } else if (vertical && grenade.body.grounded)
    grenade.body.vx = divide(grenade.body.vx * 3, 4).quotient;
  return frame.tick - current.spawnTick >= profile.fuseTicks
    ? { status: "detonated", position: { x: grenade.body.x, y: grenade.body.y } }
    : { grenade, status: "active" };
}
