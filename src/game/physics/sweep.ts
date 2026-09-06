import {
  COUNTER_LIMIT,
  MAX_MOTION,
  MAX_POSITION,
  compareContactTime,
  integer,
  motion,
  position,
} from "../core/numeric.js";
import type { Point, Rect } from "../state.js";

export interface ContactTime {
  numerator: number;
  denominator: number;
}
export interface Normal {
  x: -1 | 0 | 1;
  y: -1 | 0 | 1;
}
export type SweepHit = { kind: "hit"; time: ContactTime; normals: Normal[] };
export type SweepResult = SweepHit | { kind: "overlap" } | null;
export interface SweepTarget {
  id: number;
  rect: Rect;
  delta: Point;
  kind: "solid" | "one-way";
}
export interface SweepContact {
  otherId: number;
  kind: SweepTarget["kind"];
  time: ContactTime;
  normal: Normal;
}
export interface SweepBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const ZERO: Readonly<Point> = { x: 0, y: 0 };
const START: ContactTime = { numerator: 0, denominator: 1 };
const END: ContactTime = { numerator: 1, denominator: 1 };
function compare(a: ContactTime, b: ContactTime): number {
  return compareContactTime(a.numerator, a.denominator, b.numerator, b.denominator);
}

function validate(rect: Rect, delta: Point, segment: boolean): void {
  position(rect.x);
  position(rect.y);
  integer(rect.w, segment ? 0 : 1, MAX_POSITION, "sweep width");
  integer(rect.h, segment ? 0 : 1, MAX_POSITION, "sweep height");
  position(rect.x + rect.w);
  position(rect.y + rect.h);
  motion(delta.x);
  motion(delta.y);
  position(rect.x + delta.x);
  position(rect.y + delta.y);
  position(rect.x + rect.w + delta.x);
  position(rect.y + rect.h + delta.y);
}

export function validateSweepTarget(target: SweepTarget): void {
  integer(target.id, 1, COUNTER_LIMIT - 1, "collision entity ID");
  if (target.kind !== "solid" && target.kind !== "one-way")
    throw new Error("Unsupported collision terrain");
  validate(target.rect, target.delta, false);
}

/** Closed bounds include endpoint/corner contact and the entire linear tick path. */
export function sweepBounds(rect: Rect, delta: Point = ZERO): SweepBounds {
  validate(rect, delta, true);
  return {
    minX: rect.x + Math.min(0, delta.x),
    minY: rect.y + Math.min(0, delta.y),
    maxX: rect.x + rect.w + Math.max(0, delta.x),
    maxY: rect.y + rect.h + Math.max(0, delta.y),
  };
}

interface Slab {
  enter: ContactTime;
  exit: ContactTime;
  normal: -1 | 1;
}
function slab(
  min: number,
  max: number,
  targetMin: number,
  targetMax: number,
  delta: number,
): Slab | "inside" | null {
  if (delta === 0) return min < targetMax && max > targetMin ? "inside" : null;
  const denominator = Math.abs(delta);
  return delta > 0
    ? {
        enter: { numerator: targetMin - max, denominator },
        exit: { numerator: targetMax - min, denominator },
        normal: -1,
      }
    : {
        enter: { numerator: min - targetMax, denominator },
        exit: { numerator: max - targetMin, denominator },
        normal: 1,
      };
}

/**
 * Exact slab query for one tick, including relative target motion. Rectangles use world
 * coordinates; a point/axis segment is allowed for the mover, never for solid terrain.
 * Edges lie within ±2^24; separation numerators <=2^25; relative motion <=2^17.
 * Rational comparison products <=2^42. No float time, epsilon or accumulated fractions.
 * Strict initial overlap is reported separately. Tangent/separating boundary touches miss.
 */
