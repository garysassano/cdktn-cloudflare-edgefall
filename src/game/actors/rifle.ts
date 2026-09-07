import { muzzleBlocked } from "../combat/projectile.js";
import { type ActionCatalog, stepAction } from "../combat/timeline.js";
import type { ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, integer, nextCounter } from "../core/numeric.js";
import { worldSocket } from "../physics/body.js";
import type { SweepTarget } from "../physics/sweep.js";
import type { ActionState, ControlledActor } from "../state.js";
import type { GroundedEnemy } from "./grounded.js";

export interface RifleProfile {
  timelineIds: readonly [number, number];
  raiseTicks: number;
  lastReleaseTick: number;
  range: number;
  upAlignment: number;
  upHeight: number;
  aimHeight: number;
}
export interface RifleState {
  action: ActionState;
  targetId: number | null;
  aim: 0 | 1;
  facing: -1 | 1;
}
export function createRifleState(): RifleState {
  return {
    action: {
      kind: "ready",
      actionInstanceId: 0,
      stateStartTick: 0,
      definitionId: 0,
      nextMarkerIndex: 0,
    },
    targetId: null,
    aim: 0,
    facing: -1,
  };
}
/** A released bullet remains independent. Death cancels every later marker in this burst. */
export function cancelRifle(state: RifleState): void {
  state.action.kind = "ready";
  state.targetId = null;
}
export function rifleMode(state: RifleState, tick: number, profile: RifleProfile): 0 | 1 | 2 | 3 {
  if (state.action.kind === "ready") return 0;
  const age = tick - state.action.stateStartTick;
  return age < profile.raiseTicks ? 1 : age <= profile.lastReleaseTick ? 2 : 3;
}
/** Full private attack continuation; restore must never regenerate a consumed release marker. */
export function validateRifleState(
  state: RifleState,
  enemy: GroundedEnemy,
  tick: number,
  nextActionId: number,
  players: readonly ControlledActor[],
  catalog: ActionCatalog,
  profile: RifleProfile,
) {
  integer(state.aim, 0, 1, "rifle aim");
  if (state.facing !== -1 && state.facing !== 1) throw new Error("Invalid rifle facing");
  integer(state.action.actionInstanceId, 0, nextActionId - 1, "rifle action allocation");
  integer(state.action.stateStartTick, 0, tick, "rifle start tick");
  if (state.action.kind !== "ready" && state.action.kind !== "fire")
    throw new Error("Invalid rifle action");
  if (state.action.actionInstanceId === 0) {
    if (
      state.action.definitionId !== 0 ||
      state.action.nextMarkerIndex !== 0 ||
      state.action.stateStartTick !== 0 ||
      state.aim !== 0 ||
      state.targetId !== null ||
      state.action.kind !== "ready"
    )
      throw new Error("Invalid idle rifle");
    return;
  }
  if (state.action.definitionId !== profile.timelineIds[state.aim])
    throw new Error("Rifle pose/aim mismatch");
  const timeline = catalog.timelines.get(state.action.definitionId);
  if (!timeline) throw new Error("Missing rifle timeline");
  integer(state.action.nextMarkerIndex, 0, timeline.markers.length, "rifle marker cursor");
  const age = tick - state.action.stateStartTick;
  if (
    timeline.markers
      .slice(0, state.action.nextMarkerIndex)
      .some((marker) => marker.tickOffset > age)
  )
    throw new Error("Future rifle marker");
  if (state.action.kind === "fire") {
    if (
      enemy.life !== "alive" ||
      enemy.facing !== state.facing ||
      !players.some((player) => player.playerId === state.targetId) ||
      age >= timeline.durationTicks ||
      timeline.markers
        .slice(state.action.nextMarkerIndex)
        .some((marker) => marker.tickOffset <= age)
    )
      throw new Error("Invalid active rifle continuation");
  } else if (state.targetId !== null || (enemy.life === "alive" && age < timeline.durationTicks))
    throw new Error("Unexplained rifle cancellation");
}

/** Select once on weapon raise; the burst never follows a target after this commitment. */
export function stepRifleAttack(
  current: RifleState,
  enemy: GroundedEnemy,
  players: readonly ControlledActor[],
  tick: number,
  nextActionId: number,
  catalog: ActionCatalog,
  profile: RifleProfile,
  bullet: ShapeDefinition,
  terrain: readonly SweepTarget[],
) {
  integer(tick, 1, COUNTER_LIMIT - 1, "rifle tick");
  const state = structuredClone(current);
  let facing = current.action.kind === "fire" ? current.facing : enemy.facing;
  if (enemy.life !== "alive") {
    cancelRifle(state);
    return { state, facing, nextActionId, markers: [] };
  }
  if (state.action.kind === "ready" && enemy.body.grounded) {
    const candidates = players
      .filter((player) => player.life === "alive" && player.invulnerableTicks === 0)
      .map((player) => ({
        player,
        distance: Math.abs(player.body.x - enemy.body.x) + Math.abs(player.body.y - enemy.body.y),
      }))
      .filter(({ distance }) => distance <= profile.range)
      .sort((a, b) => a.distance - b.distance || a.player.playerId - b.player.playerId);
    for (const { player } of candidates) {
      const dx = player.body.x - enemy.body.x;
      const aim =
        Math.abs(dx) <= profile.upAlignment && enemy.body.y - player.body.y >= profile.upHeight
          ? 1
          : 0;
      const direction = dx === 0 ? facing : dx < 0 ? -1 : 1;
      const timeline = catalog.timelines.get(profile.timelineIds[aim]);
      const pose = timeline && catalog.poses.get(timeline.poses[0] ?? 0);
      const socket = pose?.sockets.find((socket) => socket.name === "muzzle");
      if (!socket) throw new Error("Missing authored rifle raise socket");
      const muzzle = worldSocket(enemy.body, socket.point, direction);
      const end =
        aim === 1
          ? { x: muzzle.x, y: player.body.y - profile.aimHeight }
          : { x: player.body.x, y: muzzle.y };
      if (muzzleBlocked(muzzle, end, bullet, terrain)) continue;
      facing = direction;
      state.facing = direction;
      state.aim = aim;
      state.targetId = player.playerId;
      state.action = {
        kind: "fire",
        actionInstanceId: nextActionId,
        stateStartTick: tick,
        definitionId: profile.timelineIds[aim],
        nextMarkerIndex: 0,
      };
      nextActionId = nextCounter(nextActionId);
      break;
    }
  }
  if (state.action.kind === "ready") return { state, facing, nextActionId, markers: [] };
  const action = stepAction(state.action, tick, catalog);
  state.action = action.action;
  if (action.finished) cancelRifle(state);
  return { state, facing, nextActionId, markers: action.markers };
}
