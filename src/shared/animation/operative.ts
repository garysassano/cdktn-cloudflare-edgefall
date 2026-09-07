import type { ControlledActor } from "../../game/state.js";
import { type NativeAtlas, nativeExposure } from "./native.js";
import { type OperativeMotion, operativeMode } from "./operative-motion.js";

export const OPERATIVE_POSES = {
  "upper-horizontal": 10,
  "upper-up": 11,
  "upper-down": 12,
  "upper-crouch": 13,
} as const;

/** Cosmetic state is sampled from an accepted world tick, never an animation callback. */
export function operativePresentation(
  actor: ControlledActor,
  tick: number,
  atlas: NativeAtlas,
  motion: OperativeMotion,
) {
  if (
    actor.life !== "alive" ||
    actor.vehicleId !== null ||
    actor.weapon.id !== "sidearm" ||
    (actor.action.kind !== "ready" && actor.action.kind !== "fire")
  )
    return null;
  if (
    motion.tick !== tick ||
    motion.playerId !== actor.playerId ||
    motion.controlEpoch !== actor.controlEpoch ||
    motion.mode !== operativeMode(actor)
  )
    throw new Error("Operative presentation has a stale motion clock");
  const aim =
    actor.aim === 1
      ? "upper-up"
      : actor.aim === 2
        ? "upper-down"
        : actor.locomotion === "crouched"
          ? "upper-crouch"
          : "upper-horizontal";
  const recoil = atlas.meta.edgefall.clips.find((clip) => clip.id === `upper.fire.${aim.slice(6)}`);
  if (!recoil) throw new Error("Missing operative recoil clip");
  const upper =
    actor.action.kind === "fire" ? nativeExposure(recoil, tick - actor.action.stateStartTick) : aim;
  const run = atlas.meta.edgefall.clips.find((clip) => clip.id === "legs.run");
  if (!run) throw new Error("Missing operative run clip");
  const transition = motion.transition
    ? atlas.meta.edgefall.clips.find((clip) => clip.id === `legs.${motion.transition}`)
    : null;
  const transitionAge = tick - motion.transitionStartTick;
  const transitionActive =
    transition &&
    transitionAge < transition.exposures.reduce((sum, exposure) => sum + exposure.ticks, 0);
  const legs = transitionActive
    ? nativeExposure(transition, transitionAge)
    : actor.locomotion === "crouched"
      ? "legs-crouch"
      : actor.locomotion === "airborne"
        ? actor.body.vy < 0
          ? "legs-rise"
          : "legs-fall"
        : actor.body.vx !== 0
          ? nativeExposure(run, Math.max(0, tick - motion.runStartTick))
          : "legs-idle";
  const variant = `p${actor.slot + 1}`;
  const upperFrame = `${variant}/${upper}`,
    legsFrame = `${variant}/${legs}`;
  const frame = atlas.frames[upperFrame],
    lowerFrame = atlas.frames[legsFrame];
  const muzzle = atlas.meta.edgefall.drawings[upper]?.sockets?.muzzle;
  if (!frame || !lowerFrame || !muzzle) throw new Error("Missing operative drawing/socket");
  const [rootX, rootY] = atlas.meta.edgefall.root;
  const x = Math.round(actor.body.x / 256),
    y = Math.round(actor.body.y / 256);
  return {
    tick,
    motion: {
      runStartTick: motion.runStartTick,
      transition: transitionActive ? motion.transition : null,
      transitionStartTick: motion.transitionStartTick,
    },
    variant,
    upperFrame,
    legsFrame,
    poseId: OPERATIVE_POSES[aim],
    x,
    y,
    flipX: actor.facing < 0,
    // Phaser flips within the untrimmed canvas. Reflect its origin too so the
    // feet stay fixed when the unequal left/right margins exchange places.
    originX: actor.facing < 0 ? 1 - rootX / frame.sourceSize.w : rootX / frame.sourceSize.w,
    originY: rootY / frame.sourceSize.h,
    muzzle: { x: x + actor.facing * muzzle[0], y: y + muzzle[1] },
    contact: atlas.meta.edgefall.drawings[legs]?.contact
      ? {
          foot: atlas.meta.edgefall.drawings[legs]?.contact?.foot,
          x: x + actor.facing * (atlas.meta.edgefall.drawings[legs]?.contact?.point[0] ?? 0),
          y,
        }
      : null,
    sourceSha256: atlas.meta.edgefall.sourceSha256,
  };
}
