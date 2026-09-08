import type { AttackDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, MAX_SHAPE, divide, integer, position } from "../core/numeric.js";
import { type SweepTarget, sweepBounds, validateSweepTarget } from "../physics/sweep.js";
import type { Point, Rect } from "../state.js";
import { type AreaAnchor, type CardinalHeading, cardinalRect } from "./area-attack.js";
import type { HurtTarget, Impact } from "./projectile.js";
import type { AttackSource } from "./volume.js";

export interface BeamProfile {
  range: number;
  width: number;
  pulseTicks: number;
}
/** One prepaid charge. Its only damage grant is returned at emission, never retained for replay. */
export interface BeamPulse extends AttackSource {
  spawnTick: number;
  tick: number;
  origin: Point;
  heading: CardinalHeading;
  length: number;
}
export interface BeamCast {
  origin: Point;
  heading: CardinalHeading;
  length: number;
  width: number;
  /** At most four contiguous wire-sized rectangles; all use the same pulse damage budget. */
  segments: Rect[];
  impacts: Impact[];
  stoppedBy: "terrain" | "shield" | "solid" | "penetration" | null;
}

export function validateBeamProfile(profile: BeamProfile) {
  integer(profile.range, 1, MAX_SHAPE * 4, "beam range");
  integer(profile.width, 1, 4096, "beam width");
  integer(profile.pulseTicks, 1, 120, "beam pulse interval");
}
function validateBeamPolicy(
  source: AttackSource,
  definition: AttackDefinition,
  profile: BeamProfile,
) {
  validateBeamProfile(profile);
  for (const id of [source.id, source.ownerId, source.actionInstanceId, source.definitionId])
    integer(id, 1, COUNTER_LIMIT - 1, "beam identity");
  integer(source.team, 1, 255, "beam team");
  if (
    source.definitionId !== definition.id ||
    definition.kind !== "beam" ||
    definition.material !== "energy" ||
    definition.speed !== 0 ||
    definition.lifetimeTicks !== profile.pulseTicks ||
    definition.repeatDamageTicks !== profile.pulseTicks
  )
    throw new Error("Invalid beam attack policy");
  integer(definition.damage, 1, 65535, "beam damage");
  integer(definition.maxTargets, 1, 64, "beam penetration budget");
}
/** Convert end-of-tick geometry to a right-facing beam frame. */
function forward(rect: Rect, origin: Point, heading: CardinalHeading): Rect {
  if (heading === 0) return { ...rect, x: rect.x - origin.x, y: rect.y - origin.y };
  if (heading === 3) return { ...rect, x: origin.x - rect.x - rect.w, y: rect.y - origin.y };
  if (heading === 1)
    return { x: origin.y - rect.y - rect.h, y: rect.x - origin.x, w: rect.h, h: rect.w };
  return { x: rect.y - origin.y, y: rect.x - origin.x, w: rect.h, h: rect.w };
}
export function beamSegments(
  origin: Point,
  heading: CardinalHeading,
  length: number,
  width: number,
): Rect[] {
  integer(heading, 0, 3, "beam heading");
  integer(length, 0, MAX_SHAPE * 4, "beam length");
  integer(width, 1, 4096, "beam width");
  const result: Rect[] = [],
    y = -divide(width, 2).quotient;
  // Validate the full endpoint even if there are no contacts or visible segments.
  sweepBounds(cardinalRect(origin, { x: 0, y, w: length, h: width }, heading));
  for (let x = 0; x < length; x += MAX_SHAPE)
    result.push(
      cardinalRect(origin, { x, y, w: Math.min(MAX_SHAPE, length - x), h: width }, heading),
    );
  return result;
}

