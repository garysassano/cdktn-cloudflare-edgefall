import type { ActorDefinition, ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, integer, motion, position } from "../core/numeric.js";
import { blockingShapes, startSupport, stepBody } from "../physics/body.js";
import type { CollisionFrame, CollisionIndex } from "../physics/grid.js";
import { ARCADE, RULE_PRESETS, type RulesetId } from "../rules.js";
import type { Body, ControlledActor, Point } from "../state.js";

export interface LifeNotice {
  kind: "death" | "respawn" | "spectate" | "ready";
  tick: number;
  playerId: number;
  lives: number;
}
export interface EntryContext {
  shape: ShapeDefinition;
  anchors: readonly Point[];
  index: CollisionIndex;
  frame: CollisionFrame;
}
export interface PlayerLifeContext extends EntryContext {
  definition: ActorDefinition;
  shapes: ReadonlyMap<number, ShapeDefinition>;
  fallBoundary: number;
}
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`Player life: ${reason}`);
}
/** Shared by lifecycle and wire validation; removed bodies retain a bounded last position. */
export function validDeathBody(actor: ControlledActor): boolean {
  if (actor.life !== "death") return actor.deathBody === null;
  if (actor.vehicleId !== null || actor.action.kind !== "ready") return false;
  if (actor.deathBody === "present") return true;
  const body = actor.body;
  return (
    actor.deathBody === "removed" &&
    actor.locomotion === "airborne" &&
    body.vx === 0 &&
    body.vy === 0 &&
    body.remainderX === 0 &&
    body.remainderY === 0 &&
    !body.grounded &&
    body.supportId === null &&
    body.contacts.length === 0
  );
}
export function validatePlayerLife(actor: ControlledActor, tick: number, ruleset: RulesetId): void {
  integer(tick, 0, COUNTER_LIMIT - 1, "life tick");
  integer(actor.lifeStartTick, 0, tick, "life phase tick");
  integer(actor.lives, 0, ARCADE.initialLives, "player lives");
  const rule = RULE_PRESETS[ruleset];
  check(rule, "unknown ruleset");
  integer(actor.health, 0, rule.footHealth, "foot health");
  integer(actor.invulnerableTicks, 0, ARCADE.respawnProtectionTicks, "entry protection");
  check(validDeathBody(actor), "inconsistent death body");
  check(
    actor.life === "alive" || actor.life === "respawning"
      ? actor.health > 0 && actor.lives > 0
      : actor.life === "death" || actor.life === "spectating"
        ? actor.health === 0 && (actor.life !== "spectating" || actor.lives === 0)
        : false,
    "inconsistent life state",
  );
}
function notice(actor: ControlledActor, tick: number, kind: LifeNotice["kind"]): LifeNotice {
  return { kind, tick, playerId: actor.playerId, lives: actor.lives };
}
function clearAction(actor: ControlledActor, tick: number) {
  actor.firearmAim = { pitch: 0, nextStepTick: 0 };
  actor.action = {
    kind: "ready",
    actionInstanceId: 0,
    stateStartTick: tick,
    definitionId: 0,
    nextMarkerIndex: 0,
  };
  actor.jumpBufferTicks = 0;
  actor.coyoteTicks = 0;
  actor.ignoredSupportId = null;
  actor.ignoredSupportTicks = 0;
}
function removeDeathBody(actor: ControlledActor): void {
  actor.deathBody = "removed";
  actor.body.vx = actor.body.vy = actor.body.remainderX = actor.body.remainderY = 0;
  actor.body.grounded = false;
  actor.body.supportId = null;
  actor.body.contacts = [];
  actor.locomotion = "airborne";
}
/** Passive motion uses the same swept solver and support carry, with no input or action admission. */
function stepDeathBody(actor: ControlledActor, context: PlayerLifeContext): void {
  if (actor.deathBody !== "present") return;
  const { definition, shapes, index, frame, fallBoundary } = context;
  position(fallBoundary);
  check(
    definition.locomotion === "grounded" &&
      definition.gravity > 0 &&
      definition.terminalVelocity > 0,
    "invalid death body physics",
  );
  motion(definition.gravity);
  motion(definition.terminalVelocity);
  check(
    actor.body.remainderX === 0 && actor.body.remainderY === 0,
    "unsupported death body remainder",
  );
  const shape = shapes.get(actor.body.shapeId);
  check(
    shape && (shape.id === definition.standingShapeId || shape.id === definition.crouchedShapeId),
    "unknown death body shape",
  );
  if (actor.body.y > fallBoundary) {
    removeDeathBody(actor);
    return;
  }
  const support =
    actor.body.vy < 0 ? null : startSupport(actor.body, shape, actor.facing, index, frame, null);
  actor.body.supportId = support;
  actor.body.grounded = support !== null;
  if (support !== null) actor.body.vx = 0;
  actor.body.vy = Math.min(definition.terminalVelocity, actor.body.vy + definition.gravity);
  const result = stepBody(actor.body, shape, actor.facing, index, { frame });
  // A corpse cannot hold the room in a failed collision tick. Retire it at its last
  // valid position when crush or bounded overlap/contact recovery cannot resolve.
  if (result.status === "failed") {
    removeDeathBody(actor);
    return;
  }
  actor.body = result.body;
  if (actor.body.y > fallBoundary) removeDeathBody(actor);
  else {
    actor.locomotion = actor.body.grounded ? "grounded" : "airborne";
    if (actor.body.grounded) actor.body.vx = 0;
  }
}
/** Damage is an authoritative collision outcome. Repeated hits cannot decrement a dead life again. */
export function damagePlayer(
  current: ControlledActor,
  tick: number,
  damage: number,
  ruleset: RulesetId,
  cause: "hit" | "fall" = "hit",
) {
  validatePlayerLife(current, tick, ruleset);
  integer(damage, 1, 65535, "player damage");
  check(cause === "hit" || cause === "fall", "unknown damage cause");
  const actor = structuredClone(current);
  if (actor.life !== "alive" || (cause === "hit" && actor.invulnerableTicks > 0))
    return { actor, notice: null };
  check(actor.vehicleId === null, "vehicle damage requires the vehicle owner");
  actor.health = cause === "fall" ? 0 : Math.max(0, actor.health - damage);
  if (actor.health > 0) return { actor, notice: null };
  actor.lives--;
  actor.life = "death";
  actor.deathBody = "present";
  actor.lifeStartTick = tick;
  actor.invulnerableTicks = 0;
  clearAction(actor, tick);
  if (cause === "fall") removeDeathBody(actor);
  else if (actor.body.grounded) actor.body.vx = 0;
  return { actor, notice: notice(actor, tick, "death") };
}

