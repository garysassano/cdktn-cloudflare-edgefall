import { type AttackMaterial, type MaterialSurface, materialBlocks } from "../content/materials.js";
import type { AttackDefinition } from "../content/schema.js";
import {
  COUNTER_LIMIT,
  MAX_SHAPE,
  compareContactTime,
  integer,
  position,
} from "../core/numeric.js";
import { validateLocalRect } from "../physics/body.js";
import type { Point, Rect } from "../state.js";
import type { HurtTarget, Impact } from "./projectile.js";
import { type AttackSource, rectangularHits } from "./volume.js";

export type CardinalHeading = 0 | 1 | 2 | 3;
export interface AreaProfile {
  kind: "shot-volume" | "flame-volumes";
  emissionOffsets: readonly number[];
  attachedTicks: number;
  /** One root-relative, right-facing exposure per lobe tick. */
  frames: readonly Rect[];
  maximumReach: number;
}
export interface AreaLobe {
  index: number;
  origin: Point;
  heading: CardinalHeading;
  /** A contacted wall permanently limits this lobe's propagation. */
  reach: number;
}
export interface AreaAttack extends AttackSource {
  startTick: number;
  emitted: number;
  cancelledTick: number | null;
  lobes: AreaLobe[];
  hits: Array<{ entityId: number; nextTick: number }>;
}
export interface AreaExposure {
  id: number;
  ownerId: number;
  actionInstanceId: number;
  definitionId: number;
  lobe: number;
  spawnTick: number;
  endTick: number;
  heading: CardinalHeading;
  attached: boolean;
  rect: Rect;
}
export interface AreaAnchor {
  origin: Point;
  heading: CardinalHeading;
}
const zero = { x: 0, y: 0 };
export function areaEndTick(attack: AreaAttack, profile: AreaProfile) {
  return attack.startTick + (profile.emissionOffsets.at(-1) ?? 0) + profile.frames.length;
}
export function cardinalRect(origin: Point, rect: Rect, heading: CardinalHeading): Rect {
  if (heading === 0) return { ...rect, x: origin.x + rect.x, y: origin.y + rect.y };
  if (heading === 3) return { ...rect, x: origin.x - rect.x - rect.w, y: origin.y + rect.y };
  if (heading === 1)
    return { x: origin.x + rect.y, y: origin.y - rect.x - rect.w, w: rect.h, h: rect.w };
  return { x: origin.x + rect.y, y: origin.y + rect.x, w: rect.h, h: rect.w };
}
function forward(rect: Rect, origin: Point, heading: CardinalHeading): Rect {
  if (heading === 0) return { ...rect, x: rect.x - origin.x, y: rect.y - origin.y };
  if (heading === 3) return { ...rect, x: origin.x - rect.x - rect.w, y: rect.y - origin.y };
  if (heading === 1)
    return { x: origin.y - rect.y - rect.h, y: rect.x - origin.x, w: rect.h, h: rect.w };
  return { x: rect.y - origin.y, y: rect.x - origin.x, w: rect.h, h: rect.w };
}

