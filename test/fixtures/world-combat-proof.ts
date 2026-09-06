import { stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held } from "../../src/game/input/types.js";
import {
  createCombatWorkload,
  evaluateCombatTick,
} from "../../src/shared/diagnostics/combat-workload.js";
import { probeContext } from "../../src/shared/diagnostics/room-workload.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";

export function worldCombatProof() {
  let state = createCombatWorkload();
  state.snapshot.roomMode = "playing";
  const streams = state.combat.players.map(
    (actor) =>
      new InputStream({
        ...probeContext(actor.slot),
        controlEpoch: actor.controlEpoch,
        baselineServerTick: 0,
      }),
  );
  const hashes: string[] = [];
  for (let tick = 1; tick <= 120; tick++) {
    for (const [slot, stream] of streams.entries()) {
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
              edges: tick === 1 ? [{ kind: Edge.FireOnset, id: 1 }] : [],
            },
          ],
        }),
        tick * 16,
        tick - 1,
      );
    }
    const transaction = InputStream.processWorldTick(streams, tick, tick * 16, (prepared) => {
      const result = evaluateCombatTick(state.combat, state.snapshot, prepared);
      for (const actor of result.state.combat.players) {
        const context = probeContext(actor.slot);
        const snapshot = { ...result.state.snapshot, connectionEpoch: context.connectionEpoch };
        if (
          stateHash(decodeSnapshot(encodeSnapshot(snapshot, context), context)) !==
          stateHash(snapshot)
        )
          throw new Error("Combat snapshot mismatch");
      }
      return result;
    });
    state = transaction.state;
    if (
      transaction.processed.some(
        (result) => result.acknowledgment.appliedAtServerTick !== state.combat.tick,
      )
    )
      throw new Error("Combat acknowledgment boundary mismatch");
    hashes.push(stateHash({ state, processed: transaction.processed }));
  }
  const before = stateHash(state),
    acks = streams.map((stream) => stream.acknowledgment);
  let failed = false;
  try {
    InputStream.processWorldTick(streams, 121, 1936, (prepared) => {
      evaluateCombatTick(state.combat, state.snapshot, prepared);
      throw new Error("Injected world publication rejection");
    });
  } catch {
    failed = true;
  }
  if (
    !failed ||
    before !== stateHash(state) ||
    stateHash(acks) !== stateHash(streams.map((stream) => stream.acknowledgment)) ||
    streams.some((stream) => !stream.requiresResync)
  )
    throw new Error("World abort was not isolated");
  return {
    ticks: state.combat.tick,
    phase: state.combat.encounter.phase,
    shots: state.combat.players.map((actor) => actor.weapon.shotOrdinal),
    kills: state.combat.encounter.kills,
    nextActionId: state.combat.nextActionId,
    abortAtTick: 121,
    traceHash: stateHash(hashes),
    finalHash: before,
  };
}
