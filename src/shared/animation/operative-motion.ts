import type { ControlledActor } from "../../game/state.js";
import type { NativeAtlas } from "./native.js";

type Transition = "start" | "stop" | "reverse" | "crouch-enter" | "crouch-exit" | "land";
export const OPERATIVE_EJECTION_TICKS = 8;
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
  if (current.playerId !== actor.playerId || current.controlEpoch !== actor.controlEpoch)
    return {
      ...initialOperativeMotion(actor, tick),
      ejectionStartTick: ejected && canRecover ? tick : null,
    };
  const ejectionStartTick = ejected ? tick : current.ejectionStartTick;
  let transition = current.transition;
  if (transition && tick - current.transitionStartTick >= duration(atlas, transition))
    transition = null;
  let next: Transition | null = null;
  if (mode === "hidden" || mode === "air") transition = null;
  else if (current.mode === "air") next = "land";
  else if (mode === "crouch" && current.mode !== "crouch") next = "crouch-enter";
  else if (current.mode === "crouch" && mode !== "crouch") next = "crouch-exit";
  else if (mode === "run" && current.mode !== "run") next = "start";
  else if (mode === "run" && before.facing !== actor.facing) next = "reverse";
  else if (mode === "idle" && current.mode === "run") next = "stop";
  return {
    ...current,
    tick,
    mode,
    ejectionStartTick:
      canRecover &&
      ejectionStartTick !== null &&
      tick - ejectionStartTick < OPERATIVE_EJECTION_TICKS
        ? ejectionStartTick
        : null,
    transition: next ?? transition,
    transitionStartTick: next ? tick : current.transitionStartTick,
    runStartTick:
      mode === "run" && current.mode !== "run"
        ? tick + (next ? duration(atlas, next) : 0)
        : current.runStartTick,
  };
}
