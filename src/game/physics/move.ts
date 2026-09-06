import {
  COUNTER_LIMIT,
  MAX_MOTION,
  MAX_POSITION,
  SUBPIXELS,
  integer,
  motion,
  position,
} from "../core/numeric.js";
import type { Point, Rect } from "../state.js";
import { type CollisionFrame, CollisionIndex } from "./grid.js";
import {
  type Normal,
  type SweepContact,
  type SweepTarget,
  displacementAtContact,
  earliestSweep,
  sweepAabb,
  sweepBounds,
  sweepOneWay,
} from "./sweep.js";

export interface KinematicState {
  rect: Rect;
  /** Own tick displacement/velocity; support carry is added only by the solver. */
  motion: Point;
  supportId: number | null;
}
export interface MovementContact extends SweepContact {
  /** Time is relative to this residual sweep, not a multiplied whole-tick fraction. */
  iteration: number;
}
export interface MovementResult extends KinematicState {
  status:
    | "complete"
    | "initial-overlap"
    | "residual-overlap"
    | "contact-limit"
    | "unresolved-contact"
    | "crushed";
  contacts: MovementContact[];
  correction: Point;
  remaining: Point;
  iterations: number;
  diagnosticIds: number[];
}
export interface MovementOptions {
  ignoredOneWayId?: number;
  maxIterations?: number;
  /** Required for indexed geometry, preventing a cached moving frame from being reused. */
  frame?: CollisionFrame;
}

const ZERO: Readonly<Point> = { x: 0, y: 0 };
const MAX_CORRECTION = SUBPIXELS;

function translate(rect: Rect, delta: Point): Rect {
  const result = { ...rect, x: position(rect.x + delta.x), y: position(rect.y + delta.y) };
  position(result.x + result.w);
  position(result.y + result.h);
  return result;
}
function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function inWorld(rect: Rect): boolean {
  return (
    rect.x >= -MAX_POSITION &&
    rect.y >= -MAX_POSITION &&
    rect.x + rect.w <= MAX_POSITION &&
    rect.y + rect.h <= MAX_POSITION
  );
}

/** Minimal cardinal correction, never a general spawn repair or an unbounded push loop. */
function correctOverlap(
  rect: Rect,
  targets: readonly SweepTarget[],
  ids: readonly number[],
  ignoredId?: number,
): Point | null {
  if (ids.length === 0) return { ...ZERO };
  if (ids.length > 8) return null;
  const overlapping = new Set(ids);
  const candidates: Array<{ delta: Point; order: number; id: number }> = [];
  for (const target of targets) {
    if (!overlapping.has(target.id)) continue;
    const b = target.rect;
    candidates.push(
      { delta: { x: b.x - rect.x - rect.w, y: 0 }, order: 0, id: target.id },
      { delta: { x: b.x + b.w - rect.x, y: 0 }, order: 1, id: target.id },
      { delta: { x: 0, y: b.y - rect.y - rect.h }, order: 2, id: target.id },
      { delta: { x: 0, y: b.y + b.h - rect.y }, order: 3, id: target.id },
    );
  }
  const distance = (delta: Point) => Math.abs(delta.x) + Math.abs(delta.y);
  candidates.sort(
    (a, b) => distance(a.delta) - distance(b.delta) || a.order - b.order || a.id - b.id,
  );
  for (const { delta } of candidates) {
    if (distance(delta) > MAX_CORRECTION) continue;
    const next = { ...rect, x: rect.x + delta.x, y: rect.y + delta.y };
    if (!inWorld(next)) continue;
    if (targets.some((target) => target.kind === "solid" && overlaps(next, target.rect))) continue;
    // Do not tunnel through a previously separate thin obstacle during correction.
    const blocked = targets.some((target) => {
      if (overlapping.has(target.id) || (target.kind === "one-way" && target.id === ignoredId))
        return false;
      const hit =
        target.kind === "solid"
          ? sweepAabb(rect, delta, target.rect)
          : sweepOneWay(rect, delta, target.rect);
      return hit?.kind === "hit" && hit.time.numerator < hit.time.denominator;
    });
    if (!blocked) return delta;
  }
  return null;
}

