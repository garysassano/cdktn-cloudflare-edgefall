import type { ShapeDefinition } from "../content/schema.js";
import {
  COUNTER_LIMIT,
  MAX_POSITION,
  MAX_SHAPE,
  integer,
  motion,
  position,
} from "../core/numeric.js";
import type { Body, Contact, Point, Rect } from "../state.js";
import type { CollisionFrame, CollisionIndex } from "./grid.js";
import { type MovementOptions, type MovementResult, moveKinematic } from "./move.js";
import { sweepAabb, sweepBounds } from "./sweep.js";

export type Facing = -1 | 1;
type Phase = "start" | "end";
const ZERO = { x: 0, y: 0 };
const NORMALS = [
  { x: -1, y: 0 },
  { x: 1, y: 0 },
  { x: 0, y: -1 },
  { x: 0, y: 1 },
] as const;

export function validateLocalRect(rect: Rect): void {
  integer(rect.x, -MAX_SHAPE, MAX_SHAPE, "local x");
  integer(rect.y, -MAX_SHAPE, MAX_SHAPE, "local y");
  integer(rect.w, 1, MAX_SHAPE, "local width");
  integer(rect.h, 1, MAX_SHAPE, "local height");
  integer(rect.x + rect.w, -MAX_SHAPE, MAX_SHAPE, "local right edge");
  integer(rect.y + rect.h, -MAX_SHAPE, MAX_SHAPE, "local bottom edge");
}
function facing(value: Facing): void {
  if (value !== -1 && value !== 1) throw new Error("Invalid body facing");
}

/** Reflect about the same root as sockets; never about a texture or a rectangle's center. */
export function worldRect(root: Point, local: Rect, direction: Facing): Rect {
  facing(direction);
  validateLocalRect(local);
  position(root.x);
  position(root.y);
  const rect = {
    x: position(root.x + (direction === 1 ? local.x : -local.x - local.w)),
    y: position(root.y + local.y),
    w: local.w,
    h: local.h,
  };
  position(rect.x + rect.w);
  position(rect.y + rect.h);
  return rect;
}
export function worldSocket(root: Point, local: Point, direction: Facing): Point {
  facing(direction);
  position(root.x);
  position(root.y);
  integer(local.x, -MAX_SHAPE, MAX_SHAPE, "socket x");
  integer(local.y, -MAX_SHAPE, MAX_SHAPE, "socket y");
  return { x: position(root.x + local.x * direction), y: position(root.y + local.y) };
}
function bodyRect(body: Body, shape: ShapeDefinition, direction: Facing): Rect {
  integer(body.id, 1, COUNTER_LIMIT - 1, "body ID");
  integer(shape.id, 1, COUNTER_LIMIT - 1, "shape ID");
  if (body.shapeId !== shape.id) throw new Error("Body/shape identity mismatch");
  if (body.grounded !== (body.supportId !== null)) throw new Error("Ground/support mismatch");
  if (body.supportId !== null) integer(body.supportId, 1, COUNTER_LIMIT - 1, "body support ID");
  motion(body.vx);
  motion(body.vy);
  motion(body.remainderX);
  motion(body.remainderY);
  return worldRect(body, shape.rect, direction);
}
function targetRect(rect: Rect, delta: Point, phase: Phase): Rect {
  return phase === "start" ? rect : { ...rect, x: rect.x + delta.x, y: rect.y + delta.y };
}

function poseCandidates(rect: Rect, index: CollisionIndex) {
  return index.query({
    minX: Math.max(-MAX_POSITION, rect.x - 1),
    minY: Math.max(-MAX_POSITION, rect.y - 1),
    maxX: Math.min(MAX_POSITION, rect.x + rect.w + 1),
    maxY: Math.min(MAX_POSITION, rect.y + rect.h + 1),
  });
}

export function blockingShapes(
  root: Point,
  local: Rect,
  direction: Facing,
  index: CollisionIndex,
  frame: CollisionFrame,
  phase: Phase = "start",
): number[] {
  index.assertFrame(frame);
  const proposed = worldRect(root, local, direction);
  return index
    .query(sweepBounds(proposed))
    .filter(
      (target) =>
        target.kind === "solid" &&
        sweepAabb(proposed, ZERO, targetRect(target.rect, target.delta, phase))?.kind === "overlap",
    )
    .map((target) => target.id);
}

