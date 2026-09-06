import type { ActorDefinition, ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, integer, motion } from "../core/numeric.js";
import { HELD_MASK, directionalIntent } from "../input/types.js";
import { type BodyStep, startSupport, stepBody, tryBodyShape, worldRect } from "../physics/body.js";
import type { CollisionFrame, CollisionIndex } from "../physics/grid.js";
import { ARCADE } from "../rules.js";
import type { ControlledActor } from "../state.js";

/** Already admitted tick intent. The input/world owner deduplicates and acknowledges edges. */
export interface FootIntent {
  held: number;
  jumpPressed: boolean;
}
export interface FootEvent {
  kind: "jump" | "drop" | "land" | "leave-support";
  tick: number;
  supportId: number | null;
}
export type FootStep =
  | { status: "inactive"; actor: ControlledActor }
  | { status: "failed"; physics: Extract<BodyStep, { status: "failed" }> }
  | {
      status: "complete";
      actor: ControlledActor;
      events: FootEvent[];
      jumpRequest: "none" | "buffered" | "consumed" | "unavailable";
      physics: Extract<BodyStep, { status: "complete" }>;
    };

function clone(actor: ControlledActor): ControlledActor {
  return {
    ...actor,
    body: { ...actor.body, contacts: actor.body.contacts.map((contact) => ({ ...contact })) },
    action: { ...actor.action },
    weapon: { ...actor.weapon },
    processedEdgeIds: [...actor.processedEdgeIds],
  };
}
function required(shapes: ReadonlyMap<number, ShapeDefinition>, id: number): ShapeDefinition {
  const value = shapes.get(id);
  if (!value || value.id !== id) throw new Error(`Missing controller shape ${id}`);
  return value;
}

