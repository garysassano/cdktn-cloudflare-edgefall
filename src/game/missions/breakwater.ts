import { createRifleState } from "../actors/rifle.js";
import { createShieldState } from "../actors/shield.js";
import { cancelArea } from "../combat/area-attack.js";
import { createDestructible } from "../combat/destructible.js";
import {
  type WeaponPickupClaim,
  type WeaponPickupState,
  createWeaponPickups,
  stepWeaponPickups,
} from "../combat/pickups.js";
import { canonical } from "../core/canonical.js";
import { integer, pixels } from "../core/numeric.js";
import { EncounterLifecycle } from "../encounters/lifecycle.js";
import {
  type CombatCommand,
  type CombatLab,
  type CombatStage,
  advanceCombatLab,
  combatAreaAnchor,
  combatEncounterDefinition,
  createCombatLab,
} from "../labs/combat.js";
import {
  AREA_PROFILES,
  COMBAT_CATALOG,
  SHIELD_PROFILE,
  TANK_PROFILE,
} from "../labs/combat-content.js";
import { footActor } from "../labs/foot-fixture.js";
import { createTank } from "../vehicles/tank.js";
import {
  type LockEngine,
  advanceLockEngine,
  damageLockEngine,
  initialLockEngine,
  lockEngineHurtboxes,
} from "./breakwater-boss.js";
import {
  BREAKWATER,
  BREAKWATER_PROPS,
  BREAKWATER_TERRAIN,
  breakwaterPickups,
} from "./breakwater-content.js";
import digest from "./compiled/breakwater.json" with { type: "json" };

