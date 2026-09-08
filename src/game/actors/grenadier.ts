import type { ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, integer, motion, nextCounter, pixels } from "../core/numeric.js";
import { worldRect, worldSocket } from "../physics/body.js";
import { type SweepTarget, earliestSweep } from "../physics/sweep.js";
import type { ControlledActor, Point } from "../state.js";
import type { GroundedEnemy } from "./grounded.js";

export interface GrenadierProfile {
  windupTicks: number;
  recoveryTicks: number;
  range: number;
  retreatRange: number;
  retreatSpeed: number;
  hand: Point;
  release: Point;
  launchY: number;
  arcs: readonly { throughDistance: number; speed: number }[];
}
export interface GrenadierState {
  tick: number;
  phase: "patrol" | "retreat" | "windup" | "recovery" | "dead";
  phaseStartTick: number;
  actionInstanceId: number;
  targetId: number | null;
  facing: -1 | 1;
  velocity: Point;
  released: boolean;
}
export interface EnemyGrenadeIntent {
  ownerId: number;
  actionInstanceId: number;
  stateStartTick: number;
  releaseTick: number;
  hand: Point;
  release: Point;
  velocity: Point;
  facing: -1 | 1;
}
export const HARBOR_GRENADIER: GrenadierProfile = {
  windupTicks: 36,
  recoveryTicks: 72,
  range: pixels(256),
  retreatRange: pixels(56),
  retreatSpeed: pixels(1),
  hand: { x: 0, y: -pixels(24) },
  release: { x: pixels(12), y: -pixels(28) },
  launchY: -pixels(4) - 128,
  arcs: [
    { throughDistance: pixels(96), speed: pixels(2) },
    { throughDistance: pixels(160), speed: pixels(3) },
    { throughDistance: pixels(256), speed: pixels(4) },
  ],
};

export function createGrenadierState(): GrenadierState {
  return {
    tick: 0,
    phase: "patrol",
    phaseStartTick: 0,
    actionInstanceId: 0,
    targetId: null,
    facing: -1,
    velocity: { x: 0, y: 0 },
    released: false,
  };
}

export function validateGrenadierState(
  state: GrenadierState,
  tick: number,
  nextActionId: number,
  players: readonly ControlledActor[],
  profile: GrenadierProfile = HARBOR_GRENADIER,
) {
  if (
    state.tick !== tick ||
    !["patrol", "retreat", "windup", "recovery", "dead"].includes(state.phase)
  )
    throw new Error("Invalid grenadier state boundary/phase");
  integer(state.phaseStartTick, 0, tick, "grenadier phase origin");
  integer(state.actionInstanceId, 0, nextActionId - 1, "grenadier action allocation");
  if ((state.facing !== -1 && state.facing !== 1) || typeof state.released !== "boolean")
    throw new Error("Invalid grenadier facing/release");
  motion(state.velocity.x);
  motion(state.velocity.y);
  const committed = state.phase === "windup" || state.phase === "recovery";
  if (committed) {
    if (
      state.actionInstanceId === 0 ||
      !players.some((player) => player.playerId === state.targetId) ||
      state.velocity.y !== profile.launchY ||
      !profile.arcs.some((arc) => state.velocity.x === arc.speed * state.facing) ||
      state.released !== (state.phase === "recovery") ||
      tick - state.phaseStartTick >=
        (state.phase === "windup" ? profile.windupTicks : profile.recoveryTicks)
    )
      throw new Error("Invalid committed grenadier continuation");
  } else if (state.targetId !== null) throw new Error("Idle grenadier retained a target");
}

/** The hand sweep and initial upward corridor must be clear; flight still collides every later tick. */
export function grenadierReleaseClear(
  body: Point,
  facing: -1 | 1,
  hand: Point,
  release: Point,
  shape: ShapeDefinition,
  terrain: readonly SweepTarget[],
) {
  const from = worldSocket(body, hand, facing),
    to = worldSocket(body, release, facing);
  const sweep = earliestSweep(
    worldRect(from, shape.rect, 1),
    { x: to.x - from.x, y: to.y - from.y },
    terrain,
  );
  if (sweep.overlaps.length || sweep.contacts.length) return false;
  const overhead = earliestSweep(worldRect(to, shape.rect, 1), { x: 0, y: -pixels(12) }, terrain);
  return overhead.overlaps.length === 0 && overhead.contacts.length === 0;
}