function support(
  rect: Rect,
  targets: readonly SweepTarget[],
  previousId: number | null,
  credited: ReadonlySet<number>,
  ignoredId?: number,
): number | null {
  const candidates = targets.filter((target) => {
    if (target.kind === "one-way" && target.id === ignoredId) return false;
    const gap = target.rect.y - rect.y - rect.h;
    // A one-subpixel gap is allowed only with a real earlier support/impact witness.
    return (
      gap >= 0 &&
      gap <= (credited.has(target.id) ? 1 : 0) &&
      rect.x < target.rect.x + target.rect.w &&
      rect.x + rect.w > target.rect.x
    );
  });
  return candidates.find((target) => target.id === previousId)?.id ?? candidates[0]?.id ?? null;
}

interface Constraint {
  id: number;
  normal: Normal;
  delta: Point;
}
/** A real coplanar face makes an adjacent corner's orthogonal constraint redundant.
 * Require exact current planes and equal remaining normal motion; unequal platforms
 * must still collide. Standalone corners keep both normals.
 */
function redundantSeam(
  rect: Rect,
  corner: Constraint,
  constraints: readonly Constraint[],
  byId: ReadonlyMap<number, SweepTarget>,
): boolean {
  const target = byId.get(corner.id);
  if (!target) return false;
  const axis = corner.normal.x !== 0 ? "y" : "x";
  const extent = axis === "x" ? "w" : "h";
  return constraints.some((face) => {
    const other = byId.get(face.id);
    if (!other || face.normal[axis] === 0 || !touching(rect, other, face.normal, 0)) return false;
    if (target.delta[axis] !== other.delta[axis]) return false;
    if (face.normal[axis] === -1)
      return (
        rect[axis] + rect[extent] === target.rect[axis] && target.rect[axis] === other.rect[axis]
      );
    return (
      rect[axis] === target.rect[axis] + target.rect[extent] &&
      target.rect[axis] + target.rect[extent] === other.rect[axis] + other.rect[extent]
    );
  });
}

function touching(rect: Rect, target: SweepTarget, normal: Normal, tolerance: number): boolean {
  const b = target.rect;
  const horizontal = rect.x < b.x + b.w && rect.x + rect.w > b.x;
  const vertical = rect.y < b.y + b.h && rect.y + rect.h > b.y;
  const gap =
    normal.x === -1
      ? b.x - rect.x - rect.w
      : normal.x === 1
        ? rect.x - b.x - b.w
        : normal.y === -1
          ? b.y - rect.y - rect.h
          : rect.y - b.y - b.h;
  return gap >= 0 && gap <= tolerance && (normal.x === 0 ? horizontal : vertical);
}

function closingTrap(
  rect: Rect,
  active: readonly Constraint[],
  targets: readonly SweepTarget[],
  byId: ReadonlyMap<number, SweepTarget>,
  remaining: Point,
  axis: "x" | "y",
): boolean {
  const otherAxis = axis === "x" ? "y" : "x";
  const otherSize = otherAxis === "x" ? "w" : "h";
  let lower = -MAX_MOTION;
  let upper = MAX_MOTION;
  for (const constraint of active) {
    if (constraint.normal[otherAxis] === 1) lower = Math.max(lower, constraint.delta[otherAxis]);
    if (constraint.normal[otherAxis] === -1) upper = Math.min(upper, constraint.delta[otherAxis]);
  }
  if (lower > upper) return false;
  const sideways = Math.max(lower, Math.min(upper, remaining[otherAxis]));
  return active.some((a) => {
    const left = byId.get(a.id);
    if (a.normal[axis] !== 1 || !left || !touching(rect, left, a.normal, 1)) return false;
    return active.some((b) => {
      const right = byId.get(b.id);
      if (b.normal[axis] !== -1 || !right || !touching(rect, right, b.normal, 1)) return false;
      const size = axis === "x" ? "w" : "h";
      const space = right.rect[axis] - left.rect[axis] - left.rect[size] - rect[size];
      const closing = a.delta[axis] - b.delta[axis];
      if (closing <= space) return false;
      // Trap closes at space/closing. Witnessed gaps total <=2 subpixels. Require
      // perpendicular overlap throughout that interval and rule out a prior side hit
      // that could change the trajectory. Products <=2^42, sums <=2^43.
      for (const target of [left, right]) {
        const relative = sideways - target.delta[otherAxis];
        if (
          (rect[otherAxis] - target.rect[otherAxis] - target.rect[otherSize]) * closing +
            relative * space >=
            0 ||
          (rect[otherAxis] + rect[otherSize] - target.rect[otherAxis]) * closing +
            relative * space <=
            0
        )
          return false;
      }
      return !targets.some((target) => {
        const relative = sideways - target.delta[otherAxis];
        if (relative === 0) return false;
        const distance =
          relative > 0
            ? target.rect[otherAxis] - rect[otherAxis] - rect[otherSize]
            : rect[otherAxis] - target.rect[otherAxis] - target.rect[otherSize];
        return distance >= 0 && distance * closing <= space * Math.abs(relative);
      });
    });
  });
}

