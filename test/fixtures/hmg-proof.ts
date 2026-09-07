import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held } from "../../src/game/input/types.js";
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

export const HMG_BOUNDARIES = [1, 6, 7, 11, 26, 47, 48, 51, 66, 70, 96, 97, 101, 102] as const;
export const hmgInput: CombatInputScript = (tick) => ({
  held:
    (tick <= 100 ? Held.Fire : 0) |
    ((tick >= 6 && tick <= 25) || (tick >= 66 && tick <= 85) || tick >= 101 ? Held.Up : 0) |
    ((tick >= 47 && tick <= 65) || (tick >= 91 && tick <= 100) ? Held.Down : 0) |
    (tick >= 86 && tick <= 90 ? Held.Left : 0),
  edges: tick === 46 ? [Edge.Jump] : [],
});
export function recordHmg() {
  return recordCombatInputs(createCombatRuntime("hmg"), 120, hmgInput, { duplicatePackets: true });
}
export async function hmgProof() {
  const fixture = recordHmg(),
    identity = await combatArchiveIdentity(),
    checkpoints = [];
  for (const tick of HMG_BOUNDARIES) {
    const original = fixture.states[tick],
      accepted = fixture.states[tick + 15];
    if (!original || !accepted) throw new Error("Missing HMG boundary");
    const raw = await encodeCombatCheckpoint(original, identity),
      restored = await decodeCombatCheckpoint(raw, identity);
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
      throw new Error("HMG continuation diverged");
    checkpoints.push({
      tick,
      snapshotBytes: wire.length,
      checkpointBytes: new TextEncoder().encode(raw).byteLength,
      players: original.combat.players,
      projectiles: original.combat.projectiles,
      hash: combatRuntimeHash(original),
      resumedHash: combatRuntimeHash(resumed),
      resumedTick: resumed.combat.tick,
    });
  }
  const releases = fixture.states.flatMap((state) =>
    state.combat.projectiles
      .filter((projectile) => projectile.spawnTick === state.combat.tick)
      .map((projectile) => ({ tick: state.combat.tick, ...projectile })),
  );
  const events = fixture.states.flatMap((state) =>
    state.combat.events.map((event) => ({ tick: state.combat.tick, ...event })),
  );
  for (const player of fixture.state.combat.players) {
    const shots = releases.filter((shot) => shot.ownerId === player.playerId);
    if (
      player.weapon.shotOrdinal !== 20 ||
      player.weapon.ammo !== 130 ||
      player.lives !== 3 ||
      player.grenadeStock !== 10 ||
      !shots.some((shot) => shot.velocity.x && shot.velocity.y < 0) ||
      !shots.some((shot) => shot.velocity.x && shot.velocity.y > 0)
    )
      throw new Error("HMG sweep, stock or life outcome diverged");
  }
  return {
    ticks: 120,
    duplicates: fixture.duplicates,
    reconciliations: fixture.reconciliations,
    checkpoints,
    releases,
    events,
    players: fixture.state.combat.players,
    finalHash: combatRuntimeHash(fixture.state),
    traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
  };
}
