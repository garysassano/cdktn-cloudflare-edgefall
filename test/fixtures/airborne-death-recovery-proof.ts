import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held } from "../../src/game/input/types.js";
import { FOOT_DEFINITION } from "../../src/game/labs/foot-fixture.js";
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

export function recordAirborneDeath(kind: "rising" | "falling") {
  const rising = kind === "rising";
  const fixture = recordCombatInputs(
    createCombatRuntime("rifle"),
    145,
    (tick) => ({
      held: rising ? Held.Right : 0,
      edges: tick === (rising ? 35 : 31) ? [Edge.Jump] : [],
    }),
    { duplicatePackets: true },
  );
  const deathTick = rising ? 37 : 77,
    slot = rising ? 3 : 0;
  const killed = fixture.states[deathTick]?.combat.players[slot];
  if (
    killed?.life !== "death" ||
    killed.body.grounded ||
    killed.lifeStartTick !== deathTick ||
    killed.bodyPresence !== "present" ||
    killed.body.vy < 0 !== rising
  )
    throw new Error("Missing real airborne rifle kill");
  return { ...fixture, deathTick, slot };
}

/** Four admitted controllers, actual enemy bullets and exact private/wire continuation across airborne death. */
export async function airborneDeathRecoveryProof() {
  const identity = await combatArchiveIdentity();
  const cases = [];
  for (const kind of ["rising", "falling"] as const) {
    const fixture = recordAirborneDeath(kind),
      { states, entries, deathTick, slot } = fixture;
    const killed = states[deathTick]?.combat.players[slot],
      next = states[deathTick + 1]?.combat.players[slot];
    if (
      !killed ||
      !next ||
      !FOOT_DEFINITION ||
      next.body.vy !== killed.body.vy + FOOT_DEFINITION.gravity ||
      next.body.x !== killed.body.x + killed.body.vx ||
      next.body.y !== killed.body.y + next.body.vy
    )
      throw new Error("Hostile hit stopped airborne integration");
    const landedTick =
      states.find(
        (state) =>
          state.combat.tick > deathTick &&
          state.combat.players[slot]?.life === "death" &&
          state.combat.players[slot]?.body.grounded,
      )?.combat.tick ?? null;
    if (kind === "falling" && (landedTick === null || landedTick >= deathTick + 30))
      throw new Error("Falling hit did not settle before respawn");
    const checkpoints = [];
    for (const tick of [
      deathTick - 1,
      deathTick,
      deathTick + 6,
      deathTick + 29,
      deathTick + 30,
      deathTick + 42,
    ]) {
      const original = states[tick],
        accepted = states[tick + 15];
      if (!original || !accepted) throw new Error("Missing airborne death boundary");
      const raw = await encodeCombatCheckpoint(original, identity);
      const checkpoint = await decodeCombatCheckpoint(raw, identity);
      const resumed = await restoreCombatJournalSegment(
        checkpoint,
        await encodeCombatJournalSegment(original, entries.slice(tick, tick + 15), identity),
        identity,
      );
      if (
        canonical(checkpoint) !== canonical(original) ||
        canonical(resumed) !== canonical(accepted)
      )
        throw new Error("Airborne death replay mismatch");
      const context = combatPeerContext(checkpoint.snapshot, slot);
      const baseline = decodeSnapshot(
        encodeSnapshot(
          { ...checkpoint.snapshot, connectionEpoch: context.connectionEpoch },
          context,
        ),
        context,
      );
      if (canonical(baseline.players) !== canonical(checkpoint.combat.players))
        throw new Error("Airborne body lost in baseline");
      checkpoints.push({
        tick,
        through: resumed.combat.tick,
        player: baseline.players[slot],
        hash: combatRuntimeHash(resumed),
      });
    }
    const entry = states[deathTick + 30]?.combat.players[slot],
      ready = states[deathTick + 42]?.combat.players[slot];
    if (
      entry?.life !== "respawning" ||
      entry.bodyPresence !== "present" ||
      ready?.life !== "alive" ||
      ready.bodyPresence !== "present" ||
      ready.lives !== 2
    )
      throw new Error("Airborne corpse changed life deadline/accounting");
    cases.push({
      kind,
      deathTick,
      slot,
      killed,
      landedTick,
      checkpoints,
      duplicates: fixture.duplicates,
      reconciliations: fixture.reconciliations,
      hash: stateHash(states.map(combatRuntimeHash)),
    });
  }
  return { cases, hash: stateHash(cases) };
}
