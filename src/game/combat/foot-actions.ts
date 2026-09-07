import { canonical } from "../core/canonical.js";
import { integer, nextCounter } from "../core/numeric.js";
import { HELD_MASK, Held } from "../input/types.js";
import type { ControlledActor } from "../state.js";
import { type FireIntent, type FirearmCatalog, beginFirearm, stepFirearm } from "./firearm.js";
import { stepAction } from "./timeline.js";

export interface FootActionProfile {
  timelineIds: readonly [number, number];
  cooldownTicks: number;
}
export interface FootActionProfiles {
  melee: FootActionProfile;
  grenade: FootActionProfile;
}
export interface FootCombatIntent extends FireIntent {
  grenadePressed: boolean;
}
export type ActionOutcome = "none" | "applied" | "cooldown" | "unavailable";

/** One action owner arbitrates grenade, eligible close melee and firearm after locomotion. */
export function stepFootCombatAction(
  current: ControlledActor,
  intent: FootCombatIntent,
  tick: number,
  nextActionId: number,
  catalog: FirearmCatalog,
  profiles: FootActionProfiles,
  closeTarget: boolean,
) {
  integer(intent.held, 0, HELD_MASK, "foot combat held mask");
  if (
    typeof intent.firePressed !== "boolean" ||
    typeof intent.grenadePressed !== "boolean" ||
    typeof closeTarget !== "boolean"
  )
    throw new Error("Invalid action arbitration");
  const advanced = stepFirearm(
    current,
    { held: 0, firePressed: false },
    tick,
    nextActionId,
    catalog,
  );
  let actor = advanced.actor;
  const markers = advanced.markers;
  for (const field of ["grenadeCooldownTicks", "meleeCooldownTicks"] as const)
    actor[field] = Math.max(0, integer(actor[field], 0, 3600, field) - 1);
  integer(actor.grenadeStock, 0, 65535, "grenade stock");
  const eligible = actor.life === "alive" && actor.vehicleId === null;
  if (actor.action.kind === "melee" || actor.action.kind === "grenade") {
    if (!eligible) actor.action.kind = "ready";
    else {
      const timeline =
        profiles[actor.action.kind].timelineIds[actor.locomotion === "crouched" ? 1 : 0];
      const previous = catalog.timelines.get(actor.action.definitionId),
        next = catalog.timelines.get(timeline);
      if (
        !previous ||
        !next ||
        previous.durationTicks !== next.durationTicks ||
        canonical(previous.markers) !== canonical(next.markers)
      )
        throw new Error("Foot action pose markers disagree");
      actor.action.definitionId = timeline;
      const result = stepAction(actor.action, tick, catalog);
      actor.action = result.action;
      markers.push(...result.markers);
      if (result.finished) actor.action.kind = "ready";
    }
  }
  let fire: ActionOutcome = "none",
    grenade: ActionOutcome = "none";
  const requested = intent.firePressed || Boolean(intent.held & Held.Fire);
  const begin = (kind: "melee" | "grenade") => {
    const profile = profiles[kind];
    actor.action = {
      kind,
      actionInstanceId: nextActionId,
      definitionId: profile.timelineIds[actor.locomotion === "crouched" ? 1 : 0],
      stateStartTick: tick,
      nextMarkerIndex: 0,
    };
    nextActionId = nextCounter(nextActionId);
    if (kind === "grenade") {
      actor.grenadeStock--;
      actor.grenadeCooldownTicks = profile.cooldownTicks;
    } else actor.meleeCooldownTicks = profile.cooldownTicks;
    const result = stepAction(actor.action, tick, catalog);
    actor.action = result.action;
    markers.push(...result.markers);
  };
  if (intent.grenadePressed) {
    if (!eligible || actor.grenadeStock === 0) grenade = "unavailable";
    else if (actor.action.kind !== "ready" || actor.grenadeCooldownTicks > 0) grenade = "cooldown";
    else {
      begin("grenade");
      grenade = "applied";
    }
  }
  if (requested) {
    if (!eligible) fire = "unavailable";
    else if (actor.action.kind !== "ready" || actor.weapon.cooldownTicks > 0) fire = "cooldown";
    else if (closeTarget && actor.aim === 0 && actor.meleeCooldownTicks === 0) {
      begin("melee");
      fire = "applied";
    } else {
      const result = beginFirearm(actor, tick, nextActionId, catalog);
      actor = result.actor;
      nextActionId = result.nextActionId;
      markers.push(...result.markers);
      fire = "applied";
    }
  }
  return { actor, markers, nextActionId, fire, grenade };
}
