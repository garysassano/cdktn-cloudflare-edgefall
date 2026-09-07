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
import { type CombatInputScript, recordCombatInputs } from "./combat-input-driver.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

export const SUPPORT_BOUNDARIES = [1, 11, 25, 34, 35, 36, 50, 58, 59, 60] as const;
export const supportInput: CombatInputScript = (tick) => ({
  held: 0,
  edges: tick === 1 || tick === 25 ? [Edge.FireOnset] : [],
});
export function recordSupport() {
  return recordCombatInputs(createCombatRuntime("support"), 120, supportInput, {
    duplicatePackets: true,
  });
}
export async function supportProof() {
  const fixture = recordSupport(),
    identity = await combatArchiveIdentity(),
    checkpoints = [];
  for (const tick of SUPPORT_BOUNDARIES) {
    const original = fixture.states[tick],
      accepted = fixture.states[tick + 15];
    if (!original || !accepted) throw new Error("Missing support boundary");
    const raw = await encodeCombatCheckpoint(original, identity);
    const restored = await decodeCombatCheckpoint(raw, identity);
    const journal = await encodeCombatJournalSegment(
      original,
      fixture.entries.slice(tick, tick + 15),
      identity,
    );
    const resumed = await restoreCombatJournalSegment(restored, journal, identity);
    const context = combatPeerContext(original.snapshot, 0),
      wire = encodeSnapshot(original.snapshot, context);
    if (
      canonical(restored) !== canonical(original) ||
      canonical(resumed) !== canonical(accepted) ||
      canonical(decodeSnapshot(wire, context)) !== canonical(original.snapshot)
    )
      throw new Error("Destructible support continuation diverged");
    checkpoints.push({
      tick,
      snapshotBytes: wire.length,
      checkpointBytes: new TextEncoder().encode(raw).byteLength,
      geometryRevision: original.snapshot.geometryRevision,
      props: original.combat.props,
      targets: original.combat.targets,
      encounter: original.combat.encounter,
      hash: combatRuntimeHash(original),
      resumedTick: resumed.combat.tick,
      resumedHash: combatRuntimeHash(resumed),
    });
  }
  const world = fixture.state.combat;
  if (
    world.props[0]?.destroyedTick !== 35 ||
    world.encounter.phase !== "complete" ||
    world.encounter.members.some(
      (member) =>
        member.reason !== "out-of-bounds" || member.resolvedTick !== 59 || member.killerId !== null,
    ) ||
    world.encounter.kills.some((kill) => kill.count !== 0) ||
    world.players.some((player) => player.weapon.shotOrdinal !== 2 || player.lives !== 3)
  )
    throw new Error("Support destruction or physical encounter outcome diverged");
  return {
    ticks: world.tick,
    duplicates: fixture.duplicates,
    reconciliations: fixture.reconciliations,
    checkpoints,
    props: world.props,
    encounter: world.encounter,
    players: world.players,
    events: fixture.states.flatMap((state) =>
      state.combat.events.map((event) => ({ tick: state.combat.tick, ...event })),
    ),
    finalHash: combatRuntimeHash(fixture.state),
    traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
  };
}