/** Centerline walls stop propagation; parallel floors/ceilings clip the cross-section. */
function clippedGeometry(
  geometry: Rect,
  lobe: AreaLobe,
  terrain: readonly MaterialSurface[],
  material: AttackMaterial,
) {
  let reach = lobe.reach;
  let top = geometry.y,
    bottom = geometry.y + geometry.h;
  for (const wall of terrain) {
    if (wall.kind !== "solid" || !materialBlocks(wall, material)) continue;
    const rect = forward(
      { ...wall.rect, x: wall.rect.x + wall.delta.x, y: wall.rect.y + wall.delta.y },
      lobe.origin,
      lobe.heading,
    );
    if (
      rect.y < geometry.y + geometry.h &&
      rect.y + rect.h > geometry.y &&
      rect.x + rect.w > 0 &&
      rect.x <= geometry.x + geometry.w
    ) {
      if (rect.y <= 0 && rect.y + rect.h >= 0) reach = Math.min(reach, Math.max(0, rect.x));
      else if (rect.y > 0) bottom = Math.min(bottom, rect.y);
      else top = Math.max(top, rect.y + rect.h);
    }
  }
  const width = Math.min(geometry.w, reach - geometry.x);
  return {
    reach,
    rect: width > 0 && bottom > top ? { ...geometry, y: top, h: bottom - top, w: width } : null,
  };
}
function geometryAt(attack: AreaAttack, lobe: AreaLobe, tick: number, profile: AreaProfile) {
  const spawnTick = attack.startTick + (profile.emissionOffsets[lobe.index] ?? -COUNTER_LIMIT);
  const geometry = profile.frames[tick - spawnTick];
  if (!geometry) return null;
  const width = Math.min(geometry.w, lobe.reach - geometry.x);
  return width > 0 ? { spawnTick, geometry: { ...geometry, w: width } } : null;
}
export function areaExposures(
  attack: AreaAttack,
  tick: number,
  profile: AreaProfile,
  terrain: readonly MaterialSurface[],
): AreaExposure[] {
  return attack.lobes.flatMap((lobe) => {
    const frame = geometryAt(attack, lobe, tick, profile);
    const geometry =
      frame &&
      clippedGeometry(
        frame.geometry,
        lobe,
        terrain,
        profile.kind === "shot-volume" ? "bullet" : "heat",
      ).rect;
    return frame && geometry
      ? [
          {
            id: attack.id,
            ownerId: attack.ownerId,
            actionInstanceId: attack.actionInstanceId,
            definitionId: attack.definitionId,
            lobe: lobe.index,
            spawnTick: frame.spawnTick,
            endTick: frame.spawnTick + profile.frames.length,
            heading: lobe.heading,
            attached: tick - frame.spawnTick < profile.attachedTicks,
            rect: cardinalRect(lobe.origin, geometry, lobe.heading),
          },
        ]
      : [];
  });
}

/** Every authored emission advances once, including a blocked muzzle. Ammunition belongs to its action. */
export function emitArea(
  attack: AreaAttack,
  tick: number,
  profile: AreaProfile,
  anchor: AreaAnchor,
  blocked: boolean,
) {
  const index = profile.emissionOffsets.indexOf(tick - attack.startTick);
  if (index < 0 || index !== attack.emitted || attack.cancelledTick !== null)
    throw new Error("Area emission cursor mismatch");
  attack.emitted++;
  if (!blocked)
    attack.lobes.push({
      index,
      origin: { ...anchor.origin },
      heading: anchor.heading,
      reach: profile.maximumReach,
    });
}

/** Released shotgun blasts and detached flame survive death; attached flame and future emission do not. */
export function cancelArea(attack: AreaAttack, tick: number, profile: AreaProfile) {
  if (profile.kind !== "flame-volumes") return;
  attack.cancelledTick ??= tick;
  attack.lobes = attack.lobes.filter(
    (lobe) =>
      tick - attack.startTick - (profile.emissionOffsets[lobe.index] ?? 0) >= profile.attachedTicks,
  );
}

