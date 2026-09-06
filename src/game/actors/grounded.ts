import type { ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, integer, motion, position } from "../core/numeric.js";
import { type BodyStep, startSupport, stepBody, tryBodyShape, worldRect } from "../physics/body.js";
import type { CollisionFrame, CollisionIndex } from "../physics/grid.js";
import { sweepBounds } from "../physics/sweep.js";
import type { Body, Rect } from "../state.js";

/** Grounded patrol foundation. Combat, authored traversal links and encounter credit are separate owners. */
export interface GroundedEnemy {
  body: Body;
  facing: -1 | 1;
  geometryRevision: number;
  life: "alive" | "removed";
  removalReason: "crushed" | "out-of-bounds" | null;
  turns: number;
}
export interface PatrolDefinition {
  speed: number;
  gravity: number;
  terminalVelocity: number;
  /** Inclusive root bounds, authored by the world. */
  bounds: Rect;
}
export type GroundedStep =
  | {
      status: "complete";
      enemy: GroundedEnemy;
      decision: "walk" | "turn" | "fall" | "removed";
      physics: BodyStep | null;
    }
  | { status: "failed"; physics: Extract<BodyStep, { status: "failed" }> };

/** Require continuous leading-foot support across the intended step in the support frame. */
function hasLeadingSupport(
  body: Body,
  shape: ShapeDefinition,
  facing: -1 | 1,
  speed: number,
  supportId: number,
  index: CollisionIndex,
  frame: CollisionFrame,
): boolean {
  index.assertFrame(frame);
  const support = index.get(supportId);
  if (!support) return false;
  const projected = worldRect(
    {
      x: position(body.x + speed * facing + support.delta.x),
      y: position(body.y + support.delta.y),
    },
    shape.rect,
    facing,
  );
  const lead = facing === 1 ? projected.x + projected.w - 1 : projected.x;
  const feet = projected.y + projected.h;
  const previousLead = lead - speed * facing;
  const first = Math.min(previousLead, lead);
  const last = Math.max(previousLead, lead);
  const spans = index
    .query(sweepBounds({ x: first, y: feet, w: last - first + 1, h: 1 }))
    .filter((target) => {
      // Traversal between independently moving supports requires an authored trajectory link.
      if (target.delta.x !== support.delta.x || target.delta.y !== support.delta.y) return false;
      const gap = target.rect.y + target.delta.y - feet;
      return gap >= 0 && gap <= (target.id === supportId ? 1 : 0);
    })
    .map((target) => ({
      start: target.rect.x + target.delta.x,
      end: target.rect.x + target.delta.x + target.rect.w,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = first;
  for (const span of spans) {
    if (span.end <= cursor) continue;
    if (span.start > cursor) return false;
    cursor = span.end;
    if (cursor > last) return true;
  }
  return false;
}

export function stepGroundedEnemy(
  current: GroundedEnemy,
  definition: PatrolDefinition,
  shape: ShapeDefinition,
  index: CollisionIndex,
  frame: CollisionFrame,
): GroundedStep {
  index.assertFrame(frame);
  if (current.geometryRevision !== frame.geometryRevision)
    throw new Error("Enemy geometry revision mismatch");
  integer(current.turns, 0, COUNTER_LIMIT - 2, "enemy turns");
  motion(definition.speed);
  motion(definition.gravity);
  motion(definition.terminalVelocity);
  if (definition.speed < 0 || definition.gravity <= 0 || definition.terminalVelocity <= 0)
    throw new Error("Invalid grounded patrol motion");
  for (const value of [
    definition.bounds.x,
    definition.bounds.y,
    definition.bounds.x + definition.bounds.w,
    definition.bounds.y + definition.bounds.h,
  ])
    position(value);
  if (definition.bounds.w <= 0 || definition.bounds.h <= 0)
    throw new Error("Invalid patrol bounds");
  if (current.life === "removed")
    return { status: "complete", enemy: current, decision: "removed", physics: null };
  const body = { ...current.body, contacts: [...current.body.contacts] };
  if (body.remainderX !== 0 || body.remainderY !== 0)
    throw new Error("Patrol requires integral motion");
  const supportId =
    body.vy >= 0 ? startSupport(body, shape, current.facing, index, frame, null) : null;
  body.supportId = supportId;
  body.grounded = supportId !== null;
  let facing = current.facing;
  let decision: "walk" | "turn" | "fall" = supportId === null ? "fall" : "walk";
  let turns = current.turns;
  if (supportId !== null) {
    const rect = worldRect(body, shape.rect, facing);
    const blocked = body.contacts.some((contact) => {
      const target = index.get(contact.otherId);
      if (target?.kind !== "solid" || contact.normalX !== -facing) return false;
      const gap =
        facing === 1 ? target.rect.x - rect.x - rect.w : rect.x - target.rect.x - target.rect.w;
      return (
        gap >= 0 &&
        gap <= 1 &&
        rect.y < target.rect.y + target.rect.h &&
        rect.y + rect.h > target.rect.y
      );
    });
    if (
      blocked ||
      !hasLeadingSupport(body, shape, facing, definition.speed, supportId, index, frame)
    ) {
      decision = "turn";
      const nextFacing = facing === 1 ? -1 : 1;
      const turn = tryBodyShape(body, shape, shape, facing, nextFacing, index, frame);
      if (turn.accepted) {
        facing = nextFacing;
        body.contacts = [];
        turns++;
      }
      body.vx = 0;
    } else body.vx = definition.speed * facing;
    body.vy = 0;
  }
  body.vy = motion(Math.min(definition.terminalVelocity, body.vy + definition.gravity));
  const physics = stepBody(body, shape, facing, index, { frame });
  if (physics.status === "failed") {
    if (physics.reason !== "crushed") return { status: "failed", physics };
    return {
      status: "complete",
      enemy: { ...current, life: "removed", removalReason: "crushed" },
      decision: "removed",
      physics,
    };
  }
  const next = physics.body;
  const bounds = definition.bounds;
  const outside =
    next.x < bounds.x ||
    next.x > bounds.x + bounds.w ||
    next.y < bounds.y ||
    next.y > bounds.y + bounds.h;
  return {
    status: "complete",
    enemy: {
      ...current,
      body: next,
      facing,
      turns,
      life: outside ? "removed" : "alive",
      removalReason: outside ? "out-of-bounds" : null,
    },
    decision: outside ? "removed" : decision,
    physics,
  };
}
