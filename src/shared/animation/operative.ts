import type { ControlledActor } from "../../game/state.js";
import { type NativeAtlas, nativeExposure } from "./native.js";
import { type OperativeMotion, operativeMode } from "./operative-motion.js";

export const OPERATIVE_POSES = {
  "upper-horizontal": 10,
  "upper-up": 11,
  "upper-down": 12,
  "upper-crouch": 13,
} as const;
export const OPERATIVE_ACTIONS = {
  40: { kind: "melee", clip: "upper.melee" },
  41: { kind: "melee", clip: "upper.melee.crouch" },
  50: { kind: "grenade", clip: "upper.grenade" },
  51: { kind: "grenade", clip: "upper.grenade.crouch" },
} as const;

/** Cosmetic state is sampled from accepted action/life clocks, never animation callbacks. */
export function operativePresentation(
  actor: ControlledActor,
  tick: number,
  atlas: NativeAtlas,
  motion: OperativeMotion,
) {
  const action = actor.action.kind;
  if (actor.life === "spectating" || actor.bodyPresence === "removed" || actor.vehicleId !== null)
    return null;
  if (actor.life === "alive" && (action === "enter" || action === "exit" || action === "hurt"))
    return null;
  if (
    actor.life === "alive" &&
    actor.weapon.id !== "sidearm" &&
    action !== "melee" &&
    action !== "grenade"
  )
    return null;
  if (
    motion.tick !== tick ||
    motion.playerId !== actor.playerId ||
    motion.controlEpoch !== actor.controlEpoch ||
    motion.mode !== operativeMode(actor)
  )
    throw new Error("Operative presentation has a stale motion clock");
  const clip = (id: string) => {
    const value = atlas.meta.edgefall.clips.find((clip) => clip.id === id);
    if (!value) throw new Error(`Missing operative clip ${id}`);
    return value;
  };
  const sample = (id: string, age: number) => nativeExposure(clip(id), age);
  const transition = motion.transition ? clip(`legs.${motion.transition}`) : null;
  const transitionAge = tick - motion.transitionStartTick;
  const transitionActive = Boolean(
    transition && transitionAge < transition.exposures.reduce((sum, e) => sum + e.ticks, 0),
  );
  const aim =
    actor.aim === 1
      ? "upper-up"
      : actor.aim === 2
        ? "upper-down"
        : actor.locomotion === "crouched"
          ? "upper-crouch"
          : "upper-horizontal";
  let fullBody: string | null = null,
    upper: string | null = null,
    legs: string | null = null,
    timelineId: number | null = null;
  if (actor.life === "death" || actor.life === "respawning") {
    fullBody = sample(
      actor.life === "death" ? "body.death" : "body.reentry",
      actor.life === "death" && !actor.body.grounded
        ? Math.min(5, tick - actor.lifeStartTick)
        : tick - actor.lifeStartTick,
    );
  } else {
    const runAge = Math.max(0, tick - motion.runStartTick);
    legs =
      transitionActive && transition
        ? nativeExposure(transition, transitionAge)
        : actor.locomotion === "crouched"
          ? "legs-crouch"
          : actor.locomotion === "airborne"
            ? actor.body.vy < 0
              ? "legs-rise"
              : "legs-fall"
            : actor.body.vx !== 0
              ? sample("legs.run", runAge)
              : "legs-idle";
    if (action === "melee" || action === "grenade") {
      const binding =
        OPERATIVE_ACTIONS[actor.action.definitionId as keyof typeof OPERATIVE_ACTIONS];
      if (!binding || binding.kind !== action) throw new Error("Missing operative action binding");
      upper = sample(binding.clip, tick - actor.action.stateStartTick);
      timelineId = actor.action.definitionId;
    } else {
      timelineId = OPERATIVE_POSES[aim];
      upper =
        action === "fire"
          ? sample(`upper.fire.${aim.slice(6)}`, tick - actor.action.stateStartTick)
          : aim !== "upper-horizontal"
            ? aim
            : transitionActive && motion.transition === "land"
              ? sample("upper.land.horizontal", transitionAge)
              : motion.mode === "run"
                ? sample("upper.run.horizontal", runAge)
                : motion.mode === "idle" && !transitionActive
                  ? sample("upper.idle.horizontal", tick)
                  : aim;
    }
  }
  const variant = `p${actor.slot + 1}`;
  const frameName = (id: string | null) => (id ? `${variant}/${id}` : null);
  const upperFrame = frameName(upper),
    legsFrame = frameName(legs),
    fullBodyFrame = frameName(fullBody);
  const primary = fullBody ?? upper;
  if (!primary || [upperFrame, legsFrame, fullBodyFrame].some((id) => id && !atlas.frames[id]))
    throw new Error("Missing operative drawing");
  const frame = atlas.frames[`${variant}/${primary}`];
  if (!frame) throw new Error("Missing operative canvas");
  const [rootX, rootY] = atlas.meta.edgefall.root;
  const x = Math.round(actor.body.x / 256),
    y = Math.round(actor.body.y / 256);
  const sockets = atlas.meta.edgefall.drawings[primary]?.sockets;
  const socket = (name: "muzzle" | "hand" | "grip") => {
    const point = sockets?.[name];
    return point ? { x: x + actor.facing * point[0], y: y + point[1] } : null;
  };
  const contact = legs ? atlas.meta.edgefall.drawings[legs]?.contact : null;
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
    fullBodyFrame,
    timelineId,
    x,
    y,
    flipX: actor.facing < 0,
    // Reflect the origin when Phaser exchanges the unequal transparent margins.
    originX: actor.facing < 0 ? 1 - rootX / frame.sourceSize.w : rootX / frame.sourceSize.w,
    originY: rootY / frame.sourceSize.h,
    muzzle: socket("muzzle"),
    hand: socket("hand"),
    grip: socket("grip"),
    contact: contact ? { foot: contact.foot, x: x + actor.facing * contact.point[0], y } : null,
    sourceSha256: atlas.meta.edgefall.sourceSha256,
  };
}
