import { createCampaign, evaluatePartyWipe, stageContinue } from "../campaign/lifecycle.js";
import { canonical } from "../core/canonical.js";
import { COUNTER_LIMIT, integer, nextCounter } from "../core/numeric.js";
import { EncounterLifecycle } from "../encounters/lifecycle.js";
import { CollisionGrid, CollisionIndex } from "../physics/grid.js";
import { RULE_PRESETS } from "../rules.js";
import type { CampaignState } from "../state.js";
import {
  type CombatLab,
  combatEncounterDefinition,
  combatEntryContext,
  createCombatLab,
} from "./combat.js";
import { combatEndTerrain } from "./combat-terrain.js";

export interface CombatContinue {
  ordinal: number;
  tick: number;
  checkpointId: number;
  fromRunEpoch: number;
  runEpoch: number;
  nextEntityIdBefore: number;
  retiredEntityIds: number[];
  spawnedEntityIds: number[];
  retiredVehicleIds: number[];
  spawnedVehicleIds: number[];
  kills: Array<{ playerId: number; count: number }>;
}
export interface CombatCampaign {
  state: CampaignState;
  /** External reset decisions survive checkpoint compaction and cannot be replayed as damage. */
  continues: CombatContinue[];
}
const check = (ok: unknown, reason: string) => {
  if (!ok) throw new Error(`Combat campaign: ${reason}`);
};
const resolvedEntities = (combat: CombatLab): CampaignState["resolvedEntities"] =>
  combat.encounter.members.flatMap((member) =>
    member.reason === "killed" || member.reason === "retreated" || member.reason === "out-of-bounds"
      ? [{ id: member.id, reason: member.reason }]
      : [],
  );
