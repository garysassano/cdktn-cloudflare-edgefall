import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held } from "../../src/game/input/types.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
} from "../../src/shared/diagnostics/combat-checkpoint.js";
import { combatRuntimeHash } from "../../src/shared/diagnostics/combat-runtime.js";
import { combatPeerContext } from "../../src/shared/diagnostics/combat-workload.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";
import { type TankInputScript, recordTankCombat } from "./tank-proof.js";

export const SPECIAL_TICKS = 130;
export const SPECIAL_BOUNDARIES = [12, 13, 26, 27, 32, 33, 61, 62, 63, 64, 97, 98, 120] as const;
// Cancel one real onset, prove held-only input does not restart it, then arm and release once.
export const specialInput: TankInputScript = (tick) => ({
  held: (tick >= 13 && tick <= 26) || tick >= 28 ? Held.VehicleSpecial : 0,
  edges: tick === 1 ? [Edge.Interact] : tick === 13 || tick === 33 ? [Edge.VehicleSpecial] : [],
});
export const recordTankSpecial = (players = 4) =>
  recordTankCombat(SPECIAL_TICKS, specialInput, players);

export async function tankSpecialProof() {
  const identity = await combatArchiveIdentity(),
    cases = [];
  for (const players of [1, 4]) {
    const fixture = recordTankSpecial(players),
      checkpoints = [];
    for (const tick of SPECIAL_BOUNDARIES) {
      const original = fixture.states[tick],
        expected = fixture.states[tick + 8];
      if (!original || !expected) throw new Error("Missing special boundary");
      const raw = await encodeCombatCheckpoint(original, identity),
        restored = await decodeCombatCheckpoint(raw, identity);
      const segment = await encodeCombatJournalSegment(
        original,
        fixture.entries.slice(tick, tick + 8),
        identity,
      );
      const resumed = await restoreCombatJournalSegment(restored, segment, identity),
        context = combatPeerContext(original.snapshot, 0);
      const bytes = encodeSnapshot(original.snapshot, context);
      if (
        canonical(restored) !== canonical(original) ||
        canonical(resumed) !== canonical(expected) ||
        canonical(decodeSnapshot(bytes, context)) !== canonical(original.snapshot)
      )
        throw new Error("Sacrifice continuation diverged");
      checkpoints.push({
        tick,
        hash: combatRuntimeHash(original),
        resumedTick: resumed.combat.tick,
        resumedHash: combatRuntimeHash(resumed),
        checkpointBytes: new TextEncoder().encode(raw).byteLength,
        snapshotBytes: bytes.byteLength,
      });
    }
    cases.push({
      players,
      ticks: fixture.state.combat.tick,
      duplicates: fixture.duplicates,
      checkpoints,
      transfers: fixture.entries.flatMap((entry) =>
        entry.boundaryEvents
          .filter(({ event }) => event.kind === "seat")
          .map(({ event }) => ({ tick: entry.tick, ...event })),
      ),
      blasts: fixture.states.flatMap(({ combat }) =>
        combat.events
          .filter((event) => event.kind === "explosion" && event.source?.definitionId === 20)
          .map((event) => ({ tick: combat.tick, ...event })),
      ),
      tanks: fixture.state.combat.tanks,
      playersFinal: fixture.state.combat.players,
      finalHash: combatRuntimeHash(fixture.state),
      traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
    });
  }
  return { cases };
}
