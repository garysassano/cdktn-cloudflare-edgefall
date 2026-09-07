import type { ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, integer } from "../core/numeric.js";
import { blockingShapes, startSupport } from "../physics/body.js";
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
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`Player life: ${reason}`);
}
export function validatePlayerLife(actor: ControlledActor, tick: number, ruleset: RulesetId): void {
  integer(tick, 0, COUNTER_LIMIT - 1, "life tick");
  integer(actor.lifeStartTick, 0, tick, "life phase tick");
  integer(actor.lives, 0, ARCADE.initialLives, "player lives");
  const rule = RULE_PRESETS[ruleset];
  check(rule, "unknown ruleset");
  integer(actor.health, 0, rule.footHealth, "foot health");
  integer(actor.invulnerableTicks, 0, ARCADE.respawnProtectionTicks, "entry protection");
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
  actor.lifeStartTick = tick;
  actor.invulnerableTicks = 0;
  actor.body.vx = actor.body.vy = actor.body.remainderX = actor.body.remainderY = 0;
  clearAction(actor, tick);
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
  context: EntryContext,
) {
  validatePlayerLife(current, tick, ruleset);
  check(context.frame.tick === tick, "entry collision tick mismatch");
  let actor = structuredClone(current);
  actor.invulnerableTicks = Math.max(0, actor.invulnerableTicks - 1);
  actor.reboardCooldownTicks = Math.max(0, actor.reboardCooldownTicks - 1);
  if (actor.life === "death" && tick - actor.lifeStartTick >= ARCADE.deathTicks) {
    if (actor.lives === 0) {
      actor.life = "spectating";
      actor.lifeStartTick = tick;
      return { actor, notice: notice(actor, tick, "spectate") };
    }
    const entered = enterPlayer(actor, tick, ruleset, context);
    if (!entered) return { actor, notice: null };
    actor = entered;
    return { actor, notice: notice(actor, tick, "respawn") };
  }
  if (actor.life === "respawning" && tick - actor.lifeStartTick >= ARCADE.respawnEntryTicks) {
    actor.life = "alive";
    actor.lifeStartTick = tick;
    return { actor, notice: notice(actor, tick, "ready") };
  }
  return { actor, notice: null };
}
