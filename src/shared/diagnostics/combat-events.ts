import type { CombatLab } from "../../game/labs/combat.js";
import { COMBAT_CONTENT } from "../../game/labs/combat-content.js";
import type { EventContext, GameplayEvent } from "../protocol/events.js";
import type { InputIdentity } from "../protocol/schema.js";

export function combatEventContext(identity: InputIdentity): EventContext {
  return {
    ...identity,
    attackIds: new Set(COMBAT_CONTENT.attacks.map((value) => value.id)),
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
  return next.events.map((notice) => {
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
    };
    if (notice.impact) {
      const projectile = previous.projectiles.find(
        (item) => item.id === notice.impact?.projectileId,
      );
      if (!projectile || projectile.actionInstanceId !== notice.actionInstanceId)
        throw new Error("Missing impact attack identity");
      event.definitionId = projectile.definitionId;
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
}
