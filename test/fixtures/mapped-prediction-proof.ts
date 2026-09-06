import { stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held, type InputCommand } from "../../src/game/input/types.js";
import {
  createControllerWorkload,
  stepNetworkController,
} from "../../src/shared/diagnostics/controller-workload.js";
import { probeContext, roomWorkloadHash } from "../../src/shared/diagnostics/room-workload.js";
import { ControllerPrediction } from "../../src/shared/prediction/controller.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { decodeInputMapping, mappingForSnapshot } from "../../src/shared/protocol/input-mapping.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";

export function mappedPredictionProof() {
  const world = createControllerWorkload(),
    context = probeContext(0);
  world.roomMode = "playing";
  const actor = world.players[0],
    acknowledgment = world.acknowledgments[0];
  if (!actor || !acknowledgment) throw new Error("Missing actor");
  const initial = {
    runEpoch: 1,
    connectionEpoch: 1,
    snapshotId: world.snapshotId,
    tick: 0,
    actor,
    acknowledgment,
  };
  const step = (a: typeof actor, c: InputCommand, tick: number) =>
    stepNetworkController(a, c, tick).actor;
  const prediction = new ControllerPrediction(initial, step, mappingForSnapshot(world, 1));
  const commands: InputCommand[] = [
    { sequence: 1, clientTick: 0, controlEpoch: 1, held: Held.Right, aim: 0, edges: [] },
    {
      sequence: 2,
      clientTick: 1,
      controlEpoch: 1,
      held: 0,
      aim: 0,
      edges: [{ kind: Edge.Jump, id: 1 }],
    },
    { sequence: 3, clientTick: 2, controlEpoch: 1, held: Held.Down, aim: 0, edges: [] },
  ];
  for (const command of commands) prediction.submit(command);
  const stream = new InputStream({ ...context, controlEpoch: 1, baselineServerTick: 0 });
  const receive = (commands: InputCommand[], packetSequence: number, now: number, tick: number) =>
    stream.receive(
      encodeInputBatch({ ...context, packetSequence, snapshotAck: 0, eventAck: 0, commands }),
      now,
      tick,
    );
  receive(commands.slice(0, 1), 1, 0, 0);
  const applied: Array<{ tick: number; sequence: number; repeated: boolean }> = [];
  for (let tick = 1; tick <= 3; tick++) {
    if (tick === 3) receive(commands.slice(1), 2, 34, 2);
    const result = stream.processTick(tick, tick * 17, (input) => {
      const current = world.players[0];
      if (!current) throw new Error("Missing actor");
      const result = stepNetworkController(current, input.command, tick);
      world.players[0] = result.actor;
      return result.edges;
    });
    world.acknowledgments[0] = result.acknowledgment;
    world.tick = tick;
    applied.push({
      tick,
      sequence: result.input.submittedCommand?.sequence ?? 0,
      repeated: result.input.repeatedHeld,
    });
  }
  world.snapshotId++;
  world.stateHash = roomWorkloadHash(world);
  const snapshot = decodeSnapshot(encodeSnapshot(world, context), context);
  const restored = snapshot.players[0],
    ack = snapshot.acknowledgments[0],
    pending = commands[2];
  if (!restored || !ack || !pending) throw new Error("Missing snapshot data");
  const mapping = decodeInputMapping(JSON.stringify(mappingForSnapshot(snapshot, 1)));
  const result = prediction.reconcile(
    {
      ...initial,
      tick: snapshot.tick,
      snapshotId: snapshot.snapshotId,
      actor: restored,
      acknowledgment: ack,
    },
    mapping,
  );
  const expected = step(restored, pending, 4);
  if (stateHash(prediction.actor) !== stateHash(expected))
    throw new Error("Remapped replay diverged");
  return {
    applied,
    mapping,
    replayed: result.replayed,
    predictedTick: prediction.tick,
    edgeCursor: prediction.actor.processedEdgeIds[0],
    traceHash: stateHash({ applied, actor: prediction.actor, mapping }),
  };
}
