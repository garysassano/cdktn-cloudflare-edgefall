import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge, type EdgeKind, Held } from "../../src/game/input/types.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
  validateCombatCheckpoint,
} from "../../src/shared/diagnostics/combat-checkpoint.js";
import {
  type CombatJournalTick,
  type CombatRuntime,
  combatRuntimeHash,
  createCombatRuntime,
  stageCombatRuntime,
} from "../../src/shared/diagnostics/combat-runtime.js";
import { combatPeerContext } from "../../src/shared/diagnostics/combat-workload.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

export const TANK_BOUNDARIES = [1, 11, 12, 15, 21, 60, 90, 96, 97] as const;
export const TANK_DAMAGE_BOUNDARIES = [1, 12, 182, 183, 195] as const;
export const tankDamageInput: TankInputScript = (tick) => ({
  held: 0,
  edges: tick === 1 ? [Edge.Interact] : [],
});
export type TankInputScript = (
  tick: number,
  slot: number,
  state: CombatRuntime,
) => {
  held: number;
  edges?: EdgeKind[];
  controlEpoch?: number;
};
export const tankInput: TankInputScript = (tick) => ({
  held:
    (tick >= 13 && tick <= 26 ? Held.Right : 0) |
    (tick >= 15 && tick <= 21 ? Held.Up : 0) |
    (tick >= 60 && tick <= 74 ? Held.Fire : 0),
  edges:
    tick === 1 || tick === 90
      ? [Edge.Interact]
      : tick === 15
        ? [Edge.Jump]
        : tick === 60
          ? [Edge.FireOnset]
          : [],
});

/** Four real admission streams; vehicle movement is authoritative in this W05 laboratory. */
export function recordTankCombat(through = 120, input: TankInputScript = tankInput, players = 4) {
  let state = createCombatRuntime("tank", players);
  const states = [structuredClone(state)],
    entries: CombatJournalTick[] = [];
  const streams = state.combat.players.map(
    (actor) =>
      new InputStream({
        ...combatPeerContext(state.snapshot, actor.slot),
        controlEpoch: actor.controlEpoch,
        baselineServerTick: 0,
      }),
  );
  const cursors = streams.map(() => [0, 0, 0, 0, 0]);
  let duplicates = 0;
  for (let tick = 1; tick <= through; tick++) {
    for (const [slot, stream] of streams.entries()) {
      const intent = input(tick, slot, state),
        player = state.combat.players[slot],
        ids = cursors[slot];
      if (!player || !ids) throw new Error("Missing tank command owner");
      const command = {
        sequence: tick,
        clientTick: tick - 1,
        controlEpoch: intent.controlEpoch ?? player.controlEpoch,
        held: intent.held,
        aim: 0 as const,
        edges: (intent.edges ?? []).map((kind) => {
          const id = (ids[kind - 1] ?? 0) + 1;
          ids[kind - 1] = id;
          return { kind, id };
        }),
      };
      const packet = encodeInputBatch({
        ...combatPeerContext(state.snapshot, slot),
        packetSequence: tick,
        snapshotAck: 0,
        eventAck: 0,
        commands: [command],
      });
      stream.receive(packet, tick * 16, tick - 1);
      const duplicate = stream.receive(packet, tick * 16, tick - 1);
      if (!duplicate.duplicate || duplicate.admitted || duplicate.renewed)
        throw new Error("Tank duplicate changed admission");
      duplicates++;
    }
    let journal: CombatJournalTick | undefined;
    const committed = InputStream.processWorldTick(streams, tick, tick * 16, (prepared) => {
      const candidate = stageCombatRuntime(state, prepared);
      validateCombatCheckpoint(candidate.state);
      journal = candidate.journal;
      return candidate;
    });
    if (!journal) throw new Error("Missing tank input transaction");
    state = committed.state;
    entries.push(journal);
    states.push(structuredClone(state));
    if (state.snapshot.roomMode !== "playing") break;
  }
  return { states, entries, state, duplicates, streams };
}

export async function tankCombatProof() {
  const fixture = recordTankCombat(),
    identity = await combatArchiveIdentity(),
    checkpoints = [];
  for (const tick of TANK_BOUNDARIES) {
    const original = fixture.states[tick],
      accepted = fixture.states[tick + 15];
    if (!original || !accepted) throw new Error("Missing tank checkpoint boundary");
    const raw = await encodeCombatCheckpoint(original, identity),
      restored = await decodeCombatCheckpoint(raw, identity),
      segment = await encodeCombatJournalSegment(
        original,
        fixture.entries.slice(tick, tick + 15),
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
      throw new Error("Tank continuation diverged");
    checkpoints.push({
      tick,
      checkpointBytes: new TextEncoder().encode(raw).byteLength,
      snapshotBytes: bytes.byteLength,
      tanks: original.combat.tanks,
      hash: combatRuntimeHash(original),
      resumedTick: resumed.combat.tick,
      resumedHash: combatRuntimeHash(resumed),
    });
  }
  return {
    ticks: fixture.state.combat.tick,
    duplicates: fixture.duplicates,
    checkpoints,
    transfers: fixture.entries.flatMap((entry) =>
      entry.boundaryEvents
        .filter(({ event }) => event.kind === "seat")
        .map(({ event }) => ({ tick: entry.tick, ...event })),
    ),
    encounter: fixture.state.combat.encounter.phase,
    finalHash: combatRuntimeHash(fixture.state),
    traceHash: stateHash(fixture.states.map(combatRuntimeHash)),
  };
}
