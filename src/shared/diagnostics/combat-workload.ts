import { rifleMode } from "../../game/actors/rifle.js";
import { shieldMode } from "../../game/actors/shield.js";
import { damagePlayer, stepPlayerLife } from "../../game/campaign/life.js";
import { areaExposures } from "../../game/combat/area-attack.js";
import { beamExposures } from "../../game/combat/beam.js";
import { type DestructibleState, validateDestructibles } from "../../game/combat/destructible.js";
import { advanceFirearmAim } from "../../game/combat/firearm-aim.js";
import { validateWeaponPickups } from "../../game/combat/pickups.js";
import { actionPose } from "../../game/combat/timeline.js";
import { SURFACE_MATERIALS } from "../../game/content/materials.js";
import {
  MATERIAL_CALIBRATION,
  MATERIAL_CASES,
  materialCase,
} from "../../game/content/scenarios/materials.js";
import { LASER_PROFILE } from "../../game/content/weapons/laser.js";
import { ROCKET_PROFILE } from "../../game/content/weapons/rocket-launcher.js";
import { stepFootController } from "../../game/controller/foot.js";
import { canonical } from "../../game/core/canonical.js";
import { Edge, type InputCommand } from "../../game/input/types.js";
import {
  COMBAT_ENTRY,
  COMBAT_TANK_DEPOT,
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
  AREA_PROFILES,
  COMBAT_CATALOG,
  COMBAT_CONTENT,
  COMBAT_SHAPES,
  FOOT_ACTION_PROFILES,
  GRENADE_PROFILE,
  RIFLE_PROFILE,
  SHIELD_PROFILE,
  TANK_PROFILE,
} from "../../game/labs/combat-content.js";
import { combatPickupDefinitions } from "../../game/labs/combat-pickups.js";
import {
  COMBAT_SCENARIOS,
  combatScenarioFromId,
  combatScenarioId,
} from "../../game/labs/combat-scenarios.js";
import {
  COMBAT_ORDNANCE,
  COMBAT_SUPPORT,
  combatCollisionIndex,
  combatDestructibles,
  combatGeometryRevision,
  ordnancePlatforms,
} from "../../game/labs/combat-terrain.js";
import { FOOT_DEFINITION } from "../../game/labs/foot-fixture.js";
import { worldSocket } from "../../game/physics/body.js";
import { ARCADE, RULE_PRESETS } from "../../game/rules.js";
import type { ControlledActor } from "../../game/state.js";
import { publicTankState } from "../../game/vehicles/tank.js";
import type { PreparedPlayerTick, WorldInputOutcome } from "../protocol/input-stream.js";
import type { FullSnapshot } from "../protocol/snapshot-schema.js";
import { controllerPeerContext } from "./controller-recovery.js";
import { PROBE_IDENTITY, createRoomWorkload, roomWorkloadHash } from "./room-workload.js";

