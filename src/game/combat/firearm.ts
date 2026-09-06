import type { WeaponDefinition } from "../content/schema.js";
import { canonical } from "../core/canonical.js";
import { COUNTER_LIMIT, integer, nextCounter } from "../core/numeric.js";
import { HELD_MASK, Held } from "../input/types.js";
import type { ControlledActor, WeaponId } from "../state.js";
import { type ActionCatalog, stepAction } from "./timeline.js";

/** Explicit authored poses: horizontal standing, up, down-air, horizontal crouched. */
export interface FirearmProfile {
  weapon: WeaponDefinition;
  timelineIds: readonly [number, number, number, number];
}
export interface FirearmCatalog extends ActionCatalog {
  firearms: ReadonlyMap<WeaponId, FirearmProfile>;
}
export interface FireIntent {
  held: number;
  firePressed: boolean;
}

function poseTimeline(actor: ControlledActor, catalog: FirearmCatalog): number {
  const profile = catalog.firearms.get(actor.weapon.id);
  if (!profile) throw new Error("Missing firearm profile");
  const poseIndex = actor.aim === 0 && actor.locomotion === "crouched" ? 3 : actor.aim;
  return profile.timelineIds[poseIndex];
}

/** Called once in the world's action phase after locomotion. It owns no renderer or clock. */
export function stepFirearm(
  current: ControlledActor,
  intent: FireIntent,
  tick: number,
  nextActionId: number,
  catalog: FirearmCatalog,
) {
  integer(tick, 1, COUNTER_LIMIT - 1, "firearm tick");
  integer(nextActionId, 1, COUNTER_LIMIT - 2, "next action ID");
  integer(intent.held, 0, HELD_MASK, "firearm held mask");
  if (typeof intent.firePressed !== "boolean") throw new Error("Invalid fire edge");
  if (nextActionId <= current.weapon.lastActionInstanceId)
    throw new Error("Action allocator regressed");
  integer(current.weapon.cooldownTicks, 0, 3600, "weapon cooldown");
  integer(current.weapon.ammo, 0, 65535, "weapon ammunition");
  const actor = structuredClone(current);
  actor.weapon.cooldownTicks = Math.max(0, actor.weapon.cooldownTicks - 1);
  let outcome: "none" | "applied" | "cooldown" | "unavailable" = "none";
  const markers: ReturnType<typeof stepAction>["markers"] = [];
  const requested = intent.firePressed || Boolean(intent.held & Held.Fire);
  // Death, hurt and seat transitions win over any previously active firearm marker.
  const eligible = actor.life === "alive" && actor.vehicleId === null;
  if (!eligible && actor.action.kind === "fire") actor.action.kind = "ready";
  if (eligible && actor.action.kind === "fire") {
    // Pose variants share marker timing; locomotion/aim changes never restart a shot.
    const nextTimeline = poseTimeline(actor, catalog);
    if (nextTimeline !== actor.action.definitionId) {
      const prior = catalog.timelines.get(actor.action.definitionId);
      const next = catalog.timelines.get(nextTimeline);
      if (
        !prior ||
        !next ||
        prior.durationTicks !== next.durationTicks ||
        canonical(prior.markers) !== canonical(next.markers)
      )
        throw new Error("Firearm pose variants disagree on action markers");
      actor.action.definitionId = nextTimeline;
    }
    const result = stepAction(actor.action, tick, catalog);
    actor.action = result.action;
    markers.push(...result.markers);
    if (result.finished) actor.action.kind = "ready";
  }
  if (requested) {
    if (!eligible || (actor.action.kind !== "ready" && actor.action.kind !== "fire"))
      outcome = "unavailable";
    else if (actor.weapon.cooldownTicks > 0 || actor.action.kind !== "ready") outcome = "cooldown";
    else {
      let profile = catalog.firearms.get(actor.weapon.id);
      if (!profile) throw new Error("Missing firearm profile");
      if (actor.weapon.ammo < profile.weapon.ammoPerAction) {
        profile = catalog.firearms.get("sidearm");
        if (profile?.weapon.ammoPerAction !== 0)
          throw new Error("Missing unlimited sidearm fallback");
        actor.weapon.id = "sidearm";
        actor.weapon.ammo = 0;
      }
      const definitionId = poseTimeline(actor, catalog);
      actor.action = {
        kind: "fire",
        actionInstanceId: nextActionId,
        stateStartTick: tick,
        definitionId,
        nextMarkerIndex: 0,
      };
      nextActionId = nextCounter(nextActionId);
      actor.weapon.ammo -= profile.weapon.ammoPerAction;
      actor.weapon.cooldownTicks = profile.weapon.cadenceTicks;
      actor.weapon.shotOrdinal = nextCounter(actor.weapon.shotOrdinal);
      actor.weapon.lastActionInstanceId = actor.action.actionInstanceId;
      const result = stepAction(actor.action, tick, catalog);
      actor.action = result.action;
      markers.push(...result.markers);
      outcome = "applied";
    }
  }
  return { actor, markers, nextActionId, outcome };
}
