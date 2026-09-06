import type { Handshake } from "./handshake.js";
import { ProtocolError } from "./schema.js";
import { decodeSnapshot } from "./snapshot.js";
import type { SnapshotContext } from "./snapshot-schema.js";

/** Install only the complete snapshot promised by this validated server welcome. */
export function decodeInitialSnapshot(
  bytes: Uint8Array,
  welcome: Handshake,
  context: SnapshotContext,
) {
  const snapshot = decodeSnapshot(bytes, {
    ...context,
    runEpoch: welcome.runEpoch,
    connectionEpoch: welcome.connectionEpoch,
    playerId: welcome.playerId,
  });
  const actor = snapshot.players.find((value) => value.playerId === welcome.playerId);
  const ack = snapshot.acknowledgments.find((value) => value.playerId === welcome.playerId);
  if (
    snapshot.tick !== welcome.initialServerTick ||
    snapshot.snapshotId !== welcome.baselineSnapshotId ||
    snapshot.baselineEventCursor !== welcome.baselineEventCursor ||
    actor?.body.id !== welcome.entityId ||
    !ack ||
    ack.lastProcessedSequence !== 0 ||
    ack.appliedAtServerTick !== 0 ||
    ack.processedEdgeIds.some((id) => id !== 0)
  )
    throw new ProtocolError("resync-required", "Welcome baseline mismatch");
  return snapshot;
}
