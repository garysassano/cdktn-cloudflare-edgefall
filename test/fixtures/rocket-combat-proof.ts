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

export const ROCKET_COMBAT_BOUNDARIES = [
  0, 7, 8, 10, 13, 31, 32, 33, 40, 41, 55, 56, 120, 121, 144, 145,
] as const;

/** Four accepted streams jump, tap fire in the air, then hold for two more charges. */
export function recordRocketCombat() {
  return recordCombatInputs(
    createCombatRuntime("rocket"),
    160,
    (tick) => ({
      held: tick >= 31 && tick <= 55 ? Held.Fire : 0,
      edges: tick === 1 ? [Edge.Jump] : tick === 7 || tick === 31 ? [Edge.FireOnset] : [],
    }),
    { duplicatePackets: true },
  );
}

export async function rocketCombatProof() {
  const fixture = recordRocketCombat(),
    identity = await combatArchiveIdentity(),
    checkpoints = [];
  for (const tick of ROCKET_COMBAT_BOUNDARIES) {
    const original = fixture.states[tick],
      accepted = fixture.states[tick + 15];
    if (!original || !accepted) throw new Error("Missing launcher continuation boundary");
    const raw = await encodeCombatCheckpoint(original, identity);
    const restored = await decodeCombatCheckpoint(raw, identity);
    const segment = await encodeCombatJournalSegment(
      original,
      fixture.entries.slice(tick, tick + 15),
      identity,
    );
    const resumed = await restoreCombatJournalSegment(restored, segment, identity);
    if (canonical(restored) !== canonical(original) || canonical(resumed) !== canonical(accepted))
      throw new Error("Launcher archive continuation diverged");
    const context = combatPeerContext(original.snapshot, 0),
      bytes = encodeSnapshot(original.snapshot, context);
    if (canonical(decodeSnapshot(bytes, context)) !== canonical(original.snapshot))
      throw new Error("Rocket flight snapshot diverged");
    checkpoints.push({
      tick,
      checkpointBytes: new TextEncoder().encode(raw).byteLength,
      snapshotBytes: bytes.byteLength,
      rockets: original.combat.rockets,
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
        player.lives !== 3 || player.weapon.ammo !== 17 || player.weapon.shotOrdinal !== 3,
    )
  )
    throw new Error("Launcher charge/life accounting diverged");
  if (
    events.filter((event) => event.kind === "shot").length !== 12 ||
    fixture.state.combat.rockets.length
  )
    throw new Error("Launcher release/terminal count diverged");
  if (
    !fixture.states.some((state) =>
      state.combat.rockets.some(
        (rocket) => rocket.heading !== rocket.launchHeading && rocket.targetId !== null,
      ),
    )
  )
    throw new Error("Launcher fixture did not exercise guided flight");
  return {
    ticks: 160,
    duplicates: fixture.duplicates,
    checkpoints,
    events,
    finalHash: combatRuntimeHash(fixture.state),
    traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
    encounter: fixture.state.combat.encounter.phase,
    players: fixture.state.combat.players.map(({ weapon, lives }) => ({ weapon, lives })),
    scope:
      "Accepted four-player launcher input/ammo, visible flight and private lock/clocks through checkpoint and journal replay. Engineering content; SQLite and browser room execution are separate harnesses.",
  };
}
