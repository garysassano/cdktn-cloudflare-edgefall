import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge } from "../../src/game/input/types.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
} from "../../src/shared/diagnostics/combat-checkpoint.js";
import {
  combatRuntimeHash,
  createCombatRuntime,
} from "../../src/shared/diagnostics/combat-runtime.js";
import { combatPeerContext } from "../../src/shared/diagnostics/combat-workload.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import { recordCombatInputs } from "./combat-input-driver.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

export const ORDNANCE_BOUNDARIES = [1, 4, 5, 49, 50, 55, 82, 83, 95] as const;
export const DELAYED_ORDNANCE_BOUNDARIES = [6, 9, 10, 50, 76, 81, 82, 83, 100] as const;
export function recordOrdnance(startTick = 1) {
  return recordCombatInputs(
    createCombatRuntime("ordnance"),
    120,
    (tick) => ({
      held: 0,
      edges: tick === startTick || tick === startTick + 2 ? [Edge.Grenade] : [],
    }),
    { duplicatePackets: true },
  );
}

async function ordnanceScenario(startTick: number) {
  const fixture = recordOrdnance(startTick),
    identity = await combatArchiveIdentity(),
    checkpoints = [];
  for (const tick of startTick === 1 ? ORDNANCE_BOUNDARIES : DELAYED_ORDNANCE_BOUNDARIES) {
    const original = fixture.states[tick],
      accepted = fixture.states[tick + 15];
    if (!original || !accepted) throw new Error("Missing ordnance boundary");
    const raw = await encodeCombatCheckpoint(original, identity),
      restored = await decodeCombatCheckpoint(raw, identity);
    const segment = await encodeCombatJournalSegment(
      original,
      fixture.entries.slice(tick, tick + 15),
      identity,
    );
    const resumed = await restoreCombatJournalSegment(restored, segment, identity);
    const context = combatPeerContext(original.snapshot, 0),
      wire = encodeSnapshot(original.snapshot, context);
    if (
      canonical(restored) !== canonical(original) ||
      canonical(resumed) !== canonical(accepted) ||
      canonical(decodeSnapshot(wire, context)) !== canonical(original.snapshot)
    )
      throw new Error("Ordnance continuation diverged");
    checkpoints.push({
      tick,
      snapshotBytes: wire.length,
      checkpointBytes: new TextEncoder().encode(raw).byteLength,
      platforms: original.snapshot.platforms,
      grenades: original.combat.grenades,
      hash: combatRuntimeHash(original),
      resumedHash: combatRuntimeHash(resumed),
      resumedTick: resumed.combat.tick,
    });
  }
  const events = fixture.states.flatMap((state) =>
    state.combat.events.map((event) => ({ tick: state.combat.tick, ...event })),
  );
  if (
    events.filter((event) => event.kind === "throw").length !== 4 ||
    events.filter((event) => event.kind === "explosion").length !== 0 ||
    events.filter((event) => event.kind === "impact" && event.impact?.definitionId === 5).length !==
      4 ||
    fixture.state.combat.players.some((player) => player.grenadeStock !== 9 || player.lives !== 3)
  )
    throw new Error("Ordnance crush/debit outcome diverged");
  return {
    startTick,
    ticks: fixture.state.combat.tick,
    duplicates: fixture.duplicates,
    reconciliations: fixture.reconciliations,
    checkpoints,
    events,
    finalHash: combatRuntimeHash(fixture.state),
    traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
  };
}

export async function ordnanceProof() {
  return { ...(await ordnanceScenario(1)), delayed: await ordnanceScenario(6) };
}