export function stepArea(
  current: AreaAttack,
  tick: number,
  definition: AttackDefinition,
  profile: AreaProfile,
  anchor: AreaAnchor | null,
  terrain: readonly MaterialSurface[],
  hurtboxes: readonly HurtTarget[],
) {
  const attack = structuredClone(current),
    impacts: Impact[] = [],
    candidatesForAction: Impact[] = [];
  if (definition.kind !== profile.kind || definition.id !== attack.definitionId)
    throw new Error("Area definition mismatch");
  if (tick >= areaEndTick(attack, profile)) return { attack: null, impacts };
  if (!anchor) cancelArea(attack, tick, profile);
  attack.lobes = attack.lobes.filter(
    (lobe) =>
      tick - attack.startTick - (profile.emissionOffsets[lobe.index] ?? 0) < profile.frames.length,
  );
  for (const lobe of attack.lobes) {
    const born = attack.startTick + (profile.emissionOffsets[lobe.index] ?? 0),
      age = tick - born;
    const frame = profile.frames[age];
    if (!frame) throw new Error("Unknown area exposure");
    const previous = structuredClone(lobe);
    if (age < profile.attachedTicks && anchor) {
      lobe.origin = { ...anchor.origin };
      lobe.heading = anchor.heading;
    }
    const endpoint = age === 0 || previous.heading !== lobe.heading;
    const delta = endpoint
      ? zero
      : { x: lobe.origin.x - previous.origin.x, y: lobe.origin.y - previous.origin.y };
    const origin = endpoint ? lobe.origin : previous.origin;
    // Contacted solids remain a propagation limit after they move or are removed.
    const clipped = clippedGeometry(
      frame,
      lobe,
      [
        ...terrain,
        ...hurtboxes
          .filter((target) => target.solid)
          .map((target) => ({ ...target, kind: "solid" as const })),
      ],
      definition.material,
    );
    lobe.reach = clipped.reach;
    if (!clipped.rect) continue;
    const excluded = attack.hits
      .filter((hit) => definition.repeatDamageTicks === 0 || tick < hit.nextTick)
      .map((hit) => hit.entityId);
    const remaining = definition.maxTargets - attack.hits.length;
    const candidates = hurtboxes.filter(
      (hurt) => remaining > 0 || attack.hits.some((hit) => hit.entityId === hurt.entityId),
    );
    const collisionTerrain = endpoint
      ? terrain.map((wall) => ({
          ...wall,
          rect: { ...wall.rect, x: wall.rect.x + wall.delta.x, y: wall.rect.y + wall.delta.y },
          delta: zero,
        }))
      : terrain;
    const hits = rectangularHits(
      attack,
      definition,
      cardinalRect(origin, clipped.rect, lobe.heading),
      delta,
      origin,
      collisionTerrain,
      endpoint
        ? candidates.map((hurt) => ({
            ...hurt,
            rect: { ...hurt.rect, x: hurt.rect.x + hurt.delta.x, y: hurt.rect.y + hurt.delta.y },
            delta: zero,
          }))
        : candidates,
      excluded,
    );
    candidatesForAction.push(...hits);
  }
  const granted = new Set<number>();
  candidatesForAction.sort(
    (a, b) =>
      compareContactTime(
        a.time.numerator,
        a.time.denominator,
        b.time.numerator,
        b.time.denominator,
      ) || a.colliderId - b.colliderId,
  );
  for (const hit of candidatesForAction) {
    if (hit.entityId === null) continue;
    if (granted.has(hit.entityId)) continue;
    let receipt = attack.hits.find((receipt) => receipt.entityId === hit.entityId);
    if (!receipt) {
      if (attack.hits.length >= definition.maxTargets) continue;
      receipt = { entityId: hit.entityId, nextTick: 0 };
      attack.hits.push(receipt);
    }
    receipt.nextTick =
      definition.repeatDamageTicks === 0
        ? areaEndTick(attack, profile)
        : tick + definition.repeatDamageTicks;
    granted.add(hit.entityId);
    impacts.push(hit);
  }
  attack.hits.sort((a, b) => a.entityId - b.entityId);
  return { attack, impacts };
}

