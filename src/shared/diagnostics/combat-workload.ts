import { rifleMode } from "../../game/actors/rifle.js";
import { shieldMode } from "../../game/actors/shield.js";
import { damagePlayer, stepPlayerLife } from "../../game/campaign/life.js";
import { actionPose } from "../../game/combat/timeline.js";
import { stepFootController } from "../../game/controller/foot.js";
import { canonical } from "../../game/core/canonical.js";
import { Edge, type InputCommand } from "../../game/input/types.js";
import {
  COMBAT_ENTRY,
  type CombatLab,
  type CombatScenario,
  advanceCombatLab,
  combatEncounterDefinition,
  combatEntryContext,
  combatTerrain,
  createCombatLab,
} from "../../game/labs/combat.js";
import type { CombatCampaign } from "../../game/labs/combat-campaign.js";
import {
  COMBAT_CATALOG,
  COMBAT_CONTENT,
  COMBAT_SHAPES,
  FOOT_ACTION_PROFILES,
  GRENADE_PROFILE,
  RIFLE_PROFILE,
  SHIELD_PROFILE,
} from "../../game/labs/combat-content.js";
import { FOOT_DEFINITION } from "../../game/labs/foot-fixture.js";
import { worldSocket } from "../../game/physics/body.js";
import { CollisionGrid, CollisionIndex } from "../../game/physics/grid.js";
import { ARCADE, RULE_PRESETS } from "../../game/rules.js";
import type { ControlledActor } from "../../game/state.js";
import type { PreparedPlayerTick, WorldInputOutcome } from "../protocol/input-stream.js";
import type { FullSnapshot } from "../protocol/snapshot-schema.js";
import { controllerPeerContext } from "./controller-recovery.js";
import { PROBE_IDENTITY, createRoomWorkload, roomWorkloadHash } from "./room-workload.js";

