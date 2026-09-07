import { damagePlayer } from "../../src/game/campaign/life.js";
import { canonical } from "../../src/game/core/canonical.js";
import { Edge, Held } from "../../src/game/input/types.js";
import {
  type CombatJournalTick,
  type CombatRuntime,
  stageCombatRuntime,
} from "../../src/shared/diagnostics/combat-runtime.js";
import { predictCombatMovement } from "../../src/shared/diagnostics/combat-workload.js";
import { controllerPeerContext } from "../../src/shared/diagnostics/controller-recovery.js";
import { ControllerPrediction } from "../../src/shared/prediction/controller.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";

/** Actual input admission and per-tick prediction from a confirmed generation boundary. */
export function recordCombatInputs(
  initial: CombatRuntime,
  ticks: number,
  held = Held.Right | Held.Fire,
) {
  let state = structuredClone(initial);
  const initialTick = initial.combat.tick;
  const states = [structuredClone(state)],
    entries: CombatJournalTick[] = [];
  const streams = state.combat.players.map(
    (actor) =>
      new InputStream({
        ...controllerPeerContext(initial.snapshot, actor.slot),
        controlEpoch: actor.controlEpoch,
        baselineServerTick: initialTick,
      }),
  );
  const baseline = (current: CombatRuntime, slot: number) => {
    const actor = current.snapshot.players[slot],
      acknowledgment = current.snapshot.acknowledgments[slot];
    if (!actor || !acknowledgment) throw new Error("Missing prediction baseline");
    return {
      runEpoch: current.snapshot.runEpoch,
      connectionEpoch: acknowledgment.connectionEpoch,
      tick: current.combat.tick,
      actor,
      acknowledgment,
    };
  };
  const reconcilers = state.combat.players.map(
    (actor) => new ControllerPrediction(baseline(state, actor.slot), predictCombatMovement),
  );
  let reconciliations = 0;
  for (let tick = initialTick + 1; tick <= initialTick + ticks; tick++) {
    const sequence = tick - initialTick;
    const predictions = [];
    for (const [slot, stream] of streams.entries()) {
      const command = {
        sequence,
        clientTick: sequence - 1,
        controlEpoch: initial.combat.players[slot]?.controlEpoch ?? 0,
        held,
        aim: 0 as const,
        edges: sequence === 1 && held & Held.Fire ? [{ kind: Edge.FireOnset, id: 1 }] : [],
      };
      stream.receive(
        encodeInputBatch({
          ...controllerPeerContext(initial.snapshot, slot),
          packetSequence: sequence,
          snapshotAck: 0,
          eventAck: 0,
          commands: [command],
        }),
        tick * 16,
        tick - 1,
      );
      const player = state.combat.players[slot];
      if (!player) throw new Error("Missing life recovery player");
      predictions.push(predictCombatMovement(player, command, tick));
      reconcilers[slot]?.submit(command);
    }
    let journal: CombatJournalTick | undefined;
    const committed = InputStream.processWorldTick(streams, tick, tick * 16, (prepared) => {
      const candidate = stageCombatRuntime(state, prepared);
      journal = candidate.journal;
      return candidate;
    });
    state = committed.state;
    if (sequence % 3 === 0 || state.snapshot.roomMode !== "playing") {
      for (const [slot, reconciler] of reconcilers.entries())
        reconciler.reconcile(baseline(state, slot));
      reconciliations++;
    }
    if (!journal) throw new Error("Missing life journal");
    for (const [slot, player] of state.combat.players.entries()) {
      let prediction = predictions[slot];
      // Movement prediction cannot know future hostile hits. Apply only the actual authoritative
      // impact outcomes before comparing life/motion, then restore through normal reconciliation.
      if (prediction)
        for (const notice of state.combat.events) {
          if (
            notice.kind === "impact" &&
            notice.targetId === player.body.id &&
            notice.impact &&
            notice.impact.damage > 0
          )
            prediction = damagePlayer(prediction, tick, notice.impact.damage, "classic").actor;
        }
      if (
        !prediction ||
        canonical([
          prediction.body,
          prediction.life,
          prediction.lifeStartTick,
          prediction.lives,
          prediction.invulnerableTicks,
        ]) !==
          canonical([
            player.body,
            player.life,
            player.lifeStartTick,
            player.lives,
            player.invulnerableTicks,
          ])
      )
        throw new Error(`Life movement prediction mismatch at ${tick}/${slot}`);
    }
    entries.push(journal);
    states.push(structuredClone(state));
    if (state.snapshot.roomMode !== "playing") break;
  }
  return { states, entries, state, reconciliations };
}