export const COMBAT_TERRAIN = combatTerrain("range");
export const COMBAT_SHAPE_IDS = new Set(COMBAT_SHAPES.keys());
export function combatPeerContext(world: FullSnapshot, slot: number) {
  return {
    ...controllerPeerContext(world, slot),
    shapeIds: COMBAT_SHAPE_IDS,
    ...combatGeometryContext(world.combat?.scenarioId),
  };
}
/** This diagnostic content has two loaded scaffold revisions; arbitrary world revisions stay rejected. */
export function combatGeometryContext(expectedScenarioId?: number) {
  return {
    geometryRevisions: new Set([1, 2]),
    validateGeometry: (snapshot: FullSnapshot) => {
      const combat = snapshot.combat;
      if (!combat) throw new Error("Missing combat geometry baseline");
      if (expectedScenarioId !== undefined && combat.scenarioId !== expectedScenarioId)
        throw new Error("Combat scenario changed within loaded content");
      const scenario = combatSnapshotScenario(snapshot);
      const material = materialCase(scenario);
      for (const enemy of snapshot.enemies)
        if (
          material &&
          (enemy.definitionId !== MATERIAL_CALIBRATION.definitionId ||
            enemy.health > MATERIAL_CALIBRATION.targetHealth)
        )
          throw new Error("Material calibration target content mismatch");
      validateWeaponPickups(
        { format: 1, tick: snapshot.tick, items: combat.pickups, contacts: [] },
        combatPickupDefinitions(scenario, snapshot.players.length),
        COMBAT_CATALOG,
        new Set(snapshot.players.map((p) => p.playerId)),
      );
      validateDestructibles(
        combat.props,
        combatDestructibles(scenario),
        snapshot.tick,
        [...snapshot.players.map((p) => p.playerId), ...combat.members.map((m) => m.id)],
        combat.nextActionId,
      );
      if (snapshot.geometryRevision !== combatGeometryRevision(combat.props))
        throw new Error("Destructible geometry revision mismatch");
    },
  };
}
/** Within one run, accepted solid removals are permanent and retain their original attribution. */
export function validateCombatGeometryTransition(previous: FullSnapshot, incoming: FullSnapshot) {
  if (previous.combat?.scenarioId !== incoming.combat?.scenarioId)
    throw new Error("Combat scenario changed within a run");
  const previousPickups = previous.combat?.pickups,
    nextPickups = incoming.combat?.pickups;
  if (!previousPickups || !nextPickups || previousPickups.length !== nextPickups.length)
    throw new Error("Pickup roster changed unexpectedly");
  for (const [index, item] of previousPickups.entries()) {
    const next = nextPickups[index];
    if (
      !next ||
      next.id !== item.id ||
      (!["dormant", "available"].includes(item.status) && canonical(next) !== canonical(item)) ||
      (item.status === "available" && next.status === "dormant") ||
      (item.resolvedTick === null &&
        next.resolvedTick !== null &&
        next.resolvedTick <= previous.tick)
    )
      throw new Error("Pickup history regressed or changed attribution");
  }
  const before = previous.combat?.props,
    after = incoming.combat?.props;
  if (
    !before ||
    !after ||
    before.length !== after.length ||
    incoming.geometryRevision < previous.geometryRevision
  )
    throw new Error("Combat geometry roster/revision changed unexpectedly");
  for (const [index, prop] of before.entries()) {
    const next = after[index];
    if (
      !next ||
      next.id !== prop.id ||
      next.definitionId !== prop.definitionId ||
      next.health > prop.health ||
      (prop.health === 0 && canonical(next) !== canonical(prop)) ||
      (prop.health > 0 && next.destroyedTick !== null && next.destroyedTick <= previous.tick)
    )
      throw new Error("Destructible history regressed or changed attribution");
  }
}
export function combatSnapshotScenario(snapshot: FullSnapshot): CombatScenario {
  if (!snapshot.combat) throw new Error("Missing combat scenario identity");
  return combatScenarioFromId(snapshot.combat.scenarioId);
}
/** Real content digest; simulation/presentation identities remain explicitly diagnostic. */
export async function combatIdentity() {
  const bytes = new TextEncoder().encode(
    canonical({
      content: COMBAT_CONTENT,
      surfaceMaterials: SURFACE_MATERIALS,
      scenarios: COMBAT_SCENARIOS,
      materials: {
        cases: MATERIAL_CASES,
        calibration: MATERIAL_CALIBRATION,
        destructibles: COMBAT_SCENARIOS.map(combatDestructibles),
      },
      campaignFormat: 2,
      combatFormat: 14,
      pickups: [1, 2, 3, 4].map((players) => [
        combatPickupDefinitions("pickups", players),
        combatPickupDefinitions("support", players),
      ]),
      rifle: RIFLE_PROFILE,
      shield: SHIELD_PROFILE,
      areas: [...AREA_PROFILES],
      footActions: FOOT_ACTION_PROFILES,
      grenade: GRENADE_PROFILE,
      rocket: ROCKET_PROFILE,
      tank: TANK_PROFILE,
      tankDepot: COMBAT_TANK_DEPOT,
      ordnance: COMBAT_ORDNANCE,
      laser: LASER_PROFILE,
      support: COMBAT_SUPPORT,
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
        sweep: profile.sweep ?? null,
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
  snapshot.geometryRevision = combatGeometryRevision(combat.props);
  snapshot.players = structuredClone(combat.players);
  snapshot.vehicles = combat.tanks.map(publicTankState);
  snapshot.platforms = combat.scenario === "ordnance" ? ordnancePlatforms(combat.tick) : [];
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
      definitionId: materialCase(combat.scenario)
        ? MATERIAL_CALIBRATION.definitionId
        : guard
          ? 4
          : rifle
            ? 3
            : shield
              ? 2
              : 1,
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
      geometryRevision: snapshot.geometryRevision,
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
      projectile.definitionId === TANK_PROFILE.attackId
        ? TANK_PROFILE.headings.findIndex(
            ({ velocity }) =>
              velocity.x === projectile.velocity.x && velocity.y === projectile.velocity.y,
          )
        : projectile.velocity.y < 0
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
  for (const rocket of combat.rockets)
    snapshot.projectiles.push({
      id: rocket.id,
      ownerId: rocket.ownerId,
      actionInstanceId: rocket.actionInstanceId,
      definitionId: rocket.definitionId,
      x: rocket.position.x,
      y: rocket.position.y,
      vx: rocket.velocity.x,
      vy: rocket.velocity.y,
      spawnTick: rocket.spawnTick,
      lifetimeTicks: ROCKET_PROFILE.lifetimeTicks,
      heading: rocket.heading,
      shapeId: ROCKET_PROFILE.bodyShapeId,
    });
  snapshot.projectiles.sort((a, b) => a.id - b.id);
  snapshot.removedIds = combat.targets
    .filter((target) => target.health === 0)
    .map((target) => target.enemy.body.id)
    .concat(combat.props.filter((prop) => prop.health === 0).map((prop) => prop.id))
    .concat(
      combat.pickups.items
        .filter((item) => !["dormant", "available"].includes(item.status))
        .map((item) => item.id),
    )
    .sort((a, b) => a - b);
  snapshot.campaign.remainingEnemies = combat.targets.filter((target) => target.health > 0).length;
  snapshot.campaign.encounterId = 1;
  const definition = combatEncounterDefinition(combat);
  snapshot.combat = {
    scenarioId: combatScenarioId(combat.scenario),
    props: structuredClone(combat.props),
    pickups: structuredClone(combat.pickups.items),
    volumes: combat.areas
      .flatMap((area) => {
        const profile = AREA_PROFILES.get(area.definitionId);
        if (!profile) throw new Error("Missing area snapshot profile");
        return areaExposures(
          area,
          combat.tick,
          profile,
          combatTerrain(combat.scenario, combat.tick, combat.props),
        );
      })
      .concat(combat.beams.flatMap((beam) => beamExposures(beam, LASER_PROFILE)))
      .sort((a, b) => a.id - b.id || a.lobe - b.lobe),
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
export function createCombatWorkload(scenario: CombatScenario = "range", players = 4) {
  const combat = createCombatLab(scenario, players),
    baseline = createRoomWorkload(1);
  baseline.acknowledgments = baseline.acknowledgments.filter((ack) =>
    combat.players.some((player) => player.playerId === ack.playerId),
  );
  return { combat, snapshot: combatSnapshot(combat, baseline) };
}
export function evaluateCombatTick(
  current: CombatLab,
  previous: FullSnapshot,
  prepared: readonly PreparedPlayerTick[],
  releasePlayerIds: readonly number[] = [],
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
      interactPressed:
        item?.input.command.edges.some((edge) => edge.kind === Edge.Interact) ?? false,
    };
  });
  const result = advanceCombatLab(current, commands, {
    connectedPlayerIds: prepared.map((item) => item.input.playerId),
    releasePlayerIds,
  });
  const outcomes: WorldInputOutcome[] = prepared.map((item) => {
    const actor = result.state.players.find((player) => player.playerId === item.input.playerId);
    const outcome = result.outcomes.find((value) => value.playerId === item.input.playerId);
    if (!actor || !outcome) throw new Error("Unknown combat input owner");
    actor.processedEdgeIds = [...item.acknowledgment.processedEdgeIds];
    let jump = false,
      grenade = false,
      fire = false,
      interact = false;
    return {
      playerId: actor.playerId,
      ...(actor.controlEpoch !== item.acknowledgment.controlEpoch
        ? { controlEpoch: actor.controlEpoch }
        : {}),
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
        if (edge.kind === Edge.Interact && !interact) {
          accepted = outcome.interact === "none" ? "unavailable" : outcome.interact;
          interact = true;
        } else if (edge.kind === Edge.Interact) accepted = "cooldown";
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
  for (const ack of snapshot.acknowledgments) {
    const actor = result.state.players.find((player) => player.playerId === ack.playerId);
    if (!actor) throw new Error("Missing combat ownership acknowledgment");
    ack.controlEpoch = actor.controlEpoch;
  }
  snapshot.stateHash = roomWorkloadHash(snapshot);
  return { state: { combat: result.state, snapshot }, outcomes, seatEvents: result.seatEvents };
}
/** Movement prediction only until global action IDs and effect confirmations are integrated. */
export function predictCombatMovement(
  actor: ControlledActor,
  command: InputCommand,
  tick: number,
  scenario: CombatScenario = "range",
  props: readonly DestructibleState[] = [],
) {
  if (!FOOT_DEFINITION) throw new Error("Missing combat foot definition");
  const frame = { tick, geometryRevision: combatGeometryRevision(props) };
  const index = combatCollisionIndex(scenario, frame, props);
  const life = stepPlayerLife(
    actor,
    tick,
    "classic",
    combatEntryContext(actor, index, frame, scenario),
  );
  const result = stepFootController(
    life.actor,
    { held: command.held, jumpPressed: command.edges.some((edge) => edge.kind === Edge.Jump) },
    FOOT_DEFINITION,
    COMBAT_SHAPES,
    index,
    frame,
  );
  if (result.status === "failed") {
    if (result.physics.reason === "crushed")
      return damagePlayer(life.actor, tick, 1, "classic", "crush").actor;
    throw new Error(`Combat prediction: ${result.physics.reason}`);
  }
  result.actor.firearmAim = advanceFirearmAim(result.actor, tick, COMBAT_CATALOG);
  return result.actor.life === "alive" && result.actor.body.y > COMBAT_ENTRY.fallBoundary
    ? damagePlayer(result.actor, tick, 1, "classic", "fall").actor
    : result.actor;
}
