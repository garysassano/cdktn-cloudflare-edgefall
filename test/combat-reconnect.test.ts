import { beforeAll, describe, expect, it } from "vitest";
import {
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
} from "../src/shared/diagnostics/combat-checkpoint.js";
import { replayCombatTick, stageCombatRuntime } from "../src/shared/diagnostics/combat-runtime.js";
import type { PreparedPlayerTick } from "../src/shared/protocol/input-stream.js";
import { combatReconnectProof, recordCombatReconnect } from "./fixtures/combat-reconnect-proof.js";
import { combatArchiveIdentity } from "./fixtures/combat-recovery-proof.js";

let fixture: ReturnType<typeof recordCombatReconnect>;
beforeAll(() => {
  fixture = recordCombatReconnect();
});
describe("per-player combat connection replacement", () => {
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
