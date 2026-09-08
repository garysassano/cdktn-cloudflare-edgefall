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
import { recordCombatInputs } from "./combat-input-driver.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

export const LASER_COMBAT_BOUNDARIES = [
  0, 1, 2, 6, 7, 8, 12, 13, 18, 19, 24, 25, 31, 32, 37, 42, 43, 49, 50,
] as const;

/** Four admitted streams tap, hold upward, move while firing, then tap again; every packet is duplicated. */
export function recordLaserCombat() {
  return recordCombatInputs(
    createCombatRuntime("laser"),
    72,
    (tick) => ({
      held:
        tick >= 7 && tick <= 24
          ? Held.Fire | Held.Up
          : tick >= 31 && tick <= 42
            ? Held.Fire | Held.Right
            : 0,
      edges: [1, 7, 13, 31, 49].includes(tick) ? [Edge.FireOnset] : [],
    }),
    { duplicatePackets: true },
  );
}

export async function laserCombatProof() {
  const fixture = recordLaserCombat(),
    identity = await combatArchiveIdentity(),
    checkpoints = [];
  for (const tick of LASER_COMBAT_BOUNDARIES) {
    const original = fixture.states[tick],
      accepted = fixture.states[tick + 15];
    if (!original || !accepted) throw new Error("Missing laser continuation boundary");
    const raw = await encodeCombatCheckpoint(original, identity);
    const restored = await decodeCombatCheckpoint(raw, identity);
    const segment = await encodeCombatJournalSegment(
      original,
      fixture.entries.slice(tick, tick + 15),
      identity,
    );
    const resumed = await restoreCombatJournalSegment(restored, segment, identity);
    if (canonical(restored) !== canonical(original) || canonical(resumed) !== canonical(accepted))
      throw new Error("Laser archive continuation diverged");
    const context = combatPeerContext(original.snapshot, 0),
      bytes = encodeSnapshot(original.snapshot, context);
    if (canonical(decodeSnapshot(bytes, context)) !== canonical(original.snapshot))
      throw new Error("Beam geometry snapshot diverged");
    checkpoints.push({
      tick,
      checkpointBytes: new TextEncoder().encode(raw).byteLength,
      snapshotBytes: bytes.byteLength,
      beams: original.combat.beams,
      volumes: original.snapshot.combat?.volumes,
      hash: combatRuntimeHash(original),
      resumedTick: resumed.combat.tick,
      resumedHash: combatRuntimeHash(resumed),
    });
  }
  const events = fixture.states.flatMap((state) =>
    state.combat.events
      .filter((event) => ["shot", "explosion", "impact", "killed"].includes(event.kind))
      .map((event) => ({ tick: state.combat.tick, ...event })),
  );
  if (
    fixture.state.combat.players.some(
      (player) =>
        player.lives !== 3 || player.weapon.ammo !== 113 || player.weapon.shotOrdinal !== 7,
    )
  )
    throw new Error("Laser charge/life accounting diverged");
  if (
    events.filter((event) => event.kind === "shot").length !== 28 ||
    fixture.state.combat.beams.length
  )
    throw new Error("Laser release/terminal count diverged");
  if (
    !fixture.states.some((state) =>
      state.combat.beams.some((beam) => beam.tick > beam.spawnTick && beam.heading === 1),
    )
  )
    throw new Error("Laser fixture did not exercise a held upward charge");
  return {
    ticks: 72,
    duplicates: fixture.duplicates,
    checkpoints,
    events,
    finalHash: combatRuntimeHash(fixture.state),
    traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
    encounter: fixture.state.combat.encounter.phase,
    players: fixture.state.combat.players.map(({ weapon, lives }) => ({ weapon, lives })),
    scope:
      "Accepted four-player laser energy/pulse accounting, public clipped geometry and private charge lifetime through checkpoint and journal replay. Engineering content; SQLite and browser room execution are separate harnesses.",
  };
}