/** Authored candidates are checked against the current collision frame, in declared priority order. */
export function entryBody(actor: ControlledActor, context: EntryContext): Body | null {
  context.index.assertFrame(context.frame);
  integer(context.anchors.length, 1, 16, "checkpoint anchor count");
  check(context.shape.rect.y + context.shape.rect.h === 0, "entry shape must use a feet anchor");
  for (const point of context.anchors) {
    if (
      blockingShapes(point, context.shape.rect, actor.facing, context.index, context.frame).length
    )
      continue;
    const body: Body = {
      ...actor.body,
      ...point,
      vx: 0,
      vy: 0,
      remainderX: 0,
      remainderY: 0,
      shapeId: context.shape.id,
      supportId: null,
      grounded: false,
      contacts: [],
    };
    const support = startSupport(
      body,
      context.shape,
      actor.facing,
      context.index,
      context.frame,
      null,
    );
    if (support === null) continue;
    body.supportId = support;
    body.grounded = true;
    return body;
  }
  return null;
}
/** Shared by ordinary respawn and campaign checkpoint resets; no life is granted here. */
export function enterPlayer(
  current: ControlledActor,
  tick: number,
  ruleset: RulesetId,
  context: EntryContext,
) {
  integer(current.lives, 1, ARCADE.initialLives, "entry lives");
  integer(tick, current.lifeStartTick, COUNTER_LIMIT - 1, "entry tick");
  check(context.frame.tick === tick, "entry collision tick mismatch");
  check(RULE_PRESETS[ruleset], "unknown ruleset");
  check(current.vehicleId === null, "vehicle seat must be released before entry");
  const body = entryBody(current, context);
  if (!body) return null;
  const actor = structuredClone(current);
  actor.body = body;
  actor.geometryRevision = context.frame.geometryRevision;
  actor.life = "respawning";
  actor.deathBody = null;
  actor.lifeStartTick = tick;
  actor.locomotion = "grounded";
  actor.health = RULE_PRESETS[ruleset].footHealth;
  actor.invulnerableTicks = ARCADE.respawnProtectionTicks;
  actor.weapon = {
    id: "sidearm",
    ammo: 0,
    cooldownTicks: 0,
    shotOrdinal: current.weapon.shotOrdinal,
    lastActionInstanceId: current.weapon.lastActionInstanceId,
  };
  actor.grenadeStock = ARCADE.initialGrenades;
  actor.grenadeCooldownTicks =
    actor.meleeCooldownTicks =
    actor.reboardCooldownTicks =
    actor.vehicleSpecialTicks =
      0;
  clearAction(actor, tick);
  return actor;
}
/** One world-owned tick. A blocked checkpoint waits without spending or granting another life. */
export function stepPlayerLife(
  current: ControlledActor,
  tick: number,
  ruleset: RulesetId,
  context: PlayerLifeContext,
) {
  validatePlayerLife(current, tick, ruleset);
  check(context.frame.tick === tick, "entry collision tick mismatch");
  context.index.assertFrame(context.frame);
  check(
    current.geometryRevision === context.frame.geometryRevision,
    "life geometry revision mismatch",
  );
  const actor = structuredClone(current);
  actor.invulnerableTicks = Math.max(0, actor.invulnerableTicks - 1);
  actor.reboardCooldownTicks = Math.max(0, actor.reboardCooldownTicks - 1);
  if (actor.life === "death" && tick - actor.lifeStartTick >= ARCADE.deathTicks) {
    if (actor.lives === 0) {
      removeDeathBody(actor);
      actor.life = "spectating";
      actor.deathBody = null;
      actor.lifeStartTick = tick;
      return { actor, notice: notice(actor, tick, "spectate") };
    }
    const entered = enterPlayer(actor, tick, ruleset, context);
    if (entered) return { actor: entered, notice: notice(entered, tick, "respawn") };
  }
  if (actor.life === "respawning" && tick - actor.lifeStartTick >= ARCADE.respawnEntryTicks) {
    actor.life = "alive";
    actor.lifeStartTick = tick;
    return { actor, notice: notice(actor, tick, "ready") };
  }
  if (actor.life === "death") stepDeathBody(actor, context);
  return { actor, notice: null };
}