/** A stance/turn changes only the collider/facing; the caller's root never moves. */
export function tryBodyShape(
  body: Body,
  current: ShapeDefinition,
  desired: ShapeDefinition,
  oldFacing: Facing,
  nextFacing: Facing,
  index: CollisionIndex,
  frame: CollisionFrame,
  phase: Phase = "start",
) {
  bodyRect(body, current, oldFacing);
  validateLocalRect(desired.rect);
  integer(desired.id, 1, COUNTER_LIMIT - 1, "desired shape ID");
  if (current.rect.y + current.rect.h !== desired.rect.y + desired.rect.h)
    throw new Error("Stance changes the feet anchor");
  const blockedBy = blockingShapes(body, desired.rect, nextFacing, index, frame, phase);
  return blockedBy.length
    ? { accepted: false as const, blockedBy, body, facing: oldFacing }
    : {
        accepted: true as const,
        blockedBy,
        body: {
          ...body,
          shapeId: desired.id,
          contacts: desired.id !== current.id || oldFacing !== nextFacing ? [] : body.contacts,
        },
        facing: nextFacing,
      };
}

/** Start-of-tick support validation, including explicit witnesses for a one-subpixel gap. */
export function startSupport(
  body: Body,
  shape: ShapeDefinition,
  direction: Facing,
  index: CollisionIndex,
  frame: CollisionFrame,
  ignoredId: number | null,
): number | null {
  index.assertFrame(frame);
  const rect = bodyRect(body, shape, direction);
  const candidates = poseCandidates(rect, index).filter((target) => {
    if (target.kind === "one-way" && target.id === ignoredId) return false;
    const gap = target.rect.y - rect.y - rect.h;
    return (
      gap >= 0 &&
      gap <= (target.id === body.supportId ? 1 : 0) &&
      rect.x < target.rect.x + target.rect.w &&
      rect.x + rect.w > target.rect.x
    );
  });
  return candidates.find((target) => target.id === body.supportId)?.id ?? candidates[0]?.id ?? null;
}

function endContacts(rect: Rect, movement: MovementResult, index: CollisionIndex): Contact[] {
  const result: Contact[] = [];
  const candidates = poseCandidates(rect, index);
  const witnesses = new Set(
    movement.contacts.map(
      (contact) => `${contact.otherId}:${contact.normal.x}:${contact.normal.y}`,
    ),
  );
  for (const normal of NORMALS) {
    const matching = candidates.filter((target) => {
      const witnessed = witnesses.has(`${target.id}:${normal.x}:${normal.y}`);
      const supported = normal.y === -1 && movement.supportId === target.id;
      if (target.kind === "one-way" && !(normal.y === -1 && (witnessed || supported))) return false;
      const b = targetRect(target.rect, target.delta, "end");
      const gap =
        normal.x === -1
          ? b.x - rect.x - rect.w
          : normal.x === 1
            ? rect.x - b.x - b.w
            : normal.y === -1
              ? b.y - rect.y - rect.h
              : rect.y - b.y - b.h;
      return (
        gap >= 0 &&
        gap <= (witnessed || supported ? 1 : 0) &&
        (normal.x === 0
          ? rect.x < b.x + b.w && rect.x + rect.w > b.x
          : rect.y < b.y + b.h && rect.y + rect.h > b.y)
      );
    });
    const target =
      (normal.y === -1 ? matching.find((target) => target.id === movement.supportId) : undefined) ??
      matching[0];
    if (target)
      result.push({
        otherId: target.id,
        normalX: normal.x,
        normalY: normal.y,
        toiNumerator: 1,
        toiDenominator: 1,
        kind: target.kind,
      });
  }
  return result.sort(
    (a, b) => a.otherId - b.otherId || a.normalX - b.normalX || a.normalY - b.normalY,
  );
}

export type BodyStep =
  | { status: "complete"; body: Body; movement: MovementResult }
  | {
      status: "failed";
      reason: Exclude<MovementResult["status"], "complete">;
      movement: MovementResult;
    };

export function stepBody(
  body: Body,
  shape: ShapeDefinition,
  direction: Facing,
  index: CollisionIndex,
  options: MovementOptions & { frame: CollisionFrame },
): BodyStep {
  const rect = bodyRect(body, shape, direction);
  const movement = moveKinematic(
    { rect, motion: { x: body.vx, y: body.vy }, supportId: body.supportId },
    index,
    options,
  );
  if (movement.status !== "complete")
    return { status: "failed", reason: movement.status, movement };
  return {
    status: "complete",
    movement,
    body: {
      ...body,
      x: position(body.x + movement.rect.x - rect.x),
      y: position(body.y + movement.rect.y - rect.y),
      vx: movement.motion.x,
      vy: movement.motion.y,
      supportId: movement.supportId,
      grounded: movement.supportId !== null,
      contacts: endContacts(movement.rect, movement, index),
    },
  };
}