/** Only target selection chooses a heading. A committed wind-up never swivels after its target. */
export function stepGrenadier(
  current: GrenadierState,
  enemy: GroundedEnemy,
  players: readonly ControlledActor[],
  enabled: boolean,
  tick: number,
  nextActionId: number,
  shape: ShapeDefinition,
  terrain: readonly SweepTarget[],
  profile: GrenadierProfile = HARBOR_GRENADIER,
) {
  integer(tick, 1, COUNTER_LIMIT - 1, "grenadier tick");
  if (current.tick !== tick - 1) throw new Error("Grenadier boundary mismatch");
  validateGrenadierState(current, tick - 1, nextActionId, players, profile);
  const state = structuredClone(current);
  state.tick = tick;
  let speed = 0,
    facing = state.facing,
    release: EnemyGrenadeIntent | null = null;
  if (enemy.life !== "alive") {
    if (state.phase !== "dead") state.phaseStartTick = tick;
    state.phase = "dead";
    state.targetId = null;
    return { state, facing, speed, nextActionId, release };
  }
  if (state.phase === "dead") throw new Error("Grenadier resurrection requires a new state");
  if (!enabled) {
    if (state.phase === "windup" || state.phase === "recovery")
      throw new Error("Cannot deactivate a committed grenadier");
    return { state, facing: enemy.facing, speed, nextActionId, release };
  }
  if (state.phase === "recovery" && tick - state.phaseStartTick >= profile.recoveryTicks) {
    state.phase = "patrol";
    state.phaseStartTick = tick;
    state.targetId = null;
  }
  if (state.phase === "patrol" || state.phase === "retreat") {
    const candidate = players
      .filter((player) => player.life === "alive" && player.invulnerableTicks === 0)
      .map((player) => ({
        player,
        distance: Math.abs(player.body.x - enemy.body.x) + Math.abs(player.body.y - enemy.body.y),
      }))
      .filter(({ distance }) => distance <= profile.range)
      .sort((a, b) => a.distance - b.distance || a.player.slot - b.player.slot)[0];
    if (!candidate || !enemy.body.grounded) {
      if (state.phase !== "patrol") state.phaseStartTick = tick;
      state.phase = "patrol";
      state.targetId = null;
      return { state, facing: enemy.facing, speed, nextActionId, release };
    }
    const dx = candidate.player.body.x - enemy.body.x;
    facing = dx === 0 ? enemy.facing : dx < 0 ? -1 : 1;
    if (candidate.distance < profile.retreatRange) {
      if (state.phase !== "retreat") state.phaseStartTick = tick;
      state.phase = "retreat";
      state.facing = facing = facing === 1 ? -1 : 1;
      state.targetId = null;
      return { state, facing, speed: profile.retreatSpeed, nextActionId, release };
    }
    if (state.phase !== "patrol") state.phaseStartTick = tick;
    state.phase = "patrol";
    state.targetId = null;
    if (!grenadierReleaseClear(enemy.body, facing, profile.hand, profile.release, shape, terrain))
      return { state, facing: enemy.facing, speed, nextActionId, release };
    const arc = profile.arcs.find((arc) => Math.abs(dx) <= arc.throughDistance);
    if (!arc) throw new Error("Missing grenadier arc");
    state.phase = "windup";
    state.phaseStartTick = tick;
    state.actionInstanceId = nextActionId;
    nextActionId = nextCounter(nextActionId);
    state.targetId = candidate.player.playerId;
    state.facing = facing;
    state.velocity = { x: motion(arc.speed * facing), y: motion(profile.launchY) };
    state.released = false;
  }
  if (state.phase === "windup" && tick - state.phaseStartTick >= profile.windupTicks) {
    if (state.released) throw new Error("Grenadier release already consumed");
    if (
      enemy.body.grounded &&
      grenadierReleaseClear(enemy.body, state.facing, profile.hand, profile.release, shape, terrain)
    )
      release = {
        ownerId: enemy.body.id,
        actionInstanceId: state.actionInstanceId,
        stateStartTick: state.phaseStartTick,
        releaseTick: tick,
        hand: profile.hand,
        release: profile.release,
        velocity: state.velocity,
        facing: state.facing,
      };
    state.released = true;
    state.phase = "recovery";
    state.phaseStartTick = tick;
  }
  return { state, facing: state.facing, speed, nextActionId, release };
}
