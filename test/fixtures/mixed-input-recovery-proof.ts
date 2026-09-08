import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge, type EdgeKind, Held } from "../../src/game/input/types.js";
import {
  decodeCombatCheckpoint,
  encodeCombatCheckpoint,
  encodeCombatJournalSegment,
  restoreCombatJournalSegment,
} from "../../src/shared/diagnostics/combat-checkpoint.js";
import {
  type CombatJournalTick,
  createCombatRuntime,
  replayCombatTick,
  stageCombatRuntime,
} from "../../src/shared/diagnostics/combat-runtime.js";
import { probeContext } from "../../src/shared/diagnostics/room-workload.js";
import { InputCapture } from "../../src/shared/input/capture.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";
import { combatArchiveIdentity } from "./combat-recovery-proof.js";

const orders: EdgeKind[][] = [
  [Edge.FireOnset, Edge.Jump],
  [Edge.Jump, Edge.FireOnset],
  [Edge.FireOnset, Edge.Jump, Edge.Grenade],
  [Edge.FireOnset, Edge.Grenade, Edge.Jump],
  [Edge.Jump, Edge.FireOnset, Edge.Grenade],
  [Edge.Jump, Edge.Grenade, Edge.FireOnset],
  [Edge.Grenade, Edge.FireOnset, Edge.Jump],
  [Edge.Grenade, Edge.Jump, Edge.FireOnset],
  [Edge.Jump, Edge.FireOnset, Edge.Jump],
];

/** Physical capture order survives admission, duplicates, atomic application and cold replay. */
export async function mixedInputRecoveryProof() {
  const identity = await combatArchiveIdentity(),
    cases = [];
  for (const order of orders) {
    const initial = createCombatRuntime();
    let state = initial;
    const streams = initial.combat.players.map(
      (actor) =>
        new InputStream({
          ...probeContext(actor.slot),
          controlEpoch: 1,
          baselineServerTick: 0,
        }),
    );
    for (const [slot, stream] of streams.entries()) {
      const capture = new InputCapture(1);
      capture.press("move", { held: Held.Right | Held.Fire });
      for (const kind of order) {
        capture.press("edge", { edge: kind });
        capture.release("edge");
      }
      const command = capture.capture(0);
      if (canonical(command.edges.map((e) => e.kind)) !== canonical(order))
        throw new Error("Capture reordered input");
      const bytes = encodeInputBatch({
        ...probeContext(slot),
        packetSequence: 1,
        snapshotAck: 0,
        eventAck: 0,
        commands: [command],
      });
      stream.receive(bytes, 0, 0);
      stream.receive(bytes, 1, 0);
    }
    const journal: CombatJournalTick[] = [];
    for (let tick = 1; tick <= 15; tick++) {
      const committed = InputStream.processWorldTick(streams, tick, tick * 16, (prepared) => {
        const candidate = stageCombatRuntime(state, prepared);
        journal.push(candidate.journal);
        return candidate;
      });
      state = committed.state;
    }
    const checkpoint = await encodeCombatCheckpoint(initial, identity),
      segment = await encodeCombatJournalSegment(initial, journal, identity),
      restored = await restoreCombatJournalSegment(
        await decodeCombatCheckpoint(checkpoint, identity),
        segment,
        identity,
      );
    if (canonical(restored) !== canonical(state))
      throw new Error("Mixed-edge cold replay diverged");
    const input = journal[0]?.inputs[0];
    if (!input || canonical(input.input.command.edges.map((e) => e.kind)) !== canonical(order))
      throw new Error("Journal changed physical input order");
    if (
      state.combat.players.some(
        (p) =>
          p.grenadeStock !== (order.includes(Edge.Grenade) ? 9 : 10) ||
          p.body.grounded ||
          p.body.vx <= 0,
      )
    )
      throw new Error("Mixed actions or locomotion disagreed");
    const bad = structuredClone(journal[0]);
    if (!bad?.inputs[0]?.input.submittedCommand) throw new Error("Missing mixed-edge journal");
    const edge = bad.inputs[0].input.command.edges[0];
    if (!edge) throw new Error("Missing corruption edge");
    bad.inputs[0].input.command.edges.push(structuredClone(edge));
    bad.inputs[0].input.submittedCommand.edges.push(structuredClone(edge));
    let rejected = false;
    try {
      replayCombatTick(initial, bad);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("Journal admitted a reused same-kind edge");
    cases.push({
      order,
      ticks: state.combat.tick,
      players: state.combat.players.length,
      hash: stateHash(state),
      journalHash: stateHash(journal),
      sameKindReuseRejected: rejected,
    });
  }
  return cases;
}