/** Pure one-tick on-foot locomotion. Combat, seat transitions and lifecycle remain world-owned. */
export function stepFootController(
  current: ControlledActor,
  intent: FootIntent,
  definition: ActorDefinition,
  shapes: ReadonlyMap<number, ShapeDefinition>,
  index: CollisionIndex,
  frame: CollisionFrame,
  controlsLocked = false,
): FootStep {
  index.assertFrame(frame);
  integer(intent.held, 0, HELD_MASK, "controller held mask");
  if (typeof intent.jumpPressed !== "boolean") throw new Error("Invalid jump edge intent");
  if (current.geometryRevision !== index.frame.geometryRevision)
    throw new Error("Controller geometry revision mismatch");
  integer(current.jumpBufferTicks, 0, ARCADE.jumpBufferTicks, "jump buffer");
  integer(current.coyoteTicks, 0, ARCADE.coyoteTicks, "coyote timer");
  integer(current.ignoredSupportTicks, 0, ARCADE.dropThroughTicks, "drop timer");
  if (current.ignoredSupportId !== null)
    integer(current.ignoredSupportId, 1, COUNTER_LIMIT - 1, "ignored support ID");
  const actor = clone(current);
  if (
    actor.life !== "alive" ||
    actor.vehicleId !== null ||
    actor.locomotion === "seated" ||
    actor.action.kind === "enter" ||
    actor.action.kind === "exit"
  )
    return { status: "inactive", actor };
  if (
    definition.locomotion !== "grounded" ||
    definition.gravity <= 0 ||
    definition.jumpVelocity + definition.gravity >= 0 ||
    definition.terminalVelocity <= 0 ||
    definition.runSpeed < 0
  )
    throw new Error("Invalid foot controller definition");
  for (const value of [
    definition.gravity,
    definition.jumpVelocity,
    definition.terminalVelocity,
    definition.runSpeed,
  ])
    motion(value);
  const standing = required(shapes, definition.standingShapeId);
  const crouched = required(shapes, definition.crouchedShapeId);
  if (
    standing.rect.y + standing.rect.h !== 0 ||
    crouched.rect.y + crouched.rect.h !== 0 ||
    crouched.rect.y < standing.rect.y ||
    crouched.rect.x < standing.rect.x ||
    crouched.rect.x + crouched.rect.w > standing.rect.x + standing.rect.w
  )
    throw new Error("Controller stances must share feet and crouch within standing bounds");
  if (actor.body.shapeId !== standing.id && actor.body.shapeId !== crouched.id)
    throw new Error("Unknown controller stance");
  // Integer per-tick velocity needs no fractional integrator state. Do not silently
  // consume a checkpoint from a different, unspecified remainder policy.
  if (actor.body.remainderX !== 0 || actor.body.remainderY !== 0)
    throw new Error("Unsupported controller motion remainder");
  let shape = required(shapes, actor.body.shapeId);
  if (actor.ignoredSupportTicks === 0 || !index.get(actor.ignoredSupportId ?? 0)) {
    actor.ignoredSupportId = null;
    actor.ignoredSupportTicks = 0;
  }
  const touchingSupport = startSupport(
    actor.body,
    shape,
    actor.facing,
    index,
    frame,
    actor.ignoredSupportId,
  );
  const support = actor.body.vy < 0 ? null : touchingSupport;
  const wasGrounded = current.body.grounded;
  actor.body.supportId = support;
  actor.body.grounded = support !== null;
  const locked = controlsLocked || actor.action.kind === "hurt";
  const held = locked ? 0 : intent.held;
  const direction = directionalIntent(held, actor.facing, support !== null);
  if (locked) actor.jumpBufferTicks = 0;
  else if (intent.jumpPressed) actor.jumpBufferTicks = ARCADE.jumpBufferTicks;
  if (support !== null) actor.coyoteTicks = ARCADE.coyoteTicks;
  let jumpRequest: "none" | "buffered" | "consumed" | "unavailable" = intent.jumpPressed
    ? locked
      ? "unavailable"
      : "buffered"
    : "none";
  const supportTarget = index.get(support ?? 0);
  const canJump =
    !locked && actor.jumpBufferTicks > 0 && (support !== null || actor.coyoteTicks > 0);
  let dropping = canJump && direction.vertical > 0 && supportTarget?.kind === "one-way";
  let dropQueuedAtEnd = false;
  let isCrouched =
    actor.locomotion === "crouched" || (crouched.id !== standing.id && shape.id === crouched.id);
  const wantsCrouch = locked ? isCrouched : direction.crouch && (!canJump || dropping);
  const desired = wantsCrouch ? crouched : standing;
  const nextFacing = locked ? actor.facing : direction.facing;
  let changed = tryBodyShape(actor.body, shape, desired, actor.facing, nextFacing, index, frame);
  if (!changed.accepted && desired.id === standing.id && isCrouched)
    changed = tryBodyShape(actor.body, shape, crouched, actor.facing, nextFacing, index, frame);
  if (changed.accepted) {
    actor.body = changed.body;
    actor.facing = changed.facing;
    shape = required(shapes, actor.body.shapeId);
    isCrouched = shape.id === crouched.id && (standing.id !== crouched.id || wantsCrouch);
  }
  actor.body.vx = locked
    ? actor.action.kind === "hurt"
      ? actor.body.vx
      : 0
    : isCrouched && support !== null
      ? 0
      : direction.horizontal * definition.runSpeed;
  actor.body.vy = Math.min(definition.terminalVelocity, actor.body.vy + definition.gravity);
  const events: FootEvent[] = [];
  let jumped = false;
  if (dropping) {
    actor.ignoredSupportId = support;
    actor.ignoredSupportTicks = ARCADE.dropThroughTicks;
    actor.body.supportId = null;
    actor.body.grounded = false;
    actor.body.vy = Math.max(definition.gravity, actor.body.vy);
    actor.jumpBufferTicks = 0;
    actor.coyoteTicks = 0;
    jumpRequest = "consumed";
    events.push({ kind: "drop", tick: frame.tick, supportId: support });
  } else if (canJump && !isCrouched) {
    // Impulse precedes this tick's gravity. Buffered launches prepared at the previous
    // tick end follow the same integration order and therefore have the same arc.
    actor.body.vy = definition.jumpVelocity + definition.gravity;
    actor.body.supportId = null;
    actor.body.grounded = false;
    actor.jumpBufferTicks = 0;
    actor.coyoteTicks = 0;
    jumped = true;
    jumpRequest = "consumed";
    events.push({ kind: "jump", tick: frame.tick, supportId: support });
  }
  const physics = stepBody(actor.body, shape, actor.facing, index, {
    frame,
    ...(actor.ignoredSupportId === null ? {} : { ignoredOneWayId: actor.ignoredSupportId }),
  });
  if (physics.status !== "complete") return { status: "failed", physics };
  actor.body = physics.body;
  const landed = support === null && actor.body.grounded;
  if (landed) events.push({ kind: "land", tick: frame.tick, supportId: actor.body.supportId });
  if ((support !== null || wasGrounded) && !actor.body.grounded && !jumped && !dropping)
    events.push({
      kind: "leave-support",
      tick: frame.tick,
      supportId: support ?? current.body.supportId,
    });
  // Landing completes this tick's displacement. A buffered jump sets the next velocity
  // immediately; it must not advance platforms or consume another simulation tick.
  if (!locked && actor.body.grounded && direction.vertical > 0) {
    const crouchAtEnd = tryBodyShape(
      actor.body,
      shape,
      crouched,
      actor.facing,
      actor.facing,
      index,
      frame,
      "end",
    );
    if (crouchAtEnd.accepted) {
      actor.body = crouchAtEnd.body;
      shape = crouched;
      isCrouched = true;
    }
  }
  if (!locked && actor.body.grounded && actor.jumpBufferTicks > 0) {
    const landedOn = actor.body.supportId;
    const landedTarget = index.get(landedOn ?? 0);
    if (direction.vertical > 0 && landedTarget?.kind === "one-way") {
      actor.ignoredSupportId = landedOn;
      actor.ignoredSupportTicks = ARCADE.dropThroughTicks;
      actor.body = { ...actor.body, vy: 0, grounded: false, supportId: null };
      actor.jumpBufferTicks = 0;
      actor.coyoteTicks = 0;
      dropping = true;
      dropQueuedAtEnd = true;
      jumpRequest = "consumed";
      events.push({ kind: "drop", tick: frame.tick, supportId: landedOn });
    } else {
      const standingAtEnd = tryBodyShape(
        actor.body,
        shape,
        standing,
        actor.facing,
        actor.facing,
        index,
        frame,
        "end",
      );
      if (standingAtEnd.accepted) {
        actor.body = {
          ...standingAtEnd.body,
          vy: definition.jumpVelocity,
          supportId: null,
          grounded: false,
        };
        shape = standing;
        isCrouched = false;
        actor.jumpBufferTicks = 0;
        actor.coyoteTicks = 0;
        jumped = true;
        jumpRequest = "consumed";
        events.push({ kind: "jump", tick: frame.tick, supportId: landedOn });
      }
    }
  }
  if (!jumped && !dropping)
    actor.coyoteTicks =
      actor.body.grounded || support !== null
        ? ARCADE.coyoteTicks
        : Math.max(0, actor.coyoteTicks - 1);
  actor.jumpBufferTicks = Math.max(0, actor.jumpBufferTicks - 1);
  if (actor.ignoredSupportId !== null) {
    if (!dropQueuedAtEnd) actor.ignoredSupportTicks = Math.max(0, actor.ignoredSupportTicks - 1);
    const ignored = index.get(actor.ignoredSupportId);
    const feet = worldRect(actor.body, shape.rect, actor.facing);
    if (
      !ignored ||
      actor.ignoredSupportTicks === 0 ||
      feet.y + feet.h > ignored.rect.y + ignored.delta.y + ignored.rect.h
    ) {
      actor.ignoredSupportId = null;
      actor.ignoredSupportTicks = 0;
    }
  }
  actor.locomotion = actor.body.grounded ? (isCrouched ? "crouched" : "grounded") : "airborne";
  if (!locked) actor.aim = directionalIntent(held, actor.facing, actor.body.grounded).aim;
  return { status: "complete", actor, events, jumpRequest, physics };
}
