import { CANNON_ATTACK } from "../../src/game/content/weapons/tank-cannon.js";
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

export const CANNON_BOUNDARIES = [
  1, 12, 18, 20, 21, 22, 63, 65, 66, 108, 109, 110, 111, 117, 156,
] as const;
export const CANNON_TICKS = 175;
export const cannonInput: TankInputScript = (tick, slot) => ({
  held:
    (tick >= 13 && tick <= 16 ? Held.Right : 0) |
    (slot === 0 && tick >= 18 && tick <= 27 ? Held.Fire : 0),
  edges:
    tick === 1 || tick === 110
      ? [Edge.Interact]
      : tick === 18
        ? slot === 0
          ? [Edge.FireOnset, Edge.Jump, Edge.Grenade]
          : [Edge.Jump, Edge.Grenade]
        : tick === 63 || tick === 108
          ? [Edge.Grenade]
          : [],
});
export const recordCannonCombat = (players = 4) =>
  recordTankCombat(CANNON_TICKS, cannonInput, players);

/** Accepted simultaneous hardpoints, delayed airborne release, and a paid/canceled third shell. */
export async function cannonCombatProof() {
  const identity = await combatArchiveIdentity(),
    cases = [];
  for (const players of [1, 4]) {
    const fixture = recordCannonCombat(players),
      checkpoints = [];
    for (const tick of CANNON_BOUNDARIES) {
      const original = fixture.states[tick],
        accepted = fixture.states[tick + 8];
      if (!original || !accepted) throw new Error("Missing cannon boundary");
      const raw = await encodeCombatCheckpoint(original, identity),
        restored = await decodeCombatCheckpoint(raw, identity),
        segment = await encodeCombatJournalSegment(
          original,
          fixture.entries.slice(tick, tick + 8),
          identity,
        ),
        resumed = await restoreCombatJournalSegment(restored, segment, identity),
        context = combatPeerContext(original.snapshot, 0),
        bytes = encodeSnapshot(original.snapshot, context);
      if (
        canonical(restored) !== canonical(original) ||
        canonical(resumed) !== canonical(accepted) ||
        canonical(decodeSnapshot(bytes, context)) !== canonical(original.snapshot)
      )
        throw new Error("Cannon continuation diverged");
      checkpoints.push({
        tick,
        hash: combatRuntimeHash(original),
        resumedTick: resumed.combat.tick,
        resumedHash: combatRuntimeHash(resumed),
        checkpointBytes: new TextEncoder().encode(raw).byteLength,
        snapshotBytes: bytes.byteLength,
      });
    }
    const notices = fixture.states.flatMap(({ combat }) =>
      combat.events
        .filter(
          (event) =>
            (event.source?.definitionId ?? event.impact?.definitionId) === CANNON_ATTACK.id,
        )
        .map((event) => ({ tick: combat.tick, ...event })),
    );
    if (
      fixture.state.combat.tanks.some(
        (tank) =>
          tank.secondary.ammo !== 7 ||
          tank.secondary.shotsFired !== 3 ||
          tank.secondary.action.kind !== "ready" ||
          tank.lifecycle !== "available",
      ) ||
      notices.filter((event) => event.kind === "shot").length !== players * 2
    )
      throw new Error("Cannon spending/release invariant");
    cases.push({
      players,
      ticks: fixture.state.combat.tick,
      duplicates: fixture.duplicates,
      checkpoints,
      notices,
      tanks: fixture.state.combat.tanks,
      finalHash: combatRuntimeHash(fixture.state),
      traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
    });
  }
  return { cases };
}