/** One instantaneous pulse after movement. Motion between pulse ticks grants no extra damage. */
export function castBeam(
  source: AttackSource,
  definition: AttackDefinition,
  profile: BeamProfile,
  origin: Point,
  heading: CardinalHeading,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
): BeamCast {
  validateBeamPolicy(source, definition, profile);
  beamSegments(origin, heading, profile.range, profile.width);
  integer(terrain.length + hurtboxes.length, 0, 4096, "beam candidate budget");
  const ids = new Set<number>();
  for (const wall of terrain) validateSweepTarget(wall);
  for (const hurt of hurtboxes) {
    integer(hurt.entityId, 1, COUNTER_LIMIT - 1, "beam target identity");
    integer(hurt.team, 0, 255, "beam target team");
    if (
      (hurt.kind !== "body" && hurt.kind !== "shield") ||
      (hurt.solid !== undefined && typeof hurt.solid !== "boolean")
    )
      throw new Error("Invalid beam target material");
    integer(hurt.rect.w, 1, 2 ** 24, "beam target width");
    integer(hurt.rect.h, 1, 2 ** 24, "beam target height");
    sweepBounds(hurt.rect, hurt.delta);
  }
  for (const candidate of [...terrain, ...hurtboxes]) {
    integer(candidate.id, 1, COUNTER_LIMIT - 1, "beam collider identity");
    if (ids.has(candidate.id)) throw new Error("Duplicate beam collider identity");
    ids.add(candidate.id);
  }
  const top = -divide(profile.width, 2).quotient,
    bottom = top + profile.width;
  const candidates = [
    ...terrain.map((target) => ({
      ...target,
      kind: "terrain" as const,
      entityId: null,
      solid: true,
      priority: 0,
    })),
    ...hurtboxes
      .filter(
        (target) =>
          target.entityId !== source.ownerId && (target.solid || target.team !== source.team),
      )
      .map((target) => ({
        ...target,
        priority: target.kind === "shield" ? 1 : target.solid ? 2 : 3,
      })),
  ]
    .flatMap((target) => {
      const rect = forward(
        { ...target.rect, x: target.rect.x + target.delta.x, y: target.rect.y + target.delta.y },
        origin,
        heading,
      );
      if (
        rect.y >= bottom ||
        rect.y + rect.h <= top ||
        rect.x + rect.w <= 0 ||
        rect.x > profile.range
      )
        return [];
      return [{ target, rect, distance: Math.max(0, rect.x) }];
    })
    .sort(
      (a, b) =>
        a.distance - b.distance ||
        a.target.priority - b.target.priority ||
        a.target.id - b.target.id,
    );
  const seen = new Set<number>(),
    impacts: Impact[] = [];
  let length = profile.range,
    stoppedBy: BeamCast["stoppedBy"] = null;
  for (const { target, rect, distance } of candidates) {
    const blocking = target.kind === "terrain" || target.kind === "shield" || target.solid;
    if (blocking) {
      length = distance;
      stoppedBy =
        target.kind === "terrain" ? "terrain" : target.kind === "shield" ? "shield" : "solid";
    }
    if (target.entityId === null || !seen.has(target.entityId)) {
      const point = cardinalRect(
        origin,
        { x: distance, y: Math.max(rect.y, Math.min(0, rect.y + rect.h)), w: 0, h: 0 },
        heading,
      );
      impacts.push({
        sourceId: source.id,
        definitionId: definition.id,
        ownerId: source.ownerId,
        actionInstanceId: source.actionInstanceId,
        colliderId: target.id,
        entityId: target.entityId,
        kind: target.kind,
        damage: target.kind === "body" ? definition.damage : 0,
        time: { numerator: 1, denominator: 1 },
        position: { x: position(point.x), y: position(point.y) },
      });
      if (target.entityId !== null) seen.add(target.entityId);
    }
    if (blocking) break;
    if (seen.size === definition.maxTargets) {
      length = distance;
      stoppedBy = "penetration";
      break;
    }
  }
  return {
    origin: { ...origin },
    heading,
    length,
    width: profile.width,
    segments: beamSegments(origin, heading, length, profile.width),
    impacts,
    stoppedBy,
  };
}

export function validateBeamPulse(
  beam: BeamPulse,
  definition: AttackDefinition,
  profile: BeamProfile,
) {
  validateBeamPolicy(beam, definition, profile);
  integer(beam.spawnTick, 1, COUNTER_LIMIT - 1 - profile.pulseTicks, "beam birth tick");
  integer(beam.tick, beam.spawnTick, beam.spawnTick + profile.pulseTicks - 1, "beam tick");
  integer(beam.length, 0, profile.range, "beam clipped length");
  beamSegments(beam.origin, beam.heading, profile.range, profile.width);
}

/** Call only for a newly accepted firearm charge; input identity and ammunition belong to that action. */
export function emitBeam(
  source: AttackSource,
  tick: number,
  definition: AttackDefinition,
  profile: BeamProfile,
  anchor: AreaAnchor,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
): { beam: BeamPulse; cast: BeamCast } {
  const beam: BeamPulse = {
    ...source,
    spawnTick: tick,
    tick,
    origin: { ...anchor.origin },
    heading: anchor.heading,
    length: profile.range,
  };
  validateBeamPulse(beam, definition, profile);
  const cast = castBeam(
    source,
    definition,
    profile,
    anchor.origin,
    anchor.heading,
    terrain,
    hurtboxes,
  );
  beam.length = cast.length;
  return { beam, cast };
}

/** Follow the accepted muzzle while held. A charge expires before the next pulse; release cancels it. */
export function stepBeam(
  current: BeamPulse,
  tick: number,
  definition: AttackDefinition,
  profile: BeamProfile,
  anchor: AreaAnchor | null,
  terrain: readonly SweepTarget[],
  hurtboxes: readonly HurtTarget[],
): { beam: BeamPulse; cast: BeamCast } | { beam: null; cast: null } {
  validateBeamPulse(current, definition, profile);
  if (tick !== current.tick + 1) throw new Error("Beam requires consecutive ticks");
  if (anchor === null || tick === current.spawnTick + profile.pulseTicks)
    return { beam: null, cast: null };
  const cast = castBeam(
    current,
    definition,
    profile,
    anchor.origin,
    anchor.heading,
    terrain,
    hurtboxes,
  );
  return {
    beam: {
      ...current,
      tick,
      origin: { ...anchor.origin },
      heading: anchor.heading,
      length: cast.length,
    },
    // Moving across a target or restoring this state cannot grant another damage pulse.
    cast: { ...cast, impacts: [] },
  };
}
