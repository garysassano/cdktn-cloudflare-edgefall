import { type ActionCatalog, stepAction } from "../combat/timeline.js";
import type { AttackDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, integer, nextCounter } from "../core/numeric.js";
import type { ActionClock, ControlledActor } from "../state.js";
import type { GroundedEnemy } from "./grounded.js";

export const SHIELD_PHASES = ["brace", "advance", "turn", "bash", "stunned", "dead"] as const;
export type ShieldPhase = (typeof SHIELD_PHASES)[number];
export interface ShieldProfile {
  timelineIds: Record<Exclude<ShieldPhase, "dead">, number>;
  integrity: number;
  speed: number;
  sightRange: number;
  bashRange: number;
  bashHeight: number;
  bashActiveTick: number;
  bashActiveTicks: number;
  damageByMaterial: Record<AttackDefinition["material"], number>;
}
export interface ShieldState {
  phase: ShieldPhase;
  integrity: number;
  facing: -1 | 1;
  turnFacing: -1 | 1;
  targetId: number | null;
  action: ActionClock;
  hitIds: number[];
}
export function createShieldState(profile: ShieldProfile): ShieldState {
  return {
    phase: "brace",
    integrity: profile.integrity,
    facing: -1,
    turnFacing: -1,
    targetId: null,
    action: { actionInstanceId: 0, stateStartTick: 0, definitionId: 0, nextMarkerIndex: 0 },
    hitIds: [],
  };
}
export function cancelShield(state: ShieldState): void {
  state.phase = "dead";
  state.targetId = null;
  state.hitIds = [];
}
export function shieldProtected(state: ShieldState, tick: number, profile: ShieldProfile): boolean {
  return (
    state.integrity > 0 &&
    (state.phase === "brace" ||
      state.phase === "advance" ||
      (state.phase === "bash" && tick - state.action.stateStartTick < profile.bashActiveTick))
  );
}
/** Definition-owned modes 0–5 are intact; 6–11 retain the phase after the shield breaks. */
export function shieldMode(state: ShieldState): number {
  return SHIELD_PHASES.indexOf(state.phase) + (state.integrity === 0 ? SHIELD_PHASES.length : 0);
}
/** Snapshot presentation can reconstruct the authored phase without private target/hit state. */
export function shieldPresentation(mode: number, age: number, profile: ShieldProfile) {
  integer(mode, 0, SHIELD_PHASES.length * 2 - 1, "shield mode");
  const phase = SHIELD_PHASES[mode % SHIELD_PHASES.length];
  const broken = mode >= SHIELD_PHASES.length;
  return {
    phase,
    broken,
    raised:
      !broken &&
      (phase === "brace" ||
        phase === "advance" ||
        (phase === "bash" && age < profile.bashActiveTick)),
  };
}
function begin(
  state: ShieldState,
  phase: Exclude<ShieldPhase, "dead">,
  tick: number,
  nextActionId: number,
  profile: ShieldProfile,
) {
  state.phase = phase;
  state.hitIds = [];
  state.action = {
    actionInstanceId: nextActionId,
    stateStartTick: tick,
    definitionId: profile.timelineIds[phase],
    nextMarkerIndex: 0,
  };
  return nextCounter(nextActionId);
}
function evaluate(
  state: ShieldState,
  tick: number,
  nextActionId: number,
  catalog: ActionCatalog,
  profile: ShieldProfile,
) {
  const advanced = stepAction(state.action, tick, catalog);
  state.action = advanced.action;
  for (const item of advanced.markers)
    if (item.marker.kind === "face") state.facing = state.turnFacing;
  return {
    state,
    nextActionId,
    markers: advanced.markers,
    speed: state.phase === "advance" ? profile.speed : 0,
  };
}

/** Stable acquisition; committed turns and bashes never track a target during their action. */
export function stepShield(
  current: ShieldState,
  enemy: GroundedEnemy,
  players: readonly ControlledActor[],
  tick: number,
  nextActionId: number,
  catalog: ActionCatalog,
  profile: ShieldProfile,
) {
  integer(tick, 1, COUNTER_LIMIT - 1, "shield tick");
  const state = structuredClone(current);
  if (enemy.life !== "alive") {
    cancelShield(state);
    return { state, nextActionId, markers: [], speed: 0 };
  }
  const duration = catalog.timelines.get(state.action.definitionId)?.durationTicks ?? 0;
  const finished = tick - state.action.stateStartTick >= duration;
  if (["turn", "bash", "stunned"].includes(state.phase) && !finished)
    return evaluate(state, tick, nextActionId, catalog, profile);
  const target = players
    .filter((player) => player.life === "alive" && player.invulnerableTicks === 0)
    .map((player) => ({
      player,
      distance: Math.abs(player.body.x - enemy.body.x) + Math.abs(player.body.y - enemy.body.y),
    }))
    .filter(({ distance }) => distance <= profile.sightRange)
    .sort((a, b) => a.distance - b.distance || a.player.playerId - b.player.playerId)[0]?.player;
  const dx = target ? target.body.x - enemy.body.x : 0;
  const direction = dx === 0 ? state.facing : dx < 0 ? -1 : 1;
  if (enemy.body.grounded && target && direction !== state.facing) {
    state.targetId = target.playerId;
    state.turnFacing = direction;
    nextActionId = begin(state, "turn", tick, nextActionId, profile);
  } else if (
    enemy.body.grounded &&
    target &&
    Math.abs(dx) <= profile.bashRange &&
    Math.abs(target.body.y - enemy.body.y) <= profile.bashHeight
  ) {
    state.targetId = target.playerId;
    nextActionId = begin(state, "bash", tick, nextActionId, profile);
  } else if (state.action.actionInstanceId === 0 || finished) {
    const phase = target && enemy.body.grounded && state.phase !== "advance" ? "advance" : "brace";
    state.targetId = target?.playerId ?? null;
    state.turnFacing = state.facing;
    nextActionId = begin(
      state,
      state.action.actionInstanceId === 0 ? "brace" : phase,
      tick,
      nextActionId,
      profile,
    );
  }
  return evaluate(state, tick, nextActionId, catalog, profile);
}

