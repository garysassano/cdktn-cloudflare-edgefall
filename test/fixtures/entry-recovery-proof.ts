import { enterPlayer } from "../../src/game/campaign/life.js";
import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { pixels } from "../../src/game/core/numeric.js";
import { Edge, Held } from "../../src/game/input/types.js";
import { combatEntryContext } from "../../src/game/labs/combat.js";
import { combatCollisionIndex } from "../../src/game/labs/combat-terrain.js";
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
import { combatPeerContext, combatSnapshot } from "../../src/shared/diagnostics/combat-workload.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import { recordCombatInputs } from "./combat-input-driver.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

export const ENTRY_BOUNDARIES = [0, 6, 11, 12, 68, 69, 98, 99, 110, 111] as const;
/** Seed ordinary campaign entry, then admit real four-player intent through the lift/press. */
export function recordMovingEntry() {
  const initial = createCombatRuntime("ordnance");
  const frame = { tick: 0, geometryRevision: 1 },
    index = combatCollisionIndex("ordnance", frame);
  initial.combat.players = initial.combat.players.map((actor) => {
    const entered = enterPlayer(
      actor,
      0,
      "classic",
      combatEntryContext(actor, index, frame, "ordnance"),
    );
    if (!entered) throw new Error("Missing initial lift entry");
    return entered;
  });
  initial.snapshot = combatSnapshot(initial.combat, initial.snapshot, initial.campaign);
  return recordCombatInputs(
    initial,
    145,
    (tick) => ({
      held: tick <= 50 ? Held.Right : 0,
      edges: tick === 6 || tick === 12 ? [Edge.FireOnset] : [],
    }),
    { duplicatePackets: true },
  );
}
export async function entryRecoveryProof() {
  const fixture = recordMovingEntry(),
    identity = await combatArchiveIdentity(),
    checkpoints = [];
  for (const [slot] of fixture.state.combat.players.entries()) {
    const initial = fixture.states[0]?.combat.players[slot],
      protectedBody = fixture.states[11]?.combat.players[slot],
      ready = fixture.states[12]?.combat.players[slot],
      killed = fixture.states[69]?.combat.players[slot],
      entered = fixture.states[99]?.combat.players[slot],
      resumed = fixture.states[111]?.combat.players[slot];
    if (
      !initial ||
      protectedBody?.life !== "respawning" ||
      protectedBody.body.x !== initial.body.x + pixels(11) ||
      protectedBody.weapon.shotOrdinal !== 0 ||
      ready?.life !== "alive" ||
      ready.body.x !== initial.body.x + pixels(15) ||
      ready.weapon.shotOrdinal !== 1 ||
      killed?.life !== "death" ||
      killed.bodyPresence !== "removed" ||
      killed.lifeStartTick !== 69 ||
      killed.lives !== 2 ||
      entered?.life !== "respawning" ||
      entered.bodyPresence !== "present" ||
      entered.lifeStartTick !== 99 ||
      resumed?.life !== "alive" ||
      resumed.lifeStartTick !== 111 ||
      resumed.lives !== 2
    )
      throw new Error(`Moving entry/crush lifecycle diverged for slot ${slot}`);
  }
  for (const tick of ENTRY_BOUNDARIES) {
    const original = fixture.states[tick],
      accepted = fixture.states[tick + 15];
    if (!original || !accepted) throw new Error("Missing moving entry boundary");
    const raw = await encodeCombatCheckpoint(original, identity),
      restored = await decodeCombatCheckpoint(raw, identity);
    const resumed = await restoreCombatJournalSegment(
      restored,
      await encodeCombatJournalSegment(original, fixture.entries.slice(tick, tick + 15), identity),
      identity,
    );
    const context = combatPeerContext(original.snapshot, 0),
      wire = encodeSnapshot(original.snapshot, context);
    if (
      canonical(restored) !== canonical(original) ||
      canonical(resumed) !== canonical(accepted) ||
      canonical(decodeSnapshot(wire, context)) !== canonical(original.snapshot)
    )
      throw new Error("Moving entry archive/wire continuation diverged");
    checkpoints.push({
      tick,
      through: resumed.combat.tick,
      player: restored.combat.players[0],
      snapshotBytes: wire.length,
      checkpointBytes: new TextEncoder().encode(raw).byteLength,
      hash: combatRuntimeHash(resumed),
    });
  }
  const events = fixture.states.flatMap((state) =>
    state.combat.events
      .filter((event) => event.kind === "shot")
      .map((event) => ({ tick: state.combat.tick, ...event })),
  );
  const transitions = fixture.states.flatMap((state, index) =>
    state.combat.players
      .filter(
        (player) => player.life !== fixture.states[index - 1]?.combat.players[player.slot]?.life,
      )
      .map(({ slot, life, lives, bodyPresence }) => ({
        tick: state.combat.tick,
        slot,
        life,
        lives,
        bodyPresence,
      })),
  );
  return {
    checkpoints,
    events,
    transitions,
    duplicates: fixture.duplicates,
    reconciliations: fixture.reconciliations,
    ticks: fixture.state.combat.tick,
    traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
  };
}
