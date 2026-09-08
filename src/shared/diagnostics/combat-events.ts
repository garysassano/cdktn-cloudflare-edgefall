import { LASER_ATTACK, LASER_PROFILE } from "../../game/content/weapons/laser.js";
import type { CombatLab } from "../../game/labs/combat.js";
import { COMBAT_CONTENT } from "../../game/labs/combat-content.js";
import { combatPickupDefinitions } from "../../game/labs/combat-pickups.js";
import type { EventContext, GameplayEvent } from "../protocol/events.js";
import type { InputIdentity } from "../protocol/schema.js";

export function combatEventContext(identity: InputIdentity): EventContext {
  return {
    ...identity,
    attackIds: new Set(COMBAT_CONTENT.attacks.map((value) => value.id)),
    beamProfiles: new Map([[LASER_ATTACK.id, LASER_PROFILE]]),
    pickupDefinitions: new Map(
      [...combatPickupDefinitions("pickups", 4), ...combatPickupDefinitions("support", 4)].map(
        (def) => [def.id, def],
      ),
    ),
    soundIds: new Set(
      COMBAT_CONTENT.timelines.flatMap((timeline) =>
        timeline.markers
          .filter((marker) => marker.kind === "sound")
          .map((marker) => marker.payloadId),
      ),
    ),
  };
}
/** Adapts committed kernel notices without making the simulation depend on a wire transport. */
export function combatGameplayEvents(previous: CombatLab, next: CombatLab): GameplayEvent[] {
  if (next.tick !== previous.tick + 1) throw new Error("Combat event boundary mismatch");
  const events = next.events.map((notice) => {
    const event: GameplayEvent = {
      kind: notice.kind,
      origin: previous.players.some((player) => player.playerId === notice.ownerId)
        ? "player"
        : "enemy",
      ownerId: notice.ownerId,
      actionInstanceId: notice.actionInstanceId,
      markerIndex: notice.markerIndex,
      definitionId: 0,
      x: notice.position.x,
      y: notice.position.y,
      targetId: notice.targetId,
      material: notice.impact?.kind ?? (notice.kind === "muzzle-blocked" ? "terrain" : "none"),
      confirmation: null,
      beam: notice.beam,
      pickup: null,
    };
    if (notice.impact) {
      if (notice.impact.actionInstanceId !== notice.actionInstanceId)
        throw new Error("Missing impact attack identity");
      event.definitionId = notice.impact.definitionId;
    } else {
      const source = notice.source;
      if (!source) throw new Error("Missing firearm confirmation source");
      event.definitionId = source.definitionId;
      if ("controlEpoch" in source)
        event.confirmation = {
          playerId: notice.ownerId,
          controlEpoch: source.controlEpoch,
          shotOrdinal: source.shotOrdinal,
        };
    }
    return event;
  });
  const definitions = combatPickupDefinitions(next.scenario, next.players.length);
  for (const claim of next.pickupClaims) {
    const def = definitions.find((def) => def.id === claim.id);
    if (!def || claim.tick !== next.tick) throw new Error("Missing pickup event content/boundary");
    events.push({
      kind: "pickup",
      origin: "player",
      ownerId: claim.playerId,
      actionInstanceId: 0,
      markerIndex: 0,
      definitionId: claim.sourceId,
      targetId: claim.id,
      x: def.rect.x,
      y: def.rect.y,
      material: "none",
      confirmation: null,
      beam: null,
      pickup: {
        claimId: claim.claimId,
        weaponId: claim.weaponId,
        previousWeaponId: claim.previousWeaponId,
        previousAmmo: claim.previousAmmo,
        ammo: claim.ammo,
      },
    });
  }
  return events;
}
