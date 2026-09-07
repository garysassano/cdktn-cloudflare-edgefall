import { beforeAll, describe, expect, it } from "vitest";
import { COUNTER_LIMIT } from "../src/game/core/numeric.js";
import {
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
  validateCombatCheckpoint,
} from "../src/shared/diagnostics/combat-checkpoint.js";
import {
  combatContinuationHash,
  replaceWaitingCombatConnection,
} from "../src/shared/diagnostics/combat-recovery.js";
import { replayCombatTick, stageCombatRuntime } from "../src/shared/diagnostics/combat-runtime.js";
import { roomWorkloadHash } from "../src/shared/diagnostics/room-workload.js";
import type { PreparedPlayerTick } from "../src/shared/protocol/input-stream.js";
import { combatReconnectProof, recordCombatReconnect } from "./fixtures/combat-reconnect-proof.js";
import { combatArchiveIdentity } from "./fixtures/combat-recovery-proof.js";

let fixture: ReturnType<typeof recordCombatReconnect>;
beforeAll(() => {
  fixture = recordCombatReconnect();
});
describe("per-player combat connection replacement", () => {
  it("replaces a waiting socket at the same tick without refilling ammunition or changing the other players", () => {
    const previous = structuredClone(required(recordCombatReconnect(1).states[2]));
    previous.snapshot.roomMode = "loading";
    previous.snapshot.stateHash = roomWorkloadHash(previous.snapshot);
    validateCombatCheckpoint(previous);
    const saved = structuredClone(previous);
    const replaced = replaceWaitingCombatConnection(previous, 2);
    validateCombatCheckpoint(replaced);
    expect(previous).toEqual(saved);
    expect(replaced.combat.tick).toBe(previous.combat.tick);
    expect(replaced.snapshot.runEpoch).toBe(previous.snapshot.runEpoch);
    expect(replaced.history).toEqual(previous.history);
    expect(replaced.combat.projectiles).toEqual(previous.combat.projectiles);
    expect(replaced.combat.encounter).toEqual(previous.combat.encounter);
    expect(combatContinuationHash(replaced.snapshot)).toBe(
      combatContinuationHash(previous.snapshot),
    );
    for (const [index, actor] of previous.combat.players.entries()) {
      const after = required(replaced.combat.players[index]);
      if (actor.playerId !== 2) {
        expect(after).toEqual(actor);
        expect(replaced.snapshot.acknowledgments[index]).toEqual(
          previous.snapshot.acknowledgments[index],
        );
        continue;
      }
      expect(after.weapon).toEqual(actor.weapon);
      expect(after.action).toEqual(actor.action);
      expect(after.controlEpoch).toBe(actor.controlEpoch);
      expect(replaced.snapshot.acknowledgments[index]).toMatchObject({
        connectionEpoch: required(previous.snapshot.acknowledgments[index]).connectionEpoch + 1,
        lastProcessedSequence: 0,
        appliedAtServerTick: 0,
        processedEdgeIds: [0, 0, 0, 0, 0],
      });
    }
  });
  it("keeps a valid snapshot recipient after all waiting connections have been replaced", () => {
    let state = structuredClone(required(fixture.states[0]));
    state.snapshot.roomMode = "loading";
    const previous = structuredClone(state.snapshot.acknowledgments);
    for (const player of state.combat.players) {
      state = replaceWaitingCombatConnection(state, player.playerId);
      validateCombatCheckpoint(state);
    }
    expect(state.snapshot.acknowledgments.map((ack) => ack.connectionEpoch)).toEqual(
      previous.map((ack) => ack.connectionEpoch + 1),
    );
    expect(state.combat.tick).toBe(0);
  });
  it("rejects loading replacement outside the barrier, for unknown owners, exhausted generations or vehicles", () => {
    const previous = structuredClone(required(fixture.states[2]));
    expect(() => replaceWaitingCombatConnection(previous, 2)).toThrow(/waiting phase/);
    previous.snapshot.roomMode = "loading";
    expect(() => replaceWaitingCombatConnection(previous, 99)).toThrow(/owner/);
    const exhausted = structuredClone(previous);
    required(exhausted.snapshot.acknowledgments[1]).connectionEpoch = COUNTER_LIMIT - 1;
    expect(() => replaceWaitingCombatConnection(exhausted, 2)).toThrow();
    const seated = structuredClone(previous);
    required(seated.combat.players[1]).vehicleId = 100;
    expect(() => replaceWaitingCombatConnection(seated, 2)).toThrow(/vehicle/);
  });
  it("does not replenish special ammunition or replace a mid-action weapon", () => {
    const special = recordCombatReconnect(1);
    const before = required(special.states[2]?.combat.players[1]);
    const after = required(special.states[3]?.combat.players[1]);
    expect(before.weapon.ammo).toBeGreaterThan(0);
    expect(after.weapon.id).toBe(before.weapon.id);
    expect(after.weapon.ammo).toBe(before.weapon.ammo);
    expect(after.weapon.shotOrdinal).toBe(before.weapon.shotOrdinal);
    expect(after.action.actionInstanceId).toBe(before.action.actionInstanceId);
    expect(after.action.stateStartTick).toBe(before.action.stateStartTick);
    expect(after.invulnerableTicks).toBe(0);
  });
  it("journals a neutral socket boundary, preserves action/weapon/ownership, and advances healthy streams", () => {
    const proof = combatReconnectProof();
    expect(proof.beforeActor?.weapon.ammo).toBe(proof.afterActor?.weapon.ammo);
    expect(proof.beforeActor?.weapon.shotOrdinal).toBe(proof.afterActor?.weapon.shotOrdinal);
    expect(proof.afterActor?.controlEpoch).toBe(proof.beforeActor?.controlEpoch);
    expect(proof.afterActor?.lives).toBe(proof.beforeActor?.lives);
    expect(proof.afterActor?.health).toBe(proof.beforeActor?.health);
    expect(proof.acknowledgments.map((a) => [a.connectionEpoch, a.lastProcessedSequence])).toEqual([
      [2, 0],
      [2, 3],
      [3, 3],
      [4, 3],
    ]);
    expect(proof.boundaryEvents).toEqual([
      { order: 0, event: { kind: "neutralize", playerId: 1, reason: "disconnect" } },
      { order: 1, event: { kind: "connection", playerId: 1, connectionEpoch: 2, connected: true } },
    ]);
    expect(proof.continuedTick).toBe(45);
  });
  it("reconstructs a replacement within an encoded durable segment", async () => {
    const start = fixture.states[0],
      end = fixture.states[15];
    if (!start || !end) throw new Error("Missing fixture");
    const identity = await combatArchiveIdentity();
    const raw = await encodeCombatJournalSegment(start, fixture.entries.slice(0, 15), identity);
    expect(await restoreCombatJournalSegment(start, raw, identity)).toEqual(end);
  });
  it("rejects reused/skipped generations, commands before welcome, duplicate owners and vehicle handoff without mutation", () => {
    const before = fixture.states[2],
      entry = fixture.entries[2];
    if (!before || !entry) throw new Error("Missing fixture");
    const saved = structuredClone(before);
    const prepared: PreparedPlayerTick[] = entry.inputs.map(({ input }, index) => ({
      input,
      acknowledgment: required(entry.acknowledgments[index]),
      neutralized: false,
    }));
    for (const connectionEpoch of [1, 3])
      expect(() =>
        stageCombatRuntime(before, prepared, [{ playerId: 1, connectionEpoch }]),
      ).toThrow(/generation/);
    expect(() =>
      stageCombatRuntime(before, prepared, [
        { playerId: 1, connectionEpoch: 2 },
        { playerId: 1, connectionEpoch: 2 },
      ]),
    ).toThrow(/owner/);
    const early = structuredClone(prepared);
    required(early[0]).input.submittedCommand = {
      ...required(early[0]).input.command,
      sequence: 1,
    };
    expect(() => stageCombatRuntime(before, early, [{ playerId: 1, connectionEpoch: 2 }])).toThrow(
      /baseline/,
    );
    const held = structuredClone(prepared);
    required(held[0]).input.command.held = 16;
    expect(() => stageCombatRuntime(before, held, [{ playerId: 1, connectionEpoch: 2 }])).toThrow(
      /intent/,
    );
    const seated = structuredClone(before);
    required(seated.combat.players[0]).vehicleId = 100;
    expect(() =>
      stageCombatRuntime(seated, prepared, [{ playerId: 1, connectionEpoch: 2 }]),
    ).toThrow(/vehicle/);
    expect(before).toEqual(saved);
  });
  it("rejects stripped or changed connection decisions and stale acknowledgments at replay", () => {
    const before = fixture.states[2],
      entry = fixture.entries[2];
    if (!before || !entry) throw new Error("Missing fixture");
    const mutations = [
      (copy: typeof entry) => {
        copy.boundaryEvents = [];
      },
      (copy: typeof entry) => {
        required(copy.acknowledgments[0]).connectionEpoch = 1;
      },
      (copy: typeof entry) => {
        copy.boundaryEvents.reverse();
      },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(entry);
      mutate(copy);
      expect(() => replayCombatTick(before, copy)).toThrow();
    }
  });
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}
