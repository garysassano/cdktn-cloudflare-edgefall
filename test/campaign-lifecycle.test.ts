import { describe, expect, it } from "vitest";
import {
  createCampaign,
  evaluatePartyWipe,
  finishMission,
  stageContinue,
  stageNextMission,
} from "../src/game/campaign/lifecycle.js";
import { pixels } from "../src/game/core/numeric.js";
import type { ControlledActor } from "../src/game/state.js";
import {
  campaignCheckpoint,
  campaignFinish,
  campaignPlayers,
  campaignProof,
  campaignSpectator,
  required,
} from "./fixtures/campaign-proof.js";

const dead = campaignSpectator;
describe("campaign lifecycle candidates", () => {
  it("waits for available respawns, ignores disconnected reservations and holds an empty party", () => {
    const state = createCampaign("classic", 1001, 101),
      players = campaignPlayers();
    players[0] = dead(required(players[0]));
    expect(evaluatePartyWipe(state, players, [1, 2], 1).phase).toBe("playing");
    expect(evaluatePartyWipe(state, players, [1], 1).phase).toBe("wipe");
    expect(evaluatePartyWipe(state, players, [], 1).phase).toBe("playing");
    players[0] = { ...required(players[0]), life: "death", bodyPresence: "present", lives: 1 };
    expect(evaluatePartyWipe(state, players, [1], 1).phase).toBe("playing");
    expect(() => evaluatePartyWipe(state, players, [3], 1)).toThrow(/unknown connected/);
    expect(() => evaluatePartyWipe(state, players, [2, 1], 1)).toThrow();
  });
  it("spends exactly one shared continue only after every participating player has a safe entry", () => {
    const players = campaignPlayers().map(dead);
    const state = evaluatePartyWipe(createCampaign("classic", 1001, 101), players, [1, 2], 1);
    const saved = structuredClone({ state, players });
    const entry = campaignCheckpoint(1);
    required(entry.entries.get(2)).anchors = [{ x: pixels(500), y: 0 }];
    expect(() => stageContinue(state, players, 1, entry)).toThrow(/blocked/);
    expect({ state, players }).toEqual(saved);
    const reset = stageContinue(state, players, 1, campaignCheckpoint(1));
    expect(reset.state).toMatchObject({
      phase: "playing",
      mission: 1,
      continuesRemaining: 2,
      continuesUsed: 1,
    });
    expect(
      reset.players.every(
        (p) =>
          p.life === "respawning" &&
          p.lives === 3 &&
          p.health === 1 &&
          p.invulnerableTicks === 120 &&
          p.weapon.id === "sidearm" &&
          p.grenadeStock === 10,
      ),
    ).toBe(true);
    expect(reset.boundary).toMatchObject({
      kind: "continue",
      checkpointId: 1001,
      continueOrdinal: 1,
    });
    expect(() => stageContinue(reset.state, reset.players, 1, campaignCheckpoint(1))).toThrow(
      /unavailable/,
    );
    expect(() => stageContinue(state, players, 1, campaignCheckpoint(1, 2))).toThrow(
      /checkpoint mismatch/,
    );
    expect({ state, players }).toEqual(saved);
  });
  it.each(["classic", "accessible"] as const)(
    "exhausts the declared %s shared budget and then defeats",
    (ruleset) => {
      const players = campaignPlayers().map(dead);
      let state = createCampaign(ruleset, 1001, 101);
      const budget = ruleset === "classic" ? 3 : 9;
      for (let used = 0; used < budget; used++) {
        state = evaluatePartyWipe(state, players, [1, 2], 1);
        const candidate = stageContinue(state, players, 1, campaignCheckpoint(1));
        expect(candidate.players[0]?.health).toBe(ruleset === "classic" ? 1 : 3);
        state = candidate.state;
        expect(state.continuesRemaining + state.continuesUsed).toBe(budget);
      }
      state = evaluatePartyWipe(state, players, [1, 2], 1);
      expect(state.phase).toBe("defeat");
      expect(() => stageContinue(state, players, 1, campaignCheckpoint(1))).toThrow(/unavailable/);
    },
  );
  it("requires the authored final encounter, objective and a living participant safely inside the exit", () => {
    const state = createCampaign("classic", 1001, 101),
      players = campaignPlayers();
    expect(finishMission(state, players, [1, 2], 1, campaignFinish(1, 1, false)).phase).toBe(
      "playing",
    );
    required(players[1]).body.x = pixels(200); // Feet are at the boundary, but half the footprint is outside.
    expect(finishMission(state, players, [1, 2], 1, campaignFinish(1)).phase).toBe("playing");
    expect(finishMission(state, players, [1], 1, campaignFinish(1)).phase).toBe("intermission");
    const pending = players.map(
      (p): ControlledActor => ({
        ...p,
        life: "death",
        bodyPresence: "present",
        health: 0,
        lives: 1,
      }),
    );
    expect(finishMission(state, pending, [1, 2], 1, campaignFinish(1)).phase).toBe("playing");
    expect(finishMission(state, players.map(dead), [1, 2], 1, campaignFinish(1)).phase).toBe(
      "wipe",
    );
    expect(() => finishMission(state, players, [1], 1, campaignFinish(1, 2))).toThrow(/identity/);
    expect(() => finishMission(state, players, [1], 2, campaignFinish(1))).toThrow(/boundary/);
    const forged = campaignFinish(1, 1, false);
    forged.encounter.phase = "complete";
    expect(() => finishMission(state, players, [1], 1, forged)).toThrow();
  });
  it("grants a single rally for the next mission and preserves living inventory without resetting accounting", () => {
    const players = campaignPlayers();
    required(players[0]).lives = 2;
    required(players[0]).weapon = {
      id: "heavy-machine-gun",
      ammo: 17,
      cooldownTicks: 3,
      shotOrdinal: 40,
      lastActionInstanceId: 50,
    };
    required(players[0]).grenadeStock = 3;
    players[1] = dead(required(players[1]));
    const state = finishMission(
      createCampaign("classic", 1001, 101),
      players,
      [1, 2],
      1,
      campaignFinish(1),
    );
    const candidate = stageNextMission(state, players, 1, campaignCheckpoint(1, 2));
    expect(candidate.boundary.rallied).toEqual([2]);
    expect(candidate.players[0]).toMatchObject({
      lives: 2,
      grenadeStock: 3,
      weapon: {
        id: "heavy-machine-gun",
        ammo: 17,
        cooldownTicks: 0,
        shotOrdinal: 40,
        lastActionInstanceId: 50,
      },
    });
    expect(candidate.players[1]).toMatchObject({ lives: 1, lastRallyMission: 2 });
    expect(candidate.state).toMatchObject({ mission: 2, continuesRemaining: 3, continuesUsed: 0 });
    expect(() =>
      stageNextMission(candidate.state, candidate.players, 1, campaignCheckpoint(1, 3)),
    ).toThrow(/unavailable/);
    players[1] = { ...required(players[1]), lastRallyMission: 2 };
    expect(stageNextMission(state, players, 1, campaignCheckpoint(1, 2)).players[1]?.lives).toBe(0);
    required(players[0]).vehicleId = 999;
    expect(() => stageNextMission(state, players, 1, campaignCheckpoint(1, 2))).toThrow(
      /vehicle seat/,
    );
  });
  it("carries reducer state through three numbered mission boundaries without regranting spent rally lives", () => {
    const result = campaignProof();
    expect(result.state).toMatchObject({
      phase: "victory",
      mission: 3,
      continuesRemaining: 3,
      continuesUsed: 0,
    });
    expect(result.boundaries.map((b) => [b.mission, b.rallied])).toEqual([
      [2, [2]],
      [3, [2]],
    ]);
    expect(result.players[1]).toMatchObject({ lastRallyMission: 3, lives: 1 });
  });
});