export function validateAreaProfile(profile: AreaProfile, definition: AttackDefinition) {
  if (definition.kind !== profile.kind || !["shot-volume", "flame-volumes"].includes(profile.kind))
    throw new Error("Unknown area profile");
  if (definition.material !== (profile.kind === "shot-volume" ? "bullet" : "heat"))
    throw new Error("Area profile material mismatch");
  integer(profile.frames.length, 1, 120, "area frames");
  integer(profile.emissionOffsets.length, 1, 4, "area emissions");
  integer(profile.attachedTicks, 0, profile.frames.length, "area attachment");
  integer(profile.maximumReach, 1, MAX_SHAPE, "area reach");
  for (const [index, offset] of profile.emissionOffsets.entries()) {
    integer(
      offset,
      index === 0 ? 0 : (profile.emissionOffsets[index - 1] ?? 0) + 1,
      120,
      "area emission offset",
    );
    if (index === 0 && offset !== 0) throw new Error("Area must begin at its first emission");
  }
  for (const frame of profile.frames) {
    validateLocalRect(frame);
    if (frame.x < 0 || frame.x + frame.w > profile.maximumReach)
      throw new Error("Area frame exceeds reach");
  }
  if (
    definition.lifetimeTicks !== (profile.emissionOffsets.at(-1) ?? 0) + profile.frames.length ||
    (profile.kind === "shot-volume" &&
      (definition.repeatDamageTicks !== 0 ||
        profile.attachedTicks !== 0 ||
        profile.emissionOffsets.length !== 1)) ||
    (profile.kind === "flame-volumes" && definition.repeatDamageTicks < 1)
  )
    throw new Error("Area lifetime/damage policy mismatch");
}

export function validateArea(
  attack: AreaAttack,
  tick: number,
  definition: AttackDefinition,
  profile: AreaProfile,
  targetIds: readonly number[],
) {
  integer(attack.startTick, 1, tick, "area start tick");
  if (tick >= areaEndTick(attack, profile)) throw new Error("Expired area attack");
  const through = attack.cancelledTick ?? tick;
  if (attack.cancelledTick !== null)
    integer(attack.cancelledTick, attack.startTick, tick, "area cancellation tick");
  const expected = profile.emissionOffsets.filter(
    (offset) => attack.startTick + offset <= through,
  ).length;
  const minimum =
    attack.cancelledTick === null
      ? expected
      : profile.emissionOffsets.filter((offset) => attack.startTick + offset < through).length;
  integer(attack.emitted, Math.max(1, minimum), expected, "area emission history");
  integer(attack.lobes.length, 0, attack.emitted, "area lobe budget");
  for (const [i, lobe] of attack.lobes.entries()) {
    integer(
      lobe.index,
      i === 0 ? 0 : (attack.lobes[i - 1]?.index ?? 0) + 1,
      attack.emitted - 1,
      "area lobe order",
    );
    integer(lobe.heading, 0, 3, "area heading");
    integer(lobe.reach, 0, profile.maximumReach, "area retained reach");
    position(lobe.origin.x);
    position(lobe.origin.y);
    const age = tick - attack.startTick - (profile.emissionOffsets[lobe.index] ?? 0);
    integer(age, 0, profile.frames.length - 1, "area lobe age");
    if (
      attack.cancelledTick !== null &&
      attack.cancelledTick - attack.startTick - (profile.emissionOffsets[lobe.index] ?? 0) <
        profile.attachedTicks
    )
      throw new Error("Cancelled attached flame");
  }
  integer(attack.hits.length, 0, definition.maxTargets, "area target budget");
  for (const [index, hit] of attack.hits.entries()) {
    if (
      !targetIds.includes(hit.entityId) ||
      (index > 0 && hit.entityId <= (attack.hits[index - 1]?.entityId ?? 0))
    )
      throw new Error("Invalid area hit history");
    integer(
      hit.nextTick,
      attack.startTick + 1,
      areaEndTick(attack, profile) + definition.repeatDamageTicks,
      "area next damage tick",
    );
    if (definition.repeatDamageTicks === 0 && hit.nextTick !== areaEndTick(attack, profile))
      throw new Error("Shotgun hit history expires early");
    if (definition.repeatDamageTicks > 0 && hit.nextTick > tick + definition.repeatDamageTicks)
      throw new Error("Area damage cooldown precedes its hit");
  }
}
