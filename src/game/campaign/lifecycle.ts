import type { ShapeDefinition } from "../content/schema.js";
import { COUNTER_LIMIT, MAX_POSITION, integer, position } from "../core/numeric.js";
import {
  type EncounterDefinition,
  EncounterLifecycle,
  type EncounterState,
} from "../encounters/lifecycle.js";
import { worldRect } from "../physics/body.js";
import { ARCADE, RULE_PRESETS, type RulesetId } from "../rules.js";
import type { CampaignState, ControlledActor, Rect } from "../state.js";
import { type EntryContext, enterPlayer, validatePlayerLife } from "./life.js";

export interface CheckpointEntry {
  mission: number;
  id: number;
  encounterId: number;
  /** The world allocator supplies the recreated checkpoint's fresh entity IDs. */
  requiredEntities: readonly number[];
  entries: ReadonlyMap<number, EntryContext>;
}
function check(ok: unknown, reason: string): asserts ok {
  if (!ok) throw new Error(`Campaign: ${reason}`);
}
function ids(values: readonly number[], label: string) {
  integer(values.length, 0, 320, `${label} count`);
  let previous = 0;
  for (const id of values) {
    integer(id, previous + 1, COUNTER_LIMIT - 1, label);
    previous = id;
  }
}
function validate(state: CampaignState) {
  const rules = RULE_PRESETS[state.ruleset];
  check(rules, "unknown ruleset");
  integer(state.mission, 1, 255, "mission number");
  integer(state.checkpointId, 1, COUNTER_LIMIT - 1, "checkpoint ID");
  integer(state.encounterId, 1, COUNTER_LIMIT - 1, "encounter ID");
  integer(state.continuesRemaining, 0, rules.sharedContinues, "remaining continues");
  integer(state.continuesUsed, 0, rules.sharedContinues, "used continues");
  check(
    state.continuesRemaining + state.continuesUsed === rules.sharedContinues,
    "continue accounting",
  );
  check(
    ["playing", "wipe", "intermission", "victory", "defeat"].includes(state.phase),
    "unknown phase",
  );
  ids(state.requiredEntities, "required entities");
  ids(
    state.resolvedEntities.map((entity) => entity.id),
    "resolved entities",
  );
  for (const entity of state.resolvedEntities)
    check(["killed", "retreated", "out-of-bounds"].includes(entity.reason), "resolution reason");
}
function party(state: CampaignState, players: readonly ControlledActor[], tick: number) {
  validate(state);
  integer(players.length, 1, ARCADE.maxPlayers, "party size");
  ids(
    players.map((player) => player.playerId),
    "player IDs",
  );
  check(new Set(players.map((player) => player.slot)).size === players.length, "duplicate slot");
  for (const player of players) {
    integer(player.slot, 0, ARCADE.maxPlayers - 1, "party slot");
    integer(player.lastRallyMission, 0, 255, "rally mission");
    validatePlayerLife(player, tick, state.ruleset);
  }
}
export function createCampaign(
  ruleset: RulesetId,
  checkpointId: number,
  encounterId: number,
): CampaignState {
  check(RULE_PRESETS[ruleset], "unknown ruleset");
  const state: CampaignState = {
    ruleset,
    mission: 1,
    checkpointId,
    encounterId,
    continuesRemaining: RULE_PRESETS[ruleset].sharedContinues,
    continuesUsed: 0,
    phase: "playing",
    requiredEntities: [],
    resolvedEntities: [],
  };
  validate(state);
  return state;
}
/** Connected participation is a world-owned decision, recorded separately from received packets. */
export function evaluatePartyWipe(
  current: CampaignState,
  players: readonly ControlledActor[],
  connected: readonly number[],
  tick: number,
) {
  party(current, players, tick);
  ids(connected, "connected players");
  check(
    connected.every((id) => players.some((player) => player.playerId === id)),
    "unknown connected player",
  );
  const state = structuredClone(current);
  if (state.phase !== "playing" || connected.length === 0) return state;
  if (players.some((player) => connected.includes(player.playerId) && player.lives > 0))
    return state;
  state.phase = state.continuesRemaining > 0 ? "wipe" : "defeat";
  return state;
}

