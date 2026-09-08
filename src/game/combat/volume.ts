import type { AttackDefinition, ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, compareContactTime, divide, integer, position } from "../core/numeric.js";
import { worldRect } from "../physics/body.js";
import {
  type ContactTime,
  type SweepTarget,
  sweepAabb,
  sweepBounds,
  validateSweepTarget,
} from "../physics/sweep.js";
import type { Point, Rect } from "../state.js";
import type { HurtTarget, Impact } from "./projectile.js";

export interface AttackSource {
  id: number;
  ownerId: number;
  team: number;
  actionInstanceId: number;
  definitionId: number;
}
export interface MeleeStrike extends AttackSource {
  spawnTick: number;
  endTick: number;
  hitIds: number[];
}
const END = { numerator: 1, denominator: 1 };
function validateQuery(
  source: AttackSource,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
) {
  for (const id of [source.id, source.ownerId, source.actionInstanceId, source.definitionId])
    integer(id, 1, COUNTER_LIMIT - 1, "attack identity");
  integer(source.team, 0, 255, "attack team");
  integer(terrain.length + hurtboxes.length, 0, 4096, "volume candidates");
  const ids = new Set<number>();
  for (const target of terrain) validateSweepTarget(target);
  for (const target of hurtboxes) {
    integer(target.entityId, 1, COUNTER_LIMIT - 1, "hurt entity");
    integer(target.team, 0, 255, "hurt team");
    if (target.kind !== "body" && target.kind !== "shield") throw new Error("Invalid hurt kind");
    // Validate both tick endpoints before nearest-point and squared-distance arithmetic.
    sweepBounds(target.rect, target.delta);
    integer(target.rect.w, 1, 2 ** 24, "hurt width");
    integer(target.rect.h, 1, 2 ** 24, "hurt height");
  }
  for (const target of [...terrain, ...hurtboxes]) {
    integer(target.id, 1, COUNTER_LIMIT - 1, "volume collision ID");
    if (ids.has(target.id)) throw new Error("Duplicate volume collision ID");
    ids.add(target.id);
  }
}
const at = (origin: Point, delta: Point, time: ContactTime): Point => ({
  x: origin.x + divide(delta.x * time.numerator, time.denominator).quotient,
  y: origin.y + divide(delta.y * time.numerator, time.denominator).quotient,
});
function nearest(origin: Point, rect: Rect): Point {
  return {
    x: Math.max(rect.x, Math.min(origin.x, rect.x + rect.w)),
    y: Math.max(rect.y, Math.min(origin.y, rect.y + rect.h)),
  };
}
function targets(source: AttackSource, hurtboxes: readonly HurtTarget[]) {
  return hurtboxes.filter(
    (target) => (target.solid || target.team !== source.team) && target.entityId !== source.ownerId,
  );
}
function occluder(
  from: Point,
  to: Point,
  time: ContactTime,
  terrain: readonly SweepTarget[],
  shields: readonly HurtTarget[],
) {
  const candidates = [
    ...terrain
      .filter((target) => target.kind === "solid")
      .map((target) => ({ ...target, entityId: null, kind: "terrain" as const, priority: 0 })),
    ...shields.map((target) => ({ ...target, priority: target.solid ? 0 : 1 })),
  ];
  let first: { target: (typeof candidates)[number]; time: ContactTime } | null = null;
  for (const target of candidates) {
    const point = at(target.rect, target.delta, time);
    const hit = sweepAabb(
      { ...from, w: 0, h: 0 },
      { x: to.x - from.x, y: to.y - from.y },
      { ...target.rect, ...point },
    );
    if (!hit) continue;
    const hitTime = hit.kind === "overlap" ? { numerator: 0, denominator: 1 } : hit.time;
    const order = first
      ? compareContactTime(
          hitTime.numerator,
          hitTime.denominator,
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
      first = { target, time: hitTime };
  }
  return first;
}
function impact(
  source: AttackSource,
  target: HurtTarget,
  time: ContactTime,
  point: Point,
  damage: number,
): Impact {
  return {
    sourceId: source.id,
    definitionId: source.definitionId,
    ownerId: source.ownerId,
    actionInstanceId: source.actionInstanceId,
    colliderId: target.id,
    entityId: target.entityId,
    kind: target.kind,
    damage,
    time,
    position: point,
  };
}
function ordered(
  hits: Impact[],
  maximum: number,
  excluded: readonly number[],
  primaryTarget: number | null = null,
): Impact[] {
  const seen = new Set(excluded);
  return hits
    .sort(
      (a, b) =>
        compareContactTime(
          a.time.numerator,
          a.time.denominator,
          b.time.numerator,
          b.time.denominator,
        ) ||
        (primaryTarget === null
          ? 0
          : Number(b.entityId === primaryTarget) - Number(a.entityId === primaryTarget)) ||
        a.colliderId - b.colliderId,
    )
    .filter((hit) => {
      if (hit.entityId === null || seen.has(hit.entityId) || seen.size >= maximum) return false;
      seen.add(hit.entityId);
      return true;
    });
}

/** Moving short volume, per-entity hit budget and point-of-contact terrain/shield occlusion. */
export function meleeHits(
  source: AttackSource,
  definition: AttackDefinition,
  shape: ShapeDefinition,
  hand: Point,
  delta: Point,
  facing: -1 | 1,
  occlusionOrigin: Point,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
  hitIds: readonly number[] = [],
): Impact[] {
  if (
    definition.kind !== "melee" ||
    (definition.material !== "blade" && definition.material !== "blunt") ||
    definition.id !== source.definitionId ||
    definition.shapeId !== shape.id
  )
    throw new Error("Invalid melee policy");
  return rectangularHits(
    source,
    definition,
    worldRect(hand, shape.rect, facing),
    delta,
    occlusionOrigin,
    terrain,
    hurtboxes,
    hitIds,
  );
}

/** Authored area attacks share exact moving-hurtbox and material occlusion rules. */
export function rectangularHits(
  source: AttackSource,
  definition: AttackDefinition,
  volume: Rect,
  delta: Point,
  occlusionOrigin: Point,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
  hitIds: readonly number[] = [],
): Impact[] {
  if (
    definition.id !== source.definitionId ||
    !["melee", "shot-volume", "flame-volumes"].includes(definition.kind)
  )
    throw new Error("Invalid rectangular attack policy");
  validateQuery(source, terrain, hurtboxes);
  integer(hitIds.length, 0, definition.maxTargets, "melee hit budget");
  for (const id of hitIds) integer(id, 1, COUNTER_LIMIT - 1, "melee hit identity");
  if (new Set(hitIds).size !== hitIds.length) throw new Error("Duplicate melee hit identity");
  sweepBounds(volume, delta);
  sweepBounds({ ...occlusionOrigin, w: 0, h: 0 }, delta);
  const enemies = targets(source, hurtboxes),
    shields = enemies.filter((target) => target.kind === "shield" || target.solid),
    hits: Impact[] = [];
  for (const target of enemies.filter(
    (target) => target.kind === "body" || definition.kind !== "melee",
  )) {
    const hit = sweepAabb(volume, delta, target.rect, target.delta);
    if (!hit) continue;
    const time = hit.kind === "overlap" ? { numerator: 0, denominator: 1 } : hit.time;
    const origin = at(occlusionOrigin, delta, time);
    const exposed = { ...target.rect, ...at(target.rect, target.delta, time) };
    const currentVolume = { ...volume, ...at(volume, delta, time) };
    const x = Math.max(exposed.x, currentVolume.x),
      y = Math.max(exposed.y, currentVolume.y);
    const point = nearest(origin, {
      x,
      y,
      w: Math.max(0, Math.min(exposed.x + exposed.w, currentVolume.x + currentVolume.w) - x),
      h: Math.max(0, Math.min(exposed.y + exposed.h, currentVolume.y + currentVolume.h) - y),
    });
    const blocked = occluder(origin, point, time, terrain, shields);
    if (blocked?.target.kind === "terrain") continue;
    if (blocked && definition.kind !== "melee") {
      const shield = {
        ...blocked.target.rect,
        ...at(blocked.target.rect, blocked.target.delta, time),
      };
      // A detached lobe may be beyond a shield. It cannot deal heat to a face
      // outside its current exposure just because that face occludes the root ray.
      if (
        shield.x > currentVolume.x + currentVolume.w ||
        shield.x + shield.w < currentVolume.x ||
        shield.y > currentVolume.y + currentVolume.h ||
        shield.y + shield.h < currentVolume.y
      )
        continue;
    }
    hits.push(
      blocked
        ? impact(
            source,
            blocked.target as HurtTarget,
            time,
            at(origin, { x: point.x - origin.x, y: point.y - origin.y }, blocked.time),
            blocked.target.kind === "body" ? definition.damage : 0,
          )
        : impact(source, target, time, point, target.kind === "shield" ? 0 : definition.damage),
    );
  }
  return ordered(hits, definition.maxTargets, hitIds);
}

/** Radius tests use the closest hurtbox point, then test concrete and shield occlusion. */
export function explosionHits(
  source: AttackSource,
  definition: AttackDefinition,
  center: Point,
  radius: number,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
  options: { time?: ContactTime; primaryTarget?: number | null } = {},
): Impact[] {
  const { time = END, primaryTarget = null } = options;
  if (
    definition.id !== source.definitionId ||
    definition.kind !== "explosion" ||
    definition.material !== "explosive"
  )
    throw new Error("Invalid explosion policy");
  integer(radius, 1, 2 ** 16, "blast radius");
  integer(time.denominator, 1, 2 ** 17, "blast contact denominator");
  integer(time.numerator, 0, time.denominator, "blast contact numerator");
  if (primaryTarget !== null) integer(primaryTarget, 1, COUNTER_LIMIT - 1, "blast primary target");
  position(center.x);
  position(center.y);
  validateQuery(source, terrain, hurtboxes);
  const enemies = targets(source, hurtboxes),
    shields = enemies.filter((target) => target.kind === "shield" || target.solid),
    hits: Impact[] = [];
  for (const target of enemies.filter((target) => target.kind === "body")) {
    const point = nearest(center, {
      ...target.rect,
      ...at(target.rect, target.delta, time),
    });
    const dx = point.x - center.x,
      dy = point.y - center.y;
    if (dx * dx + dy * dy > radius * radius) continue;
    const blocked = occluder(center, point, time, terrain, shields);
    if (blocked?.target.kind === "terrain") continue;
    hits.push(
      blocked
        ? impact(
            source,
            blocked.target as HurtTarget,
            time,
            at(center, { x: point.x - center.x, y: point.y - center.y }, blocked.time),
            blocked.target.kind === "body" ? definition.damage : 0,
          )
        : impact(source, target, time, point, definition.damage),
    );
  }
  return ordered(hits, definition.maxTargets, [], primaryTarget);
}
