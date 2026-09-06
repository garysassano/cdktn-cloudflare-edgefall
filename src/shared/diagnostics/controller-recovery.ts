import { nextCounter } from "../../game/core/numeric.js";
import type { FullSnapshot } from "../protocol/snapshot-schema.js";
import { probeContext, roomWorkloadHash } from "./room-workload.js";

/** In-memory controller laboratory recovery. Durable checkpoint/journal recovery is separate. */
export function recoverControllerWorld(current: FullSnapshot): FullSnapshot {
  if (current.vehicles.length || current.players.some((actor) => actor.vehicleId !== null))
    throw new Error("Controller recovery does not own vehicle handoff");
  const next = structuredClone(current);
  next.runEpoch = nextCounter(current.runEpoch);
  next.roomMode = "loading";
  for (const actor of next.players) {
    const ack = next.acknowledgments.find((value) => value.playerId === actor.playerId);
    if (!ack) throw new Error("Missing recovery acknowledgment");
    actor.controlEpoch = nextCounter(actor.controlEpoch);
    actor.jumpBufferTicks = 0;
    actor.processedEdgeIds = [0, 0, 0, 0, 0];
    ack.connectionEpoch = nextCounter(ack.connectionEpoch);
    ack.controlEpoch = actor.controlEpoch;
    ack.lastProcessedSequence = 0;
    ack.appliedAtServerTick = 0;
    ack.processedEdgeIds = [0, 0, 0, 0, 0];
  }
  next.stateHash = roomWorkloadHash(next);
  return next;
}

export function controllerPeerContext(world: FullSnapshot, slot: number) {
  const actor = world.players.find((value) => value.slot === slot);
  const ack = world.acknowledgments.find((value) => value.playerId === actor?.playerId);
  if (!actor || !ack) throw new Error("Missing controller session");
  return {
    ...probeContext(slot),
    runEpoch: world.runEpoch,
    connectionEpoch: ack.connectionEpoch,
    playerId: actor.playerId,
    geometryRevision: world.geometryRevision,
  };
}
