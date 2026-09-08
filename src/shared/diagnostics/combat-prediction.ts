import { shieldPresentation } from "../../game/actors/shield.js";
import { destructibleHurtboxes } from "../../game/combat/destructible.js";
import { stepFootCombatAction } from "../../game/combat/foot-actions.js";
import type { HurtTarget } from "../../game/combat/projectile.js";
import { actionPose } from "../../game/combat/timeline.js";
import { Edge, type InputCommand } from "../../game/input/types.js";
import { combatMeleeEligible } from "../../game/labs/combat.js";
import {
  COMBAT_CATALOG,
  COMBAT_SHAPES,
  FOOT_ACTION_PROFILES,
  SHIELD_PROFILE,
} from "../../game/labs/combat-content.js";
import { combatDestructibles, combatEndTerrain } from "../../game/labs/combat-terrain.js";
import { worldRect, worldSocket } from "../../game/physics/body.js";
import type { ControlledActor } from "../../game/state.js";
import type { PredictionFrame } from "../prediction/controller.js";
import type { PredictedFirearmCue } from "../prediction/firearm-feedback.js";
import type { FullSnapshot } from "../protocol/snapshot-schema.js";
import { combatSnapshotScenario, predictCombatMovement } from "./combat-workload.js";

/** Locomotion and action timing share the kernel; target poses remain snapshot estimates. */
export function predictCombatController(
  actor: ControlledActor,
  command: InputCommand,
  tick: number,
  snapshot: FullSnapshot,
): ControlledActor {
  const scenario = combatSnapshotScenario(snapshot),
    props = snapshot.combat?.props ?? [],
    moved = predictCombatMovement(actor, command, tick, scenario, props);
  const hurtboxes: HurtTarget[] = snapshot.enemies.flatMap((enemy) => {
    const protectedBody =
      enemy.definitionId === 2 ||
      (enemy.definitionId === 4 &&
        shieldPresentation(enemy.mode, enemy.modeTicks, SHIELD_PROFILE).raised);
    return (protectedBody ? (["body", "shield"] as const) : (["body"] as const)).map((kind) => {
      const shape = COMBAT_SHAPES.get(kind === "body" ? 3 : 8);
      if (!shape) throw new Error("Missing predicted target shape");
      return {
        id: enemy.id * 2 + (kind === "shield" ? 1 : 0),
        entityId: enemy.id,
        team: 2,
        kind,
        rect: worldRect(enemy, shape.rect, enemy.facing),
        delta: { x: 0, y: 0 },
      };
    });
  });
  hurtboxes.push(...destructibleHurtboxes(props, combatDestructibles(scenario)));
  return stepFootCombatAction(
    moved,
    {
      held: command.held,
      firePressed: command.edges.some((edge) => edge.kind === Edge.FireOnset),
      grenadePressed: command.edges.some((edge) => edge.kind === Edge.Grenade),
    },
    tick,
    // A private replay allocator only satisfies the shared action contract. No predicted
    // global ID, damage, entity, inventory grant or event is ever sent to the room.
    Math.max(moved.action.actionInstanceId, moved.weapon.lastActionInstanceId) + 1,
    COMBAT_CATALOG,
    FOOT_ACTION_PROFILES,
    combatMeleeEligible(
      moved,
      // Damageable cover occurs once in the query, as a solid hurtbox, just as in
      // the authoritative action phase. Including its terrain ID too is invalid.
      combatEndTerrain(scenario, tick, props).filter(
        (surface) => !props.some((prop) => prop.id === surface.id),
      ),
      hurtboxes,
    ),
  ).actor;
}

/** Pure projection: re-running a pending controller never invokes a presentation callback. */
export function predictedFirearmCues(frames: readonly PredictionFrame[]): PredictedFirearmCue[] {
  return frames.flatMap(({ sequence, tick, actor }) => {
    if (actor.life !== "alive" || actor.vehicleId !== null || actor.action.kind !== "fire")
      return [];
    const age = tick - actor.action.stateStartTick,
      timeline = COMBAT_CATALOG.timelines.get(actor.action.definitionId),
      pose = actionPose(COMBAT_CATALOG, actor.action.definitionId, age);
    if (!timeline || !pose) throw new Error("Missing predicted firearm pose");
    return timeline.markers.flatMap((marker, markerIndex) => {
      if (marker.kind !== "spawn-attack" || marker.tickOffset !== age) return [];
      const socket = pose.sockets.find((socket) => socket.name === marker.socket);
      if (!socket) throw new Error("Missing predicted firearm socket");
      return [
        {
          sequence,
          tick,
          confirmation: {
            playerId: actor.playerId,
            controlEpoch: actor.controlEpoch,
            shotOrdinal: actor.weapon.shotOrdinal,
          },
          markerIndex,
          definitionId: marker.payloadId,
          ...worldSocket(actor.body, socket.point, actor.facing),
        },
      ];
    });
  });
}
