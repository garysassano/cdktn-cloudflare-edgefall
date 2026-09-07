import { damagePlayer, stepPlayerLife } from "../../src/game/campaign/life.js";
import {
  type CheckpointEntry,
  createCampaign,
  finishMission,
  stageNextMission,
} from "../../src/game/campaign/lifecycle.js";
import { stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import {
  type EncounterDefinition,
  EncounterLifecycle,
} from "../../src/game/encounters/lifecycle.js";
import { FOOT_FLOOR, FOOT_SHAPES, footActor } from "../../src/game/labs/foot-fixture.js";
import { CollisionGrid, CollisionIndex } from "../../src/game/physics/grid.js";
import type { ControlledActor } from "../../src/game/state.js";

export function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing campaign fixture entry");
  return value;
}
export function campaignPlayers() {
  return [
    footActor(),
    { ...footActor(30), playerId: 2, slot: 1, body: { ...footActor(30).body, id: 2 } },
  ];
}
export function campaignCheckpoint(tick: number, mission = 1): CheckpointEntry {
  const shape = FOOT_SHAPES.get(1);
  if (!shape) throw new Error("Missing campaign shape");
  const frame = { tick, geometryRevision: 1 };
  const index = new CollisionIndex(new CollisionGrid([FOOT_FLOOR]), [], frame);
  return {
    mission,
    id: 1000 + mission,
    encounterId: 100 + mission,
    requiredEntities: [2000 + mission],
    entries: new Map(
      [1, 2].map((playerId) => [
        playerId,
        { shape, index, frame, anchors: [{ x: pixels((playerId - 1) * 30), y: 0 }] },
      ]),
    ),
  };
}
/** Minimal encounter receipts for reducer tests, not authored campaign content. */
export function campaignFinish(tick: number, mission = 1, complete = true) {
  const finalEncounter: EncounterDefinition = {
    id: 100 + mission,
    participants: [1, 2],
    members: [
      {
        id: 2000 + mission,
        required: true,
        critical: true,
        retreatAllowed: false,
        watchdogTicks: 600,
        ambientCleanupTicks: null,
      },
    ],
    objectives: [3000 + mission],
  };
  const lifecycle = new EncounterLifecycle(finalEncounter);
  const result = lifecycle.step(
    lifecycle.begin(tick - 1),
    tick,
    [
      { sequence: 1, tick, kind: "activate", id: 2000 + mission },
      { sequence: 2, tick, kind: "resolve", id: 2000 + mission, reason: "killed", killerId: 1 },
      ...(complete ? [{ sequence: 3, tick, kind: "objective" as const, id: 3000 + mission }] : []),
    ],
    [],
  );
  return {
    mission,
    missionCount: 3,
    finalEncounter,
    encounter: result.state,
    exit: { x: pixels(-200), y: pixels(-50), w: pixels(400), h: pixels(50) },
    shapes: FOOT_SHAPES,
  };
}
/** Three numbered reducer transitions. This does not simulate any authored mission. */
export function campaignProof() {
  let players = campaignPlayers(),
    state = createCampaign("classic", 1001, 101),
    tick = 1;
  const spectator: ControlledActor = {
    ...required(players[1]),
    life: "spectating",
    health: 0,
    lives: 0,
  };
  players[1] = spectator;
  const boundaries = [],
    hashes: string[] = [];
  for (let mission = 1; mission <= 3; mission++) {
    state = finishMission(state, players, [1, 2], tick, campaignFinish(tick, mission));
    if (state.phase !== (mission === 3 ? "victory" : "intermission"))
      throw new Error("Missing mission boundary");
    hashes.push(stateHash({ state, players, tick }));
    if (mission === 3) break;
    const entry = campaignCheckpoint(tick, mission + 1);
    const transition = stageNextMission(state, players, tick, entry);
    state = transition.state;
    players = JSON.parse(JSON.stringify(transition.players));
    boundaries.push(transition.boundary);
    for (let step = 0; step < 12; step++) {
      tick++;
      players = players.map(
        (player) =>
          stepPlayerLife(
            player,
            tick,
            "classic",
            required(campaignCheckpoint(tick, mission + 1).entries.get(player.playerId)),
          ).actor,
      );
    }
    if (mission === 1) {
      players[1] = damagePlayer(required(players[1]), tick, 1, "classic", "fall").actor;
      for (let step = 0; step < 30; step++) {
        tick++;
        players = players.map(
          (player) =>
            stepPlayerLife(
              player,
              tick,
              "classic",
              required(campaignCheckpoint(tick, mission + 1).entries.get(player.playerId)),
            ).actor,
        );
      }
    }
    tick++;
  }
  return {
    tick,
    state,
    players,
    boundaries,
    traceHash: stateHash(hashes),
    scope: "Synthetic campaign reducer boundaries; no authored mission traversal or world reset",
  };
}