export interface MissionFinish {
  mission: number;
  missionCount: number;
  finalEncounter: EncounterDefinition;
  encounter: EncounterState;
  exit: Rect;
  shapes: ReadonlyMap<number, ShapeDefinition>;
}
/** Only a complete authored final encounter and a safe party exit can finish a mission. */
export function finishMission(
  current: CampaignState,
  players: readonly ControlledActor[],
  connected: readonly number[],
  tick: number,
  finish: MissionFinish,
) {
  const state = evaluatePartyWipe(current, players, connected, tick);
  integer(finish.missionCount, 1, 255, "campaign mission count");
  check(
    finish.mission === state.mission && state.mission <= finish.missionCount,
    "mission identity",
  );
  check(finish.finalEncounter.id === state.encounterId, "final encounter identity");
  const encounter = new EncounterLifecycle(finish.finalEncounter).restore(finish.encounter);
  check(encounter.tick === tick, "encounter boundary");
  if (state.phase !== "playing" || connected.length === 0 || encounter.phase !== "complete")
    return state;
  if (!players.some((player) => connected.includes(player.playerId) && player.life === "alive"))
    return state;
  // Validate the authored rectangle even when a party member is outside it.
  position(finish.exit.x);
  position(finish.exit.y);
  integer(finish.exit.w, 1, MAX_POSITION * 2, "exit width");
  integer(finish.exit.h, 1, MAX_POSITION * 2, "exit height");
  position(finish.exit.x + finish.exit.w);
  position(finish.exit.y + finish.exit.h);
  for (const player of players) {
    if (
      !connected.includes(player.playerId) ||
      player.life === "death" ||
      player.life === "spectating"
    )
      continue;
    const shape = finish.shapes.get(player.body.shapeId);
    check(shape, "missing exit body shape");
    const body = worldRect(player.body, shape.rect, player.facing);
    if (
      body.x < finish.exit.x ||
      body.y < finish.exit.y ||
      body.x + body.w > finish.exit.x + finish.exit.w ||
      body.y + body.h > finish.exit.y + finish.exit.h
    )
      return state;
  }
  state.phase = state.mission === finish.missionCount ? "victory" : "intermission";
  return state;
}

function checkpoint(current: CampaignState, entry: CheckpointEntry, mission: number) {
  check(entry.mission === mission, "checkpoint mission mismatch");
  integer(entry.id, 1, COUNTER_LIMIT - 1, "checkpoint ID");
  integer(entry.encounterId, 1, COUNTER_LIMIT - 1, "checkpoint encounter ID");
  ids(entry.requiredEntities, "checkpoint entities");
  return {
    ...structuredClone(current),
    mission,
    checkpointId: entry.id,
    encounterId: entry.encounterId,
    requiredEntities: [...entry.requiredEntities],
    resolvedEntities: [],
    phase: "playing" as const,
  };
}
function enter(
  player: ControlledActor,
  state: CampaignState,
  tick: number,
  entry: CheckpointEntry,
) {
  const context = entry.entries.get(player.playerId);
  check(context, "missing checkpoint player anchor");
  const next = enterPlayer(player, tick, state.ruleset, context);
  check(next, "checkpoint player anchor is blocked");
  return next;
}
/** A candidate for the world's atomic checkpoint reset, not permission to publish or run a room. */
export function stageContinue(
  current: CampaignState,
  players: readonly ControlledActor[],
  tick: number,
  entry: CheckpointEntry,
) {
  party(current, players, tick);
  check(current.phase === "wipe" && current.continuesRemaining > 0, "continue unavailable");
  check(entry.id === current.checkpointId, "continue checkpoint mismatch");
  const state = checkpoint(current, entry, current.mission);
  const reset = players.map((player) =>
    enter({ ...player, lives: ARCADE.initialLives }, state, tick, entry),
  );
  state.continuesRemaining--;
  state.continuesUsed++;
  return {
    state,
    players: reset,
    boundary: {
      kind: "continue" as const,
      tick,
      mission: state.mission,
      checkpointId: state.checkpointId,
      continueOrdinal: state.continuesUsed,
    },
  };
}
/** Rally is keyed to the next mission; an already spent grant cannot be minted again. */
export function stageNextMission(
  current: CampaignState,
  players: readonly ControlledActor[],
  tick: number,
  entry: CheckpointEntry,
) {
  party(current, players, tick);
  check(
    current.phase === "intermission" && current.mission < 255,
    "mission transition unavailable",
  );
  const state = checkpoint(current, entry, current.mission + 1);
  const rallied: number[] = [];
  const reset = players.map((currentPlayer) => {
    const player = structuredClone(currentPlayer);
    check(player.lastRallyMission <= state.mission, "future rally grant");
    if (player.lives === 0) {
      if (player.lastRallyMission === state.mission) return player;
      player.lives = 1;
      player.lastRallyMission = state.mission;
      rallied.push(player.playerId);
    }
    const next = enter(player, state, tick, entry);
    if (currentPlayer.life === "alive") {
      next.weapon = { ...currentPlayer.weapon, cooldownTicks: 0 };
      next.grenadeStock = currentPlayer.grenadeStock;
      next.health = currentPlayer.health;
    }
    return next;
  });
  return {
    state,
    players: reset,
    boundary: { kind: "next-mission" as const, tick, mission: state.mission, rallied },
  };
}
