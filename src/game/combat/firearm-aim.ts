import { canonical } from "../core/canonical.js";
import { COUNTER_LIMIT, integer, motion } from "../core/numeric.js";
import type { ControlledActor, FirearmAimState, Point } from "../state.js";
import type { FirearmCatalog, FirearmProfile } from "./firearm.js";

export interface FirearmHeading {
  pitch: number;
  timelineId: number;
  muzzle: Point;
  velocity: Point;
}
export interface FirearmSweepProfile {
  stepTicks: number;
  /** Nine authored exposures, ordered from downward to upward elevation. */
  headings: readonly FirearmHeading[];
}

export function validateFirearmSweep(profile: FirearmProfile, catalog: FirearmCatalog): void {
  const sweep = profile.sweep;
  if (!sweep) return;
  integer(sweep.stepTicks, 1, 60, "firearm heading exposure");
  const reference = catalog.timelines.get(profile.timelineIds[0]);
  if (!reference || sweep.headings.length !== 9) throw new Error("Incomplete firearm sweep");
  for (const [index, heading] of sweep.headings.entries()) {
    if (heading.pitch !== index - 4)
      throw new Error("Firearm headings must cover -4 through 4 in order");
    const timeline = catalog.timelines.get(heading.timelineId);
    if (
      !timeline ||
      timeline.durationTicks !== reference.durationTicks ||
      canonical(timeline.markers) !== canonical(reference.markers)
    )
      throw new Error("Firearm sweep marker schedules disagree");
    motion(heading.velocity.x);
    motion(heading.velocity.y);
    if (
      heading.velocity.x < 0 ||
      Math.sign(heading.velocity.y) !== -Math.sign(heading.pitch) ||
      (Math.abs(heading.pitch) === 4) !== (heading.velocity.x === 0) ||
      (heading.velocity.x === 0 && heading.velocity.y === 0)
    )
      throw new Error("Invalid authored firearm velocity");
    for (const poseId of timeline.poses) {
      const muzzle = catalog.poses.get(poseId)?.sockets.find((socket) => socket.name === "muzzle");
      if (!muzzle || canonical(muzzle.point) !== canonical(heading.muzzle))
        throw new Error("Firearm sweep socket mismatch");
    }
  }
  for (const [pitch, timelineId] of [
    [0, profile.timelineIds[0]],
    [4, profile.timelineIds[1]],
    [-4, profile.timelineIds[2]],
  ])
    if (sweep.headings.find((heading) => heading.pitch === pitch)?.timelineId !== timelineId)
      throw new Error("Firearm cardinal and sweep poses disagree");
}

const cardinalPitch = (actor: ControlledActor) => (actor.aim === 1 ? 4 : actor.aim === 2 ? -4 : 0);
const lowered = (actor: ControlledActor) => actor.life !== "alive" || actor.vehicleId !== null;
const crouched = (actor: ControlledActor) => actor.aim === 0 && actor.locomotion === "crouched";

/** Advance once after locomotion, independently of cadence and consumed action markers. */
export function advanceFirearmAim(
  actor: ControlledActor,
  tick: number,
  catalog: FirearmCatalog,
): FirearmAimState {
  integer(tick, 1, COUNTER_LIMIT - 1, "firearm aim tick");
  const profile = catalog.firearms.get(actor.weapon.id);
  if (!profile) throw new Error("Missing firearm aim profile");
  integer(actor.firearmAim.pitch, -4, 4, "firearm pitch");
  integer(
    actor.firearmAim.nextStepTick,
    0,
    tick + (profile.sweep?.stepTicks ?? 0),
    "firearm turn tick",
  );
  if (lowered(actor) || crouched(actor)) return { pitch: 0, nextStepTick: 0 };
  const target = cardinalPitch(actor);
  if (!profile.sweep) return { pitch: target, nextStepTick: 0 };
  const aim = { ...actor.firearmAim };
  if (aim.pitch !== target && tick >= aim.nextStepTick) {
    aim.pitch += Math.sign(target - aim.pitch);
    aim.nextStepTick = tick + profile.sweep.stepTicks;
  }
  return aim;
}

export function firearmPoseTimeline(actor: ControlledActor, catalog: FirearmCatalog): number {
  const profile = catalog.firearms.get(actor.weapon.id);
  if (!profile) throw new Error("Missing firearm profile");
  if (profile.sweep && !crouched(actor)) {
    const heading = profile.sweep.headings.find((value) => value.pitch === actor.firearmAim.pitch);
    if (!heading) throw new Error("Missing authored firearm heading");
    return heading.timelineId;
  }
  return profile.timelineIds[crouched(actor) ? 3 : actor.aim];
}

export function firearmVelocity(
  actor: ControlledActor,
  speed: number,
  catalog: FirearmCatalog,
): Point {
  const profile = catalog.firearms.get(actor.weapon.id);
  if (!profile) throw new Error("Missing firearm profile");
  if (profile.sweep) {
    const heading = profile.sweep.headings.find((value) => value.pitch === actor.firearmAim.pitch);
    if (!heading) throw new Error("Missing authored firearm velocity");
    return { x: motion(heading.velocity.x * actor.facing), y: heading.velocity.y };
  }
  return {
    x: actor.aim === 0 ? motion(speed * actor.facing) : 0,
    y: actor.aim === 1 ? -speed : actor.aim === 2 ? speed : 0,
  };
}

export function validateFirearmAim(
  actor: ControlledActor,
  tick: number,
  catalog: FirearmCatalog,
): void {
  const profile = catalog.firearms.get(actor.weapon.id);
  if (!profile) throw new Error("Missing firearm profile");
  integer(actor.firearmAim.pitch, -4, 4, "firearm pitch");
  integer(
    actor.firearmAim.nextStepTick,
    0,
    tick + (profile.sweep?.stepTicks ?? 0),
    "firearm turn tick",
  );
  if (lowered(actor) || crouched(actor)) {
    if (actor.firearmAim.pitch !== 0 || actor.firearmAim.nextStepTick !== 0)
      throw new Error("Lowered firearm must have neutral aim");
  } else if (
    !profile.sweep &&
    (actor.firearmAim.pitch !== cardinalPitch(actor) || actor.firearmAim.nextStepTick !== 0)
  )
    throw new Error("Cardinal firearm aim mismatch");
  if (
    actor.action.kind === "fire" &&
    actor.action.definitionId !== firearmPoseTimeline(actor, catalog)
  )
    throw new Error("Firearm pose and heading disagree");
}
