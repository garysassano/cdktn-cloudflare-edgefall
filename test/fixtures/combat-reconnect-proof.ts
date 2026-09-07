import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Held } from "../../src/game/input/types.js";
import {
  type CombatJournalTick,
  combatRuntimeHash,
  createCombatRuntime,
  replayCombatTick,
  stageCombatRuntime,
} from "../../src/shared/diagnostics/combat-runtime.js";
import { probeContext } from "../../src/shared/diagnostics/room-workload.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";

export function recordCombatReconnect(reconnectingSlot = 0) {
  let state = createCombatRuntime();
  const states = [structuredClone(state)],
    entries: CombatJournalTick[] = [];
  const streams = state.combat.players.map(
    (p) => new InputStream({ ...probeContext(p.slot), controlEpoch: 1, baselineServerTick: 0 }),
  );
  for (let tick = 1; tick <= 45; tick++) {
    if (tick === 3)
      streams[reconnectingSlot] = new InputStream({
        ...probeContext(reconnectingSlot),
        connectionEpoch: reconnectingSlot + 2,
        controlEpoch: 1,
        baselineServerTick: 2,
      });
    for (const [slot, stream] of streams.entries()) {
      if (tick === 3 && slot === reconnectingSlot) continue;
      const sequence = slot === reconnectingSlot && tick > 3 ? tick - 3 : tick;
      stream.receive(
        encodeInputBatch({
          ...probeContext(slot),
          connectionEpoch: stream.acknowledgment.connectionEpoch,
          packetSequence: sequence,
          snapshotAck: 0,
          eventAck: 0,
          commands: [
            {
              sequence,
              clientTick: sequence - 1,
              controlEpoch: 1,
              held: Held.Fire,
              aim: 0,
              edges: [],
            },
          ],
        }),
        tick * 16,
        tick - 1,
      );
    }
    let entry: CombatJournalTick | undefined;
    const committed = InputStream.processWorldTick(streams, tick, tick * 16, (prepared) => {
      const candidate = stageCombatRuntime(
        state,
        prepared,
        tick === 3
          ? [{ playerId: reconnectingSlot + 1, connectionEpoch: reconnectingSlot + 2 }]
          : [],
      );
      entry = candidate.journal;
      return candidate;
    });
    if (!entry) throw new Error("Missing reconnect journal");
    if (canonical(replayCombatTick(state, entry)) !== canonical(committed.state))
      throw new Error("Reconnect replay changed accepted continuation");
    state = committed.state;
    entries.push(entry);
    states.push(structuredClone(state));
    if (tick === 3)
      streams[reconnectingSlot] = new InputStream({
        ...probeContext(reconnectingSlot),
        connectionEpoch: reconnectingSlot + 2,
        controlEpoch: 1,
        baselineServerTick: 3,
      });
  }
  return { states, entries };
}
export function combatReconnectProof() {
  const { states, entries } = recordCombatReconnect();
  const before = states[2],
    after = states[3],
    last = states[45];
  if (!before || !after || !last) throw new Error("Missing reconnect boundaries");
  if (
    before.combat.players[0]?.action.kind !== "fire" ||
    before.combat.players[0]?.action.actionInstanceId !==
      after.combat.players[0]?.action.actionInstanceId
  )
    throw new Error("Reconnect restarted an active action");
  return {
    transitionTick: 3,
    beforeActor: before.combat.players[0],
    afterActor: after.combat.players[0],
    acknowledgments: after.snapshot.acknowledgments,
    boundaryEvents: entries[2]?.boundaryEvents,
    continuedTick: last.combat.tick,
    finalHash: combatRuntimeHash(last),
    journalHash: stateHash(entries),
  };
}
