import { beforeAll, describe, expect, it } from "vitest";
import { canonical } from "../src/game/core/canonical.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  validateCombatCheckpoint,
} from "../src/shared/diagnostics/combat-checkpoint.js";
import { transitionCombatRuntime } from "../src/shared/diagnostics/combat-recovery.js";
import type { CombatRuntime } from "../src/shared/diagnostics/combat-runtime.js";
import { recordCombatInputs } from "./fixtures/combat-input-driver.js";
import { combatArchiveIdentity } from "./fixtures/combat-recovery-proof.js";
import { recordPlayerLifeRecovery } from "./fixtures/player-life-recovery-proof.js";

let wipe: CombatRuntime;
beforeAll(() => {
  wipe = recordPlayerLifeRecovery().states.at(-1) as CombatRuntime;
});
describe("world checkpoint continue", () => {
  it("derives a wipe from actual falls, preserves it on recovery and prevents load/start bypass", async () => {
    expect(wipe.snapshot).toMatchObject({
      roomMode: "intermission",
      campaign: { phase: "wipe", continuesRemaining: 3, continuesUsed: 0 },
    });
    expect(wipe.combat.players.every((player) => player.life === "spectating")).toBe(true);
    const identity = await combatArchiveIdentity();
    const restored = await decodeCombatCheckpoint(
      await encodeCombatCheckpoint(wipe, identity),
      identity,
    );
    expect(restored).toEqual(wipe);
    const recovered = transitionCombatRuntime(restored, "recover");
    expect(recovered.snapshot).toMatchObject({
      roomMode: "intermission",
      campaign: { phase: "wipe" },
    });
    expect(() => transitionCombatRuntime(recovered, "load")).toThrow(/continue/);
    expect(() => transitionCombatRuntime(recovered, "start")).toThrow(/loading/);
  });
  it("atomically stages fresh enemies, baseline equipment and generation fences without resetting time or allocators", async () => {
    const before = canonical(wipe);
    const continued = transitionCombatRuntime(wipe, "continue");
    expect(canonical(wipe)).toBe(before);
    expect(continued.snapshot).toMatchObject({
      tick: wipe.combat.tick,
      runEpoch: 2,
      roomMode: "loading",
      campaign: { phase: "playing", continuesRemaining: 2, continuesUsed: 1 },
    });
    expect(continued.combat.targets.map((target) => target.enemy.body.id)).toEqual([
      wipe.combat.nextEntityId,
      wipe.combat.nextEntityId + 1,
    ]);
    expect(continued.combat.nextEntityId).toBe(wipe.combat.nextEntityId + 2);
    expect(continued.combat.nextActionId).toBe(wipe.combat.nextActionId);
    expect(continued.combat.projectiles).toEqual([]);
    expect(continued.history.entries).toEqual([]);
    expect(
      continued.combat.players.every(
        (player, slot) =>
          player.lives === 3 &&
          player.health === 1 &&
          player.invulnerableTicks === 120 &&
          player.weapon.id === "sidearm" &&
          player.grenadeStock === 10 &&
          player.controlEpoch === 2 &&
          player.weapon.shotOrdinal === wipe.combat.players[slot]?.weapon.shotOrdinal,
      ),
    ).toBe(true);
    expect(
      continued.snapshot.acknowledgments.every(
        (ack, slot) =>
          ack.connectionEpoch === slot + 2 &&
          ack.lastProcessedSequence === 0 &&
          ack.processedEdgeIds.every((id) => id === 0),
      ),
    ).toBe(true);
    expect(continued.campaign.continues[0]).toMatchObject({
      ordinal: 1,
      tick: wipe.combat.tick,
      fromRunEpoch: 1,
      runEpoch: 2,
      kills: wipe.combat.encounter.kills,
    });
    const identity = await combatArchiveIdentity();
    expect(
      await decodeCombatCheckpoint(await encodeCombatCheckpoint(continued, identity), identity),
    ).toEqual(continued);
    const running = transitionCombatRuntime(continued, "start");
    const replayed = recordCombatInputs(running, 15);
    expect(replayed.state.combat.tick).toBe(wipe.combat.tick + 15);
    expect(replayed.state.combat.players.every((player) => player.life === "alive")).toBe(true);
    expect(
      replayed.state.combat.encounter.members.every((member) => member.status !== "pending"),
    ).toBe(true);
    validateCombatCheckpoint(replayed.state);
    expect(() => transitionCombatRuntime(continued, "continue")).toThrow();
  });
  it("rejects changed credit history, reused entity IDs and broken checkpoint projection", () => {
    const continued = transitionCombatRuntime(wipe, "continue");
    const mutations: Array<(state: CombatRuntime) => void> = [
      (state) => {
        state.campaign.continues = [];
      },
      (state) => {
        const row = state.campaign.continues[0];
        if (row) row.spawnedEntityIds[0] = 20;
      },
      (state) => {
        state.campaign.state.requiredEntities = [20, 21];
      },
      (state) => {
        state.campaign.state.resolvedEntities = [
          { id: state.combat.nextEntityId - 1, reason: "killed" },
        ];
      },
      (state) => {
        const row = state.campaign.continues[0];
        if (row) row.retiredEntityIds = [18, 19];
      },
      (state) => {
        state.snapshot.campaign.continuesRemaining++;
      },
      (state) => {
        const row = state.campaign.continues[0];
        if (row) row.kills[0] = { playerId: 1, count: 3 };
      },
    ];
    for (const mutate of mutations) {
      const bad = structuredClone(continued);
      mutate(bad);
      expect(() => validateCombatCheckpoint(bad)).toThrow();
    }
  });
  it("exhausts three real checkpoint retries into defeat without another load or continue", () => {
    let current = structuredClone(wipe);
    const ids = new Set(current.combat.targets.map((target) => target.enemy.body.id));
    for (let ordinal = 1; ordinal <= 3; ordinal++) {
      const continued = transitionCombatRuntime(current, "continue");
      for (const target of continued.combat.targets) {
        expect(ids.has(target.enemy.body.id)).toBe(false);
        ids.add(target.enemy.body.id);
      }
      current = recordCombatInputs(transitionCombatRuntime(continued, "start"), 900).state;
      expect(current.campaign.state.continuesUsed).toBe(ordinal);
      validateCombatCheckpoint(current);
    }
    expect(current.campaign.state.phase).toBe("defeat");
    expect(current.campaign.state.continuesRemaining).toBe(0);
    expect(() => transitionCombatRuntime(current, "continue")).toThrow(/unavailable/);
    expect(() => transitionCombatRuntime(current, "load")).toThrow(/continue/);
  }, 15000);
});
