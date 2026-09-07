import { stateHash } from "../../src/game/core/canonical.js";
import { Held } from "../../src/game/input/types.js";
import { stepCombatLab } from "../../src/game/labs/combat.js";
import {
  combatEventContext,
  combatGameplayEvents,
} from "../../src/shared/diagnostics/combat-events.js";
import {
  combatSnapshot,
  createCombatWorkload,
} from "../../src/shared/diagnostics/combat-workload.js";
import { probeContext, roomWorkloadHash } from "../../src/shared/diagnostics/room-workload.js";
import {
  EventReceiver,
  acceptsEventBaseline,
  createEventHistory,
  eventBatches,
  stageEventTick,
} from "../../src/shared/protocol/event-stream.js";
import {
  decodeEventBaseline,
  decodeEventBatch,
  encodeEventBatch,
} from "../../src/shared/protocol/events.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";

export function eventDeliveryProof() {
  const initial = createCombatWorkload();
  let world = initial.combat,
    history = createEventHistory(1);
  const contexts = world.players.map((actor) => combatEventContext(probeContext(actor.slot)));
  const primary = contexts[0];
  if (!primary) throw new Error("Missing event proof owner");
  const receivers = contexts.map(
    (context) =>
      new EventReceiver(context, { ...initial.snapshot, connectionEpoch: context.connectionEpoch }),
  );
  const chains = ["0", "0", "0", "0"],
    kills = [0, 0, 0, 0];
  const traces: string[] = [];
  let dropped = 0,
    repairTick = 0;
  const actionKeys = new Map<number, string>();
  const keyOwners = new Map<string, number>();
  for (let tick = 1; tick <= 300; tick++) {
    const next = stepCombatLab(
      world,
      world.players.map(() => ({
        held: Held.Fire,
        jumpPressed: false,
        grenadePressed: false,
        firePressed: tick === 1,
      })),
    );
    const notices = combatGameplayEvents(world, next);
    for (const event of notices)
      if (event.confirmation) {
        const key = JSON.stringify(event.confirmation);
        if (
          (actionKeys.has(event.actionInstanceId) &&
            actionKeys.get(event.actionInstanceId) !== key) ||
          (keyOwners.has(key) && keyOwners.get(key) !== event.actionInstanceId)
        )
          throw new Error("Firearm confirmation key was reused or changed between markers");
        actionKeys.set(event.actionInstanceId, key);
        keyOwners.set(key, event.actionInstanceId);
      }
    history = stageEventTick(history, tick, notices, primary);
    world = next;
    if (tick % 3 !== 0) continue;
    for (const [slot, receiver] of receivers.entries()) {
      const context = contexts[slot];
      if (!context) throw new Error("Missing event proof session");
      const batches = eventBatches(history, receiver.cursor, context.connectionEpoch);
      if (batches === null) {
        const snapshot = combatSnapshot(world, initial.snapshot);
        Object.assign(snapshot, {
          snapshotId: tick * 4 + slot + 10,
          connectionEpoch: context.connectionEpoch,
          baselineEventCursor: history.cursor,
        });
        snapshot.stateHash = roomWorkloadHash(snapshot);
        const baseline = decodeSnapshot(
          encodeSnapshot(snapshot, probeContext(slot)),
          probeContext(slot),
        );
        const promise = decodeEventBaseline(
          JSON.stringify({
            type: "resync-required",
            scope: "events",
            reason: "history-expired",
            runEpoch: 1,
            connectionEpoch: context.connectionEpoch,
            snapshotId: baseline.snapshotId,
            tick,
            baselineEventCursor: history.cursor,
          }),
          context,
        );
        receiver.installBaseline(baseline, promise);
        if (!acceptsEventBaseline(promise, baseline.snapshotId, receiver.cursor, 0))
          throw new Error("Missing explicit event baseline acceptance");
        repairTick = tick;
      } else if (slot === 0 && tick > 60 && repairTick === 0) dropped += batches.length;
      else
        for (const batch of batches) {
          const decoded = decodeEventBatch(encodeEventBatch(batch, context), context);
          const fresh = receiver.consume(decoded);
          if (slot === 1 && receiver.consume(decoded).length !== 0)
            throw new Error("Duplicate event was replayed");
          for (const item of fresh) {
            chains[slot] = stateHash([chains[slot], { runEpoch: 1, ...item }]);
            if (item.event.kind === "killed") kills[slot] = (kills[slot] ?? 0) + 1;
          }
        }
    }
    traces.push(
      stateHash({ tick, history, receivers: receivers.map((item) => item.status), chains, kills }),
    );
  }
  if (receivers.some((item) => item.cursor !== history.cursor || item.requiresBaseline))
    throw new Error("Event cursor convergence failed");
  if (
    chains[1] !== chains[2] ||
    chains[2] !== chains[3] ||
    receivers[0]?.status.baselines !== 1 ||
    !repairTick ||
    receivers[1]?.status.duplicates === 0 ||
    kills.some((count) => count !== 2)
  )
    throw new Error("Event delivery, repair or effect deduplication failed");
  if (actionKeys.size !== world.players.reduce((sum, actor) => sum + actor.weapon.shotOrdinal, 0))
    throw new Error("Missing automatic-fire confirmation key");
  return {
    ticks: world.tick,
    confirmedActions: actionKeys.size,
    cursor: history.cursor,
    repairTick,
    droppedFrames: dropped,
    retained: history.entries.length,
    capEvictions: history.capEvictions,
    ageEvictions: history.ageEvictions,
    receivers: receivers.map((item) => item.status),
    kills,
    unimpairedHash: chains[1],
    traceHash: stateHash(traces),
  };
}
