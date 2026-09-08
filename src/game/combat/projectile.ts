import type { AttackDefinition, ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, compareContactTime, divide, integer, position } from "../core/numeric.js";
import { worldRect } from "../physics/body.js";
import { type SweepTarget, sweepAabb, sweepBounds } from "../physics/sweep.js";
import type { Point, Rect } from "../state.js";

export interface BallisticProjectile {
  id: number;
  ownerId: number;
  team: number;
  actionInstanceId: number;
  definitionId: number;
  position: Point;
  velocity: Point;
  spawnTick: number;
}
export interface HurtTarget {
  /** Collision ID is unique per shape; entityId groups an actor's hurtboxes. */
  id: number;
  entityId: number;
  team: number;
  kind: "body" | "shield";
  /** A damageable solid competes with concrete and occludes attacks behind its face. */
  solid?: boolean;
  rect: Rect;
  delta: Point;
}
export interface Impact {
  sourceId: number;
  definitionId: number;
  actionInstanceId: number;
  ownerId: number;
  colliderId: number;
  entityId: number | null;
  kind: "terrain" | "shield" | "body";
  damage: number;
  position: Point;
  time: { numerator: number; denominator: number };
}

/** One common query makes walls, shield faces and body hurtboxes compete by exact hit time. */
export function sweepProjectile(
  projectile: BallisticProjectile,
  definition: AttackDefinition,
  shape: ShapeDefinition,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
) {
  if (
    definition.id !== projectile.definitionId ||
    definition.shapeId !== shape.id ||
    definition.kind !== "swept-projectile" ||
    definition.maxTargets !== 1 ||
    definition.material !== "bullet"
  )
    throw new Error("Unsupported ballistic policy");
  return projectileImpact(projectile, shape, definition.damage, terrain, hurtboxes);
}

/** Shared swept contact query; the weapon owns direct-hit, blast and penetration policy. */
export function projectileImpact(
  projectile: BallisticProjectile,
  shape: ShapeDefinition,
  bodyDamage: number,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
) {
  integer(bodyDamage, 0, 65535, "projectile body damage");
  integer(terrain.length + hurtboxes.length, 0, 4096, "projectile candidate count");
  const bounds = worldRect(projectile.position, shape.rect, 1);
  sweepBounds(bounds, projectile.velocity);
  const candidates = [
    ...terrain.map((target) => ({
      ...target,
      entityId: null,
      priority: 0,
      kind: "terrain" as const,
    })),
    ...hurtboxes
      .filter(
        (target) =>
          target.entityId !== projectile.ownerId &&
          (target.solid || target.team !== projectile.team),
      )
      .map((target) => ({
        ...target,
        priority: target.solid ? 0 : target.kind === "shield" ? 1 : 2,
      })),
  ];
  const ids = new Set<number>();
  let first: { target: (typeof candidates)[number]; time: Impact["time"] } | null = null;
  for (const target of candidates) {
    integer(target.id, 1, COUNTER_LIMIT - 1, "projectile collision ID");
    if (ids.has(target.id)) throw new Error("Duplicate projectile collision ID");
    ids.add(target.id);
    const hit = sweepAabb(bounds, projectile.velocity, target.rect, target.delta);
    if (!hit) continue;
    const time = hit.kind === "overlap" ? { numerator: 0, denominator: 1 } : hit.time;
    const order = first
      ? compareContactTime(
          time.numerator,
          time.denominator,
          first.time.numerator,
          first.time.denominator,
        )
      : -1;
    if (
      order < 0 ||
      (order === 0 &&
        first &&
        (target.priority < first.target.priority ||
          (target.priority === first.target.priority && target.id < first.target.id)))
    )
      first = { target, time };
  }
  if (!first) return null;
  const { target, time } = first;
  return {
    sourceId: projectile.id,
    definitionId: projectile.definitionId,
    actionInstanceId: projectile.actionInstanceId,
    ownerId: projectile.ownerId,
    colliderId: target.id,
    entityId: target.entityId,
    kind: target.kind,
    damage: target.kind === "body" ? bodyDamage : 0,
    position: {
      x: position(
        projectile.position.x +
          divide(projectile.velocity.x * time.numerator, time.denominator).quotient,
      ),
      y: position(
        projectile.position.y +
          divide(projectile.velocity.y * time.numerator, time.denominator).quotient,
      ),
    },
    time,
  } satisfies Impact;
}

/** Instantaneous release uses terrain at the end of its tick motion. */
export function muzzleBlocked(
  hand: Point,
  muzzle: Point,
  shape: ShapeDefinition,
  terrain: readonly SweepTarget[],
) {
  const bounds = worldRect(hand, shape.rect, 1);
  const delta = { x: muzzle.x - hand.x, y: muzzle.y - hand.y };
  return terrain.some(
    (target) =>
      sweepAabb(bounds, delta, {
        ...target.rect,
        x: target.rect.x + target.delta.x,
        y: target.rect.y + target.delta.y,
      }) !== null,
  );
}
