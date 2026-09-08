import type { ControlledActor } from "../../game/state.js";
import type { NativeAtlas } from "./native.js";

type Transition =
  | "start"
  | "stop"
  | "reverse"
  | "crouch-enter"
  | "crouch-exit"
  | "land-light"
  | "land-heavy";
export type OperativeAirPhase = "launch" | "rise" | "apex" | "fall";
export const OPERATIVE_EJECTION_TICKS = 8;
export const OPERATIVE_LAUNCH_TICKS = 2;
// Cosmetic Q256 velocity bands, independent of damage and movement rules.
export const OPERATIVE_APEX_SPEED = 110;
export const OPERATIVE_HEAVY_LAND_SPEED = 4 * 256;
export const operativeLanding = (transition: Transition | null) =>
  transition === "land-light" || transition === "land-heavy";
const airbornePhase = (actor: ControlledActor): OperativeAirPhase =>
  Math.abs(actor.body.vy) <= OPERATIVE_APEX_SPEED ? "apex" : actor.body.vy < 0 ? "rise" : "fall";
export const operativeMode = (actor: ControlledActor) =>
  actor.life !== "alive" || actor.vehicleId !== null
    ? "hidden"
    : actor.locomotion === "airborne"
      ? "air"
      : actor.locomotion === "crouched"
        ? "crouch"
        : actor.body.vx !== 0
          ? "run"
          : "idle";

export interface OperativeMotion {
  playerId: number;
  controlEpoch: number;
  tick: number;
  mode: ReturnType<typeof operativeMode>;
  runStartTick: number;
  transition: Transition | null;
  transitionStartTick: number;
  ejectionStartTick: number | null;
  airPhase: OperativeAirPhase | null;
  airPhaseStartTick: number;
}
export function initialOperativeMotion(actor: ControlledActor, tick: number): OperativeMotion {
  return {
    playerId: actor.playerId,
    controlEpoch: actor.controlEpoch,
    tick,
    mode: operativeMode(actor),
    runStartTick: 0,
    transition: null,
    transitionStartTick: tick,
    ejectionStartTick: null,
    airPhase:
      operativeMode(actor) === "air" ? (actor.body.vy >= 0 ? "fall" : airbornePhase(actor)) : null,
    airPhaseStartTick: tick,
  };
}
function duration(atlas: NativeAtlas, transition: Transition) {
  const clip = atlas.meta.edgefall.clips.find((clip) => clip.id === `legs.${transition}`);
  if (!clip) throw new Error("Missing operative transition");
  return clip.exposures.reduce((total, exposure) => total + exposure.ticks, 0);
}

/** A bounded cosmetic clock advanced at accepted world boundaries, never render frames. */
export function advanceOperativeMotion(
  before: ControlledActor,
  actor: ControlledActor,
  current: OperativeMotion,
  tick: number,
  atlas: NativeAtlas,
): OperativeMotion {
  if (tick !== current.tick + 1) throw new Error("Operative motion skipped/repeated a world tick");
  const mode = operativeMode(actor);
  const ejected =
    before.playerId === actor.playerId &&
    before.body.id === actor.body.id &&
    before.vehicleId !== null &&
    actor.vehicleId === null &&
    before.action.kind !== "exit";
  // A safe grounded release can show a short recovery at the accepted feet root.
  // Movement, aiming, crouching, actions and airborne exits remain immediate.
  const canRecover = mode === "idle" && actor.action.kind === "ready" && actor.aim === 0;
  if (
    current.playerId !== actor.playerId ||
    current.controlEpoch !== actor.controlEpoch ||
    before.body.id !== actor.body.id
  )
    return {
      ...initialOperativeMotion(actor, tick),
      ejectionStartTick: ejected && canRecover ? tick : null,
    };
  const ejectionStartTick = ejected ? tick : current.ejectionStartTick;
  let airPhase: OperativeAirPhase | null = null;
  if (mode === "air") {
    // Includes coyote jumps and buffered land-and-jump boundaries that never
    // expose an intervening grounded snapshot. Cold observations never launch.
    const launched =
      actor.body.vy < -OPERATIVE_APEX_SPEED && (before.body.grounded || before.body.vy >= 0);
    airPhase =
      launched ||
      (current.airPhase === "launch" &&
        tick - current.airPhaseStartTick < OPERATIVE_LAUNCH_TICKS &&
        actor.body.vy < -OPERATIVE_APEX_SPEED)
        ? "launch"
        : before.body.vy < -OPERATIVE_APEX_SPEED && actor.body.vy >= 0
          ? "fall"
          : airbornePhase(actor);
    // A ceiling contact enters descent immediately instead of briefly replaying apex.
    if ((current.airPhase === "fall" || current.airPhase === null) && actor.body.vy >= 0)
      airPhase = "fall";
  }
  let transition = current.transition;
  if (transition && tick - current.transitionStartTick >= duration(atlas, transition))
    transition = null;
  let next: Transition | null = null;
  if (mode === "hidden" || mode === "air") transition = null;
  else if (current.mode === "air" && mode === "idle")
    next = before.body.vy >= OPERATIVE_HEAVY_LAND_SPEED ? "land-heavy" : "land-light";
  else if (mode === "crouch" && current.mode !== "crouch") next = "crouch-enter";
  else if (current.mode === "crouch" && mode !== "crouch") next = "crouch-exit";
  else if (mode === "run" && current.mode !== "run" && current.mode !== "air") next = "start";
  else if (mode === "run" && before.facing !== actor.facing) next = "reverse";
  else if (mode === "idle" && current.mode === "run") next = "stop";
  return {
    ...current,
    tick,
    mode,
    airPhase,
    airPhaseStartTick: airPhase !== current.airPhase ? tick : current.airPhaseStartTick,
    ejectionStartTick:
      canRecover &&
      ejectionStartTick !== null &&
      tick - ejectionStartTick < OPERATIVE_EJECTION_TICKS
        ? ejectionStartTick
        : null,
    transition: next ?? (operativeLanding(transition) && mode !== "idle" ? null : transition),
    transitionStartTick: next ? tick : current.transitionStartTick,
    runStartTick:
      mode === "run" && current.mode !== "run"
        ? tick + (next ? duration(atlas, next) : 0)
        : current.runStartTick,
  };
}
