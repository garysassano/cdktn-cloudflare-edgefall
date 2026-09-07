import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held } from "../../src/game/input/types.js";
import {
  type CombatArchiveIdentity,
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
} from "../../src/shared/diagnostics/combat-checkpoint.js";
import {
  type CombatJournalTick,
  combatRuntimeHash,
  createCombatRuntime,
  stageCombatRuntime,
} from "../../src/shared/diagnostics/combat-runtime.js";
import { combatIdentity } from "../../src/shared/diagnostics/combat-workload.js";
import { probeContext } from "../../src/shared/diagnostics/room-workload.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";

export async function combatArchiveIdentity(): Promise<CombatArchiveIdentity> {
  const { simulationVersion, simulationBuild, contentFormat, contentHash } = await combatIdentity();
  return {
    simulationVersion,
    simulationBuild,
    contentFormat,
    contentHash,
    runId: "combat-recovery-proof",
  };
}
/** Actual admission decides late/held/neutral ticks; recovery receives only committed decisions. */
export function recordCombatRecovery() {
  let state = createCombatRuntime();
  const states = [structuredClone(state)];
  const entries: CombatJournalTick[] = [];
  const streams = state.combat.players.map(
    (actor) =>
      new InputStream({ ...probeContext(actor.slot), controlEpoch: 1, baselineServerTick: 0 }),
  );
  for (let tick = 1; tick <= 119; tick++) {
    const active = streams.filter((_, slot) => slot !== 3 || tick < 67);
    for (const [slot, stream] of active.entries()) {
      if (slot === 2 && tick >= 62) continue;
      stream.receive(
        encodeInputBatch({
          ...probeContext(slot),
          packetSequence: tick,
          snapshotAck: 0,
          eventAck: 0,
          commands: [
            {
              sequence: tick,
              clientTick: tick - 1,
              controlEpoch: 1,
              held: Held.Fire,
              aim: 0,
              edges:
                tick === 1
                  ? [{ kind: Edge.FireOnset, id: 1 }]
                  : tick === 63 && slot === 0
                    ? [{ kind: Edge.Jump, id: 1 }]
                    : [],
            },
          ],
        }),
        tick * 16,
        tick - 1,
      );
    }
    let entry: CombatJournalTick | undefined;
    const committed = InputStream.processWorldTick(active, tick, tick * 16, (prepared) => {
      const candidate = stageCombatRuntime(state, prepared);
      entry = candidate.journal;
      return candidate;
    });
    state = committed.state;
    if (
      !entry ||
      canonical(entry.inputs) !==
        canonical(committed.processed.map(({ input, edgeResults }) => ({ input, edgeResults })))
    )
      throw new Error("Journal differs from committed applied inputs");
    entries.push(entry);
    states.push(structuredClone(state));
  }
  return { states, entries };
}
export async function combatRecoveryProof() {
  const identity = await combatArchiveIdentity();
  const { states, entries } = recordCombatRecovery();
  const captured = states[60],
    durable = states[105],
    live = states[119];
  if (!captured || !durable || !live) throw new Error("Missing checkpoint fixture");
  const raw = await encodeCombatCheckpoint(captured, identity);
  let restored = await decodeCombatCheckpoint(raw, identity);
  const bytes: number[] = [];
  for (let start = 60; start < 105; start += 15) {
    const source = states[start];
    if (!source) throw new Error("Missing segment boundary");
    const segment = await encodeCombatJournalSegment(
      source,
      entries.slice(start, start + 15),
      identity,
    );
    bytes.push(new TextEncoder().encode(segment).byteLength);
    restored = await restoreCombatJournalSegment(restored, segment, identity);
  }
  if (canonical(restored) !== canonical(durable))
    throw new Error("Committed combat reconstruction diverged");
  const baseline = decodeSnapshot(
    encodeSnapshot(restored.snapshot, probeContext(0)),
    probeContext(0),
  );
  if (baseline.combat?.phase !== "complete" || baseline.combat.kills[1]?.count !== 2)
    throw new Error("Recovery baseline lost encounter accounting");
  const boundaries = entries
    .slice(60, 105)
    .flatMap((entry) =>
      entry.boundaryEvents.map((boundary) => ({ tick: entry.tick, ...boundary })),
    );
  if (
    !boundaries.some((b) => b.event.kind === "neutralize" && b.event.reason === "stale") ||
    !boundaries.some((b) => b.event.kind === "connection" && !b.event.connected)
  )
    throw new Error("Missing external recovery decisions");
  return {
    checkpointTick: 60,
    committedTick: restored.combat.tick,
    observedTick: live.combat.tick,
    uncommittedTicks: live.combat.tick - restored.combat.tick,
    checkpointBytes: new TextEncoder().encode(raw).byteLength,
    segmentBytes: bytes,
    connectedPlayerIds: restored.connectedPlayerIds,
    shots: restored.combat.players.map((p) => p.weapon.shotOrdinal),
    nextEntityId: restored.combat.nextEntityId,
    nextActionId: restored.combat.nextActionId,
    kills: baseline.combat.kills,
    eventCursor: restored.history.cursor,
    boundaries,
    stateHash: combatRuntimeHash(restored),
    journalHash: stateHash(entries.slice(60, 105)),
  };
}