/** Shield damage has its own material budget; breaking it never spills damage into the body. */
export function damageShield(
  current: ShieldState,
  attack: AttackDefinition,
  tick: number,
  nextActionId: number,
  catalog: ActionCatalog,
  profile: ShieldProfile,
) {
  const state = structuredClone(current);
  const damage = profile.damageByMaterial[attack.material];
  integer(damage, 0, 65535, "shield material damage");
  if (state.phase === "dead" || state.integrity === 0 || damage === 0)
    return { state, nextActionId, broken: false, markers: [] };
  state.integrity = Math.max(0, state.integrity - damage);
  if (state.integrity > 0) return { state, nextActionId, broken: false, markers: [] };
  state.targetId = null;
  state.turnFacing = state.facing;
  nextActionId = begin(state, "stunned", tick, nextActionId, profile);
  return { ...evaluate(state, tick, nextActionId, catalog, profile), broken: true };
}

export function validateShield(
  state: ShieldState,
  enemy: GroundedEnemy,
  tick: number,
  nextActionId: number,
  players: readonly ControlledActor[],
  catalog: ActionCatalog,
  profile: ShieldProfile,
  additionalHitIds: readonly number[] = [],
) {
  if (!SHIELD_PHASES.includes(state.phase)) throw new Error("Invalid shield phase");
  integer(state.integrity, 0, profile.integrity, "shield integrity");
  if (
    ![state.facing, state.turnFacing].every((value) => value === -1 || value === 1) ||
    state.facing !== enemy.facing
  )
    throw new Error("Invalid shield facing");
  if ((state.phase === "dead") !== (enemy.life === "removed"))
    throw new Error("Shield life mismatch");
  if (state.targetId !== null && !players.some((player) => player.playerId === state.targetId))
    throw new Error("Unknown shield target");
  const action = state.action;
  integer(action.actionInstanceId, 0, nextActionId - 1, "shield action allocation");
  integer(action.stateStartTick, 0, tick, "shield start tick");
  if (action.actionInstanceId === 0) {
    if (
      state.phase !== "brace" ||
      state.integrity !== profile.integrity ||
      action.definitionId !== 0 ||
      action.nextMarkerIndex !== 0 ||
      action.stateStartTick !== 0 ||
      state.targetId !== null ||
      state.hitIds.length !== 0 ||
      state.turnFacing !== state.facing
    )
      throw new Error("Invalid initial shield");
    return;
  }
  const timeline = catalog.timelines.get(action.definitionId);
  if (
    !timeline ||
    !Object.values(profile.timelineIds).includes(action.definitionId) ||
    (state.phase !== "dead" && action.definitionId !== profile.timelineIds[state.phase])
  )
    throw new Error("Shield phase/timeline mismatch");
  const age = tick - action.stateStartTick;
  integer(action.nextMarkerIndex, 0, timeline.markers.length, "shield marker cursor");
  if (
    timeline.markers.slice(0, action.nextMarkerIndex).some((marker) => marker.tickOffset > age) ||
    (state.phase !== "dead" &&
      (age >= timeline.durationTicks ||
        timeline.markers.slice(action.nextMarkerIndex).some((marker) => marker.tickOffset <= age)))
  )
    throw new Error("Invalid shield marker continuation");
  if (state.phase === "turn") {
    const flipped = timeline.markers
      .slice(0, action.nextMarkerIndex)
      .some((marker) => marker.kind === "face");
    if (
      state.targetId === null ||
      state.facing !== (flipped ? state.turnFacing : -state.turnFacing)
    )
      throw new Error("Invalid committed shield turn");
  }
  if (state.phase === "bash" && state.targetId === null) throw new Error("Missing bash target");
  if (state.phase === "stunned" && (state.integrity !== 0 || state.targetId !== null))
    throw new Error("Invalid broken shield stun");
  integer(state.hitIds.length, 0, 4, "bash hit budget");
  for (const [index, id] of state.hitIds.entries()) {
    if (
      state.phase !== "bash" ||
      age < profile.bashActiveTick ||
      (index > 0 && id <= (state.hitIds[index - 1] ?? 0)) ||
      (!players.some((player) => player.body.id === id) && !additionalHitIds.includes(id))
    )
      throw new Error("Invalid bash hit ledger");
  }
}