/**
 * Bounded sweep/slide with moving obstacles and support carry. Each interval consumes
 * integer displacements toward its start, then requantizes every residual. No products
 * of denominators accumulate. A failed result is a partial pose, never an accepted
 * end-of-tick body; callers must resolve crush/recovery before advancing the world.
 */
export function moveKinematic(
  state: KinematicState,
  terrain: readonly SweepTarget[] | CollisionIndex,
  options: MovementOptions = {},
): MovementResult {
  const limit = integer(options.maxIterations ?? 4, 1, 4, "movement contact limit");
  if (state.supportId !== null) integer(state.supportId, 1, COUNTER_LIMIT - 1, "support ID");
  if (options.ignoredOneWayId !== undefined)
    integer(options.ignoredOneWayId, 1, COUNTER_LIMIT - 1, "ignored support ID");
  integer(state.rect.w, 1, MAX_POSITION, "body width");
  integer(state.rect.h, 1, MAX_POSITION, "body height");
  const index = terrain instanceof CollisionIndex ? terrain : undefined;
  index?.assertFrame(options.frame);
  const source = terrain instanceof CollisionIndex ? terrain.targets : terrain;
  const targets = source
    .map((target) => ({ ...target, rect: { ...target.rect }, delta: { ...target.delta } }))
    .sort((a, b) => a.id - b.id);
  const byId = new Map(targets.map((target) => [target.id, target]));
  const query = (rect: Rect, delta: Point) => {
    // Every residual target position remains inside its original swept bounds. Requery
    // the actual new body path after each collision; retain full geometry for support,
    // correction and closing-trap proof so broadphase cannot change those decisions.
    const candidates = index
      ? index.query(sweepBounds(rect, delta)).map((target) => {
          const current = byId.get(target.id);
          if (!current) throw new Error("Missing current collision target");
          return current;
        })
      : targets;
    return earliestSweep(rect, delta, candidates, options.ignoredOneWayId);
  };
  const initial = query(state.rect, state.motion);
  const correction = correctOverlap(state.rect, targets, initial.overlaps, options.ignoredOneWayId);
  const result: MovementResult = {
    rect: { ...state.rect },
    motion: { ...state.motion },
    supportId: null,
    status: "complete",
    contacts: [],
    correction: correction ?? { ...ZERO },
    remaining: { ...state.motion },
    iterations: 0,
    diagnosticIds: [],
  };
  if (!correction) return { ...result, status: "initial-overlap", diagnosticIds: initial.overlaps };
  result.rect = translate(result.rect, correction);
  const credited = new Set<number>(state.supportId === null ? [] : [state.supportId]);
  const startingSupport =
    state.motion.y < 0
      ? null
      : support(result.rect, targets, state.supportId, credited, options.ignoredOneWayId);
  const carry = byId.get(startingSupport ?? 0)?.delta ?? ZERO;
  // Authored platform speed + own controller motion must fit the existing tick bound.
  result.remaining = { x: motion(state.motion.x + carry.x), y: motion(state.motion.y + carry.y) };
  if (startingSupport !== null) credited.add(startingSupport);
  let active: Constraint[] = [];
  for (let iteration = 0; iteration < limit; iteration++) {
    const hits = query(result.rect, result.remaining);
    if (hits.overlaps.length)
      return { ...result, status: "residual-overlap", diagnosticIds: hits.overlaps };
    if (!hits.contacts.length) {
      result.rect = translate(result.rect, result.remaining);
      for (const target of targets) target.rect = translate(target.rect, target.delta);
      result.remaining = { ...ZERO };
      result.supportId =
        result.motion.y < 0
          ? null
          : support(result.rect, targets, startingSupport, credited, options.ignoredOneWayId);
      return result;
    }
    const first = hits.contacts[0];
    if (!first) throw new Error("Missing movement contact");
    result.iterations++;
    const moved = displacementAtContact(result.remaining, first.time);
    result.rect = translate(result.rect, moved);
    result.remaining = { x: result.remaining.x - moved.x, y: result.remaining.y - moved.y };
    for (const target of targets) {
      const movedTarget = displacementAtContact(target.delta, first.time);
      target.rect = translate(target.rect, movedTarget);
      target.delta = { x: target.delta.x - movedTarget.x, y: target.delta.y - movedTarget.y };
    }
    const current = hits.contacts.map((contact) => {
      result.contacts.push({ ...contact, iteration });
      if (contact.normal.y === -1) credited.add(contact.otherId);
      const target = byId.get(contact.otherId);
      if (!target) throw new Error("Missing contact target");
      return { id: target.id, normal: contact.normal, delta: target.delta };
    });
    // Keep only witnessed planes still touching; no proximity-based collision creation.
    active = active.flatMap((constraint) => {
      const target = byId.get(constraint.id);
      return target && touching(result.rect, target, constraint.normal, 1)
        ? [{ ...constraint, delta: target.delta }]
        : [];
    });
    const witnessed = [...active, ...current];
    for (const constraint of current) {
      if (redundantSeam(result.rect, constraint, witnessed, byId)) continue;
      if (
        !active.some(
          (item) =>
            item.id === constraint.id &&
            item.normal.x === constraint.normal.x &&
            item.normal.y === constraint.normal.y,
        )
      )
        active.push(constraint);
    }
    for (const axis of ["x", "y"] as const) {
      let lower = -MAX_MOTION;
      let upper = MAX_MOTION;
      for (const constraint of active) {
        const normal = constraint.normal[axis];
        if (normal === 1) lower = Math.max(lower, constraint.delta[axis]);
        if (normal === -1) upper = Math.min(upper, constraint.delta[axis]);
        if (result.motion[axis] * normal < 0) result.motion[axis] = 0;
      }
      if (lower > upper) {
        // Only already touching opposing faces prove crush. Conservative subpixel/corner
        // constraints may instead be unresolved; never turn numerical uncertainty into death.
        const exact = active.filter((constraint) => {
          const target = byId.get(constraint.id);
          return target && touching(result.rect, target, constraint.normal, 0);
        });
        const crush =
          exact.some(
            (a) =>
              a.normal[axis] === 1 &&
              exact.some((b) => b.normal[axis] === -1 && a.delta[axis] > b.delta[axis]),
          ) || closingTrap(result.rect, active, targets, byId, result.remaining, axis);
        return {
          ...result,
          status: crush ? "crushed" : "unresolved-contact",
          diagnosticIds: [
            ...new Set(
              active
                .filter((constraint) => constraint.normal[axis] !== 0)
                .map((constraint) => constraint.id),
            ),
          ].sort((a, b) => a - b),
        };
      }
      result.remaining[axis] = Math.max(lower, Math.min(upper, result.remaining[axis]));
    }
    if (
      result.remaining.x === 0 &&
      result.remaining.y === 0 &&
      targets.every((target) => target.delta.x === 0 && target.delta.y === 0)
    ) {
      result.supportId = support(
        result.rect,
        targets,
        startingSupport,
        credited,
        options.ignoredOneWayId,
      );
      return result;
    }
  }
  return {
    ...result,
    status: "contact-limit",
    diagnosticIds: [...new Set(result.contacts.map((contact) => contact.otherId))].sort(
      (a, b) => a - b,
    ),
  };
}