export function createCombatCampaign(combat: CombatLab): CombatCampaign {
  const state = createCampaign("classic", 1, combatEncounterDefinition(combat).id);
  state.requiredEntities = combat.targets.map((target) => target.enemy.body.id);
  return { state, continues: [] };
}
export function validateCombatCampaign(
  campaign: CombatCampaign,
  combat: CombatLab,
  runEpoch: number,
): void {
  integer(runEpoch, 1, COUNTER_LIMIT - 1, "campaign epoch");
  const state = campaign.state;
  check(
    state.ruleset === "classic" &&
      state.mission === 1 &&
      state.checkpointId === 1 &&
      state.encounterId === 1,
    "diagnostic checkpoint identity",
  );
  // Reuse the shared state/player invariants without deriving a new wipe decision.
  evaluatePartyWipe(state, combat.players, [], combat.tick);
  check(["playing", "wipe", "defeat"].includes(state.phase), "unsupported diagnostic phase");
  check(state.phase !== "wipe" || state.continuesRemaining > 0, "wipe credit budget");
  check(state.phase !== "defeat" || state.continuesRemaining === 0, "defeat credit budget");
  check(
    canonical(state.resolvedEntities) === canonical(resolvedEntities(combat)),
    "campaign resolution ledger",
  );
  const initial = createCombatLab(combat.scenario, combat.players.length);
  const initialVehicles = initial.tanks.map((tank) => tank.body.id);
  const initialIds = initial.targets.map((target) => target.enemy.body.id);
  check(campaign.continues.length === state.continuesUsed, "continue decision count");
  integer(
    campaign.continues.length,
    0,
    RULE_PRESETS[state.ruleset].sharedContinues,
    "continue history length",
  );
  let lastTick = -1,
    lastEpoch = 0;
  const allocated = new Set<number>();
  for (const [index, decision] of campaign.continues.entries()) {
    check(
      decision.ordinal === index + 1 && decision.checkpointId === state.checkpointId,
      "continue decision identity",
    );
    integer(decision.tick, lastTick + 1, combat.tick, "continue tick");
    integer(decision.fromRunEpoch, lastEpoch || 1, runEpoch - 1, "continue source epoch");
    check(decision.runEpoch === decision.fromRunEpoch + 1, "continue generation");
    integer(
      decision.nextEntityIdBefore,
      Math.max(
        ...(campaign.continues[index - 1]?.spawnedEntityIds ?? initialIds),
        ...(campaign.continues[index - 1]?.spawnedVehicleIds ?? initialVehicles),
      ) + 1,
      combat.nextEntityId - 1,
      "continue allocation boundary",
    );
    check(
      [...decision.spawnedEntityIds, ...decision.spawnedVehicleIds].every(
        (id, i) => id === decision.nextEntityIdBefore + i,
      ),
      "checkpoint allocation sequence",
    );
    for (const ids of [decision.retiredVehicleIds, decision.spawnedVehicleIds]) {
      check(ids.length === initialVehicles.length, "checkpoint vehicle count");
      for (const [i, id] of ids.entries())
        integer(
          id,
          i ? (ids[i - 1] ?? 0) + 1 : 1,
          combat.nextEntityId - 1,
          "checkpoint vehicle ID",
        );
    }
    check(
      canonical(decision.retiredVehicleIds) ===
        canonical(campaign.continues[index - 1]?.spawnedVehicleIds ?? initialVehicles),
      "checkpoint vehicle retirement prefix",
    );
    for (const ids of [decision.retiredEntityIds, decision.spawnedEntityIds]) {
      check(ids.length === combat.targets.length, "checkpoint entity count");
      for (const [i, id] of ids.entries())
        integer(id, i ? (ids[i - 1] ?? 0) + 1 : 1, combat.nextEntityId - 1, "checkpoint entity ID");
    }
    check(
      canonical(decision.retiredEntityIds) ===
        canonical(campaign.continues[index - 1]?.spawnedEntityIds ?? initialIds),
      "checkpoint retirement prefix",
    );
    if (index === 0)
      for (const id of [...decision.retiredEntityIds, ...decision.retiredVehicleIds])
        allocated.add(id);
    for (const id of [...decision.spawnedEntityIds, ...decision.spawnedVehicleIds]) {
      check(!allocated.has(id), "reused checkpoint entity");
      allocated.add(id);
    }
    check(decision.kills.length === combat.players.length, "checkpoint kill roster");
    for (const [i, credit] of decision.kills.entries()) {
      check(credit.playerId === combat.players[i]?.playerId, "checkpoint kill owner");
      integer(credit.count, 0, combat.targets.length, "checkpoint kills");
    }
    check(
      decision.kills.reduce((sum, credit) => sum + credit.count, 0) <= combat.targets.length,
      "checkpoint kill total",
    );
    lastTick = decision.tick;
    lastEpoch = decision.runEpoch;
  }
  const expectedIds = campaign.continues.at(-1)?.spawnedEntityIds ?? initialIds;
  check(
    canonical(combat.tanks.map((tank) => tank.body.id)) ===
      canonical(campaign.continues.at(-1)?.spawnedVehicleIds ?? initialVehicles),
    "current checkpoint vehicle roster",
  );
  check(
    canonical(combat.targets.map((target) => target.enemy.body.id)) === canonical(expectedIds),
    "current checkpoint entity roster",
  );
  check(
    canonical(state.requiredEntities) === canonical(expectedIds),
    "campaign requirement roster",
  );
}
/** Death presentation finishes before a wipe stops the world's simulation clock. */
export function advanceCombatCampaign(
  current: CombatCampaign,
  combat: CombatLab,
  connected: readonly number[],
): CombatCampaign {
  const campaign = structuredClone(current);
  campaign.state.resolvedEntities = resolvedEntities(combat);
  if (
    connected.length &&
    connected.every((id) =>
      combat.players.some((player) => player.playerId === id && player.life === "spectating"),
    )
  )
    campaign.state = evaluatePartyWipe(campaign.state, combat.players, connected, combat.tick);
  return campaign;
}
/** Recreate the actual checkpoint roster using fresh allocation IDs; retain player and action identity. */
export function continueCombatCheckpoint(
  current: CombatLab,
  campaign: CombatCampaign,
  runEpoch: number,
) {
  validateCombatCampaign(campaign, current, runEpoch);
  const world = structuredClone(current);
  const template = createCombatLab(current.scenario, current.players.length);
  world.targets = template.targets.map((target) => {
    const id = world.nextEntityId;
    world.nextEntityId = nextCounter(world.nextEntityId);
    return { ...target, enemy: { ...target.enemy, body: { ...target.enemy.body, id } } };
  });
  world.tanks = template.tanks.map((tank) => {
    const id = world.nextEntityId;
    world.nextEntityId = nextCounter(world.nextEntityId);
    tank.body.id = id;
    tank.action.stateStartTick = world.tick;
    return tank;
  });
  world.props = structuredClone(template.props);
  for (const player of world.players) player.geometryRevision = 1;
  world.projectiles = [];
  world.rockets = [];
  world.strikes = [];
  world.grenades = [];
  world.areas = [];
  world.events = [];
  world.eventSequence = 0;
  world.encounter = new EncounterLifecycle(combatEncounterDefinition(world)).begin(world.tick);
  const frame = { tick: world.tick, geometryRevision: 1 };
  const index = new CollisionIndex(
    new CollisionGrid(combatEndTerrain(world.scenario, world.tick, world.props)),
    [],
    frame,
  );
  const entry = stageContinue(campaign.state, world.players, world.tick, {
    mission: 1,
    id: 1,
    encounterId: 1,
    requiredEntities: world.targets.map((target) => target.enemy.body.id),
    entries: new Map(
      world.players.map((player) => [
        player.playerId,
        combatEntryContext(player, index, frame, world.scenario),
      ]),
    ),
  });
  world.players = entry.players;
  const decision: CombatContinue = {
    ordinal: entry.boundary.continueOrdinal,
    tick: world.tick,
    checkpointId: 1,
    fromRunEpoch: runEpoch,
    runEpoch: nextCounter(runEpoch),
    nextEntityIdBefore: current.nextEntityId,
    retiredEntityIds: current.targets.map((target) => target.enemy.body.id),
    spawnedEntityIds: world.targets.map((target) => target.enemy.body.id),
    retiredVehicleIds: current.tanks.map((tank) => tank.body.id),
    spawnedVehicleIds: world.tanks.map((tank) => tank.body.id),
    kills: structuredClone(current.encounter.kills),
  };
  return {
    combat: world,
    campaign: { state: entry.state, continues: [...structuredClone(campaign.continues), decision] },
  };
}
