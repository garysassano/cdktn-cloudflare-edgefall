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

export type AreaProofMode = "shotgun" | "flame";
export const AREA_BOUNDARIES = {
  shotgun: [1, 4, 5, 6, 7],
  flame: [6, 7, 12, 13, 15, 18, 19, 25, 30, 31],
} as const;

/** Four admitted keyboard-equivalent streams, one charge each and no authority mutation. */
export function recordAreaCombat(mode: AreaProofMode) {
  return recordCombatInputs(
    createCombatRuntime(mode),
    120,
    (tick) => ({
      held: Held.Down | (tick <= 18 ? Held.Fire : 0),
      edges: tick === 1 ? [Edge.FireOnset] : [],
    }),
    { duplicatePackets: true },
  );
}

export async function areaCombatProof() {
  const identity = await combatArchiveIdentity(),
    scenarios = [];
  for (const mode of ["shotgun", "flame"] as const) {
    const fixture = recordAreaCombat(mode),
      checkpoints = [];
    for (const tick of AREA_BOUNDARIES[mode]) {
      const original = fixture.states[tick],
        accepted = fixture.states[tick + 15];
      if (!original || !accepted) throw new Error("Missing area boundary");
      const raw = await encodeCombatCheckpoint(original, identity);
      const restored = await decodeCombatCheckpoint(raw, identity);
      const segment = await encodeCombatJournalSegment(
        original,
        fixture.entries.slice(tick, tick + 15),
        identity,
      );
      const resumed = await restoreCombatJournalSegment(restored, segment, identity);
      if (canonical(restored) !== canonical(original) || canonical(resumed) !== canonical(accepted))
        throw new Error("Area attack continuation diverged");
      const context = combatPeerContext(original.snapshot, 0),
        bytes = encodeSnapshot(original.snapshot, context);
      if (canonical(decodeSnapshot(bytes, context)) !== canonical(original.snapshot))
        throw new Error("Area exposure wire diverged");
      checkpoints.push({
        tick,
        checkpointBytes: new TextEncoder().encode(raw).byteLength,
        snapshotBytes: bytes.byteLength,
        volumes: original.snapshot.combat?.volumes,
        areas: original.combat.areas,
        hash: combatRuntimeHash(original),
        resumedTick: resumed.combat.tick,
        resumedHash: combatRuntimeHash(resumed),
      });
    }
    const events = fixture.states.flatMap((state) =>
      state.combat.events
        .filter((event) => ["shot", "impact", "shield-break", "killed"].includes(event.kind))
        .map((event) => ({
          tick: state.combat.tick,
          kind: event.kind,
          ownerId: event.ownerId,
          targetId: event.targetId,
          actionInstanceId: event.actionInstanceId,
          impact: event.impact,
        })),
    );
    if (
      fixture.state.combat.players.some(
        (player) =>
          player.lives !== 3 ||
          player.weapon.ammo !== (mode === "shotgun" ? 23 : 29) ||
          player.weapon.shotOrdinal !== 1,
      )
    )
      throw new Error("Area charge/life accounting diverged");
    if (
      events.filter((event) => event.kind === "shot" && event.ownerId <= 4).length !==
      (mode === "shotgun" ? 4 : 12)
    )
      throw new Error("Area emission count diverged");
    if (mode === "shotgun" && fixture.states[5]?.combat.encounter.phase !== "complete")
      throw new Error("Shotgun failed its expansion gate");
    if (
      mode === "flame" &&
      (fixture.states[13]?.combat.targets[0]?.health !== 1 ||
        fixture.states[13]?.combat.targets[0]?.guard?.integrity !== 0 ||
        fixture.states[15]?.combat.targets[0]?.health !== 0)
    )
      throw new Error("Flame break/body separation diverged");
    scenarios.push({
      mode,
      ticks: 120,
      duplicates: fixture.duplicates,
      checkpoints,
      events,
      finalHash: combatRuntimeHash(fixture.state),
      traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
      encounter: fixture.state.combat.encounter.phase,
    });
  }
  return {
    scenarios,
    scope:
      "Four admitted input streams and exact area rectangles, emission cursors, hit cooldowns and wall reach across archive recovery; engineering targets, no final media or deployed timing acceptance",
  };
}
