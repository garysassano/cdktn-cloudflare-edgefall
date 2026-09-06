import { canonical, stateHash } from "../../src/game/core/canonical.js";
import { Edge, Held, type InputCommand } from "../../src/game/input/types.js";
import {
  createControllerWorkload,
  stepNetworkController,
} from "../../src/shared/diagnostics/controller-workload.js";
import { probeContext, roomWorkloadHash } from "../../src/shared/diagnostics/room-workload.js";
import { ControllerPrediction } from "../../src/shared/prediction/controller.js";
import { encodeInputBatch } from "../../src/shared/protocol/codec.js";
import { InputStream } from "../../src/shared/protocol/input-stream.js";
import { decodeSnapshot, encodeSnapshot } from "../../src/shared/protocol/snapshot.js";

export function predictionProof() {
  const world = createControllerWorkload();
  world.roomMode = "playing";
  const peers = world.players.map((actor, slot) => {
    const acknowledgment = world.acknowledgments[slot];
    if (!acknowledgment) throw new Error("Missing ack");
    return {
      slot,
      sequence: 0,
      packet: 0,
      snapshotAck: 0,
      stream: new InputStream({ ...probeContext(slot), controlEpoch: 1, baselineServerTick: 0 }),
      prediction: new ControllerPrediction(
        { runEpoch: 1, connectionEpoch: slot + 1, tick: 0, actor, acknowledgment },
        (a, c, t) => stepNetworkController(a, c, t).actor,
      ),
      minY: actor.body.y,
      crouched: false,
    };
  });
  const send = (peer: (typeof peers)[number], tick: number) => {
    const commands: InputCommand[] = [];
    for (let i = 0; i < 3; i++) {
      const clientTick = peer.sequence,
        command: InputCommand = {
          sequence: ++peer.sequence,
          clientTick,
          controlEpoch: 1,
          held:
            clientTick < 10
              ? Held.Right
              : clientTick >= 30 && clientTick < 40
                ? Held.Left
                : clientTick >= 70 && clientTick < 80
                  ? Held.Down
                  : 0,
          aim: 0,
          edges: clientTick === 6 + peer.slot * 3 ? [{ kind: Edge.Jump, id: 1 }] : [],
        };
      peer.prediction.submit(command);
      commands.push(command);
    }
    peer.stream.receive(
      encodeInputBatch({
        runEpoch: 1,
        connectionEpoch: peer.slot + 1,
        packetSequence: ++peer.packet,
        snapshotAck: peer.snapshotAck,
        eventAck: 0,
        commands,
      }),
      (tick * 1000) / 60,
      tick,
    );
  };
  for (const peer of peers) {
    send(peer, 0);
    send(peer, 0);
  }
  let traceHash = "00000000",
    bytes = 0,
    reconciliations = 0;
  for (let tick = 1; tick <= 180; tick++) {
    for (const peer of peers) {
      const processed = peer.stream.processTick(tick, (tick * 1000) / 60, (input) => {
        const actor = world.players[peer.slot];
        if (!actor) throw new Error("Missing actor");
        const result = stepNetworkController(actor, input.command, tick);
        world.players[peer.slot] = result.actor;
        return result.edges;
      });
      world.acknowledgments[peer.slot] = processed.acknowledgment;
      const actor = world.players[peer.slot];
      if (!actor) throw new Error("Missing actor");
      actor.processedEdgeIds = [...processed.acknowledgment.processedEdgeIds];
      peer.minY = Math.min(peer.minY, actor.body.y);
      peer.crouched ||= actor.body.shapeId === 2;
    }
    world.tick = tick;
    if (tick % 3 === 0) {
      world.stateHash = roomWorkloadHash(world);
      for (const peer of peers) {
        world.connectionEpoch = peer.slot + 1;
        world.snapshotId++;
        const encoded = encodeSnapshot(world, probeContext(peer.slot));
        bytes = encoded.byteLength;
        peer.stream.recordSent(world.snapshotId, 0);
        peer.snapshotAck = world.snapshotId;
        const decoded = decodeSnapshot(encoded, probeContext(peer.slot)),
          actor = decoded.players[peer.slot],
          acknowledgment = decoded.acknowledgments[peer.slot];
        if (!actor || !acknowledgment) throw new Error("Missing decoded player");
        const before = canonical(peer.prediction.actor);
        const result = peer.prediction.reconcile({
          runEpoch: 1,
          connectionEpoch: peer.slot + 1,
          tick,
          actor,
          acknowledgment,
        });
        if (result.correction?.changed || canonical(peer.prediction.actor) !== before)
          throw new Error("Full controller replay divergence");
        reconciliations++;
        send(peer, tick);
      }
    }
    traceHash = stateHash({ traceHash, tick, players: world.players, acks: world.acknowledgments });
  }
  if (peers.some((p) => p.minY >= 280 * 256 || !p.crouched))
    throw new Error("Missing jump/crouch behavior");
  return {
    ticks: world.tick,
    traceHash,
    bytes,
    reconciliations,
    players: world.players,
    coverage: peers.map((p) => ({
      slot: p.slot,
      minY: p.minY,
      crouched: p.crouched,
      pending: p.prediction.pending,
    })),
  };
}