export function sweepAabb(
  body: Rect,
  delta: Point,
  target: Rect,
  targetDelta: Point = ZERO,
): SweepResult {
  validate(body, delta, true);
  validate(target, targetDelta, false);
  if (
    body.x < target.x + target.w &&
    body.x + body.w > target.x &&
    body.y < target.y + target.h &&
    body.y + body.h > target.y
  )
    return { kind: "overlap" };
  const axes = [
    slab(body.x, body.x + body.w, target.x, target.x + target.w, delta.x - targetDelta.x),
    slab(body.y, body.y + body.h, target.y, target.y + target.h, delta.y - targetDelta.y),
  ];
  let enter: ContactTime | undefined;
  let exit: ContactTime | undefined;
  const normals: Array<{ time: ContactTime; normal: Normal }> = [];
  for (const [index, axis] of axes.entries()) {
    if (axis === null) return null;
    if (axis === "inside") continue;
    if (!enter || compare(axis.enter, enter) > 0) enter = axis.enter;
    if (!exit || compare(axis.exit, exit) < 0) exit = axis.exit;
    normals.push({
      time: axis.enter,
      normal: index === 0 ? { x: axis.normal, y: 0 } : { x: 0, y: axis.normal },
    });
  }
  if (
    !enter ||
    !exit ||
    compare(enter, START) < 0 ||
    compare(enter, END) > 0 ||
    compare(enter, exit) >= 0
  )
    return null;
  return {
    kind: "hit",
    time: enter,
    normals: normals.filter((item) => compare(item.time, enter) === 0).map((item) => item.normal),
  };
}

/** One-way top only: previous feet on/above top, crossing down in relative space. */
export function sweepOneWay(
  body: Rect,
  delta: Point,
  target: Rect,
  targetDelta: Point = ZERO,
): SweepHit | null {
  validate(body, delta, true);
  validate(target, targetDelta, false);
  const distance = target.y - (body.y + body.h);
  const relativeY = delta.y - targetDelta.y;
  if (distance < 0 || relativeY <= 0 || distance > relativeY) return null;
  const time = { numerator: distance, denominator: relativeY };
  const relativeX = delta.x - targetDelta.x;
  // Each term <=2^42; sums <=2^43. Strict horizontal overlap excludes corner grazes.
  if (
    (body.x - target.x - target.w) * relativeY + relativeX * distance >= 0 ||
    (body.x + body.w - target.x) * relativeY + relativeX * distance <= 0
  )
    return null;
  return { kind: "hit", time, normals: [{ x: 0, y: -1 }] };
}

/** Gather every equal-time hit; ID then X/Y normal order is independent of insertion order. */
export function earliestSweep(
  body: Rect,
  delta: Point,
  targets: readonly SweepTarget[],
  ignoredOneWayId?: number,
): { overlaps: number[]; contacts: SweepContact[] } {
  validate(body, delta, true);
  integer(targets.length, 0, 4096, "sweep candidate count");
  const ids = new Set<number>();
  const overlaps: number[] = [];
  let contacts: SweepContact[] = [];
  let earliest: ContactTime | undefined;
  for (const target of [...targets].sort((a, b) => a.id - b.id)) {
    validateSweepTarget(target);
    if (ids.has(target.id)) throw new Error("Duplicate collision entity ID");
    ids.add(target.id);
    if (target.kind === "one-way" && target.id === ignoredOneWayId) continue;
    const result =
      target.kind === "solid"
        ? sweepAabb(body, delta, target.rect, target.delta)
        : sweepOneWay(body, delta, target.rect, target.delta);
    if (result?.kind === "overlap") {
      overlaps.push(target.id);
      continue;
    }
    if (!result || (earliest && compare(result.time, earliest) > 0)) continue;
    if (!earliest || compare(result.time, earliest) < 0) contacts = [];
    earliest = result.time;
    for (const normal of result.normals)
      contacts.push({ otherId: target.id, kind: target.kind, time: result.time, normal });
  }
  return { overlaps, contacts };
}

/** Round each component toward its start, at most one subpixel before exact contact. */
export function displacementAtContact(delta: Point, time: ContactTime): Point {
  motion(delta.x);
  motion(delta.y);
  integer(time.denominator, 1, MAX_MOTION * 2, "contact denominator");
  integer(time.numerator, 0, time.denominator, "contact numerator");
  // |motion * numerator| <=2^33, safely exact; division never rounds beyond contact.
  return {
    x: Math.trunc((delta.x * time.numerator) / time.denominator) || 0,
    y: Math.trunc((delta.y * time.numerator) / time.denominator) || 0,
  };
}