export const COMBAT_TERRAIN = combatTerrain("range");
const grid = new CollisionGrid(COMBAT_TERRAIN);
export const COMBAT_SHAPE_IDS = new Set(COMBAT_SHAPES.keys());
export function combatPeerContext(world: FullSnapshot, slot: number) {
  return { ...controllerPeerContext(world, slot), shapeIds: COMBAT_SHAPE_IDS };
}
/** Real content digest; simulation/presentation identities remain explicitly diagnostic. */
export async function combatIdentity() {
  const bytes = new TextEncoder().encode(
    canonical({
      content: COMBAT_CONTENT,
      campaignFormat: 1,
      rifle: RIFLE_PROFILE,
      shield: SHIELD_PROFILE,
      footActions: FOOT_ACTION_PROFILES,
      grenade: GRENADE_PROFILE,
      life: {
        rules: RULE_PRESETS,
        deathTicks: ARCADE.deathTicks,
        entryTicks: ARCADE.respawnEntryTicks,
        protectionTicks: ARCADE.respawnProtectionTicks,
        checkpoint: COMBAT_ENTRY,
      },
      profiles: [...COMBAT_CATALOG.firearms].map(([id, profile]) => ({
        id,
        timelineIds: profile.timelineIds,
      })),
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    ...PROBE_IDENTITY,
    contentHash: Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
  };
}
export function projectCombatCampaign(snapshot: FullSnapshot, campaign: CombatCampaign): void {
  const { ruleset, mission, checkpointId, continuesRemaining, continuesUsed, phase, encounterId } =
    campaign.state;
  Object.assign(snapshot.campaign, {
    ruleset,
    mission,
    checkpointId,
    continuesRemaining,
    continuesUsed,
    phase,
    encounterId,
  });
}
export function combatSnapshot(
  combat: CombatLab,
  previous = createRoomWorkload(1),
  campaign?: CombatCampaign,
): FullSnapshot {
  const snapshot = structuredClone(previous);
  snapshot.tick = combat.tick;
  snapshot.players = structuredClone(combat.players);
  snapshot.vehicles = [];
  snapshot.platforms = [];
  snapshot.threats = combat.targets.flatMap(({ enemy, health, rifle }) => {
    if (
      !rifle ||
      health === 0 ||
      rifle.action.kind !== "fire" ||
      combat.tick - rifle.action.stateStartTick > RIFLE_PROFILE.lastReleaseTick
    )
      return [];
    const pose = actionPose(
      COMBAT_CATALOG,
      rifle.action.definitionId,
      combat.tick - rifle.action.stateStartTick,
    );
    const socket = pose?.sockets.find((socket) => socket.name === "muzzle");
    const attack = COMBAT_CONTENT.attacks.find((attack) => attack.id === 3);
    if (!socket || !attack) throw new Error("Missing rifle threat content");
    const point = worldSocket(enemy.body, socket.point, enemy.facing);
    return [
      {
        actionInstanceId: rifle.action.actionInstanceId,
        sourceId: enemy.body.id,
        definitionId: attack.id,
        telegraphTick: rifle.action.stateStartTick,
        activeTick: rifle.action.stateStartTick + RIFLE_PROFILE.raiseTicks,
        endTick: rifle.action.stateStartTick + RIFLE_PROFILE.lastReleaseTick,
        x: point.x,
        y: point.y,
        vx: rifle.aim === 0 ? attack.speed * enemy.facing : 0,
        vy: rifle.aim === 1 ? -attack.speed : 0,
        heading: rifle.aim === 1 ? 1 : enemy.facing === -1 ? 3 : 0,
        targetId: rifle.targetId,
        motion: "locked" as const,
        cancelled: false,
        stateVersion: 1,
        shapeId: attack.shapeId,
      },
    ];
  });
  for (const player of combat.players) {
    if (player.life !== "alive" || player.action.kind !== "melee") continue;
    const marker = COMBAT_CATALOG.timelines
      .get(player.action.definitionId)
      ?.markers.find((marker) => marker.kind === "activate-hitbox");
    const definition =
      marker && COMBAT_CONTENT.attacks.find((attack) => attack.id === marker.payloadId);
    if (!marker || !definition) throw new Error("Missing melee threat window");
    const activeTick = player.action.stateStartTick + marker.tickOffset;
    const endTick = activeTick + definition.lifetimeTicks;
    if (combat.tick >= endTick) continue;
    const pose = actionPose(
      COMBAT_CATALOG,
      player.action.definitionId,
      combat.tick - player.action.stateStartTick,
    );
    const socket = pose?.sockets.find((socket) => socket.name === "hand");
    if (!socket) throw new Error("Missing melee threat socket");
    const hand = worldSocket(player.body, socket.point, player.facing);
    snapshot.threats.push({
      actionInstanceId: player.action.actionInstanceId,
      sourceId: player.playerId,
      definitionId: 4,
      telegraphTick: player.action.stateStartTick,
      activeTick,
      endTick,
      x: hand.x,
      y: hand.y,
      vx: 0,
      vy: 0,
      heading: player.facing === 1 ? 0 : 3,
      targetId: null,
      motion: "authored",
      cancelled: false,
      stateVersion: 1,
      shapeId: 9,
    });
  }
  for (const target of combat.targets) {
    const guard = target.guard;
    if (
      !guard ||
      target.health === 0 ||
      guard.phase !== "bash" ||
      combat.tick - guard.action.stateStartTick >=
        SHIELD_PROFILE.bashActiveTick + SHIELD_PROFILE.bashActiveTicks
    )
      continue;
    const pose = actionPose(
      COMBAT_CATALOG,
      guard.action.definitionId,
      combat.tick - guard.action.stateStartTick,
    );
    const socket = pose?.sockets.find((socket) => socket.name === "hand");
    if (!socket) throw new Error("Missing bash telegraph socket");
    const point = worldSocket(target.enemy.body, socket.point, guard.facing);
    snapshot.threats.push({
      actionInstanceId: guard.action.actionInstanceId,
      sourceId: target.enemy.body.id,
      definitionId: 6,
      telegraphTick: guard.action.stateStartTick,
      activeTick: guard.action.stateStartTick + SHIELD_PROFILE.bashActiveTick,
      endTick:
        guard.action.stateStartTick +
        SHIELD_PROFILE.bashActiveTick +
        SHIELD_PROFILE.bashActiveTicks,
      ...point,
      vx: 0,
      vy: 0,
      heading: guard.facing === 1 ? 0 : 3,
      targetId: guard.targetId,
      motion: "authored",
      cancelled: false,
      stateVersion: 1,
      shapeId: 12,
    });
  }
  snapshot.threats.sort((a, b) => a.actionInstanceId - b.actionInstanceId);
  snapshot.enemies = combat.targets
    .filter((target) => target.health > 0)
    .map(({ enemy, health, shield, rifle, guard }) => ({
      id: enemy.body.id,
      definitionId: guard ? 4 : rifle ? 3 : shield ? 2 : 1,
      x: enemy.body.x,
      y: enemy.body.y,
      vx: enemy.body.vx,
      vy: enemy.body.vy,
      shapeId: enemy.body.shapeId,
      facing: enemy.facing,
      health,
      mode: guard ? shieldMode(guard) : rifle ? rifleMode(rifle, combat.tick, RIFLE_PROFILE) : 0,
      stateStartTick: guard?.action.stateStartTick ?? rifle?.action.stateStartTick ?? 0,
      actionInstanceId:
        guard?.action.actionInstanceId ??
        (rifle?.action.kind === "fire" ? rifle.action.actionInstanceId : 0),
      actionDefinitionId:
        guard?.action.definitionId ??
        (rifle?.action.kind === "fire" ? rifle.action.definitionId : 0),
      modeTicks: guard?.action.actionInstanceId
        ? combat.tick - guard.action.stateStartTick
        : rifle?.action.kind === "fire"
          ? combat.tick - rifle.action.stateStartTick
          : 0,
      supportId: enemy.body.supportId,
      geometryRevision: 1,
    }));
  snapshot.projectiles = combat.projectiles.map((projectile) => ({
    id: projectile.id,
    ownerId: projectile.ownerId,
    actionInstanceId: projectile.actionInstanceId,
    definitionId: projectile.definitionId,
    x: projectile.position.x,
    y: projectile.position.y,
    vx: projectile.velocity.x,
    vy: projectile.velocity.y,
    spawnTick: projectile.spawnTick,
    lifetimeTicks:
      COMBAT_CONTENT.attacks.find((attack) => attack.id === projectile.definitionId)
        ?.lifetimeTicks ?? 0,
    heading:
      projectile.velocity.y < 0
        ? 1
        : projectile.velocity.y > 0
          ? 2
          : projectile.velocity.x < 0
            ? 3
            : 0,
    shapeId: 4,
  }));
  for (const grenade of combat.grenades)
    snapshot.projectiles.push({
      id: grenade.id,
      ownerId: grenade.ownerId,
      actionInstanceId: grenade.actionInstanceId,
      definitionId: grenade.definitionId,
      x: grenade.body.x,
      y: grenade.body.y,
      vx: grenade.body.vx,
      vy: grenade.body.vy,
      spawnTick: grenade.spawnTick,
      lifetimeTicks: GRENADE_PROFILE.fuseTicks,
      heading: grenade.body.vy < 0 ? 1 : grenade.body.vy > 0 ? 2 : grenade.body.vx < 0 ? 3 : 0,
      shapeId: grenade.body.shapeId,
    });
  snapshot.projectiles.sort((a, b) => a.id - b.id);
  snapshot.removedIds = combat.targets
    .filter((target) => target.health === 0)
    .map((target) => target.enemy.body.id);
  snapshot.campaign.remainingEnemies = combat.targets.filter((target) => target.health > 0).length;
  snapshot.campaign.encounterId = 1;
  const definition = combatEncounterDefinition(combat);
  snapshot.combat = {
    nextEntityId: combat.nextEntityId,
    nextActionId: combat.nextActionId,
    encounterEventCursor: combat.eventSequence,
    encounterId: definition.id,
    phase: combat.encounter.phase,
    members: combat.encounter.members.map((member, index) => {
      const policy = definition.members[index];
      if (!policy || policy.id !== member.id) throw new Error("Combat roster mismatch");
      return {
        id: member.id,
        required: policy.required,
        critical: policy.critical,
        retreatAllowed: policy.retreatAllowed,
        status: member.status,
        activatedTick: member.activatedTick,
        resolvedTick: member.resolvedTick,
        reason: member.reason,
        killerId: member.killerId,
      };
    }),
    objectives: structuredClone(combat.encounter.objectives),
    kills: structuredClone(combat.encounter.kills),
    failure: structuredClone(combat.encounter.failure),
  };
  if (campaign) projectCombatCampaign(snapshot, campaign);
  snapshot.stateHash = roomWorkloadHash(snapshot);
  return snapshot;
}
export function createCombatWorkload(scenario: CombatScenario = "range") {
  const combat = createCombatLab(scenario, 4);
  return { combat, snapshot: combatSnapshot(combat) };
}
export function evaluateCombatTick(
  current: CombatLab,
  previous: FullSnapshot,
  prepared: readonly PreparedPlayerTick[],
) {
  if (current.tick !== previous.tick) throw new Error("Combat/snapshot boundary mismatch");
  const commands = current.players.map((actor) => {
    const item = prepared.find(({ input }) => input.playerId === actor.playerId);
    if (item && item.input.serverTick !== current.tick + 1)
      throw new Error("Combat input tick mismatch");
    return {
      held: item?.input.command.held ?? 0,
      jumpPressed: item?.input.command.edges.some((edge) => edge.kind === Edge.Jump) ?? false,
      firePressed: item?.input.command.edges.some((edge) => edge.kind === Edge.FireOnset) ?? false,
      grenadePressed: item?.input.command.edges.some((edge) => edge.kind === Edge.Grenade) ?? false,
    };
  });
  const result = advanceCombatLab(current, commands);
  const outcomes: WorldInputOutcome[] = prepared.map((item) => {
    const actor = result.state.players.find((player) => player.playerId === item.input.playerId);
    const outcome = result.outcomes.find((value) => value.playerId === item.input.playerId);
    if (!actor || !outcome) throw new Error("Unknown combat input owner");
    actor.processedEdgeIds = [...item.acknowledgment.processedEdgeIds];
    let jump = false,
      grenade = false,
      fire = false;
    return {
      playerId: actor.playerId,
      edgeResults: item.input.command.edges.map((edge) => {
        let accepted: "applied" | "cooldown" | "unavailable" = "unavailable";
        if (edge.kind === Edge.Jump && !jump) {
          accepted = outcome.jumpAccepted ? "applied" : "unavailable";
          jump = true;
        }
        if (edge.kind === Edge.Grenade && !grenade) {
          accepted = outcome.grenade === "none" ? "unavailable" : outcome.grenade;
          grenade = true;
        } else if (edge.kind === Edge.Grenade) accepted = "cooldown";
        if (edge.kind === Edge.FireOnset && !fire) {
          accepted = outcome.fire === "none" ? "unavailable" : outcome.fire;
          fire = true;
        } else if (edge.kind === Edge.FireOnset) accepted = "cooldown";
        return { ...edge, outcome: accepted };
      }),
    };
  });
  const snapshot = combatSnapshot(result.state, previous);
  for (const item of prepared) {
    const index = snapshot.acknowledgments.findIndex((ack) => ack.playerId === item.input.playerId);
    if (index < 0) throw new Error("Missing combat acknowledgment");
    snapshot.acknowledgments[index] = structuredClone(item.acknowledgment);
  }
  snapshot.stateHash = roomWorkloadHash(snapshot);
  return { state: { combat: result.state, snapshot }, outcomes };
}
/** Movement prediction only until global action IDs and effect confirmations are integrated. */
export function predictCombatMovement(actor: ControlledActor, command: InputCommand, tick: number) {
  if (!FOOT_DEFINITION) throw new Error("Missing combat foot definition");
  const frame = { tick, geometryRevision: 1 };
  const index = new CollisionIndex(grid, [], frame);
  const life = stepPlayerLife(actor, tick, "classic", combatEntryContext(actor, index, frame));
  const result = stepFootController(
    life.actor,
    { held: command.held, jumpPressed: command.edges.some((edge) => edge.kind === Edge.Jump) },
    FOOT_DEFINITION,
    COMBAT_SHAPES,
    index,
    frame,
  );
  if (result.status === "failed") throw new Error(`Combat prediction: ${result.physics.reason}`);
  return result.actor.life === "alive" && result.actor.body.y > COMBAT_ENTRY.fallBoundary
    ? damagePlayer(result.actor, tick, 1, "classic", "fall").actor
    : result.actor;
}
