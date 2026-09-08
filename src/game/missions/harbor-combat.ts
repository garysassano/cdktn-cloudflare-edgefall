import {
  type GrenadierState,
  createGrenadierState,
  stepGrenadier,
  validateGrenadierState,
} from "../actors/grenadier.js";
import { createRifleState } from "../actors/rifle.js";
import { createShieldState } from "../actors/shield.js";
import { createDestructible } from "../combat/destructible.js";
import { createWeaponPickups } from "../combat/pickups.js";
import { canonical } from "../core/canonical.js";
import { integer, pixels } from "../core/numeric.js";
import { EncounterLifecycle } from "../encounters/lifecycle.js";
import {
  type CombatCommand,
  type CombatLab,
  advanceCombatLab,
  combatEncounterDefinition,
  createCombatLab,
} from "../labs/combat.js";
import {
  COMBAT_CATALOG,
  COMBAT_SHAPES,
  GRENADE_PROFILE,
  SHIELD_PROFILE,
} from "../labs/combat-content.js";
import { footActor } from "../labs/foot-fixture.js";
import content from "./compiled/harbor.json" with { type: "json" };
import {
  HARBOR,
  HARBOR_PROPS,
  HARBOR_TERRAIN,
  harborDepot,
  harborPickups,
  harborStage,
} from "./harbor-content.js";

/** Mission combat continuation. Clearing this infantry roster is not a Harbor boss victory. */
export interface HarborCombat {
  format: 1;
  contentHash: string;
  combat: CombatLab;
  grenadiers: Array<{ id: number; state: GrenadierState }>;
}

export function createHarborCombat(players = 1): HarborCombat {
  const combat = createCombatLab("range", players);
  for (const player of combat.players) {
    player.body.x = pixels(HARBOR.checkpoints[0].x + player.slot * 24);
    player.body.y = pixels(HARBOR.checkpoints[0].y);
    player.body.supportId = HARBOR.checkpoints[0].supportId;
    player.weapon.id = HARBOR.loadout.weapon;
    player.weapon.ammo = HARBOR.loadout.ammo;
    player.grenadeStock = HARBOR.loadout.grenades;
  }
  combat.targets = HARBOR.infantry.map((spawn) => {
    const body = footActor(spawn.x, spawn.y).body;
    body.id = spawn.id;
    body.supportId = spawn.supportId;
    return {
      enemy: {
        body,
        facing: -1,
        geometryRevision: 1,
        life: "alive",
        removalReason: null,
        turns: 0,
      },
      health: 1,
      shield: false,
      rifle: spawn.kind === "rifle" ? createRifleState() : null,
      guard: spawn.kind === "shield" ? createShieldState(SHIELD_PROFILE) : null,
    };
  });
  combat.props = HARBOR_PROPS.map(createDestructible);
  combat.tanks = harborDepot(players);
  combat.pickups = createWeaponPickups(harborPickups(players), COMBAT_CATALOG, HARBOR_TERRAIN);
  combat.nextEntityId = 2000;
  combat.encounter = new EncounterLifecycle(combatEncounterDefinition(combat)).begin();
  return {
    format: 1,
    contentHash: content.contentHash,
    combat,
    grenadiers: HARBOR.infantry
      .filter((spawn) => spawn.kind === "grenadier")
      .map((spawn) => ({ id: spawn.id, state: createGrenadierState() })),
  };
}

export function harborCombatStage(state: HarborCombat) {
  const stage = harborStage(0);
  const lead = Math.max(
    0,
    ...state.combat.players
      .filter((player) => player.life === "alive")
      .map((player) => player.body.x),
  );
  stage.activeEnemyIds = new Set(
    HARBOR.infantry
      .filter(
        (spawn) =>
          lead >= pixels(spawn.activateX) ||
          state.combat.encounter.members.some(
            (member) => member.id === spawn.id && member.status !== "pending",
          ),
      )
      .map((spawn) => spawn.id),
  );
  stage.destructibles = HARBOR_PROPS;
  stage.pickups = harborPickups(state.combat.players.length);
  stage.terrain.push(
    ...HARBOR_PROPS.filter((definition) =>
      state.combat.props.some((prop) => prop.id === definition.id && prop.health > 0),
    ).map((definition) => ({
      id: definition.id,
      kind: "solid" as const,
      materialId: definition.materialId,
      rect: { ...definition.rect },
      delta: { x: 0, y: 0 },
    })),
  );
  return stage;
}

export function stepHarborCombat(
  current: HarborCombat,
  commands: readonly CombatCommand[],
): HarborCombat {
  if (current.format !== 1 || current.contentHash !== content.contentHash)
    throw new Error("Harbor combat content mismatch");
  integer(current.combat.tick, 0, HARBOR.maxTicks - 1, "Harbor combat tick");
  if (
    canonical(current.grenadiers.map((grenadier) => grenadier.id)) !==
    canonical(
      HARBOR.infantry.filter((spawn) => spawn.kind === "grenadier").map((spawn) => spawn.id),
    )
  )
    throw new Error("Harbor grenadier roster mismatch");
  const next = structuredClone(current),
    stage = harborCombatStage(next);
  const shape = COMBAT_SHAPES.get(GRENADE_PROFILE.bodyShapeId);
  if (!shape) throw new Error("Missing Harbor grenade body");
  const speeds = new Map<number, number>(),
    releases = [];
  for (const grenadier of next.grenadiers) {
    const target = next.combat.targets.find((target) => target.enemy.body.id === grenadier.id);
    if (!target) throw new Error("Missing Harbor grenadier body");
    const result = stepGrenadier(
      grenadier.state,
      target.enemy,
      next.combat.players,
      stage.activeEnemyIds.has(grenadier.id),
      next.combat.tick + 1,
      next.combat.nextActionId,
      shape,
      stage.terrain,
      HARBOR.grenadier,
    );
    grenadier.state = result.state;
    target.enemy.facing = result.facing;
    speeds.set(grenadier.id, result.speed);
    next.combat.nextActionId = result.nextActionId;
    if (result.release) releases.push(result.release);
  }
  stage.enemyPatrolSpeeds = speeds;
  stage.enemyGrenades = releases;
  next.combat = advanceCombatLab(next.combat, commands, undefined, stage).state;
  for (const grenadier of next.grenadiers) {
    const target = next.combat.targets.find((target) => target.enemy.body.id === grenadier.id);
    if (!target || target.health === 0 || target.enemy.life !== "alive") {
      if (grenadier.state.phase !== "dead") grenadier.state.phaseStartTick = next.combat.tick;
      grenadier.state.phase = "dead";
      grenadier.state.targetId = null;
    }
    validateGrenadierState(
      grenadier.state,
      next.combat.tick,
      next.combat.nextActionId,
      next.combat.players,
      HARBOR.grenadier,
    );
  }
  return next;
}

export interface HarborCombatRecording {
  format: 1;
  contentHash: string;
  players: number;
  commands: CombatCommand[][];
  finalState: string;
}
export function replayHarborCombat(recording: HarborCombatRecording): HarborCombat {
  if (
    recording.format !== 1 ||
    recording.contentHash !== content.contentHash ||
    !Array.isArray(recording.commands) ||
    recording.commands.length > HARBOR.maxTicks
  )
    throw new Error("Invalid Harbor combat recording");
  let state = createHarborCombat(recording.players);
  for (const commands of recording.commands) state = stepHarborCombat(state, commands);
  if (canonical(state) !== recording.finalState) throw new Error("Harbor combat replay diverged");
  return state;
}