export interface BreakwaterMission {
  format: 6;
  contentHash: string;
  seed: number;
  phase: "playing" | "victory" | "defeat";
  finishedTick: number | null;
  checkpoint: number;
  combat: CombatLab;
  boss: LockEngine;
  supplies: WeaponPickupState;
  notices: Array<{
    kind: "pickup" | "checkpoint" | "victory" | "defeat";
    tick: number;
    id: number;
    playerId: number | null;
    claim: WeaponPickupClaim | null;
  }>;
}
export function createBreakwater(players = 1, seed = 0x42574159): BreakwaterMission {
  integer(players, 1, 4, "mission players");
  integer(seed, 1, 0xffffffff, "mission seed");
  const combat = createCombatLab("range", players);
  for (const player of combat.players) {
    player.body.x = pixels(48 + player.slot * 24);
    player.weapon.id = "sidearm";
    player.weapon.ammo = 0;
    player.grenadeStock = 6;
  }
  let random = seed;
  combat.targets = BREAKWATER.enemies.map((spawn) => {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const body = footActor(spawn.x + (random % 17) - 8, spawn.y).body;
    body.id = spawn.id;
    body.supportId = "supportId" in spawn ? spawn.supportId : 100;
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
  combat.tanks = [
    createTank(
      BREAKWATER.tank.id,
      { x: pixels(BREAKWATER.tank.x), y: pixels(BREAKWATER.tank.y) },
      100,
      TANK_PROFILE,
    ),
  ];
  combat.props = BREAKWATER_PROPS.map(createDestructible);
  combat.nextEntityId = 2000;
  combat.encounter = new EncounterLifecycle(combatEncounterDefinition(combat)).begin();
  return {
    format: 6,
    contentHash: digest.contentHash,
    seed,
    phase: "playing",
    finishedTick: null,
    checkpoint: 0,
    combat,
    boss: initialLockEngine(players),
    supplies: createWeaponPickups(breakwaterPickups(players), COMBAT_CATALOG, BREAKWATER_TERRAIN),
    notices: [],
  };
}
export function breakwaterTerrain(mission: BreakwaterMission) {
  return [
    ...BREAKWATER_TERRAIN,
    ...mission.combat.props
      .filter((prop) => prop.health > 0)
      .map((prop) => {
        const definition = BREAKWATER_PROPS.find((d) => d.id === prop.id);
        if (!definition) throw new Error("Unknown quay prop");
        return {
          id: prop.id,
          kind: "solid" as const,
          materialId: definition.materialId,
          rect: { ...definition.rect },
          delta: { x: 0, y: 0 },
        };
      }),
  ];
}
export function breakwaterStage(mission: BreakwaterMission): CombatStage {
  const entry = BREAKWATER.checkpoints[mission.checkpoint];
  if (!entry) throw new Error("Unknown mission checkpoint");
  const lead = Math.max(
    0,
    ...mission.combat.players.filter((p) => p.life === "alive").map((p) => p.body.x),
  );
  return {
    terrain: breakwaterTerrain(mission),
    destructibles: BREAKWATER_PROPS,
    enemyBounds: { x: 0, y: 0, w: pixels(BREAKWATER.width), h: pixels(232) },
    fallBoundary: pixels(248),
    entry: { x: pixels(entry.x), y: pixels(entry.y) },
    activeEnemyIds: new Set(
      BREAKWATER.enemies
        .filter(
          (spawn) =>
            lead >= pixels(spawn.activateX) ||
            mission.combat.encounter.members.some(
              (m) => m.id === spawn.id && m.status !== "pending",
            ),
        )
        .map((spawn) => spawn.id),
    ),
    extraHurtboxes: lockEngineHurtboxes(mission.boss),
  };
}
/** One accepted mission boundary. Only input and this state can change inventory, targets or outcomes. */
export function stepBreakwater(
  current: BreakwaterMission,
  commands: readonly CombatCommand[],
): BreakwaterMission {
  if (current.contentHash !== digest.contentHash || current.format !== 6)
    throw new Error("Mission content mismatch");
  if (current.phase !== "playing") return structuredClone(current);
  integer(current.combat.tick, 0, BREAKWATER.maxTicks - 1, "mission tick");
  if (commands.length !== current.combat.players.length) throw new Error("Missing mission input");
  const mission = structuredClone(current);
  mission.notices = [];
  if (mission.supplies.tick !== mission.combat.tick)
    throw new Error("Mission supply boundary mismatch");
  const lead = Math.max(
    0,
    ...mission.combat.players.filter((p) => p.life === "alive").map((p) => p.body.x),
  );
  const bossEvents = advanceLockEngine(mission.boss, mission.combat, lead);
  const result = advanceCombatLab(mission.combat, commands, undefined, breakwaterStage(mission));
  mission.combat = result.state;
  mission.combat.events.unshift(...bossEvents);
  mission.combat.events.push(
    ...damageLockEngine(mission.boss, result.impacts, mission.combat.tick),
  );
  const supplied = stepWeaponPickups(
    mission.supplies,
    breakwaterPickups(mission.combat.players.length),
    mission.combat.players,
    result.playerMovement,
    breakwaterTerrain(mission),
    COMBAT_CATALOG,
  );
  mission.supplies = supplied.state;
  mission.combat.players = supplied.players;
  for (const claim of supplied.claims)
    mission.notices.push({
      kind: "pickup",
      id: claim.id,
      playerId: claim.playerId,
      tick: claim.tick,
      claim,
    });
  mission.combat.beams = mission.combat.beams.filter(
    (beam) => combatAreaAnchor(mission.combat, beam) !== null,
  );
  for (const area of mission.combat.areas) {
    const profile = AREA_PROFILES.get(area.definitionId);
    if (!profile) throw new Error("Missing supply cancellation profile");
    if (!combatAreaAnchor(mission.combat, area)) cancelArea(area, mission.combat.tick, profile);
  }
  const checkpoint = BREAKWATER.checkpoints.findLastIndex((p) => lead >= pixels(p.x));
  if (checkpoint > mission.checkpoint) {
    mission.checkpoint = checkpoint;
    mission.notices.push({
      kind: "checkpoint",
      tick: mission.combat.tick,
      id: checkpoint,
      playerId: null,
      claim: null,
    });
  }
  if (mission.boss.health === 0 && mission.combat.encounter.phase === "complete")
    mission.phase = "victory";
  else if (mission.combat.players.every((p) => p.life === "spectating")) mission.phase = "defeat";
  if (mission.phase !== "playing") {
    mission.finishedTick = mission.combat.tick;
    mission.notices.push({
      kind: mission.phase,
      tick: mission.combat.tick,
      id: 0,
      playerId: null,
      claim: null,
    });
  }
  return mission;
}
export interface BreakwaterRecording {
  format: 6;
  contentHash: string;
  seed: number;
  players: number;
  commands: CombatCommand[][];
  finalState: string;
}
export function replayBreakwater(
  recording: BreakwaterRecording,
  observe?: (state: BreakwaterMission) => void,
): BreakwaterMission {
  if (
    recording.format !== 6 ||
    recording.contentHash !== digest.contentHash ||
    !Array.isArray(recording.commands) ||
    recording.commands.length > BREAKWATER.maxTicks
  )
    throw new Error("Invalid mission recording");
  let state = createBreakwater(recording.players, recording.seed);
  observe?.(structuredClone(state));
  for (const commands of recording.commands) {
    if (state.phase !== "playing") throw new Error("Input after mission outcome");
    state = stepBreakwater(state, commands);
    observe?.(structuredClone(state));
  }
  if (canonical(state) !== recording.finalState) throw new Error("Mission replay diverged");
  return state;
}
